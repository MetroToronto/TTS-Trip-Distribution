/* routing.js — Trip generation with PD/PZ mode switch
   - ORS Directions v2 routing.
   - Stable NB/EB/SB/WB with 100 m ramp buffer on highways.
   - Optional highway name fallback from local centerlines; overlay toggle.
   - Generate Trips works in 2 modes:
       * PD mode: same as before (selected PDs)
       * PZ mode: routes to zones (selected zones via getSelectedPZTargets()
                 or, if not available, all zone polygons inside exactly one selected PD)
   - PZ Report button is still available (zones for one PD, printable).
   - Robust guards & fixes from previous iteration included.
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
  const RAMP_SKIP_M            = 100;   // skip first 100 m for ramps
  const PER_REQUEST_DELAY      = 80;

  const PROFILE    = 'driving-car';
  const PREFERENCE = 'fastest';
  const ORS_BASE   = 'https://api.openrouteservice.org';

  const COLOR_FIRST  = '#0b3aa5';
  const COLOR_OTHERS = '#2166f3';
  const CENTERLINE_COLOR = '#ff0080';

  // Optional highway centerlines (if present)
  const HIGHWAY_URLS = [
    'data/highway_centerlines_wgs84.geojson',
    'data/highway_centrelines.json',
    'data/highway_centerlines.json',
    'data/toronto_highways.geojson'
  ];

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
    highwayLayer:null,
    resultsRouteCoordsRef:null,
    mode:'PD',          // 'PD' | 'PZ'
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

  // ===== Highway resolver (optional) =====
  const HighwayResolver = (() => {
    function isHighwayLabel(label){
      const s = String(label || '').toUpperCase();
      return /(^|\b)(HWY|HIGHWAY|PARKWAY|EXPRESSWAY|QEW|DVP|DON VALLEY|GARDINER|ALLEN|BLACK CREEK|401|404|427|409|410|403|407)\b/.test(s);
    }
    function labelFromProps(props){
      return normalizeName(props?.Name || props?.name || props?.official_name || props?.short || props?.ref);
    }
    function pointSegDistM(p, a, b){
      const kx = 111320 * Math.cos(toRad((a[1]+b[1])/2));
      const ky = 110540;
      const ax = a[0]*kx, ay=a[1]*ky, bx=b[0]*kx, by=b[1]*ky, px=p[0]*kx, py=p[1]*ky;
      const vx = bx-ax, vy = by-ay, wx = px-ax, wy = py-ay;
      const c1 = vx*wx + vy*wy, c2 = vx*vx + vy*vy;
      const t = c2 ? Math.max(0, Math.min(1, c1/c2)) : 0;
      const nx=ax+t*vx, ny=ay+t*vy, dx=px-nx, dy=py-ny;
      return Math.sqrt(dx*dx + dy*dy);
    }
    function bestLabelForSegment(features, segCoords){
      if (!features?.length || !segCoords || segCoords.length < 2) return '';
      const sampled = resampleByDistance(segCoords, SAMPLE_EVERY_M);
      const tallies = new Map();
      for (const p of sampled){
        let best = { d: 1e12, label: '' };
        for (const f of features){
          const cs = f.coords;
          for (let i=1;i<cs.length;i++){
            const d = pointSegDistM(p, cs[i-1], cs[i]);
            if (d < best.d){ best = { d, label: f.label }; }
          }
        }
        if (best.label && best.d <= MATCH_BUFFER_M){
          const t = tallies.get(best.label) || { near:0, sum:0 };
          t.near++; t.sum += best.d;
          tallies.set(best.label, t);
        }
      }
      let winner = '', wNear=0, wMean=1e12;
      for (const [label, t] of tallies){ if (t.near > wNear){ winner=label; wNear=t.near; wMean=t.sum/t.near; } }
      const share = sampled.length ? (wNear/sampled.length) : 0;
      if (winner && share>=CONF_REQ_SHARE && wMean<=CONF_REQ_MEAN_M && isHighwayLabel(winner)) return winner;
      return '';
    }
    async function loadFirstAvailable(urls){
      for (const url of urls){
        try {
          const res = await fetch(url, { cache:'no-store' });
          if (!res.ok) continue;
          const data = await res.json();
          const arr = [];
          if (Array.isArray(data?.features)){
            for (const f of data.features){
              const g = f.geometry||{}, p=f.properties||{};
              const label = labelFromProps(p);
              if (!label || !isHighwayLabel(label)) continue;
              if (g.type==='LineString') arr.push({ label, coords: g.coordinates });
              else if (g.type==='MultiLineString') (g.coordinates||[]).forEach(cs=>arr.push({ label, coords: cs }));
            }
          }
          if (arr.length) return arr;
        } catch {}
      }
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
      headers: { Authorization: currentKey(), ...(method!=='GET' && {'Content-Type':'application/json'}) },
      body: method==='GET'?undefined:JSON.stringify(body)
    });
    if ([401,403,429].includes(res.status) && rotateKey()){
      await sleep(150);
      return orsFetch(path, { method, body }, attempt+1);
    }
    if (res.status===500 && attempt<1){
      await sleep(200);
      return orsFetch(path, { method, body }, attempt+1);
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
    const body = {
      coordinates: [o, d], preference: PREFERENCE,
      instructions: true, instructions_format: 'html',
      language: 'en', geometry_simplify: false, elevation: false, units: 'km'
    };
    try { return await orsFetch(`/v2/directions/${PROFILE}/geojson`, { method:'POST', body }); }
    catch (e) {
      const msg = String(e.message||'');
      const is2099 = msg.includes('ORS 500') && (msg.includes('"code":2099') || msg.includes('code:2099'));
      if (!is2099) throw e;
      const dSwap = sanitizeLonLat([d[1], d[0]]);
      return await orsFetch(`/v2/directions/${PROFILE}/geojson`, { method:'POST', body:{...body, coordinates:[o,dSwap]} });
    }
  }

  // ===== Movement / direction =====
  function sliceCoords(full, i0, i1){
    const s = Math.max(0, Math.min(i0, full.length-1));
    const e = Math.max(0, Math.min(i1, full.length-1));
    return e<=s ? full.slice(s, s+1) : full.slice(s, e+1);
  }
  function cutAfterDistance(coords, startIdx, endIdx, metersToSkip){
    if (metersToSkip<=0) return startIdx;
    let acc=0;
    for (let i=startIdx+1;i<=endIdx;i++){
      acc += haversineMeters(coords[i-1], coords[i]);
      if (acc >= metersToSkip) return i;
    }
    return endIdx;
  }
  function stableBoundForStep(fullCoords, waypoints, limitM = BOUND_LOCK_WINDOW_M){
    if (!Array.isArray(waypoints) || waypoints.length!==2) return '';
    const [w0,w1] = waypoints;
    const s = Math.max(0, Math.min(w0, fullCoords.length-1));
    const e = Math.max(0, Math.min(w1, fullCoords.length-1));
    if (e<=s+1) return '';
    let acc=0, cut=s+1;
    for (let i=s+1;i<=e;i++){
      acc += haversineMeters(fullCoords[i-1], fullCoords[i]);
      if (acc >= limitM){ cut=i; break; }
    }
    const seg = fullCoords.slice(s, Math.max(cut, s+1)+1);
    const samples = resampleByDistance(seg, 50);
    if (samples.length<2) return '';
    const bearings=[]; for (let i=1;i<samples.length;i++) bearings.push(bearingDeg(samples[i-1], samples[i]));
    return boundFrom(circularMean(bearings));
  }
  function wholeStepBound(seg){
    const s = resampleByDistance(seg, 50);
    if (s.length<2) return '';
    const bearings=[]; for (let i=1;i<s.length;i++) bearings.push(bearingDeg(s[i-1], s[i]));
    return boundFrom(circularMean(bearings));
  }

  // ===== Highway alias grouping =====
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
    const out=[]; let i=0;
    while (i < rows.length){
      const r = rows[i]; if (!r){ i++; continue; }
      const key = canonicalHighwayKey(r.name);
      if (!key){ out.push(r); i++; continue; }
      let j=i, kmByDir=new Map(), kmTotal=0, bestName=r.name, bestKm=r.km||0;
      while (j<rows.length){
        const rij = rows[j]; if (!rij){ j++; continue; }
        const kj = canonicalHighwayKey(rij.name);
        if (!kj || kj.key!==key.key) break;
        kmTotal += (rij.km||0);
        kmByDir.set(rij.dir||'', (kmByDir.get(rij.dir||'')||0)+(rij.km||0));
        if ((rij.km||0) > bestKm){ bestKm=rij.km||0; bestName=rij.name; }
        j++;
      }
      let domDir='', domKm=-1; for (const [d,km] of kmByDir.entries()){ if (km>domKm){ domKm=km; domDir=d; } }
      out.push({ dir: domDir, name: bestName, km:+kmTotal.toFixed(2) });
      i=j;
    }
    return out;
  }

  // ===== Build movements =====
  function buildMovementsFromDirections(coords, steps){
    if (!coords?.length || !steps?.length) return [];
    const rows = [];

    const pushRow = (name, i0, i1, isHighwayStep=false) => {
      const nm = normalizeName(name); if (!nm) return;
      const seg = sliceCoords(coords, i0, i1); if (seg.length<2) return;
      let meters=0; for (let i=1;i<seg.length;i++) meters += haversineMeters(seg[i-1], seg[i]);
      if (meters < MIN_FRAGMENT_M) return;

      let dir='';
      if (isHighwayStep){
        const cut = cutAfterDistance(coords, i0, i1, RAMP_SKIP_M);
        const segAfter = sliceCoords(coords, cut, i1);
        dir = stableBoundForStep(coords, [cut, i1], BOUND_LOCK_WINDOW_M) || wholeStepBound(segAfter);
      } else {
        dir = stableBoundForStep(coords, [i0,i1], BOUND_LOCK_WINDOW_M) || wholeStepBound(seg);
      }
      rows.push({ dir, name: nm, km:+(meters/1000).toFixed(2) });
    };

    for (let i=0;i<steps.length;i++){
      const st = steps[i] || {};
      const wp = st.way_points || st.wayPoints || st.waypoints || [0,0];
      const [i0=0,i1=0] = wp;
      let name = stepNameNatural(st);
      const instr = cleanHtml(st?.instruction||'');
      const isGeneric = !name && GENERIC_REGEX.test(instr);

      let isHighwayStep = false;
      if (S.highwaysOn && (!name || isGeneric)){
        const cut = cutAfterDistance(S.resultsRouteCoordsRef||[], i0, i1, RAMP_SKIP_M);
        const segAfter = sliceCoords(S.resultsRouteCoordsRef||[], cut, i1);
        const label = HighwayResolver.bestLabelForSegment(S.highwayFeatures, segAfter.length?segAfter:sliceCoords(S.resultsRouteCoordsRef||[], i0, i1));
        if (label){ name = label; isHighwayStep = true; }
      }
      if (!name) name = normalizeName(instr);
      pushRow(name, i0, i1, isHighwayStep);
    }
    return mergeConsecutiveSameCorridor(rows).filter(Boolean);
  }

  // ===== Map helpers =====
  function clearAll(){
    S.results = [];
    if (S.group) S.group.clearLayers();
    const btn = byId('rt-print'); if (btn) btn.disabled = true;
    const db  = byId('rt-debug'); if (db) db.disabled  = true;
  }
  function drawRoute(coords, color){
    if (!coords?.length) return;
    if (!S.group) S.group = L.layerGroup().addTo(S.map);
    L.polyline(coords.map(([lng,lat])=>[lat,lng]), { color, weight:4, opacity:0.9 }).addTo(S.group);
  }
  function updateCenterlineLayer(){
    if (S.highwayLayer){ try{ S.map.removeLayer(S.highwayLayer); }catch{} S.highwayLayer=null; }
    if (!S.highwaysOn || !S.highwayFeatures.length) return;
    const grp = L.layerGroup();
    for (const f of S.highwayFeatures){
      const latlngs = f.coords.map(([lon,lat])=>[lat,lon]);
      L.polyline(latlngs, { color:CENTERLINE_COLOR, weight:2, opacity:0.45, dashArray:'6,6' }).addTo(grp);
    }
    S.highwayLayer = grp.addTo(S.map);
  }

  // Harvest ANY polygon features already on the map
  function harvestPolygonsFromMap(){
    const polys = [];
    if (!S.map || !S.map._layers) return polys;

    const pushFeat = (f) => {
      if (!f || f.type!=='Feature') return;
      const g = f.geometry; if (!g) return;
      if (g.type==='Polygon' || g.type==='MultiPolygon') polys.push({ type:'Feature', geometry:g, properties: (f.properties||{}) });
    };

    Object.values(S.map._layers).forEach(layer=>{
      if (!layer) return;
      if (layer.feature) pushFeat(layer.feature);
      if (typeof layer.toGeoJSON === 'function'){
        try{
          const gj = layer.toGeoJSON();
          if (gj){
            if (Array.isArray(gj.features)) gj.features.forEach(pushFeat);
            else pushFeat(gj);
          }
        }catch{}
      }
      if (typeof layer.eachLayer === 'function'){
        try { layer.eachLayer(l => { if (l && l.feature) pushFeat(l.feature); }); } catch {}
      }
    });

    return polys;
  }

  // Basic geometry helpers
  function centroidWGS84(geom){
    function ringCentroid(coords){
      let area=0, x=0, y=0; const pts=coords[0]; if (!pts || pts.length<3) return null;
      for (let i=0;i<pts.length-1;i++){
        const [x0,y0]=pts[i], [x1,y1]=pts[i+1];
        const a=x0*y1 - x1*y0; area+=a; x+=(x0+x1)*a; y+=(y0+y1)*a;
      }
      area*=0.5; if (Math.abs(area)<1e-12) return null; return [x/(6*area), y/(6*area)];
    }
    if (!geom) return null;
    if (geom.type==='Polygon') return ringCentroid(geom.coordinates);
    if (geom.type==='MultiPolygon'){ for (const p of geom.coordinates){ const c=ringCentroid(p); if (c) return c; } }
    return null;
  }
  function pointInPolygon(pt, geom){
    const [x,y]=pt;
    const inRing=(ring)=>{
      let inside=false;
      for (let i=0,j=ring.length-1;i<ring.length;j=i++){
        const xi=ring[i][0], yi=ring[i][1], xj=ring[j][0], yj=ring[j][1];
        const intersect=((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/(yj-yi + 1e-20)+xi);
        if (intersect) inside=!inside;
      }
      return inside;
    };
    if (geom.type==='Polygon'){
      const rings=geom.coordinates||[]; if (!rings.length) return false;
      if (!inRing(rings[0])) return false;
      for (let k=1;k<rings.length;k++){ if (inRing(rings[k])) return false; }
      return true;
    }
    if (geom.type==='MultiPolygon'){
      for (const poly of geom.coordinates){
        if (!poly.length) continue;
        if (inRing(poly[0])) {
          let hole=false;
          for (let k=1;k<poly.length;k++){ if (inRing(poly[k])) { hole=true; break; } }
          if (!hole) return true;
        }
      }
    }
    return false;
  }

  // ===== Mode helpers =====
  function parsePDIdFromLabel(lbl){
    const m = String(lbl||'').match(/\bPD\s*([0-9]+)\b/i);
    return m ? m[1] : null;
  }
  function pickProp(obj, keys, fallback){
    for (const k of keys){ if (obj && obj[k]!=null && obj[k]!=='' ) return obj[k]; }
    return fallback;
  }
  function looksLikePDFeature(f){
    const p = f.properties || {};
    const joined = Object.keys(p).join('|').toLowerCase();
    return /pd|district|planning/.test(joined);
  }
  function looksLikeZoneFeature(f){
    const p = f.properties || {};
    const joined = Object.keys(p).join('|').toLowerCase();
    return /zone/.test(joined) || 'tts' in p || 'id' in p || true;
  }
  function guessZoneLabel(props, idx){
    const k = pickProp(props, ['ZONE','ZONE_ID','TTS_ZONE','TTS','ID','Name','name','label'], null);
    return (k!=null && k!=='') ? String(k) : `Zone ${idx+1}`;
  }
  function findSelectedPDPolygon(pdId, selectedPointLonLat){
    const polys = harvestPolygonsFromMap();
    let byProp = polys.find(f=>{
      if (!looksLikePDFeature(f)) return false;
      const p = f.properties||{};
      const val = pickProp(p, ['PD','PD_ID','PDID','DISTRICT','PlanningDistrict','PD_NAME','name','label'], null);
      if (val==null) return false;
      const clean = String(val).trim().replace(/^PD\s*/i,'');
      return clean === String(pdId);
    });
    if (byProp) return byProp.geometry;
    if (selectedPointLonLat){
      const pt = sanitizeLonLat(selectedPointLonLat);
      const container = polys.find(f => looksLikePDFeature(f) && pointInPolygon(pt, f.geometry));
      if (container) return container.geometry;
    }
    return null;
  }

  // ===== Generate Trips (mode aware) =====
  async function generate(){
    let originLonLat;
    try { originLonLat = getOriginLonLat(); }
    catch (e) { alert('Origin has invalid coordinates. Please re-select the address.'); return; }

    setBusy(true); clearAll();

    try {
      // ----- Mode: PZ -----
      if (S.mode === 'PZ') {
        // Best case: zones are explicitly selected by your UI
        let zoneTargets = [];
        if (typeof global.getSelectedPZTargets === 'function') {
          const raw = await Promise.resolve(global.getSelectedPZTargets()) || [];
          raw.forEach((t,i)=>{
            try{
              if (Array.isArray(t)) {
                const p = sanitizeLonLat([t[0],t[1]]);
                zoneTargets.push({ lon:p[0], lat:p[1], label: t[2] ?? `Zone ${i+1}` });
              } else if (t && typeof t==='object'){
                const p = sanitizeLonLat([t.lon ?? t.lng ?? t.x, t.lat ?? t.y]);
                zoneTargets.push({ lon:p[0], lat:p[1], label: t.label ?? t.name ?? `Zone ${i+1}` });
              }
            }catch{}
          });
        }

        // Fallback: harvest zones within exactly one selected PD
        if (!zoneTargets.length) {
          const pdSel = (global.getSelectedPDTargets && global.getSelectedPDTargets()) || [];
          if (pdSel.length !== 1) {
            alert('PZ mode: select exactly one PD, or provide selected zones via getSelectedPZTargets().');
            setBusy(false);
            return;
          }
          const one = pdSel[0];
          const label = Array.isArray(one) ? (one[2] || '') : (one.label || one.name || '');
          const pdId = parsePDIdFromLabel(label) || one.pdId || one.PD || one.PD_ID;
          if (!pdId) { alert('PZ mode: could not determine PD id.'); setBusy(false); return; }

          const selectedPDPoint = Array.isArray(one)
            ? sanitizeLonLat([one[0], one[1]])
            : sanitizeLonLat([one.lon ?? one.lng ?? one.x, one.lat ?? one.y]);

          const pdGeom = findSelectedPDPolygon(String(pdId), selectedPDPoint);
          if (!pdGeom){ alert('PZ mode: PD boundary not found on the map.'); setBusy(false); return; }

          const allPolys = harvestPolygonsFromMap().filter(looksLikeZoneFeature);
          for (let i=0;i<allPolys.length;i++){
            const f = allPolys[i];
            const c = centroidWGS84(f.geometry); if (!c) continue;
            const lonlat = sanitizeLonLat([c[0], c[1]]);
            if (pointInPolygon(lonlat, pdGeom)){
              const labelZ = guessZoneLabel(f.properties||{}, i);
              zoneTargets.push({ lon: lonlat[0], lat: lonlat[1], label: labelZ });
            }
          }
          if (!zoneTargets.length){ alert('PZ mode: no zones found inside the selected PD on the map.'); setBusy(false); return; }
        }

        // Route to all zone targets
        for (let idx=0; idx<zoneTargets.length; idx++){
          const z = zoneTargets[idx];
          const json = await getRoute(originLonLat, [z.lon, z.lat]);
          const feat  = json.features?.[0];
          const coords = feat?.geometry?.coordinates || [];
          const steps  = feat?.properties?.segments?.[0]?.steps || [];
          S.resultsRouteCoordsRef = coords;

          S.results.push({ dest:{ lon:z.lon, lat:z.lat, label:z.label }, route:{ coords, steps }});
          drawRoute(coords, idx===0 ? COLOR_FIRST : COLOR_OTHERS);
          await sleep(PER_REQUEST_DELAY);
        }

        // Enable buttons
        const printBtn = byId('rt-print'); if (printBtn) printBtn.disabled=false;
        const debugBtn = byId('rt-debug'); if (debugBtn) debugBtn.disabled=false;
        setBusy(false);
        return;
      }

      // ----- Mode: PD (unchanged behavior) -----
      const rawTargets = (global.getSelectedPDTargets && global.getSelectedPDTargets()) || [];
      const targets = [];
      (rawTargets||[]).forEach((t,i)=>{
        try{
          if (Array.isArray(t)) targets.push([sanitizeLonLat([t[0],t[1]])[0], sanitizeLonLat([t[0],t[1]])[1], t[2]??`PD ${i+1}`]);
          else if (t && typeof t==='object'){
            const p = sanitizeLonLat([t.lon ?? t.lng ?? t.x, t.lat ?? t.y]);
            targets.push([p[0], p[1], t.label ?? t.name ?? `PD ${i+1}`]);
          }
        }catch{}
      });
      if (!targets.length){ alert('PD mode: select at least one PD with valid coordinates.'); setBusy(false); return; }

      for (let idx=0; idx<targets.length; idx++){
        const [lon,lat,label] = targets[idx];
        const json = await getRoute(originLonLat, [lon,lat]);
        const feat  = json.features?.[0];
        const coords = feat?.geometry?.coordinates || [];
        const steps  = feat?.properties?.segments?.[0]?.steps || [];
        S.resultsRouteCoordsRef = coords;

        S.results.push({ dest:{lon,lat,label}, route:{coords,steps} });
        drawRoute(coords, idx===0 ? COLOR_FIRST : COLOR_OTHERS);
        await sleep(PER_REQUEST_DELAY);
      }
      const printBtn = byId('rt-print'); if (printBtn) printBtn.disabled=false;
      const debugBtn = byId('rt-debug'); if (debugBtn) debugBtn.disabled=false;

    } catch(e){
      alert('Routing error: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  function setBusy(b){
    const g = byId('rt-generate');
    if (g){ g.disabled=b; g.textContent = b ? `Generating… (${S.mode})` : 'Generate Trips'; }
  }

  // ===== PZ report (unchanged; keeps one-PD rule) =====
  async function pzReport(){
    const pdTargets = (global.getSelectedPDTargets && global.getSelectedPDTargets()) || [];
    if (!pdTargets.length) { alert('Please select exactly one PD to run a PZ report.'); return; }
    if (pdTargets.length > 1) { alert('Only one PD can be selected for a PZ report.'); return; }

    const one = pdTargets[0];
    const label = Array.isArray(one) ? (one[2] || '') : (one.label || one.name || '');
    const pdId = parsePDIdFromLabel(label) || one.pdId || one.PD || one.PD_ID;
    if (!pdId) { alert('Could not determine the PD id for the selection.'); return; }

    const selectedPDPoint = Array.isArray(one)
      ? sanitizeLonLat([one[0], one[1]])
      : sanitizeLonLat([one.lon ?? one.lng ?? one.x, one.lat ?? one.y]);

    let originLonLat;
    try { originLonLat = getOriginLonLat(); }
    catch (e) { alert('Origin has invalid coordinates. Please re-select the address.'); return; }

    const pdGeom = findSelectedPDPolygon(String(pdId), selectedPDPoint);
    if (!pdGeom){ alert('PZ report error: PD boundary not found on the map.'); return; }

    const allPolys = harvestPolygonsFromMap().filter(looksLikeZoneFeature);

    const zoneTargets = [];
    for (let i=0;i<allPolys.length;i++){
      const f = allPolys[i];
      const c = centroidWGS84(f.geometry); if (!c) continue;
      const lonlat = sanitizeLonLat([c[0], c[1]]);
      if (pointInPolygon(lonlat, pdGeom)){
        const labelZ = guessZoneLabel(f.properties||{}, zoneTargets.length);
        zoneTargets.push({ lon: lonlat[0], lat: lonlat[1], label: labelZ });
      }
    }
    if (!zoneTargets.length){ alert('PZ report error: No zones found inside the selected PD on the map.'); return; }

    setBusy(true);
    try{
      const results = [];
      for (let i=0;i<zoneTargets.length;i++){
        const z = zoneTargets[i];
        const json  = await getRoute(originLonLat, [z.lon, z.lat]);
        const feat  = json.features?.[0];
        const coords = feat?.geometry?.coordinates || [];
        const steps  = feat?.properties?.segments?.[0]?.steps || [];
        S.resultsRouteCoordsRef = coords;

        results.push({ dest:{ lon:z.lon, lat:z.lat, label:z.label }, route:{ coords, steps }});
        await sleep(PER_REQUEST_DELAY);
      }

      const cards = results.map((r) => {
        const mov = (buildMovementsFromDirections(r.route.coords, r.route.steps) || []).filter(m=>m && m.name);
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
        </style>`;
      const w = window.open('', '_blank');
      w.document.write(`<!doctype html><meta charset="utf-8"><title>PZ Report — PD ${pdId}</title>${css}<h1>PZ Report — PD ${pdId}</h1>${cards}<script>onload=()=>print();</script>`);
      w.document.close();
    } catch(e){
      alert('PZ report error: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  // ===== Reports / Debug =====
  function km2(n){ return (n||0).toFixed(2); }
  function printReport(){
    if (!S.results.length) { alert('No trips generated yet.'); return; }
    const rowsHtml = S.results.map((r) => {
      const mov = (buildMovementsFromDirections(r.route.coords, r.route.steps) || []).filter(m=>m && m.name);
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
      </style>`;
    const w = window.open('', '_blank');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>Trip Report</title>${css}<h1>Trip Report — Street List</h1>${rowsHtml}<script>onload=()=>print();</script>`);
    w.document.close();
  }
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
      </style>`;
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
          <button id="rt-mode" class="ghost">Mode: PD</button>
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
    const m = byId('rt-mode');
    const g = byId('rt-generate');
    const c = byId('rt-clear');
    const p = byId('rt-print');
    const d = byId('rt-debug');
    const t = byId('rt-toggle-highways');
    const z = byId('rt-pz');
    const s = byId('rt-save');
    const u = byId('rt-url');
    const inp = byId('rt-keys');

    if (m) m.onclick = () => { S.mode = (S.mode === 'PD') ? 'PZ' : 'PD'; m.textContent = `Mode: ${S.mode}`; };
    if (g) g.onclick = () => generate();
    if (c) c.onclick = () => clearAll();
    if (p) p.onclick = () => printReport();
    if (d) d.onclick = () => printDebugSteps();
    if (t) t.onclick = () => { S.highwaysOn = !S.highwaysOn; t.textContent = `Highways: ${S.highwaysOn ? 'ON' : 'OFF'}`; updateCenterlineLayer(); };
    if (z) z.onclick = () => pzReport();

    if (s && inp) s.onclick = () => {
      const arr = inp.value.split(',').map(x=>x.trim()).filter(Boolean);
      localStorage.setItem(LS_KEYS, JSON.stringify(arr)); hydrateKeys(); alert(`Saved ${S.keys.length} key(s).`);
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

    // Optional highway centerlines (if file exists)
    try { S.highwayFeatures = await HighwayResolver.loadFirstAvailable(HIGHWAY_URLS); }
    catch { S.highwayFeatures = []; }
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
