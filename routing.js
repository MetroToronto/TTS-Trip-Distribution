/* routing.js — ORS Directions (1x/PD) + Snap v2 (road) for movements
 * Origin is provided by the top geocoder via window.ROUTING_ORIGIN (script.js).
 * Keys: inline fallback, ?orsKey=K1,K2 override, or saved in localStorage.
 */
(function (global) {
  // ===== Config =====
  const INLINE_DEFAULT_KEY =
    'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=';

  const PROFILE = 'driving-car';
  const PREFERENCE = 'fastest';
  const THROTTLE_MS_DIRECTIONS = 1200; // keep < 40 req/min
  const SNAP_BATCH_SIZE = 200;         // batch size per Snap request
  const SAMPLE_EVERY_M = 50;           // spacing for polyline sampling (movements)

  const COLOR_FIRST  = '#0b3aa5';
  const COLOR_OTHERS = '#2166f3';

  const ORS_BASE = 'https://api.openrouteservice.org';

  const LS_KEYS = 'ORS_KEYS';
  const LS_ACTIVE_INDEX = 'ORS_ACTIVE_INDEX';

  // ===== State =====
  const S = {
    map: null,
    group: null,
    keys: [],
    keyIndex: 0,
    results: [], // [{label, lat, lon, km, min, steps[], assignments[], gj}]
    els: {}
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ===== Key helpers =====
  const parseUrlKeys = () => {
    const raw = new URLSearchParams(location.search).get('orsKey');
    return raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  };
  const loadKeys = () => {
    const u = parseUrlKeys(); if (u.length) return u;
    try {
      const ls = JSON.parse(localStorage.getItem(LS_KEYS) || '[]');
      if (Array.isArray(ls) && ls.length) return ls;
    } catch {}
    return [INLINE_DEFAULT_KEY];
  };
  const saveKeys = (arr) => localStorage.setItem(LS_KEYS, JSON.stringify(arr));
  const setIndex = (i) => { S.keyIndex = Math.max(0, Math.min(i, S.keys.length - 1)); localStorage.setItem(LS_ACTIVE_INDEX, String(S.keyIndex)); };
  const getIndex = () => Number(localStorage.getItem(LS_ACTIVE_INDEX) || 0);
  const currentKey = () => S.keys[S.keyIndex];
  const rotateKey   = () => (S.keys.length > 1 ? (setIndex((S.keyIndex + 1) % S.keys.length), true) : false);

  // ===== Map helpers =====
  const ensureGroup = () => { if (!S.group) S.group = L.layerGroup().addTo(S.map); };
  const clearAll = () => { if (S.group) S.group.clearLayers(); S.results = []; setReportEnabled(false); };
  const popup = (html, at) => {
    const ll = at || (S.map ? S.map.getCenter() : null);
    if (ll) L.popup().setLatLng(ll).setContent(html).openOn(S.map);
    else alert(html.replace(/<[^>]+>/g, ''));
  };

  // Place Trip + Report under PD/Zones column after they exist
  function placeBelowPdAndZonesWithRetry() {
    const start = performance.now();
    const maxWaitMs = 2000;
    (function tick(){
      const geocoder = document.querySelector('.leaflet-control-geocoder');
      const column =
        geocoder?.closest('.leaflet-top.leaflet-left, .leaflet-top.leaflet-right') ||
        document.querySelector('.leaflet-top.leaflet-left');

      const trip   = document.querySelector('.routing-control.trip-card');
      const report = document.querySelector('.routing-control.report-card');

      const pdZones = Array.from(document.querySelectorAll('.pd-control'));
      const ready = column && trip && report && pdZones.length >= 2;

      if (ready) { column.appendChild(trip); column.appendChild(report); return; }
      if (performance.now() - start < maxWaitMs) return setTimeout(tick, 80);
      if (column) { if (trip) column.appendChild(trip); if (report) column.appendChild(report); }
    })();
  }

  // ===== ORS fetch helpers =====
  async function orsFetch(path, { method = 'GET', body, query } = {}) {
    const url = new URL(ORS_BASE + path);
    if (query) Object.entries(query).forEach(([k,v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString(), {
      method,
      headers: { Authorization: currentKey(), ...(method !== 'GET' && { 'Content-Type': 'application/json' }) },
      body: method === 'GET' ? undefined : JSON.stringify(body)
    });
    if ([401,403,429].includes(res.status)) {
      if (rotateKey()) return orsFetch(path, { method, body, query });
    }
    if (!res.ok) throw new Error(`ORS ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    return res.json();
  }

  // Directions v2
  async function getRoute(originLonLat, destLonLat) {
    return orsFetch(`/v2/directions/${PROFILE}/geojson`, {
      method: 'POST',
      body: {
        coordinates: [originLonLat, destLonLat],
        preference: PREFERENCE,
        instructions: true,
        instructions_format: 'html',
        language: 'en',
        units: 'km'
      }
    });
  }

  // ===== SNAP v2 (road) — send BOTH keys to be tenant-proof =====
  async function snapRoad(pointsArr) {
    // We send both { points: [...] } and { locations: [...] }.
    // Tenants ignore the extra key; this saves us from format mismatches.
    if (!pointsArr?.length) return [];
    const url = `${ORS_BASE}/v2/snap/road`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': currentKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: pointsArr, locations: pointsArr })
    });
    if ([401,403,429].includes(res.status) && rotateKey()) return snapRoad(pointsArr);
    if (!res.ok) {
      const t = await res.text().catch(()=> '');
      throw new Error(`Snap road ${res.status} ${t}`);
    }
    const json = await res.json();
    return Array.isArray(json?.features) ? json.features : [];
  }

  // ===== Geometry / Sampling / Headings =====
  function toRad(d){ return d*Math.PI/180; }
  function toDeg(r){ return r*180/Math.PI; }
  function haversineMeters(a,b){
    const R=6371000;
    const [lng1,lat1]=[a[0],a[1]], [lng2,lat2]=[b[0],b[1]];
    const dLat=toRad(lat2-lat1), dLng=toRad(lng2-lng1);
    const s=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
    return 2*R*Math.asin(Math.sqrt(s));
  }

  // Sample and also remember the *approximate* polyline index when the sample was emitted.
  function sampleLineWithIndex(coords, stepM){
    if (!coords || coords.length<2) return { pts: coords||[], idx: coords?.map((_,i)=>i)||[] };
    const pts=[coords[0]], idx=[0];
    let acc=0;
    for (let i=1;i<coords.length;i++){
      const seg=haversineMeters(coords[i-1], coords[i]);
      acc+=seg;
      if (acc>=stepM){ pts.push(coords[i]); idx.push(i); acc=0; }
    }
    if (pts[pts.length-1]!==coords[coords.length-1]) { pts.push(coords[coords.length-1]); idx.push(coords.length-1); }
    return { pts, idx };
  }

  function bearingDeg(a,b){
    const [lng1,lat1]=[toRad(a[0]),toRad(a[1])], [lng2,lat2]=[toRad(b[0]),toRad(b[1])];
    const y=Math.sin(lng2-lng1)*Math.cos(lat2);
    const x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(lng2-lng1);
    return (toDeg(Math.atan2(y,x))+360)%360;
  }
  function cardinal4(deg){
    if (deg>=315||deg<45) return "NB";
    if (deg<135) return "EB";
    if (deg<225) return "SB";
    return "WB";
  }

  // ===== Directions HTML fallback parser =====
  function nameFromInstructionHTML(instrHTML = '', prevName = '') {
    if (!instrHTML) return '';
    const div = document.createElement('div');
    div.innerHTML = instrHTML;
    const candidates = Array.from(div.querySelectorAll('b,strong,abbr,span'))
      .map(el => String(el.textContent || '').trim())
      .filter(Boolean);
    if (candidates.length) return candidates[candidates.length - 1];
    const text = (div.textContent || '').replace(/\s+/g,' ').trim();
    const pats = [
      /\bexit(?:\s+\d+)?\s+(?:onto|to)\s+([^,;.]+)\b/i,
      /\bramp(?:\s+to)?\s+([^,;.]+)\b/i,
      /\bmerge\s+(?:onto|to)\s+([^,;.]+)\b/i,
      /\bcontinue\s+(?:onto|on)\s+([^,;.]+)\b/i,
      /\bturn\s+(?:left|right)\s+(?:onto|to)\s+([^,;.]+)\b/i,
      /\bkeep\s+(?:left|right)\s+(?:onto|to)?\s*([^,;.]+)\b/i,
      /\bfollow\s+([^,;.]+)\b/i
    ];
    for (const re of pats) {
      const m = text.match(re);
      if (m && m[1]) return m[1].trim();
    }
    if (/^continue\b/i.test(text) && prevName) return prevName;
    return '';
  }

  // ===== Deep name extractor for Snap features =====
  function pickStreetNameDeep(props = {}) {
    const directKeys = ['name','road','street','way_name','label','ref','ref_name','display_name','official_name','loc_name','alt_name','signed_name','abbr','short_name','name:en','official_name:en'];
    const candidates = [];

    const push = (v, key='') => {
      if (!v) return;
      if (typeof v === 'string') {
        const s = v.trim();
        if (s) candidates.push([key.toLowerCase(), s]);
      }
    };

    for (const k of directKeys) push(props[k], k);

    const nests = [props.tags, props.properties, props.attrs, props.meta, props.edge, props.way, props.osm, props.segment, props.road];
    for (const obj of nests) if (obj && typeof obj === 'object') {
      for (const k of directKeys) push(obj[k], k);
      if (obj.ref && typeof obj.ref === 'string') push(obj.ref, 'ref');
    }

    const q = [];
    const pushObj = (o, depth=0) => {
      if (!o || typeof o !== 'object' || depth > 3) return;
      for (const [k,v] of Object.entries(o)) {
        if (typeof v === 'string' && /(name|street|road|way|label|ref)/i.test(k)) push(v, k);
        else if (typeof v === 'object') pushObj(v, depth+1);
      }
    };
    pushObj(props, 0);

    const norm = (s) => s
      .replace(/\s+/g,' ')
      .replace(/\b(hwy)\b/ig,'Highway')
      .replace(/\b(hwy)\s*(\d+)\b/ig,'Highway $2')
      .replace(/\b(st)\b\.?/ig,'Street')
      .replace(/\b(rd)\b\.?/ig,'Road')
      .replace(/\b(ave)\b\.?/ig,'Avenue')
      .trim();

    const scored = [];
    for (const [key, raw] of candidates) {
      let s = norm(raw);
      if (!s) continue;
      if (/^ON\s*\d+\b/i.test(s)) s = s.replace(/^ON\s*/i, 'Highway ');
      if (s.length > 80) continue;
      let score = 0;
      if (/name|street|road|way_name|label/.test(key)) score += 5;
      if (/ref/.test(key)) score += 2;
      if (/[A-Za-z]/.test(s)) score += 3;
      if (/^Highway\s*\d+/.test(s)) score += 2;
      if (/^\d+$/.test(s)) { s = `Highway ${s}`; score += 1; }
      scored.push({ s, score });
    }

    if (!scored.length) {
      if (props.ref && /^\d+[A-Z]?$/.test(String(props.ref))) return `Highway ${props.ref}`;
      return '';
    }

    scored.sort((a,b)=> b.score - a.score || b.s.length - a.s.length);
    return scored[0].s;
  }

  // ===== Movements from polyline (sample → snap → name → bound → merge) =====
  async function buildMovementsFromPolyline(coords, {
    sampleMeters = SAMPLE_EVERY_M,
    minMeters = 40,
    headingWindow = 1,
    stepFallbackObj = null // pass seg (so we have steps + way_points)
  } = {}) {
    const { pts: sampled, idx: sampledIdx } = sampleLineWithIndex(coords, sampleMeters);
    if (!sampled || sampled.length<2) return [];

    // Prepare step fallback mapping: way_point index -> instruction/name
    let stepsMeta = [];
    if (stepFallbackObj && Array.isArray(stepFallbackObj.steps)) {
      stepsMeta = stepFallbackObj.steps.map(s => ({
        from: (s.way_points?.[0] ?? 0),
        to:   (s.way_points?.[1] ?? 0),
        html: s.instruction || '',
        name: (s.name || '').trim()
      }));
    }

    const features = [];
    let unnamedSnapCount = 0;

    // Snap all samples in batches
    for (let i=0;i<sampled.length;i+=SNAP_BATCH_SIZE){
      const chunk = sampled.slice(i, i+SNAP_BATCH_SIZE);
      const feats = await snapRoad(chunk);
      // Pad/trim to chunk length
      if (feats.length < chunk.length) {
        for (let k=feats.length; k<chunk.length; k++) feats.push({});
      } else if (feats.length > chunk.length) {
        feats.length = chunk.length;
      }
      features.push(...feats);
    }

    // A helper to fallback to Directions step for a given sample index
    const nameFromStepsAt = (sampleIndex) => {
      if (!stepsMeta.length) return '';
      const coordIdx = sampledIdx[Math.max(0, Math.min(sampledIdx.length-1, sampleIndex))];
      const st = stepsMeta.find(s => coordIdx >= s.from && coordIdx <= s.to);
      if (!st) return '';
      return nameFromInstructionHTML(st.html, st.name) || st.name || '';
    };

    // Name + bound per consecutive sample pair
    const rows=[];
    let cur=null;
    const getHeading=(k)=>{
      const i1=Math.max(0, k-headingWindow);
      const i2=Math.min(sampled.length-1, k+1+headingWindow);
      return cardinal4(bearingDeg(sampled[i1], sampled[i2]));
    };

    for (let i=0;i<sampled.length-1;i++){
      const segDist=haversineMeters(sampled[i], sampled[i+1]);
      if (segDist<=0) continue;

      const props = features[i]?.properties || {};
      let name = pickStreetNameDeep(props);
      if (!name) {
        unnamedSnapCount++;
        name = nameFromStepsAt(i) || "(unnamed)";
      }
      const bound = getHeading(i);

      if (!cur){ cur={street:name, bound, distance_m:0}; }
      if (cur.street===name && cur.bound===bound){
        cur.distance_m += segDist;
      } else {
        if (cur.distance_m>=minMeters) rows.push({...cur, distance_m:Math.round(cur.distance_m)});
        cur={street:name, bound, distance_m:segDist};
      }
    }
    if (cur && cur.distance_m>=minMeters) rows.push({...cur, distance_m:Math.round(cur.distance_m)});

    // Second-pass merge in case of short jitter
    const merged=[];
    for (const r of rows){
      const last=merged[merged.length-1];
      if (last && last.street===r.street && last.bound===r.bound){
        last.distance_m += r.distance_m;
      } else merged.push({...r});
    }
    merged.forEach(r=>r.distance_m=Math.round(r.distance_m));

    // Debug: surface when your tenant returns few/zero names so we can see keys
    const unnamedRate = unnamedSnapCount / Math.max(1, sampled.length-1);
    if (unnamedRate > 0.7) {
      console.warn('[Routing] Snap names mostly empty (', Math.round(unnamedRate*100), '% ). Example properties:');
      for (let j=0; j<Math.min(5, features.length); j++){
        const p = features[j]?.properties;
        if (p) console.warn('Snap props sample #', j, JSON.parse(JSON.stringify(p)));
      }
    }

    return merged;
  }

  // ===== Drawing =====
  function drawRoute(geojson, color) {
    ensureGroup();
    const line = L.geoJSON(geojson, { style: { color, weight: 5, opacity: 0.9 } });
    S.group.addLayer(line);
    return line;
  }
  function addMarker(lat, lon, html, radius = 6) {
    ensureGroup();
    const m = L.circleMarker([lat, lon], { radius }).bindPopup(html);
    S.group.addLayer(m);
    return m;
  }

  // ===== Controls (titles above buttons) =====
  const TripControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const el = L.DomUtil.create('div', 'routing-control trip-card');
      el.innerHTML = `
        <div class="routing-header"><strong>Trip Generator</strong></div>
        <div class="routing-actions" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          <button id="rt-gen">Generate Trips</button>
          <button id="rt-clr" class="ghost">Clear</button>
        </div>
        <small class="routing-hint">Uses the address from the top search bar. Click a result so the blue pin appears.</small>
        <details class="routing-section" style="margin-top:8px;">
          <summary style="cursor:pointer">API keys & options</summary>
          <div class="key-row" style="margin-top:8px;display:grid;gap:8px;">
            <label for="rt-keys" style="font-weight:600;">OpenRouteService key(s)</label>
            <input id="rt-keys" type="text" placeholder="KEY1,KEY2 (comma-separated)">
            <div class="routing-row" style="display:flex;gap:10px;flex-wrap:wrap;">
              <button id="rt-save">Save Keys</button>
              <button id="rt-url" class="ghost">Use ?orsKey</button>
            </div>
            <small class="routing-hint">Priority: ?orsKey → saved → inline fallback. Keys auto-rotate on 401/429.</small>
          </div>
        </details>
      `;
      L.DomEvent.disableClickPropagation(el);
      return el;
    }
  });

  const ReportControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const el = L.DomUtil.create('div', 'routing-control report-card');
      el.innerHTML = `
        <div class="routing-header"><strong>Report</strong></div>
        <div class="routing-actions" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          <button id="rt-print" disabled>Print Report</button>
        </div>
        <small class="routing-hint">Prints the directions already generated — no new API calls.</small>
      `;
      L.DomEvent.disableClickPropagation(el);
      return el;
    }
  });

  function setReportEnabled(enabled) {
    const b = document.getElementById('rt-print');
    if (b) b.disabled = !enabled;
  }

  // ===== Init =====
  function init(map) {
    S.map = map;
    S.keys = loadKeys();
    setIndex(getIndex());

    S.map.addControl(new TripControl());
    S.map.addControl(new ReportControl());
    placeBelowPdAndZonesWithRetry();

    S.els = {
      gen: document.getElementById('rt-gen'),
      clr: document.getElementById('rt-clr'),
      print: document.getElementById('rt-print'),
      keys: document.getElementById('rt-keys'),
      save: document.getElementById('rt-save'),
      url: document.getElementById('rt-url')
    };
    if (S.els.keys) S.els.keys.value = S.keys.join(',');

    S.els.gen.onclick   = generateTrips;
    S.els.clr.onclick   = () => clearAll();
    S.els.print.onclick = () => printReport();
    S.els.save.onclick  = () => {
      const arr = (S.els.keys.value || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!arr.length) return popup('<b>Routing</b><br>Enter a key.');
      S.keys = arr; saveKeys(arr); setIndex(0);
      popup('<b>Routing</b><br>Keys saved.');
    };
    S.els.url.onclick   = () => {
      const arr = parseUrlKeys();
      if (!arr.length) return popup('<b>Routing</b><br>No <code>?orsKey=</code> in URL.');
      S.keys = arr; setIndex(0);
      popup('<b>Routing</b><br>Using keys from URL.');
    };
  }

  // ===== Generate Trips =====
  async function generateTrips() {
    try {
      const origin = global.ROUTING_ORIGIN;
      if (!origin) return popup('<b>Routing</b><br>Search an address in the top bar and select a result first.');

      clearAll();
      addMarker(origin.lat, origin.lon, `<b>Origin</b><br>${origin.label}`, 6);

      let targets = [];
      if (typeof global.getSelectedPDTargets === 'function') targets = global.getSelectedPDTargets(); // [lon,lat,label]
      if (!targets.length) return popup('<b>Routing</b><br>No PDs selected.');

      try {
        const f = targets[0];
        S.map.fitBounds(L.latLngBounds([[origin.lat, origin.lon], [f[1], f[0]]]), { padding: [24, 24] });
      } catch {}

      for (let i = 0; i < targets.length; i++) {
        const [dlon, dlat, label] = targets[i];

        // 1) Directions (1 call per PD)
        let gj = null, feat = null, seg = null, km = '—', min = '—';
        try {
          gj = await getRoute([origin.lon, origin.lat], [dlon, dlat]);
          drawRoute(gj, i === 0 ? COLOR_FIRST : COLOR_OTHERS);

          feat = gj?.features?.[0];
          seg  = feat?.properties?.segments?.[0];

          let totalKm = (seg && seg.distance > 0) ? (seg.distance / 1000) : lengthFromCoordsKm(feat?.geometry?.coordinates || []);
          km  = totalKm.toFixed(1);
          min = seg ? Math.round((seg.duration || 0) / 60) : '—';
        } catch (e) {
          console.error('Directions failed:', e);
          popup(`<b>Routing</b><br>Routing failed for ${label}<br><small>${e.message}</small>`);
          continue; // if directions fail, skip this PD
        }

        // Turn-by-turn (plain text) for popup details only
        const steps = (seg?.steps || []).map(s => {
          const txt = String(s.instruction || '').replace(/<[^>]+>/g, '');
          const dist = ((s.distance || 0) / 1000).toFixed(2);
          return `${txt} — ${dist} km`;
        });

        // 2) Movements via Snap v2 + robust fallback to Directions step names
        let assignments = [];
        try {
          const coords = feat?.geometry?.coordinates || [];
          const movRows = await buildMovementsFromPolyline(coords, {
            sampleMeters: SAMPLE_EVERY_M,
            minMeters: 40,
            headingWindow: 1,
            stepFallbackObj: seg // gives us steps + way_points
          });
          assignments = movRows.map(r => ({ dir: r.bound, name: r.street, km: +(r.distance_m/1000).toFixed(2) }));
        } catch (e) {
          console.warn('Snap failed; falling back to minimal movements:', e);
          assignments = buildFallbackMovements(feat?.geometry?.coordinates || []);
        }

        S.results.push({ label, lat: dlat, lon: dlon, km, min, steps, assignments, gj });

        // Popup preview
        const assignPreview = assignments.slice(0, 6).map(a => `<li>${a.dir} ${a.name} — ${a.km.toFixed(2)} km</li>`).join('');
        const html = `
          <div style="max-height:35vh;overflow:auto;">
            <strong>${label}</strong><br>${km} km • ${min} min
            <div style="margin-top:6px;">
              <em>Street assignments</em>
              <ul style="margin:6px 0 8px 18px; padding:0;">${assignPreview || '<li><em>No named streets</em></li>'}</ul>
            </div>
            <details>
              <summary>Turn-by-turn</summary>
              <ol style="margin:6px 0 0 18px; padding:0;">${steps.map(s=>`<li>${s}</li>`).join('')}</ol>
            </details>
          </div>`;
        addMarker(dlat, dlon, html, 5).openPopup();

        if (i < targets.length - 1) await sleep(THROTTLE_MS_DIRECTIONS);
      }

      setReportEnabled(S.results.length > 0);
      if (S.results.length) popup('<b>Routing</b><br>All routes processed. Popups added at each destination.');
    } catch (e) {
      console.error(e);
      popup(`<b>Routing</b><br>${e.message || 'Unknown error.'}`);
    }
  }

  function lengthFromCoordsKm(coords) {
    let km = 0;
    for (let i=0;i<coords.length-1;i++){
      const [lon1,lat1] = coords[i], [lon2,lat2] = coords[i+1];
      km += (haversineMeters([lon1,lat1],[lon2,lat2]) / 1000);
    }
    return km;
  }

  // Fallback movements if everything fails: merges by direction only with "(unnamed)"
  function buildFallbackMovements(coords) {
    if (!coords || coords.length < 2) return [];
    const { pts: sampled } = sampleLineWithIndex(coords, SAMPLE_EVERY_M);
    const rows = [];
    let cur = null;
    for (let i=0;i<sampled.length-1;i++){
      const d = haversineMeters(sampled[i], sampled[i+1]);
      const b = cardinal4(bearingDeg(sampled[i], sampled[i+1]));
      if (!cur) cur = { dir: b, name: '(unnamed)', km: 0 };
      if (cur.dir === b) cur.km += d/1000;
      else { rows.push({ ...cur }); cur = { dir: b, name: '(unnamed)', km: d/1000 }; }
    }
    if (cur) rows.push(cur);
    return rows.map(r => ({ ...r, km: +r.km.toFixed(2) }));
  }

  // ===== Print Report (cached; no new API calls) =====
  function printReport() {
    if (!S.results.length) return popup('<b>Routing</b><br>Generate trips first.');
    const w = window.open('', '_blank');
    const css = `
      <style>
        body { font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; padding:16px; }
        h1 { margin:0 0 8px; font-size:20px; }
        .card { border:1px solid #ddd; border-radius:12px; padding:12px; margin:12px 0; }
        .sub { color:#555; margin-bottom:8px; }
        table { width:100%; border-collapse:collapse; margin-top:8px; }
        th, td { text-align:left; padding:6px 8px; border-bottom:1px solid #eee; }
        th { font-weight:700; background:#fafafa; }
        .right { text-align:right; white-space:nowrap; }
      </style>`;
    const rows = S.results.map((r,i) => {
      const lines = (r.assignments && r.assignments.length)
        ? r.assignments.map(a => `<tr><td>${a.dir}</td><td>${a.name}</td><td class="right">${a.km.toFixed(2)} km</td></tr>`).join('')
        : `<tr><td colspan="3"><em>No named streets on route</em></td></tr>`;
      return `
        <div class="card">
          <h2>${i+1}. ${r.label}</h2>
          <div class="sub">Distance: ${r.km} km • ${r.min} min</div>
          <table>
            <thead><tr><th>Bound</th><th>Street</th><th class="right">Distance</th></tr></thead>
            <tbody>${lines}</tbody>
          </table>
        </div>`;
    }).join('');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Trip Report</title>${css}</head>
    <body><h1>Trip Report — Street Assignments</h1>${rows}
    <script>window.onload=()=>window.print();</script></body></html>`);
    w.document.close();
  }

  // ===== Public API =====
  const Routing = {
    init(map) { init(map); },
    clear() { clearAll(); },
    setApiKeys(arr) { S.keys = Array.isArray(arr) ? [...arr] : []; saveKeys(S.keys); setIndex(0); }
  };
  global.Routing = Routing;

  document.addEventListener('DOMContentLoaded', () => { if (global.map) Routing.init(global.map); });
})(window);
