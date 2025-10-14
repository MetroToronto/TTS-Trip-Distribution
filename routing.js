/* routing.js — simplified naming (no Snap v2 logic), reliable highway rows
   - Uses ORS Directions v2 (geojson) only
   - Keeps step names as-is (trim/collapse whitespace only)
   - First highway/expressway always appears, then list stops
   - Stable NB/EB/SB/WB using first ~300 m of each step
*/
(function (global) {
  // ===== Tunables ===========================================================
  const SWITCH_CONFIRM_M    = 200;  // minimum distance to accept a new street row
  const REJOIN_WINDOW_M     = 600;  // allow re-merge with same street within window
  const MIN_FRAGMENT_M      = 60;   // drop tiny noise fragments (non-highway)
  const BOUND_LOCK_WINDOW_M = 300;  // length used to compute stable bearing
  const SAMPLE_EVERY_M      = 50;   // resample polyline for bearing stability

  const PROFILE    = 'driving-car';
  const PREFERENCE = 'fastest';
  const ORS_BASE   = 'https://api.openrouteservice.org';

  const COLOR_FIRST  = '#0b3aa5';
  const COLOR_OTHERS = '#2166f3';

  // Fallback inline key (will be ignored if ?orsKey or saved keys exist)
  const INLINE_DEFAULT_KEY =
    'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=';

  const LS_KEYS = 'ORS_KEYS';
  const LS_ACTIVE_INDEX = 'ORS_ACTIVE_INDEX';

  // ===== State ==============================================================
  const S = {
    map: null,
    group: null,            // L.LayerGroup for polylines
    keys: [],
    keyIndex: 0,
    results: [],            // [{dest:{lon,lat,label}, route:{coords,steps}}]
    els: {}                 // for controls
  };

  // ===== Small helpers ======================================================
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const getParam = (k) => new URLSearchParams(location.search).get(k) || '';
  const byId = (id) => document.getElementById(id);

  // ===== Geometry / math helpers ===========================================
  const toRad = d => d * Math.PI / 180;
  function haversineMeters(a, b) {
    const R = 6371000; const [x1, y1] = a, [x2, y2] = b;
    const dLat = toRad(y2 - y1), dLng = toRad(x2 - x1);
    const s = Math.sin(dLat/2)**2 + Math.cos(toRad(y1))*Math.cos(toRad(y2))*Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function bearingDeg(a, b) {
    const [lng1, lat1] = [toRad(a[0]), toRad(a[1])], [lng2, lat2] = [toRad(b[0]), toRad(b[1])];
    const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function circularMean(degArr) {
    const sx = degArr.reduce((a,d) => a + Math.cos(toRad(d)), 0);
    const sy = degArr.reduce((a,d) => a + Math.sin(toRad(d)), 0);
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

  // ===== Name handling (simplified) ========================================
  function cleanHtml(s) { return String(s || '').replace(/<[^>]*>/g, '').trim(); }

  // Minimal normalization: trim + collapse spaces; NEVER rewrite highway names.
  function normalizeName(raw) {
    if (!raw) return '';
    let s = String(raw).trim().replace(/\s+/g, ' ');
    if (!s || /^unnamed\b/i.test(s) || /^[-–]+$/.test(s)) return '';
    return s;
  }

  // Pull name for a step: prefer step.name; otherwise parse from instruction.
  function stepName(step) {
    const byField = normalizeName(step?.name || step?.road || '');
    if (byField) return byField;

    const t = cleanHtml(step?.instruction || '');
    // Try explicit named expressways first
    const named = t.match(/\b(Gardiner(?:\s+Expressway)?|Don Valley Parkway|DVP|QEW|Allen Road|Black Creek Drive)\b/i);
    if (named) return normalizeName(named[1]);

    // Try generic highway numbers like ON-401 / Hwy 404 / 427
    const hnum = t.match(/\b(?:ON|Ontario)?[-– ]?(?:Hwy|HWY|Highway|RTE|Route)?\s*(\d{2,3})\b/);
    if (hnum) return normalizeName(`Highway ${hnum[1]}`);

    // Fallback: "onto X" / "on X"
    const m = t.match(/\b(?:onto|on|to|toward|towards)\s+([A-Za-z0-9 .'\-\/&]+)$/i);
    if (m) return normalizeName(m[1]);

    return '';
  }

  // Simple highway check (no rewriting)
  function isHighwayName(name = '') {
    return /\b(Highway\s?\d{2,3}|Gardiner\s+Expressway|Don Valley Parkway|QEW|DVP|Allen Road|Black Creek Drive)\b/i.test(name);
  }

  // ===== ORS requests =======================================================
  function savedKeys() {
    try { return JSON.parse(localStorage.getItem(LS_KEYS) || '[]'); } catch { return []; }
  }
  function saveKeys(arr) {
    localStorage.setItem(LS_KEYS, JSON.stringify(Array.isArray(arr) ? arr : []));
  }
  function getIndex() { return +(localStorage.getItem(LS_ACTIVE_INDEX) || 0) || 0; }
  function setIndex(i) { localStorage.setItem(LS_ACTIVE_INDEX, String(i)); }

  function hydrateKeys() {
    const urlKey = getParam('orsKey');
    const saved = savedKeys();
    const inline = [INLINE_DEFAULT_KEY];
    S.keys = (urlKey ? [urlKey] : []).concat(saved.length ? saved : inline);
    S.keyIndex = Math.min(getIndex(), Math.max(0, S.keys.length - 1));
  }
  function currentKey() { return S.keys[Math.min(Math.max(S.keyIndex, 0), S.keys.length - 1)] || ''; }
  function rotateKey() {
    if (S.keys.length <= 1) return false;
    S.keyIndex = (S.keyIndex + 1) % S.keys.length;
    setIndex(S.keyIndex);
    return true;
    }

  async function orsFetch(path, { method = 'GET', body, query } = {}) {
    const url = new URL(ORS_BASE + path);
    if (query) Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString(), {
      method,
      headers: { Authorization: currentKey(), ...(method !== 'GET' && { 'Content-Type':'application/json' }) },
      body: method === 'GET' ? undefined : JSON.stringify(body)
    });
    if ([401,403,429].includes(res.status) && rotateKey()) return orsFetch(path, { method, body, query });
    if (!res.ok) throw new Error(`ORS ${res.status}: ${await res.text().catch(()=>res.statusText)}`);
    return res.json();
  }

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

  // ===== Movement list builder (directions-only) ============================
  function sliceCoords(fullCoords, i0, i1) {
    const s = Math.max(0, Math.min(i0, fullCoords.length - 1));
    const e = Math.max(0, Math.min(i1, fullCoords.length - 1));
    if (e <= s) return fullCoords.slice(s, s + 1);
    return fullCoords.slice(s, e + 1);
  }

  function stableBoundForStep(fullCoords, waypoints, limitM = BOUND_LOCK_WINDOW_M) {
    if (!Array.isArray(waypoints) || waypoints.length !== 2) return '';
    const [w0, w1] = waypoints;
    const s = Math.max(0, Math.min(w0, fullCoords.length - 1));
    const e = Math.max(0, Math.min(w1, fullCoords.length - 1));
    if (e <= s + 1) return '';

    // Walk from s forward until ~limitM reached
    let accum = 0;
    let cut = s + 1;
    for (let i = s + 1; i <= e; i++) {
      accum += haversineMeters(fullCoords[i - 1], fullCoords[i]);
      if (accum >= limitM) { cut = i; break; }
    }
    const seg = fullCoords.slice(s, Math.max(cut, s + 1) + 1);
    const samples = resample(seg, SAMPLE_EVERY_M);
    if (samples.length < 2) return '';

    const bearings = [];
    for (let i = 1; i < samples.length; i++) bearings.push(bearingDeg(samples[i - 1], samples[i]));
    const mean = circularMean(bearings);
    return boundFrom(mean);
  }

  function buildMovementsFromDirections(coords, steps) {
    if (!coords?.length || !steps?.length) return [];

    const rows = [];
    const pushRow = (name, i0, i1, waypoints, isHighway) => {
      const nm = normalizeName(name);
      if (!nm) return;

      const seg = sliceCoords(coords, i0, i1);
      if (seg.length < 2) return;

      // distance of this row
      let meters = 0; for (let i = 1; i < seg.length; i++) meters += haversineMeters(seg[i - 1], seg[i]);
      // Keep tiny fragments only if it's the highway row
      if (meters < MIN_FRAGMENT_M && !isHighway) return;

      const dir = stableBoundForStep(coords, waypoints, BOUND_LOCK_WINDOW_M) || '';

      const last = rows[rows.length - 1];
      if (last && last.name === nm && last.dir === dir) {
        last.km = +(last.km + meters / 1000).toFixed(2);
      } else {
        rows.push({ dir, name: nm, km: +(meters / 1000).toFixed(2) });
      }
    };

    let stopped = false;
    for (const step of steps) {
      const nm = stepName(step);
      const isHwy = isHighwayName(nm);
      const [i0, i1] = Array.isArray(step.way_points) ? step.way_points : step.wayPoints || step.waypoints || [0, 0];

      // Push row
      pushRow(nm, i0, i1, [i0, i1], isHwy);

      if (isHwy) { stopped = true; break; }
    }

    // Remove ultra-short non-highway rows at the start that can appear before the first meaningful segment
    return rows.filter(r => r.km >= (isHighwayName(r.name) ? 0 : (SWITCH_CONFIRM_M / 1000)));
  }

  // ===== Map drawing & orchestration =======================================
  function clearAll() {
    S.results = [];
    if (S.group) S.group.clearLayers();
    setReportEnabled(false);
  }

  function drawRoute(coords, color) {
    if (!coords?.length) return;
    if (!S.group) S.group = L.layerGroup().addTo(S.map);
    L.polyline(coords.map(([lng, lat]) => [lat, lng]), {
      color, weight: 4, opacity: 0.9
    }).addTo(S.group);
  }

  async function generate() {
    const origin = global.ROUTING_ORIGIN; // {lat, lng} from script.js geocoder
    if (!origin) { alert('Pick an origin address first.'); return; }

    const targets = (global.getSelectedPDTargets && global.getSelectedPDTargets()) || [];
    if (!targets.length) { alert('Select at least one PD.'); return; }

    setBusy(true);
    clearAll();

    try {
      const originLonLat = [origin.lng, origin.lat];

      for (let idx = 0; idx < targets.length; idx++) {
        const [lon, lat, label] = targets[idx];
        const destLonLat = [lon, lat];

        const json = await getRoute(originLonLat, destLonLat);
        const feat = json.features?.[0];
        const coords = feat?.geometry?.coordinates || [];
        const steps = feat?.properties?.segments?.[0]?.steps || [];

        // Keep for printing
        S.results.push({
          dest: { lon, lat, label },
          route: { coords, steps }
        });

        // Draw
        drawRoute(coords, idx === 0 ? COLOR_FIRST : COLOR_OTHERS);
        await sleep(60); // gentle pacing for UI
      }

      setReportEnabled(true);
    } catch (e) {
      console.error(e);
      alert('Routing error: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  function setBusy(b) {
    const g = byId('rt-generate');
    if (g) { g.disabled = b; g.textContent = b ? 'Generating…' : 'Generate Trips'; }
  }

  // ===== Print report =======================================================
  function setReportEnabled(enabled) {
    const b = byId('rt-print');
    if (b) b.disabled = !enabled;
  }

  function km(n) { return (n || 0).toFixed(2); }

  function printReport() {
    if (!S.results.length) { alert('No trips generated yet.'); return; }

    const cards = S.results.map((r, i) => {
      const rows = buildMovementsFromDirections(r.route.coords, r.route.steps);
      const lines = rows.map(m => `<tr><td>${m.dir || ''}</td><td>${m.name}</td><td style="text-align:right">${km(m.km)}</td></tr>`).join('');
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
    w.document.write(`<!doctype html><meta charset="utf-8"><title>Trip Report</title>${css}<h1>Trip Report — Street List</h1>${cards}<script>onload=()=>print();</script>`);
    w.document.close();
  }

  // ===== Controls (UI) ======================================================
  const GeneratorControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const el = L.DomUtil.create('div', 'routing-control');
      el.innerHTML = `
        <div class="routing-header"><strong>Routing</strong></div>
        <div class="routing-actions" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          <button id="rt-generate">Generate Trips</button>
          <button id="rt-clear" class="ghost">Clear</button>
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

  const ReportControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const el = L.DomUtil.create('div', 'routing-control report-card');
      el.innerHTML = `
        <div class="routing-header"><strong>Report</strong></div>
        <div class="routing-actions" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          <button id="rt-print" disabled>Print Report</button>
        </div>
        <small class="routing-hint">Prints the routes already generated — no new API calls.</small>`;
      L.DomEvent.disableClickPropagation(el);
      return el;
    }
  });

  function wireControls() {
    const g = byId('rt-generate');
    const c = byId('rt-clear');
    const s = byId('rt-save');
    const u = byId('rt-url');
    const inp = byId('rt-keys');

    if (g) g.onclick = () => generate();
    if (c) c.onclick = () => clearAll();
    if (s && inp) s.onclick = () => {
      const arr = inp.value.split(',').map(x => x.trim()).filter(Boolean);
      saveKeys(arr);
      hydrateKeys();
      alert(`Saved ${S.keys.length} key(s).`);
    };
    if (u) u.onclick = () => {
      const k = getParam('orsKey');
      if (!k) alert('Add ?orsKey=YOUR_KEY to the URL query.');
      else { saveKeys([k]); hydrateKeys(); alert('Using orsKey from URL.'); }
    };
  }

  // ===== Init (robust, one-time) ===========================================
  function init(map) {
    if (!map) return;
    S.map = map;
    hydrateKeys();

    if (!S.group) S.group = L.layerGroup().addTo(map);

    const genCtl = new GeneratorControl();
    const repCtl = new ReportControl();
    map.addControl(genCtl);
    map.addControl(repCtl);

    // Delay wiring a tick to ensure DOM nodes exist
    setTimeout(() => { wireControls(); }, 0);
  }

  // Expose API
  const Routing = {
    init(map) {
      // guard: wait until map is loaded so buttons don’t race and disappear
      if (!map || !map._loaded) {
        const retry = () => (map && map._loaded) ? init(map) : setTimeout(retry, 80);
        return retry();
      }
      init(map);
    },
    clear() { clearAll(); },
    printReport() { printReport(); },
    _debugBuild(rowsArgs) { return buildMovementsFromDirections(...rowsArgs); }
  };

  global.Routing = Routing;

  // Auto-init once DOM is ready and a global map exists (matches your script.js)
  document.addEventListener('DOMContentLoaded', () => {
    const tryInit = () => {
      if (global.map && (global.map._loaded || global.map._size)) Routing.init(global.map);
      else setTimeout(tryInit, 80);
    };
    tryInit();
  });
})(window);
