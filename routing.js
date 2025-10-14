/* routing.js — simplified naming + hardened ORS calls
   - Keeps ORS step names (no Snap v2 remnants)
   - Always lists the first highway, then stops
   - Adds coordinate sanitization + robust retry for ORS 500/2099
*/
(function (global) {
  // ===== Tunables ===========================================================
  const MIN_FRAGMENT_M      = 60;   // keep tiny fragments only if highway
  const BOUND_LOCK_WINDOW_M = 300;  // meters used to stabilize heading
  const SAMPLE_EVERY_M      = 50;   // resampling for heading
  const PER_REQUEST_DELAY   = 80;   // ms between PD requests

  const PROFILE    = 'driving-car';
  const PREFERENCE = 'fastest';
  const ORS_BASE   = 'https://api.openrouteservice.org';

  const COLOR_FIRST  = '#0b3aa5';
  const COLOR_OTHERS = '#2166f3';

  // Fallback inline key (ignored if ?orsKey or saved keys exist)
  const INLINE_DEFAULT_KEY =
    'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=';

  const LS_KEYS = 'ORS_KEYS';
  const LS_ACTIVE_INDEX = 'ORS_ACTIVE_INDEX';

  // ===== State ==============================================================
  const S = {
    map: null,
    group: null,
    keys: [],
    keyIndex: 0,
    results: [],
  };

  // ===== Helpers ============================================================
  const byId   = (id) => document.getElementById(id);
  const toRad  = (d) => d * Math.PI / 180;
  const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
  const qParam = (k) => new URLSearchParams(location.search).get(k) || '';

  function haversineMeters(a, b) {
    const R = 6371000;
    const [x1, y1] = a, [x2, y2] = b;
    const dLat = toRad(y2 - y1), dLng = toRad(x2 - x1);
    const s = Math.sin(dLat/2)**2 + Math.cos(toRad(y1))*Math.cos(toRad(y2))*Math.sin(dLng/2)**2 * Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(Math.sin(dLat/2)**2 + Math.cos(toRad(y1))*Math.cos(toRad(y2))*Math.sin(dLng/2)**2));
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
  function resample(coords, everyM) {
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

  // ===== Minimal naming (no rewrites) ======================================
  function cleanHtml(s) { return String(s || '').replace(/<[^>]*>/g, '').trim(); }
  function normalizeName(raw) {
    if (!raw) return '';
    const s = String(raw).trim().replace(/\s+/g, ' ');
    if (!s || /^unnamed\b/i.test(s) || /^[-–]+$/.test(s)) return '';
    return s;
  }
  function stepName(step) {
    const field = normalizeName(step?.name || step?.road || '');
    if (field) return field;

    const t = cleanHtml(step?.instruction || '');
    // Named expressways
    const named = t.match(/\b(Gardiner(?:\s+Expressway)?|Don Valley Parkway|QEW|DVP|Allen Road|Black Creek Drive)\b/i);
    if (named) return normalizeName(named[1]);
    // Highway numbers like ON-401 / Hwy 404 / 427
    const hnum = t.match(/\b(?:ON|Ontario)?[-– ]?(?:Hwy|HWY|Highway|RTE|Route)?\s*(\d{2,3})\b/);
    if (hnum) return normalizeName(`Highway ${hnum[1]}`);
    // Fallback: "onto X" / "on X"
    const m = t.match(/\b(?:onto|on|to|toward|towards)\s+([A-Za-z0-9 .'\-\/&]+)$/i);
    if (m) return normalizeName(m[1]);
    return '';
  }
  function isHighwayName(name='') {
    return /\b(Highway\s?\d{2,3}|Gardiner\s+Expressway|Don Valley Parkway|QEW|DVP|Allen Road|Black Creek Drive)\b/i.test(name);
  }

  // ===== Coords sanitization (prevents 2099 from bad inputs) ===============
  function isFiniteNum(n){ return Number.isFinite(n) && !Number.isNaN(n); }
  function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

  // Accepts [lon, lat]; returns a safe [lon, lat]
  function sanitizeLonLat(pair){
    let [x, y] = Array.isArray(pair) ? pair : [NaN, NaN];
    x = +x; y = +y;

    // If they look swapped (|x|<=90 and |y|>=90), swap back
    if (isFiniteNum(x) && isFiniteNum(y) && Math.abs(x) <= 90 && Math.abs(y) > 90){
      const tmp = x; x = y; y = tmp;
    }

    if (!isFiniteNum(x) || !isFiniteNum(y)) throw new Error('Invalid coordinate (NaN).');
    x = clamp(x, -180, 180);
    y = clamp(y,  -85,  85); // keep away from poles
    return [x, y];
  }

  // ===== ORS keys & fetch with retry =======================================
  function savedKeys() {
    try { return JSON.parse(localStorage.getItem(LS_KEYS) || '[]'); } catch { return []; }
  }
  function saveKeys(arr) {
    localStorage.setItem(LS_KEYS, JSON.stringify(Array.isArray(arr) ? arr : []));
  }
  function getIndex() { return +(localStorage.getItem(LS_ACTIVE_INDEX) || 0) || 0; }
  function setIndex(i) { localStorage.setItem(LS_ACTIVE_INDEX, String(i)); }

  function hydrateKeys() {
    const urlKey = qParam('orsKey');
    const saved = savedKeys();
    const inline = [INLINE_DEFAULT_KEY];
    S.keys = (urlKey ? [urlKey] : []).concat(saved.length ? saved : inline);
    S.keyIndex = Math.min(getIndex(), Math.max(0, S.keys.length - 1));
  }
  function currentKey(){ return S.keys[Math.min(Math.max(S.keyIndex,0), S.keys.length-1)] || ''; }
  function rotateKey(){
    if (S.keys.length <= 1) return false;
    S.keyIndex = (S.keyIndex + 1) % S.keys.length;
    setIndex(S.keyIndex);
    return true;
  }

  async function orsFetch(path, { method='GET', body, query } = {}, attempt = 0){
    const url = new URL(ORS_BASE + path);
    if (query) Object.entries(query).forEach(([k,v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString(), {
      method,
      headers: { Authorization: currentKey(), ...(method !== 'GET' && { 'Content-Type':'application/json' }) },
      body: method === 'GET' ? undefined : JSON.stringify(body)
    });

    // Handle quota / auth, rotate key
    if ([401,403,429].includes(res.status) && rotateKey()){
      await sleep(150);
      return orsFetch(path, { method, body, query }, attempt + 1);
    }

    // Retry a transient 500 once with small backoff
    if (res.status === 500 && attempt < 1){
      await sleep(200);
      return orsFetch(path, { method, body, query }, attempt + 1);
    }

    if (!res.ok){
      const txt = await res.text().catch(()=>res.statusText);
      throw new Error(`ORS ${res.status}: ${txt}`);
    }
    return res.json();
  }

  // Try normal → if 500/2099 comes back, attempt a SAFE swap of *one* point once.
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
      return await orsFetch(`/v2/directions/${PROFILE}/geojson`, { method: 'POST', body: baseBody });
    } catch (e) {
      // Only consider fallback on the specific 500/2099 signature
      const msg = String(e.message || '');
      const is2099 = msg.includes('ORS 500') && (msg.includes('"code":2099') || msg.includes('code:2099'));
      if (!is2099) throw e;

      // Fallback: try swap of destination (common case is centroid lat/lon accidentally reversed upstream)
      const dSwap = [d[1], d[0]];
      const bodySwap = { ...baseBody, coordinates: [o, sanitizeLonLat(dSwap)] };
      return await orsFetch(`/v2/directions/${PROFILE}/geojson`, { method: 'POST', body: bodySwap });
    }
  }

  // ===== Movement list ======================================================
  function sliceCoords(full, i0, i1){
    const s = Math.max(0, Math.min(i0, full.length - 1));
    const e = Math.max(0, Math.min(i1, full.length - 1));
    return e <= s ? full.slice(s, s + 1) : full.slice(s, e + 1);
  }
  function stableBoundForStep(fullCoords, waypoints, limitM = BOUND_LOCK_WINDOW_M){
    if (!Array.isArray(waypoints) || waypoints.length !== 2) return '';
    const [w0, w1] = waypoints;
    const s = Math.max(0, Math.min(w0, fullCoords.length - 1));
    const e = Math.max(0, Math.min(w1, fullCoords.length - 1));
    if (e <= s + 1) return '';

    // Advance ~limitM from start of step
    let acc = 0, cut = s + 1;
    for (let i = s + 1; i <= e; i++){
      acc += haversineMeters(fullCoords[i-1], fullCoords[i]);
      if (acc >= limitM) { cut = i; break; }
    }
    const seg = fullCoords.slice(s, Math.max(cut, s + 1) + 1);
    const samples = resample(seg, SAMPLE_EVERY_M);
    if (samples.length < 2) return '';

    const bearings = [];
    for (let i = 1; i < samples.length; i++) bearings.push(bearingDeg(samples[i-1], samples[i]));
    const mean = circularMean(bearings);
    return boundFrom(mean);
  }

  function buildMovementsFromDirections(coords, steps){
    if (!coords?.length || !steps?.length) return [];
    const rows = [];

    const pushRow = (name, i0, i1, waypoints, isHwy) => {
      const nm = normalizeName(name);
      if (!nm) return;
      const seg = sliceCoords(coords, i0, i1);
      if (seg.length < 2) return;

      // Distance
      let meters = 0; for (let i = 1; i < seg.length; i++) meters += haversineMeters(seg[i-1], seg[i]);
      if (meters < MIN_FRAGMENT_M && !isHwy) return;

      const dir = stableBoundForStep(coords, waypoints, BOUND_LOCK_WINDOW_M) || '';
      const last = rows[rows.length - 1];
      if (last && last.name === nm && last.dir === dir){
        last.km = +(last.km + meters / 1000).toFixed(2);
      } else {
        rows.push({ dir, name: nm, km: +(meters / 1000).toFixed(2) });
      }
    };

    for (const step of steps){
      const nm = stepName(step);
      const isHwy = isHighwayName(nm);
      const wp = step.way_points || step.wayPoints || step.waypoints || [0, 0];
      const [i0, i1] = wp;
      pushRow(nm, i0, i1, [i0, i1], isHwy);
      if (isHwy) break; // stop after first highway row appears
    }

    // Keep all highway rows; for non-highways, drop near-zero totals
    return rows.filter(r => r.km >= (isHighwayName(r.name) ? 0 : 0.05));
  }

  // ===== Map draw & orchestration ==========================================
  function clearAll(){
    S.results = [];
    if (S.group) S.group.clearLayers();
    const btn = byId('rt-print'); if (btn) btn.disabled = true;
  }
  function drawRoute(coords, color){
    if (!coords?.length) return;
    if (!S.group) S.group = L.layerGroup().addTo(S.map);
    L.polyline(coords.map(([lng, lat]) => [lat, lng]), { color, weight: 4, opacity: 0.9 }).addTo(S.group);
  }

  async function generate(){
    const origin = global.ROUTING_ORIGIN; // set by script.js geocoder
    if (!origin) { alert('Pick an origin address first.'); return; }

    const targets = (global.getSelectedPDTargets && global.getSelectedPDTargets()) || [];
    if (!targets.length) { alert('Select at least one PD.'); return; }

    setBusy(true); clearAll();
    try {
      const originLonLat = sanitizeLonLat([+origin.lng, +origin.lat]);

      for (let idx = 0; idx < targets.length; idx++){
        const [lon, lat, label] = targets[idx];
        const destLonLat = sanitizeLonLat([+lon, +lat]);

        const json  = await getRoute(originLonLat, destLonLat);
        const feat  = json.features?.[0];
        const coords = feat?.geometry?.coordinates || [];
        const steps  = feat?.properties?.segments?.[0]?.steps || [];

        S.results.push({ dest: { lon, lat, label }, route: { coords, steps }});
        drawRoute(coords, idx === 0 ? COLOR_FIRST : COLOR_OTHERS);

        await sleep(PER_REQUEST_DELAY);
      }

      const printBtn = byId('rt-print'); if (printBtn) printBtn.disabled = false;
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

  // ===== Print Report =======================================================
  function printReport(){
    if (!S.results.length) { alert('No trips generated yet.'); return; }

    const rowsHtml = S.results.map((r, i) => {
      const mov = buildMovementsFromDirections(r.route.coords, r.route.steps);
      const lines = mov.map(m => `<tr><td>${m.dir || ''}</td><td>${m.name}</td><td style="text-align:right">${(m.km||0).toFixed(2)}</td></tr>`).join('');
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

  // ===== Controls ===========================================================
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
    const s = byId('rt-save');
    const u = byId('rt-url');
    const inp = byId('rt-keys');

    if (g) g.onclick = () => generate();
    if (c) c.onclick = () => clearAll();
    if (p) p.onclick = () => printReport();

    if (s && inp) s.onclick = () => {
      const arr = inp.value.split(',').map(x => x.trim()).filter(Boolean);
      saveKeys(arr); hydrateKeys();
      alert(`Saved ${S.keys.length} key(s).`);
    };
    if (u) u.onclick = () => {
      const k = qParam('orsKey');
      if (!k) alert('Add ?orsKey=YOUR_KEY to the URL query.');
      else { saveKeys([k]); hydrateKeys(); alert('Using orsKey from URL.'); }
    };
  }

  // ===== Init ===============================================================
  function innerInit(map){
    S.map = map;
    hydrateKeys();
    if (!S.group) S.group = L.layerGroup().addTo(map);
    map.addControl(new GeneratorControl());
    setTimeout(wireControls, 0);
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
