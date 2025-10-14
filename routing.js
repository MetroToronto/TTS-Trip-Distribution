/* routing.js — natural step listing (no highway rules), robust coords, stable UI */
(function (global) {
  // ===== Tunables ===========================================================
  const MIN_FRAGMENT_M      = 20;   // drop only very tiny noise segments
  const BOUND_LOCK_WINDOW_M = 300;  // meters to stabilize heading labels
  const SAMPLE_EVERY_M      = 50;   // resampling interval for heading
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

  // ===== Small helpers ======================================================
  const byId   = (id) => document.getElementById(id);
  const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
  const qParam = (k) => new URLSearchParams(location.search).get(k) || '';
  const toRad  = (d) => d * Math.PI / 180;

  function isFiniteNum(n){ return Number.isFinite(n) && !Number.isNaN(n); }
  function num(x){ const n = typeof x === 'string' ? parseFloat(x) : +x; return Number.isFinite(n) ? n : NaN; }
  function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

  // Accepts anything-ish; returns [lon, lat] or throws with context
  function sanitizeLonLat(input){
    let arr = Array.isArray(input) ? input : [undefined, undefined];
    let x = num(arr[0]);
    let y = num(arr[1]);

    // If swapped (|x|<=90, |y|>90) then swap back
    if (isFiniteNum(x) && isFiniteNum(y) && Math.abs(x) <= 90 && Math.abs(y) > 90){
      const t = x; x = y; y = t;
    }

    if (!isFiniteNum(x) || !isFiniteNum(y)){
      throw new Error(`Invalid coordinate (NaN). Raw: ${JSON.stringify(input)}`);
    }
    x = clamp(x, -180, 180);
    y = clamp(y,  -85,  85);
    return [x, y];
  }

  // Robust origin extractor -> [lon, lat]
  function getOriginLonLat(){
    const o = global.ROUTING_ORIGIN;
    if (!o) throw new Error('Origin not set');

    if (Array.isArray(o) && o.length >= 2) return sanitizeLonLat([o[0], o[1]]);
    if (typeof o.getLatLng === 'function') { const ll = o.getLatLng(); return sanitizeLonLat([ll.lng, ll.lat]); }
    if (isFiniteNum(num(o.lng)) && isFiniteNum(num(o.lat))) return sanitizeLonLat([o.lng, o.lat]);
    if (o.latlng && isFiniteNum(num(o.latlng.lng)) && isFiniteNum(num(o.latlng.lat))) return sanitizeLonLat([o.latlng.lng, o.latlng.lat]);

    if (o.center) {
      if (Array.isArray(o.center) && o.center.length >= 2) return sanitizeLonLat([o.center[0], o.center[1]]);
      if (isFiniteNum(num(o.center.lng)) && isFiniteNum(num(o.center.lat))) return sanitizeLonLat([o.center.lng, o.center.lat]);
    }
    if (o.geometry && Array.isArray(o.geometry.coordinates) && o.geometry.coordinates.length >= 2)
      return sanitizeLonLat([o.geometry.coordinates[0], o.geometry.coordinates[1]]);

    const x = o.lon ?? o.x; const y = o.lat ?? o.y;
    if (isFiniteNum(num(x)) && isFiniteNum(num(y))) return sanitizeLonLat([x, y]);

    if (typeof o === 'string' && o.includes(',')) {
      const [a,b] = o.split(',').map(s => s.trim());
      try { return sanitizeLonLat([a,b]); } catch {}
      return sanitizeLonLat([b,a]);
    }

    throw new Error(`Origin shape unsupported: ${JSON.stringify(o)}`);
  }

  // Normalize possible outputs from getSelectedPDTargets()
  function normalizeTargets(rawList){
    const out = [];
    const bad = [];
    (rawList || []).forEach((t, i) => {
      let lon, lat, label;
      if (Array.isArray(t)) { lon = t[0]; lat = t[1]; label = t[2] ?? `PD ${i+1}`; }
      else if (t && typeof t === 'object') { lon = t.lon ?? t.lng ?? t.x; lat = t.lat ?? t.y; label = t.label ?? t.name ?? `PD ${i+1}`; }
      else if (typeof t === 'string' && t.includes(',')) { const [a,b]=t.split(',').map(s=>s.trim()); lon=a; lat=b; label=`PD ${i+1}`; }
      try { const pair = sanitizeLonLat([lon, lat]); out.push([pair[0], pair[1], label]); }
      catch (e) { bad.push({ index:i, value:t, reason:String(e.message||e) }); }
    });
    return { good: out, bad };
  }

  // ===== Distances / bearings ==============================================
  function haversineMeters(a, b) {
    const R = 6371000;
    const [lon1, lat1] = a, [lon2, lat2] = b;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
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
    // 1) Prefer ORS-provided name exactly as-is (trimmed)
    const field = normalizeName(step?.name || step?.road || '');
    if (field) return field;

    // 2) Fallback: extract trailing place from instruction without rewriting tokens
    //    e.g., "Take the ramp onto ON-401 E" -> "ON-401 E"
    const t = cleanHtml(step?.instruction || '');
    const m = t.match(/\b(?:onto|on|to|toward|towards)\s+([A-Za-z0-9 .,'\-\/&()]+)$/i);
    if (m) return normalizeName(m[1]);

    // 3) Nothing usable
    return '';
  }

  // ===== ORS keys & fetch with retry =======================================
  function savedKeys() { try { return JSON.parse(localStorage.getItem(LS_KEYS) || '[]'); } catch { return []; } }
  function saveKeys(arr) { localStorage.setItem(LS_KEYS, JSON.stringify(Array.isArray(arr) ? arr : [])); }
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

    if ([401,403,429].includes(res.status) && rotateKey()){
      await sleep(150);
      return orsFetch(path, { method, body, query }, attempt + 1);
    }
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

  // Try normal; if we get ORS 500/2099, attempt a one-time destination swap.
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
      const msg = String(e.message || '');
      const is2099 = msg.includes('ORS 500') && (msg.includes('"code":2099') || msg.includes('code:2099'));
      if (!is2099) throw e;

      const dSwap = sanitizeLonLat([d[1], d[0]]);
      const bodySwap = { ...baseBody, coordinates: [o, dSwap] };
      return await orsFetch(`/v2/directions/${PROFILE}/geojson`, { method: 'POST', body: bodySwap });
    }
  }

  // ===== Movement list (no highway special-casing) ==========================
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

    const pushRow = (name, i0, i1, waypoints) => {
      const nm = normalizeName(name);
      if (!nm) return;
      const seg = sliceCoords(coords, i0, i1);
      if (seg.length < 2) return;

      let meters = 0; for (let i = 1; i < seg.length; i++) meters += haversineMeters(seg[i-1], seg[i]);
      if (meters < MIN_FRAGMENT_M) return;

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
      const wp = step.way_points || step.wayPoints || step.waypoints || [0, 0];
      const [i0, i1] = wp;
      pushRow(nm, i0, i1, [i0, i1]);
    }

    // Keep everything except near-zero noise; no highway detection/filtering.
    return rows.filter(r => r.km >= 0.02);
  }

  // ===== Map drawing & orchestration =======================================
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
    // 1) Origin
    let originLonLat;
    try {
      originLonLat = getOriginLonLat();
    } catch (e) {
      console.error('Origin invalid:', global.ROUTING_ORIGIN, e);
      alert('Origin has invalid coordinates. Please re-select the address.');
      return;
    }

    // 2) Targets
    const rawTargets = (global.getSelectedPDTargets && global.getSelectedPDTargets()) || [];
    const { good: targets, bad } = normalizeTargets(rawTargets);
    if (bad.length){
      console.warn('Some PD targets were invalid and will be skipped:', bad);
      const list = bad.slice(0,5).map(b => `#${b.index+1}: ${b.reason}`).join('\n');
      alert(`Some PDs have invalid coordinates and were skipped:\n${list}${bad.length>5?'\n…':''}`);
    }
    if (!targets.length){
      alert('Select at least one PD with valid coordinates.'); return;
    }

    setBusy(true); clearAll();

    try {
      for (let idx = 0; idx < targets.length; idx++){
        const [lon, lat, label] = targets[idx];
        const destLonLat = sanitizeLonLat([lon, lat]);

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

    const rowsHtml = S.results.map((r) => {
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
