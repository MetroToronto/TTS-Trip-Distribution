/* routing.js — ORS routes + street list + PZ report
   - Highway name fallback from local centerlines (only real highways; confidence-gated).
   - Ramp buffer: skip first 100 m of a highway step for naming & direction stabilization.
   - Direction stability with whole-step fallback.
   - Highway alias grouping (same corridor name & direction = max-km).
   - Drops tiny fragments (<30 m) to avoid ghosts.
   - Buttons: Generate Trips, Print Report, Debug Steps, Highways: ON/OFF, **PZ report**.
   - PZ report: runs trips for **all Planning Zones in exactly one selected PD**. If multiple/none PDs selected, shows an alert.
   - Expects WGS84 centerlines; tries the paths in HIGHWAY_URLS (relative, for GitHub Pages).
*/
(function (global) {
  // ===== Tunables =====
  const GENERIC_REGEX          = /\b(keep (right|left)|continue|head (east|west|north|south))\b/i;
  const SAMPLE_EVERY_M         = 500;
  const MATCH_BUFFER_M         = 260;
  const CONF_REQ_SHARE         = 0.60;
  const CONF_REQ_MEAN_M        = 120;
  const BOUND_LOCK_WINDOW_M    = 300;
  const MIN_FRAGMENT_M         = 30;
  const RAMP_SKIP_M            = 100;   // ramp buffer
  const PER_REQUEST_DELAY      = 80;

  const PROFILE    = 'driving-car';
  const PREFERENCE = 'fastest';
  const ORS_BASE   = 'https://api.openrouteservice.org';

  const COLOR_FIRST  = '#0b3aa5';
  const COLOR_OTHERS = '#2166f3';
  const CENTERLINE_COLOR = '#ff0080';

  const HIGHWAY_URLS = [
    'data/highway_centerlines_wgs84.geojson',
    'data/highway_centrelines.json',
    'data/highway_centerlines.json',
    'data/toronto_highways.geojson'
  ];

  const ZONES_URL = 'data/tts_zones.json'; // fallback for PZ report when helpers not provided

  // ===== Keys / State =====
  const INLINE_DEFAULT_KEY =
    'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=';
  const LS_KEYS = 'ORS_KEYS';
  const LS_ACTIVE_INDEX = 'ORS_ACTIVE_INDEX';

  const S = {
    map:null, group:null, results:[],
    keys:[], keyIndex:0,
    highwaysOn:true,
    highwayFeatures:[],  // [{label, coords:[ [lon,lat], ... ]}]
    highwayLayer:null
  };

  // ===== Utils =====
  const byId  = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const qParam = (k) => new URLSearchParams(location.search).get(k) || '';
  const toRad  = (d) => d * Math.PI / 180;
  const isFiniteNum = (n) => Number.isFinite(n) && !Number.isNaN(n);
  const num = (x) => { const n = typeof x === 'string' ? parseFloat(x) : +x; return Number.isFinite(n) ? n : NaN; };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function sanitizeLonLat(input){
    let arr = Array.isArray(input) ? input : [undefined, undefined];
    let x = num(arr[0]), y = num(arr[1]);
    if (isFiniteNum(x) && isFiniteNum(y) && Math.abs(x) <= 90 && Math.abs(y) > 90){ const t=x; x=y; y=t; }
    if (!isFiniteNum(x) || !isFiniteNum(y)) throw new Error(`Invalid coordinate (NaN). Raw: ${JSON.stringify(input)}`);
    x = clamp(x, -180, 180); y = clamp(y, -85, 85);
    return [x, y];
  }

  function getOriginLonLat(){
    const o = global.ROUTING_ORIGIN;
    if (!o) throw new Error('Origin not set');
    if (Array.isArray(o) && o.length >= 2) return sanitizeLonLat([o[0], o[1]]);
    if (typeof o.getLatLng === 'function'){ const ll = o.getLatLng(); return sanitizeLonLat([ll.lng, ll.lat]); }
    if (isFiniteNum(num(o.lng)) && isFiniteNum(num(o.lat))) return sanitizeLonLat([o.lng, o.lat]);
    if (o.latlng && isFiniteNum(num(o.latlng.lng)) && isFiniteNum(num(o.latlng.lat))) return sanitizeLonLat([o.latlng.lng, o.latlng.lat]);
    if (o.center){
      if (Array.isArray(o.center) && o.center.length >= 2) return sanitizeLonLat([o.center[0], o.center[1]]);
      if (isFiniteNum(num(o.center.lng)) && isFiniteNum(num(o.center.lat))) return sanitizeLonLat([o.center.lng, o.center.lat]);
    }
    if (o.geometry?.coordinates?.length >= 2) return sanitizeLonLat([o.geometry.coordinates[0], o.geometry.coordinates[1]]);
    const x = o.lon ?? o.x, y = o.lat ?? o.y;
    if (isFiniteNum(num(x)) && isFiniteNum(num(y))) return sanitizeLonLat([x, y]);
    if (typeof o === 'string' && o.includes(',')){
      const [a,b] = o.split(',').map(s=>s.trim());
      try { return sanitizeLonLat([a,b]); } catch {}
      return sanitizeLonLat([b,a]);
    }
    throw new Error(`Origin shape unsupported: ${JSON.stringify(o)}`);
  }

  // Distance / bearing / sampling
  function haversineMeters(a, b) {
    const R = 6371000;
    const [lon1, lat1] = a, [lon2, lat2] = b;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const s = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function bearingDeg(a, b) {
    const [lng1, lat1] = [toRad(a[0]), toRad(a[1])], [lng2, lat2] = [toRad(b[0]), toRad(b[1])];
    const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function circularMean(degArr) {
    const sx = degArr.reduce((a, d) => a + Math.cos(toRad(d)), 0);
    const sy = degArr.reduce((a, d) => a + Math.sin(toRad(d)), 0);
    return (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360;
  }
  function boundFrom(deg) {
    if (deg >= 315 || deg < 45) return 'NB';
    if (deg >= 45 && deg < 135) return 'EB';
    if (deg >= 135 && deg < 225) return 'SB';
    return 'WB';
  }
  function resampleByDistance(coords, everyM) {
    if (!coords || coords.length < 2) return coords || [];
    const out = [coords[0]];
    let acc = 0;
    for (let i = 1; i < coords.length; i++) {
      const d = haversineMeters(coords[i-1], coords[i]);
      acc += d;
      if (acc >= everyM) { out.push(coords[i]); acc = 0; }
    }
    if (out[out.length-1] !== coords[coords.length-1]) out.push(coords[coords.length-1]);
    return out;
  }

  // ===== Natural naming =====
  function cleanHtml(s){ return String(s || '').replace(/<[^>]*>/g, '').trim(); }
  function normalizeName(raw){
    if (!raw) return '';
    const s = String(raw).trim().replace(/\s+/g, ' ');
    if (!s || /^unnamed\b/i.test(s) || /^[-–]+$/.test(s)) return '';
    return s;
  }
  function stepNameNatural(step) {
    const field = normalizeName(step?.name || step?.road || '');
    if (field) return field;
    const t = cleanHtml(step?.instruction || '');
    if (!t) return '';
    const token =
      t.match(/\b(?:ON[- ]?)?(?:HWY|Hwy|Highway)?[- ]?\d{2,3}\b(?:\s*[ENSW][BW]?)?/i) ||
      t.match(/\b(QEW|DVP|Gardiner(?:\s+Expressway)?|Don Valley Parkway|Allen Road|Black Creek Drive)\b/i);
    if (token) return normalizeName(token[0]);
    if (GENERIC_REGEX.test(t)) return '';
    const m = t.match(/\b(?:onto|on|to|toward|towards)\s+([A-Za-z0-9 .,'\-\/&()]+)$/i);
    if (m) return normalizeName(m[1]);
    return normalizeName(t);
  }

  // ===== Highway resolver =====
  const HighwayResolver = (() => {
    function isHighwayLabel(label){
      const s = String(label || '').toUpperCase();
      return /(^|\b)(HWY|HIGHWAY|PARKWAY|EXPRESSWAY|QEW|DVP|DON VALLEY|GARDINER|ALLEN|BLACK CREEK|401|404|427|409|410|403|407)\b/.test(s);
    }

    function flattenGeoJSONFeature(f){
      const props = f.properties || {};
      const g = f.geometry || {};
      const out = [];
      if (!g) return out;
      if (g.type === 'LineString') out.push({ props, coords: g.coordinates });
      if (g.type === 'MultiLineString') (g.coordinates || []).forEach(cs => out.push({ props, coords: cs }));
      return out;
    }
    function flattenEsriFeature(f){
      const props = (f.attributes || f.properties || {});
      const geom  = f.geometry || {};
      const paths = geom.paths || geom.PATHS || [];
      const out = [];
      for (const p of paths) out.push({ props, coords: p });
      return out;
    }
    function labelFromProps(props){
      return normalizeName(props.Name || props.name || props.official_name || props.short || props.ref);
    }

    function pointSegDistM(p, a, b){
      const kx = 111320 * Math.cos(toRad((a[1]+b[1])/2));
      const ky = 110540;
      const ax = a[0]*kx, ay=a[1]*ky, bx=b[0]*kx, by=b[1]*ky, px=p[0]*kx, py=p[1]*ky;
      const vx = bx-ax, vy = by-ay;
      const wx = px-ax, wy = py-ay;
      const c1 = vx*wx + vy*wy;
      const c2 = vx*vx + vy*vy;
      const t = c2 ? Math.max(0, Math.min(1, c1/c2)) : 0;
      const nx = ax + t*vx, ny = ay + t*vy;
      const dx = px - nx, dy = py - ny;
      return Math.sqrt(dx*dx + dy*dy);
    }

    function bestLabelForSegment(features, segCoords){
      if (!features?.length || !segCoords || segCoords.length < 2) return '';
      const sampled = resampleByDistance(segCoords, SAMPLE_EVERY_M);
      const tallies = new Map(); // label -> {near:count, sum:meters}
      for (const p of sampled){
        let best = { d: 1e12, label: '' };
        for (const f of features){
          const cs = f.coords;
          for (let i=1; i<cs.length; i++){
            const d = pointSegDistM(p, cs[i-1], cs[i]);
            if (d < best.d){ best.d = d; best.label = f.label; }
          }
        }
        if (best.label && best.d <= MATCH_BUFFER_M){
          const t = tallies.get(best.label) || { near:0, sum:0 };
          t.near++; t.sum += best.d;
          tallies.set(best.label, t);
        }
      }
      let winner = '', wNear = 0, wMean = 1e12;
      for (const [label, t] of tallies){
        if (t.near > wNear){ winner = label; wNear = t.near; wMean = t.sum / t.near; }
      }
      const share = sampled.length ? (wNear / sampled.length) : 0;
      if (winner && share >= CONF_REQ_SHARE && wMean <= CONF_REQ_MEAN_M && isHighwayLabel(winner)) return winner;
      return '';
    }

    async function loadFirstAvailable(urls){
      for (const url of urls){
        try {
          const res = await fetch(url, { cache: 'no-cache' });
          if (!res.ok) { console.warn('[HighwayResolver] fetch failed', url, res.status); continue; }
          const data = await res.json();

          const arr = [];
          if (Array.isArray(data?.features)) {
            const isEsri = !!data.features[0]?.geometry?.paths || !!data.geometryType;
            if (isEsri) {
              data.features.forEach(f => {
                flattenEsriFeature(f).forEach(part => {
                  const label = labelFromProps(part.props);
                  if (label && isHighwayLabel(label)) arr.push({ label, coords: part.coords });
                });
              });
            } else {
              data.features.forEach(f => {
                flattenGeoJSONFeature(f).forEach(part => {
                  const label = labelFromProps(part.props);
                  if (label && isHighwayLabel(label)) arr.push({ label, coords: part.coords });
                });
              });
            }
          } else if (Array.isArray(data)) {
            data.forEach(f => {
              flattenGeoJSONFeature(f).concat(flattenEsriFeature(f)).forEach(part => {
                const label = labelFromProps(part.props);
                if (label && isHighwayLabel(label)) arr.push({ label, coords: part.coords });
              });
            });
          }

          if (arr.length){
            console.info('[HighwayResolver] loaded features:', arr.length, 'from', url);
            return arr;
          }
        } catch (e) {
          console.warn('[HighwayResolver] error loading', url, e);
        }
      }
      console.warn('[HighwayResolver] no highway file found / parsed');
      return [];
    }

    return { loadFirstAvailable, bestLabelForSegment };
  })();

  // ===== ORS plumbing =====
  function savedKeys(){ try { return JSON.parse(localStorage.getItem(LS_KEYS) || '[]'); } catch { return []; } }
  function hydrateKeys(){
    const urlKey = qParam('orsKey');
    const saved = savedKeys();
    const inline = [INLINE_DEFAULT_KEY];
    S.keys = (urlKey ? [urlKey] : []).concat(saved.length ? saved : inline);
    S.keyIndex = Math.min(+localStorage.getItem(LS_ACTIVE_INDEX) || 0, Math.max(0, S.keys.length - 1));
  }
  function currentKey(){ return S.keys[Math.min(Math.max(S.keyIndex,0), S.keys.length-1)] || ''; }
  function rotateKey(){
    if (S.keys.length <= 1) return false;
    S.keyIndex = (S.keyIndex + 1) % S.keys.length;
    localStorage.setItem(LS_ACTIVE_INDEX, String(S.keyIndex));
    return true;
  }
  async function orsFetch(path, { method='GET', body } = {}, attempt = 0){
    const url = new URL(ORS_BASE + path);
    const res = await fetch(url.toString(), {
      method,
      headers: { Authorization: currentKey(), ...(method !== 'GET' && { 'Content-Type':'application/json' }) },
      body: method === 'GET' ? undefined : JSON.stringify(body)
    });
    if ([401,403,429].includes(res.status) && rotateKey()){
      await sleep(150);
      return orsFetch(path, { method, body }, attempt + 1);
    }
    if (res.status === 500 && attempt < 1){
      await sleep(200);
      return orsFetch(path, { method, body }, attempt + 1);
    }
    if (!res.ok){
      const txt = await res.text().catch(()=>res.statusText);
      throw new Error(`ORS ${res.status}: ${txt}`);
    }
    return res.json();
  }

  async function getRoute(originLonLat, destLonLat) {
    let o = sanitizeLonLat(originLonLat);
    let d = sanitizeLonLat(destLonLat);
    const baseBody = {
      coordinates: [o, d],
      preference: PREFERENCE,
      instructions: true,
      instructions_format: 'html',
      language: 'en',
      geometry_simplify: false,
      elevation: false,
      units: 'km'
    };
    try {
      return await orsFetch(`/v2/directions/${PROFILE}/geojson`, { method:'POST', body: baseBody });
    } catch (e) {
      const msg = String(e.message || '');
      const is2099 = msg.includes('ORS 500') && (msg.includes('"code":2099') || msg.includes('code:2099'));
      if (!is2099) throw e;
      const dSwap = sanitizeLonLat([d[1], d[0]]);
      const bodySwap = { ...baseBody, coordinates:[o, dSwap] };
      return await orsFetch(`/v2/directions/${PROFILE}/geojson`, { method:'POST', body: bodySwap });
    }
  }

  // ===== Movement / direction =====
  function sliceCoords(full, i0, i1){
    const s = Math.max(0, Math.min(i0, full.length - 1));
    const e = Math.max(0, Math.min(i1, full.length - 1));
    return e <= s ? full.slice(s, s + 1) : full.slice(s, e + 1);
  }
  function cutAfterDistance(coords, startIdx, endIdx, metersToSkip){
    if (metersToSkip <= 0) return startIdx;
    let acc = 0;
    for (let i = startIdx + 1; i <= endIdx; i++){
      acc += haversineMeters(coords[i-1], coords[i]);
      if (acc >= metersToSkip) return i;
    }
    return endIdx;
  }
  function stableBoundForStep(fullCoords, waypoints, limitM = BOUND_LOCK_WINDOW_M){
    if (!Array.isArray(waypoints) || waypoints.length !== 2) return '';
    const [w0, w1] = waypoints;
    const s = Math.max(0, Math.min(w0, fullCoords.length - 1));
    const e = Math.max(0, Math.min(w1, fullCoords.length - 1));
    if (e <= s + 1) return '';
    let acc = 0, cut = s + 1;
    for (let i = s + 1; i <= e; i++){
      acc += haversineMeters(fullCoords[i-1], fullCoords[i]);
      if (acc >= limitM) { cut = i; break; }
    }
    const seg = fullCoords.slice(s, Math.max(cut, s + 1) + 1);
    const samples = resampleByDistance(seg, 50);
    if (samples.length < 2) return '';
    const bearings = [];
    for (let i = 1; i < samples.length; i++) bearings.push(bearingDeg(samples[i-1], samples[i]));
    const mean = circularMean(bearings);
    return boundFrom(mean);
  }
  function wholeStepBound(seg){
    const s = resampleByDistance(seg, 50);
    if (s.length < 2) return '';
    const bearings = [];
    for (let i=1;i<s.length;i++) bearings.push(bearingDeg(s[i-1], s[i]));
    return boundFrom(circularMean(bearings));
  }

  // Highway alias grouping
  function canonicalHighwayKey(name){
    if (!name) return null;
    const s = String(name).trim();
    const numTok = s.match(/(?:HWY|HIGHWAY|ROUTE|RTE)?\s*([0-9]{2,3})\b/) || s.match(/,\s*([0-9]{2,3})\b/);
    if (numTok) return { key:`RTE-${numTok[1]}`, num:numTok[1], labelBase:`${numTok[1]}` };
    const up = s.toUpperCase();
    const named = up.match(/\b(QEW|DVP|GARDINER|DON VALLEY PARKWAY|ALLEN ROAD|BLACK CREEK DRIVE)\b/);
    if (named) return { key:`NAMED-${named[1]}`, num:null, labelBase:named[1] };
    return null;
  }
  function mergeConsecutiveSameCorridor(rows){
    if (!rows.length) return rows;
    const out = [];
    let i = 0;
    while (i < rows.length){
      const r = rows[i];
      const key = canonicalHighwayKey(r.name);
      if (!key){ out.push(r); i++; continue; }
      let j = i, kmByDir = new Map(), kmTotal = 0;
      let bestName = r.name, bestKm = r.km;
      while (j < rows.length){
        const rij = rows[j];
        const kj  = canonicalHighwayKey(rij.name);
        if (!kj || kj.key !== key.key) break;
        kmTotal += rij.km;
        kmByDir.set(rij.dir || '', (kmByDir.get(rij.dir || '') || 0) + rij.km);
        if (rij.km > bestKm){ bestKm = rij.km; bestName = rij.name; }
        j++;
      }
      let domDir = '', domKm = -1;
      for (const [d,km] of kmByDir.entries()){ if (km > domKm){ domKm = km; domDir = d; } }
      out.push({ dir: domDir, name: bestName, km: +kmTotal.toFixed(2) });
      i = j;
    }
    return out;
  }

  // Build movements
  function buildMovementsFromDirections(coords, steps){
    if (!coords?.length || !steps?.length) return [];
    const rows = [];

    const pushRow = (name, i0, i1, waypoints, isHighwayStep = false) => {
      const nm = normalizeName(name);
      if (!nm) return;

      let seg = sliceCoords(coords, i0, i1);
      if (seg.length < 2) return;

      let meters = 0; for (let i = 1; i < seg.length; i++) meters += haversineMeters(seg[i-1], seg[i]);
      if (meters < MIN_FRAGMENT_M) return;

      let dir = '';
      if (isHighwayStep) {
        const cut = cutAfterDistance(coords, i0, i1, RAMP_SKIP_M);
        const segAfter = sliceCoords(coords, cut, i1);
        dir = stableBoundForStep(coords, [cut, i1], BOUND_LOCK_WINDOW_M) || wholeStepBound(segAfter);
      } else {
        dir = stableBoundForStep(coords, waypoints, BOUND_LOCK_WINDOW_M) || wholeStepBound(seg);
      }

      const last = rows[rows.length - 1];
      if (last && last.name === nm && last.dir === dir){
        last.km = +(last.km + meters / 1000).toFixed(2);
      } else {
        rows.push({ dir, name: nm, km: +(meters / 1000).toFixed(2) });
      }
    };

    for (let i = 0; i < steps.length; i++){
      const st  = steps[i];
      const wp  = st.way_points || st.wayPoints || st.waypoints || [0,0];
      const [i0, i1] = wp;

      // 1) Natural name
      let name = stepNameNatural(st);
      const instr = cleanHtml(st?.instruction || '');
      const isGeneric = !name && GENERIC_REGEX.test(instr);

      // 2) Highway naming (ramp-buffered) if unlabeled/generic
      let isHighwayStep = false;
      if (S.highwaysOn && (!name || isGeneric)) {
        const cut = cutAfterDistance(S.resultsRouteCoordsRef || [], i0, i1, RAMP_SKIP_M); // guard if not set
        const segAfter = sliceCoords(S.resultsRouteCoordsRef || [], cut, i1);
        const label = HighwayResolver.bestLabelForSegment(S.highwayFeatures, segAfter.length ? segAfter : sliceCoords(S.resultsRouteCoordsRef || [], i0, i1));
        if (label) { name = label; isHighwayStep = true; }
      }

      if (!name) name = normalizeName(instr);
      pushRow(name, i0, i1, [i0, i1], isHighwayStep);
    }

    return mergeConsecutiveSameCorridor(rows);
  }

  // ===== Map & orchestration =====
  function clearAll(){
    S.results = [];
    if (S.group) S.group.clearLayers();
    const btn = byId('rt-print'); if (btn) btn.disabled = true;
    const db  = byId('rt-debug'); if (db) db.disabled  = true;
  }
  function drawRoute(coords, color){
    if (!coords?.length) return;
    if (!S.group) S.group = L.layerGroup().addTo(S.map);
    L.polyline(coords.map(([lng, lat]) => [lat, lng]), { color, weight: 4, opacity: 0.9 }).addTo(S.group);
  }

  function updateCenterlineLayer(){
    if (S.highwayLayer){ try { S.map.removeLayer(S.highwayLayer); } catch {} S.highwayLayer = null; }
    if (!S.highwaysOn || !S.highwayFeatures.length) return;

    const grp = L.layerGroup();
    for (const f of S.highwayFeatures){
      const latlngs = f.coords.map(([lon,lat]) => [lat, lon]);
      L.polyline(latlngs, { color: CENTERLINE_COLOR, weight: 2, opacity: 0.45, dashArray: '6,6' }).addTo(grp);
    }
    S.highwayLayer = grp.addTo(S.map);
  }

  async function generate(){
    let originLonLat;
    try { originLonLat = getOriginLonLat(); }
    catch (e) { console.error('Origin invalid:', global.ROUTING_ORIGIN, e); alert('Origin has invalid coordinates. Please re-select the address.'); return; }

    const rawTargets = (global.getSelectedPDTargets && global.getSelectedPDTargets()) || [];
    const targets = [];
    (rawTargets || []).forEach((t, i) => {
      try {
        if (Array.isArray(t)) targets.push([sanitizeLonLat([t[0], t[1]])[0], sanitizeLonLat([t[0], t[1]])[1], t[2] ?? `PD ${i+1}`]);
        else if (t && typeof t === 'object') {
          const pair = sanitizeLonLat([t.lon ?? t.lng ?? t.x, t.lat ?? t.y]);
          targets.push([pair[0], pair[1], t.label ?? t.name ?? `PD ${i+1}`]);
        }
      } catch {}
    });
    if (!targets.length){ alert('Select at least one PD with valid coordinates.'); return; }

    setBusy(true); clearAll();

    try {
      for (let idx = 0; idx < targets.length; idx++){
        const [lon, lat, label] = targets[idx];
        const destLonLat = sanitizeLonLat([lon, lat]);

        const json  = await getRoute(originLonLat, destLonLat);
        const feat  = json.features?.[0];
        const coords = feat?.geometry?.coordinates || [];
        const steps  = feat?.properties?.segments?.[0]?.steps || [];
        S.resultsRouteCoordsRef = coords;

        S.results.push({ dest: { lon, lat, label }, route: { coords, steps }});
        drawRoute(coords, idx === 0 ? COLOR_FIRST : COLOR_OTHERS);

        await sleep(PER_REQUEST_DELAY);
      }

      const printBtn = byId('rt-print'); if (printBtn) printBtn.disabled = false;
      const debugBtn = byId('rt-debug'); if (debugBtn) debugBtn.disabled = false;
    } catch (e) {
      console.error(e);
      alert('Routing error: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  function setBusy(b){
    const g = byId('rt-generate');
    if (g){ g.disabled = b; g.textContent = b ? 'Generating…' : 'Generate Trips'; }
  }

  // ===== PZ report (zones in one PD) =====
  function parsePDIdFromLabel(lbl){
    const m = String(lbl || '').match(/\bPD\s*([0-9]+)\b/i);
    return m ? m[1] : null;
  }
  async function loadZonesGeo(){
    try {
      const res = await fetch(ZONES_URL, { cache:'no-cache' });
      if (!res.ok) throw new Error('zones not found');
      return await res.json();
    } catch (e) {
      console.warn('Could not load zones file', e);
      return null;
    }
  }
  function centroidWGS84(geom){
    // rough centroid; fine for routing origins
    function polyCentroid(coords){
      let area=0, x=0, y=0;
      const pts = coords[0]; if (!pts || pts.length<3) return null;
      for (let i=0;i<pts.length-1;i++){
        const [x0,y0]=pts[i], [x1,y1]=pts[i+1];
        const a = x0*y1 - x1*y0;
        area += a; x += (x0+x1)*a; y += (y0+y1)*a;
      }
      area *= 0.5;
      if (Math.abs(area) < 1e-12) return null;
      return [x/(6*area), y/(6*area)];
    }
    if (!geom) return null;
    if (geom.type === 'Polygon') return polyCentroid(geom.coordinates);
    if (geom.type === 'MultiPolygon'){
      for (const p of geom.coordinates){ const c = polyCentroid(p); if (c) return c; }
    }
    return null;
  }

  async function getZoneTargetsForSinglePD(selectedPDId){
    // 1) Prefer helper from your app if present
    if (typeof global.getZoneTargetsForPD === 'function') {
      // expected return: [{lon,lat,label}] or [[lon,lat,label], ...]
      const arr = await Promise.resolve(global.getZoneTargetsForPD(selectedPDId));
      return (arr || []).map(t => Array.isArray(t) ? { lon:t[0], lat:t[1], label:t[2] } : t);
    }
    if (typeof global.getZonesForPD === 'function') {
      const arr = await Promise.resolve(global.getZonesForPD(selectedPDId));
      return (arr || []).map(t => Array.isArray(t) ? { lon:t[0], lat:t[1], label:t[2] } : t);
    }

    // 2) Fallback: load zones file and filter by PD id/name field
    const gj = await loadZonesGeo();
    if (!gj || !Array.isArray(gj.features)) throw new Error('Zones data unavailable');

    const feats = gj.features.filter(f => {
      const p = f.properties || {};
      // try a handful of likely field names
      const pd = p.PD || p.PD_ID || p.PDID || p.DISTRICT || p.PlanningDistrict || p.PD_NAME;
      if (pd == null) return false;
      return String(pd).trim().replace(/^PD\s*/i,'') == String(selectedPDId);
    });

    if (!feats.length) throw new Error('No zones found for PD ' + selectedPDId);

    const targets = [];
    for (const f of feats){
      const c = centroidWGS84(f.geometry);
      if (!c) continue;
      const [lon, lat] = sanitizeLonLat([c[0], c[1]]);
      const p = f.properties || {};
      const label = p.ZONE || p.ZONE_ID || p.TTS_ZONE || p.ID || p.Name || 'Zone';
      targets.push({ lon, lat, label: String(label) });
    }
    return targets;
  }

  async function pzReport(){
    // get selected PDs (use your helper if present)
    const pdTargets = (global.getSelectedPDTargets && global.getSelectedPDTargets()) || [];
    if (!pdTargets.length) { alert('Please select one PD to run a PZ report.'); return; }
    if (pdTargets.length > 1) { alert('Only one PD can be selected for a PZ report.'); return; }

    // Determine PD id (try label like "PD 5", else accept numeric in object)
    const one = pdTargets[0];
    const label = Array.isArray(one) ? (one[2] || '') : (one.label || one.name || '');
    const pdId = parsePDIdFromLabel(label) || one.pdId || one.PD || one.PD_ID;
    if (!pdId) { alert('Could not determine the PD id for the selection.'); return; }

    let originLonLat;
    try { originLonLat = getOriginLonLat(); }
    catch (e) { alert('Origin has invalid coordinates. Please re-select the address.'); return; }

    setBusy(true);

    try {
      const zones = await getZoneTargetsForSinglePD(String(pdId));
      if (!zones || !zones.length){ alert('No zones found for this PD.'); return; }

      const results = [];
      for (let i=0; i<zones.length; i++){
        const z = zones[i];
        const dest = sanitizeLonLat([z.lon ?? z.lng ?? (Array.isArray(z) ? z[0] : null),
                                     z.lat ?? (Array.isArray(z) ? z[1] : null)]);
        const json  = await getRoute(originLonLat, dest);
        const feat  = json.features?.[0];
        const coords = feat?.geometry?.coordinates || [];
        const steps  = feat?.properties?.segments?.[0]?.steps || [];
        S.resultsRouteCoordsRef = coords; // for ramp-buffered labeling

        results.push({ dest: { lon: dest[0], lat: dest[1], label: z.label || `Zone ${i+1}` }, route: { coords, steps }});
        await sleep(PER_REQUEST_DELAY);
      }

      // Build a single PZ report window
      const cards = results.map((r) => {
        const mov = buildMovementsFromDirections(r.route.coords, r.route.steps);
        const lines = mov.map(m => `<tr><td>${m.dir || ''}</td><td>${m.name}</td><td style="text-align:right">${(m.km||0).toFixed(2)}</td></tr>`).join('');
        return `
          <div class="card">
            <h2>Destination: ${r.dest.label}</h2>
            <table>
              <thead><tr><th>Dir</th><th>Street</th><th style="text-align:right">km</th></tr></thead>
              <tbody>${lines}</tbody>
            </table>
          </div>`;
      }).join('');

      const css = `
        <style>
          body{font:14px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;}
          h1{font-size:18px;margin:16px 0;}
          h2{font-size:16px;margin:14px 0 8px;}
          table{width:100%;border-collapse:collapse;margin-bottom:18px;}
          th,td{border:1px solid #ddd;padding:6px 8px;}
          thead th{background:#f7f7f7;}
          .card{page-break-inside:avoid;margin-bottom:22px;}
        </style>
      `;
      const w = window.open('', '_blank');
      w.document.write(`<!doctype html><meta charset="utf-8"><title>PZ Report — PD ${pdId}</title>${css}<h1>PZ Report — PD ${pdId}</h1>${cards}<script>onload=()=>print();</script>`);
      w.document.close();

    } catch (e) {
      console.error(e);
      alert('PZ report error: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  // ===== Reports =====
  function km2(n){ return (n || 0).toFixed(2); }

  function printReport(){
    if (!S.results.length) { alert('No trips generated yet.'); return; }

    const rowsHtml = S.results.map((r) => {
      const mov = buildMovementsFromDirections(r.route.coords, r.route.steps);
      const lines = mov.map(m => `<tr><td>${m.dir || ''}</td><td>${m.name}</td><td style="text-align:right">${km2(m.km)}</td></tr>`).join('');
      return `
        <div class="card">
          <h2>Destination: ${r.dest.label || (r.dest.lon+','+r.dest.lat)}</h2>
          <table>
            <thead><tr><th>Dir</th><th>Street</th><th style="text-align:right">km</th></tr></thead>
            <tbody>${lines}</tbody>
          </table>
        </div>`;
    }).join('');

    const css = `
      <style>
        body{font:14px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;}
        h1{font-size:18px;margin:16px 0;}
        h2{font-size:16px;margin:14px 0 8px;}
        table{width:100%;border-collapse:collapse;margin-bottom:18px;}
        th,td{border:1px solid #ddd;padding:6px 8px;}
        thead th{background:#f7f7f7;}
        .card{page-break-inside:avoid;margin-bottom:22px;}
      </style>
    `;
    const w = window.open('', '_blank');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>Trip Report</title>${css}<h1>Trip Report — Street List</h1>${rowsHtml}<script>onload=()=>print();</script>`);
    w.document.close();
  }

  // ===== Debug =====
  function printDebugSteps(){
    if (!S.results.length) { alert('No trips generated yet.'); return; }
    const cards = S.results.map((r) => {
      const steps = r.route.steps || [];
      const rows = steps.map((st, i) => {
        const nameField = normalizeName(st?.name || st?.road || '');
        const chosen = stepNameNatural(st) || '(generic)';
        const instr = cleanHtml(st?.instruction || '');
        const distKm = ((st?.distance || 0) / 1000).toFixed(3);
        return `<tr>
          <td style="text-align:right">${i}</td>
          <td style="text-align:right">${distKm}</td>
          <td>${nameField}</td>
          <td>${chosen}</td>
          <td>${instr}</td>
        </tr>`;
      }).join('');
      return `
        <div class="card">
          <h2>Debug — ${r.dest.label || (r.dest.lon+','+r.dest.lat)}</h2>
          <table>
            <thead><tr>
              <th style="text-align:right">#</th>
              <th style="text-align:right">km</th>
              <th>step.name</th>
              <th>chosen name</th>
              <th>instruction (raw)</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }).join('');
    const css = `
      <style>
        body{font:13px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;}
        h1{font-size:18px;margin:16px 0;}
        h2{font-size:15px;margin:12px 0 8px;}
        table{width:100%;border-collapse:collapse;margin-bottom:18px;}
        th,td{border:1px solid #ddd;padding:4px 6px;vertical-align:top;}
        thead th{background:#f7f7f7;}
        .card{page-break-inside:avoid;margin-bottom:22px;}
        td:nth-child(3), td:nth-child(4) {white-space:nowrap;}
      </style>
    `;
    const w = window.open('', '_blank');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>Debug Steps</title>${css}<h1>OpenRouteService — Raw Steps</h1>${cards}<script>onload=()=>print();</script>`);
    w.document.close();
  }

  // ===== Controls & Init =====
  const GeneratorControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const el = L.DomUtil.create('div', 'routing-control');
      el.innerHTML = `
        <div class="routing-header"><strong>Routing</strong></div>
        <div class="routing-actions" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          <button id="rt-generate">Generate Trips</button>
          <button id="rt-clear" class="ghost">Clear</button>
          <button id="rt-print" disabled>Print Report</button>
          <button id="rt-debug" class="ghost" disabled>Debug Steps</button>
          <button id="rt-toggle-highways" class="ghost">Highways: ON</button>
          <button id="rt-pz" class="ghost">PZ report</button>
        </div>
        <details>
          <summary><strong>Keys</strong></summary>
          <div class="routing-card">
            <label for="rt-keys" style="font-weight:600;">OpenRouteService key(s)</label>
            <input id="rt-keys" type="text" placeholder="KEY1,KEY2 (comma-separated)">
            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:6px;">
              <button id="rt-save">Save Keys</button>
              <button id="rt-url" class="ghost">Use ?orsKey</button>
            </div>
            <small class="routing-hint">Priority: ?orsKey → saved → inline fallback. Keys auto-rotate on 401/429.</small>
          </div>
        </details>`;
      L.DomEvent.disableClickPropagation(el);
      return el;
    }
  });

  function wireControls(){
    const g = byId('rt-generate');
    const c = byId('rt-clear');
    const p = byId('rt-print');
    const d = byId('rt-debug');
    const t = byId('rt-toggle-highways');
    const z = byId('rt-pz');
    const s = byId('rt-save');
    const u = byId('rt-url');
    const inp = byId('rt-keys');

    if (g) g.onclick = () => generate();
    if (c) c.onclick = () => clearAll();
    if (p) p.onclick = () => printReport();
    if (d) d.onclick = () => printDebugSteps();
    if (t) t.onclick = () => {
      S.highwaysOn = !S.highwaysOn;
      t.textContent = `Highways: ${S.highwaysOn ? 'ON' : 'OFF'}`;
      updateCenterlineLayer();
    };
    if (z) z.onclick = () => pzReport();

    if (s && inp) s.onclick = () => {
      const arr = inp.value.split(',').map(x => x.trim()).filter(Boolean);
      localStorage.setItem(LS_KEYS, JSON.stringify(arr));
      hydrateKeys();
      alert(`Saved ${S.keys.length} key(s).`);
    };
    if (u) u.onclick = () => {
      const k = qParam('orsKey');
      if (!k) alert('Add ?orsKey=YOUR_KEY to the URL query.');
      else { localStorage.setItem(LS_KEYS, JSON.stringify([k])); hydrateKeys(); alert('Using orsKey from URL.'); }
    };
  }

  async function innerInit(map){
    S.map = map;
    hydrateKeys();
    if (!S.group) S.group = L.layerGroup().addTo(map);
    map.addControl(new GeneratorControl());
    setTimeout(wireControls, 0);

    S.highwayFeatures = await HighwayResolver.loadFirstAvailable(HIGHWAY_URLS);
    updateCenterlineLayer();
  }

  const Routing = {
    init(map){
      if (!map || !map._loaded){
        const retry = () => (map && map._loaded) ? innerInit(map) : setTimeout(retry, 80);
        return retry();
      }
      innerInit(map);
    }
  };

  global.Routing = Routing;

  document.addEventListener('DOMContentLoaded', () => {
    const tryInit = () => {
      if (global.map && (global.map._loaded || global.map._size)) Routing.init(global.map);
      else setTimeout(tryInit, 80);
    };
    tryInit();
  });
})(window);
