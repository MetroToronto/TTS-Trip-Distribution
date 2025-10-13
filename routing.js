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
  const SNAP_BATCH_SIZE = 200;         // safe batch size per Snap request
  const SAMPLE_EVERY_M = 50;           // spacing for polyline sampling

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

  // ===== SNAP v2 (road) — correct endpoint + schema =====
  async function snapRoad(pointsLngLat) {
    if (!pointsLngLat?.length) return [];
    const url = `${ORS_BASE}/v2/snap/road`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': currentKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: pointsLngLat })
    });
    if ([401,403,429].includes(res.status) && rotateKey()) return snapRoad(pointsLngLat);
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
  function sampleLine(coords, stepM){
    if (!coords || coords.length<2) return coords||[];
    const out=[coords[0]];
    let acc=0;
    for (let i=1;i<coords.length;i++){
      const seg=haversineMeters(coords[i-1], coords[i]);
      acc+=seg;
      if (acc>=stepM){ out.push(coords[i]); acc=0; }
    }
    if (out[out.length-1]!==coords[coords.length-1]) out.push(coords[coords.length-1]);
    return out;
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

  // ===== Naming helpers =====
  function pickStreetName(props={}){
    const cands=[props.name,props.road,props.street,props.way_name,props.label,props.ref,props.display_name]
      .filter(Boolean).map(String);
    const norm=s=>s
      .replace(/\b(hwy)\b/ig,"Highway")
      .replace(/\b(hwy)\s*(\d+)\b/ig,"Highway $2")
      .replace(/\b(st)\b\.?/ig,"Street")
      .replace(/\b(rd)\b\.?/ig,"Road")
      .replace(/\b(ave)\b\.?/ig,"Avenue")
      .replace(/\s+/g," ").trim();
    const seen=new Set(); const uniq=[];
    for (const s of cands.map(norm)) if (!seen.has(s)){ seen.add(s); uniq.push(s); }
    if (!uniq.length && props.ref) return `Highway ${props.ref}`;
    if (uniq[0] && /^\d+$/.test(uniq[0])) return `Highway ${uniq[0]}`;
    return uniq[0]||"";
  }

  // ===== Movements from polyline (sample → snap → name → bound → merge) =====
  async function buildMovementsFromPolyline(coords, {
    sampleMeters = SAMPLE_EVERY_M,
    minMeters = 40,
    headingWindow = 1
  } = {}) {
    const sampled = sampleLine(coords, sampleMeters);
    if (!sampled || sampled.length<2) return [];

    // Snap all samples in batches
    const features = [];
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
      const name = pickStreetName(features[i]?.properties||{}) || "(unnamed)";
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
        try {
          // 1) Directions (1 call per PD)
          const gj = await getRoute([origin.lon, origin.lat], [dlon, dlat]);
          drawRoute(gj, i === 0 ? COLOR_FIRST : COLOR_OTHERS);

          const feat = gj?.features?.[0];
          const seg  = feat?.properties?.segments?.[0];

          // Distance/time with geometry fallback
          let totalKm = (seg && seg.distance > 0) ? (seg.distance / 1000) : lengthFromCoordsKm(feat?.geometry?.coordinates || []);
          const km  = totalKm.toFixed(1);
          const min = seg ? Math.round((seg.duration || 0) / 60) : '—';

          // Turn-by-turn (plain text) for popup details only
          const steps = (seg?.steps || []).map(s => {
            const txt = String(s.instruction || '').replace(/<[^>]+>/g, '');
            const dist = ((s.distance || 0) / 1000).toFixed(2);
            return `${txt} — ${dist} km`;
          });

          // 2) Movements via Snap v2 (no reverse geocode)
          const coords = feat?.geometry?.coordinates || [];
          const movRows = await buildMovementsFromPolyline(coords, {
            sampleMeters: SAMPLE_EVERY_M,
            minMeters: 40,
            headingWindow: 1
          });
          const assignments = movRows.map(r => ({ dir: r.bound, name: r.street, km: +(r.distance_m/1000).toFixed(2) }));

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
        } catch (e) {
          console.error(e);
          popup(`<b>Routing</b><br>Route failed for ${label}<br><small>${e.message}</small>`);
        }
        if (i < targets.length - 1) await sleep(THROTTLE_MS_DIRECTIONS);
      }

      setReportEnabled(S.results.length > 0);
      popup('<b>Routing</b><br>All routes generated. Popups added at each destination.');
    } catch (e) {
      console.error(e);
      popup(`<b>Routing</b><br>${e.message || 'Unknown error.'}`);
    }
  }

  // lengthFromCoordsKm (used above)
  function lengthFromCoordsKm(coords) {
    let km = 0;
    for (let i=0;i<coords.length-1;i++){
      const [lon1,lat1] = coords[i], [lon2,lat2] = coords[i+1];
      km += (haversineMeters([lon1,lat1],[lon2,lat2]) / 1000);
    }
    return km;
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
