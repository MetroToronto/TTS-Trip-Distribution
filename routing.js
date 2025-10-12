/* routing.js — Directions-only; stacked under PD & Zones; street-by-street assignments
 * Uses origin from the top geocoder (window.ROUTING_ORIGIN set in script.js).
 * Inline fallback key (override via ?orsKey=K1,K2 or save in UI):
 * eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=
 */

(function (global) {
  // ===== Config =====
  const INLINE_DEFAULT_KEY =
    'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=';

  const PROFILE = 'driving-car';
  const PREFERENCE = 'fastest';
  const THROTTLE_MS = 1500; // keep < 40 req/min

  const COLOR_FIRST  = '#0b3aa5';
  const COLOR_OTHERS = '#2166f3';

  const ORS_BASE = 'https://api.openrouteservice.org';
  const EP = { DIRECTIONS: '/v2/directions' };

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

  // ===== Placement: ensure Trip + Report are **after** PD & Zones in same column =====
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

  // ===== ORS fetch =====
  async function orsFetch(path, { method = 'GET', body } = {}) {
    const url = new URL(ORS_BASE + path);
    const res = await fetch(url.toString(), {
      method,
      headers: { Authorization: currentKey(), ...(method !== 'GET' && { 'Content-Type': 'application/json' }) },
      body: method === 'GET' ? undefined : JSON.stringify(body)
    });
    if ([401,403,429].includes(res.status)) {
      if (rotateKey()) return orsFetch(path, { method, body });
    }
    if (!res.ok) throw new Error(`ORS ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    return res.json();
  }

  async function getRoute(originLonLat, destLonLat) {
    return orsFetch(`${EP.DIRECTIONS}/${PROFILE}/geojson`, {
      method: 'POST',
      body: {
        coordinates: [originLonLat, destLonLat],
        preference: PREFERENCE,
        instructions: true,
        instructions_format: 'text',
        language: 'en',
        units: 'km'
      }
    });
  }

  // ===== Geometry / headings / name extraction =====
  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371, toRad = x => x * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }
  function lengthFromCoordsKm(coords) {
    let km = 0;
    for (let i=0;i<coords.length-1;i++){
      const [lon1,lat1] = coords[i], [lon2,lat2] = coords[i+1];
      km += haversineKm(lat1,lon1,lat2,lon2);
    }
    return km;
  }
  function toCardinal4(deg) {
    const a = (deg + 360) % 360;
    if (a >= 45 && a < 135) return 'EB';
    if (a >= 135 && a < 225) return 'SB';
    if (a >= 225 && a < 315) return 'WB';
    return 'NB';
  }
  function headingFromCoords(coords) {
    if (!coords || coords.length < 2) return null;
    let vx = 0, vy = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const [lon1, lat1] = coords[i], [lon2, lat2] = coords[i + 1];
      const k = Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
      vx += (lon2 - lon1) * k;
      vy += (lat2 - lat1);
    }
    if (vx === 0 && vy === 0) return null;
    return (Math.atan2(vx, vy) * 180 / Math.PI + 360) % 360; // 0° = N
  }
  // Robust extractor for street names from instruction text
  function nameFromInstruction(instr = '', prevName = '') {
    const t = String(instr).trim();
    if (!t) return '';
    const s = t.replace(/\s+/g, ' ');
    const patterns = [
      /\bexit(?:\s+\d+)?\s+(?:onto|to)\s+([^,;.]+)\b/i,
      /\bramp(?:\s+to)?\s+([^,;.]+)\b/i,
      /\bmerge\s+(?:onto|to)\s+([^,;.]+)\b/i,
      /\bcontinue\s+(?:onto|on)\s+([^,;.]+)\b/i,
      /\bturn\s+(?:left|right)\s+(?:onto|to)\s+([^,;.]+)\b/i,
      /\bkeep\s+(?:left|right)\s+(?:onto|to)?\s*([^,;.]+)\b/i,
      /\bfollow\s+([^,;.]+)\b/i,
      /\b(on|onto|to|toward|via)\s+([^,;.]+)\b/i
    ];
    for (const re of patterns) {
      const m = s.match(re);
      if (m && (m[2] || m[1])) {
        const cand = (m[2] || m[1]).trim();
        if (cand && !/^(the|a|an|roundabout|ramp|slip road)$/i.test(cand)) return cand;
      }
    }
    if (/^continue\b/i.test(s) && prevName) return prevName;
    return '';
  }

  // Build merged street-by-street assignments from ORS geojson
  function buildStreetAssignments(gj, { minStepMeters = 10 } = {}) {
    const feat = gj?.features?.[0];
    const seg = feat?.properties?.segments?.[0];
    const steps = seg?.steps || [];
    const line = feat?.geometry?.coordinates || [];
    if (!line.length || !steps.length) return [];

    const rows = [];
    let lastName = '';

    for (const s of steps) {
      const [i0, i1] = s.way_points || [0, 0];
      const coords = line.slice(Math.max(0, i0), Math.min(line.length, i1 + 1));

      const distM = (s.distance && s.distance > 0) ? s.distance : (lengthFromCoordsKm(coords) * 1000);
      if (distM < minStepMeters) continue;

      const street = (s.name && s.name.trim()) || nameFromInstruction(s.instruction || '', lastName) || '';
      if (!street) continue;

      const hdg = headingFromCoords(coords);
      const dir = toCardinal4(hdg ?? 0);

      rows.push({ name: street.trim(), km: +(distM/1000).toFixed(2), dir });
      lastName = street.trim();
    }

    if (!rows.length) return [];

    const merged = [];
    for (const r of rows) {
      const last = merged[merged.length - 1];
      if (last && last.name === r.name && last.dir === r.dir) {
        last.km = +(last.km + r.km).toFixed(2);
      } else {
        merged.push({ ...r });
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

  // ===== Generate Trips (Directions for each selected PD) =====
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
        try {
          const gj = await getRoute([origin.lon, origin.lat], [dlon, dlat]);
          drawRoute(gj, i === 0 ? COLOR_FIRST : COLOR_OTHERS);

          const feat = gj?.features?.[0];
          const seg  = feat?.properties?.segments?.[0];

          // Total distance/time (with geometry fallback)
          let totalKm = (seg && seg.distance > 0) ? (seg.distance / 1000) : lengthFromCoordsKm(feat?.geometry?.coordinates || []);
          const km  = totalKm.toFixed(1);
          const min = seg ? Math.round((seg.duration || 0) / 60) : '—';

          // Turn-by-turn text (still available)
          const steps = (seg?.steps || []).map(s => `${s.instruction} — ${((s.distance||0)/1000).toFixed(2)} km`);

          // Street-by-street assignments for the whole route
          const assignments = buildStreetAssignments(gj);

          S.results.push({ label, lat: dlat, lon: dlon, km, min, steps, assignments, gj });

          // Popup: assignments preview + collapsible steps
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
        } catch (e) {
          console.error(e);
          popup(`<b>Routing</b><br>Route failed for ${label}<br><small>${e.message}</small>`);
        }
        if (i < targets.length - 1) await sleep(THROTTLE_MS);
      }

      setReportEnabled(S.results.length > 0);
      popup('<b>Routing</b><br>All routes generated. Popups added at each destination.');
    } catch (e) {
      console.error(e);
      popup(`<b>Routing</b><br>${e.message || 'Unknown error.'}`);
    }
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
          <div class="sub">Distance: ${r.km} km • Time: ${r.min} min</div>
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
    setApiKeys(arr) { S.keys = [...arr]; saveKeys(S.keys); setIndex(0); }
  };
  global.Routing = Routing;

  document.addEventListener('DOMContentLoaded', () => { if (global.map) Routing.init(global.map); });
})(window);
