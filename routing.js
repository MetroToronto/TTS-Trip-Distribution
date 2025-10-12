/* routing.js — Directions-only, origin from top geocoder, stacked UI cards
 * Inline fallback key (you can still override via ?orsKey=K1,K2 or save in UI):
 * eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=
 */

(function (global) {
  // ---------- Config ----------
  const INLINE_DEFAULT_KEY =
    'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=';

  const PROFILE = 'driving-car';
  const PREFERENCE = 'fastest';
  const THROTTLE_MS = 1500;  // stay under 40 req/min

  const COLOR_FIRST  = '#0b3aa5';
  const COLOR_OTHERS = '#2166f3';

  const LS_KEYS = 'ORS_KEYS';
  const LS_ACTIVE_INDEX = 'ORS_ACTIVE_INDEX';

  const ORS_BASE = 'https://api.openrouteservice.org';
  const EP = { DIRECTIONS:'/v2/directions' };

  // ---------- State ----------
  const S = {
    map:null, group:null,
    keys:[], keyIndex:0,
    results:[],           // [{label, lat, lon, km, min, steps[], gj}]
    els:{}
  };

  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

  // ---------- Keys ----------
  const parseUrlKeys = () => {
    const raw = new URLSearchParams(location.search).get('orsKey');
    return raw ? raw.split(',').map(s=>s.trim()).filter(Boolean) : [];
  };
  const loadKeys = () => {
    const u = parseUrlKeys(); if (u.length) return u;
    try {
      const ls = JSON.parse(localStorage.getItem(LS_KEYS) || '[]');
      if (Array.isArray(ls) && ls.length) return ls;
    } catch {}
    return [INLINE_DEFAULT_KEY];
  };
  const saveKeys = (arr)=>localStorage.setItem(LS_KEYS, JSON.stringify(arr));
  const setIndex = (i)=>{ S.keyIndex = Math.max(0, Math.min(i, S.keys.length-1)); localStorage.setItem(LS_ACTIVE_INDEX, String(S.keyIndex)); };
  const getIndex = ()=> Number(localStorage.getItem(LS_ACTIVE_INDEX) || 0);
  const currentKey = ()=> S.keys[S.keyIndex];
  const rotateKey = ()=> (S.keys.length>1 ? (setIndex((S.keyIndex+1)%S.keys.length), true) : false);

  // ---------- Map helpers ----------
  const ensureGroup = ()=>{ if(!S.group) S.group = L.layerGroup().addTo(S.map); };
  const clearAll = ()=> { if (S.group) S.group.clearLayers(); S.results = []; setReportEnabled(false); };
  const popup = (html, at)=> {
    const ll = at || (S.map ? S.map.getCenter() : null);
    if (ll) L.popup().setLatLng(ll).setContent(html).openOn(S.map);
    else alert(html.replace(/<[^>]+>/g,''));
  };

  // ---------- Fetch ----------
  async function orsFetch(path, { method='GET', body } = {}) {
    const url = new URL(ORS_BASE + path);
    const res = await fetch(url.toString(), {
      method,
      headers: { Authorization: currentKey(), ...(method!=='GET' && { 'Content-Type':'application/json' }) },
      body: method==='GET' ? undefined : JSON.stringify(body)
    });
    if ([401,403,429].includes(res.status)) {
      if (rotateKey()) return orsFetch(path, { method, body });
    }
    if (!res.ok) throw new Error(`ORS ${res.status}: ${await res.text().catch(()=>res.statusText)}`);
    return res.json();
  }

  async function getRoute(originLonLat, destLonLat) {
    return orsFetch(`${EP.DIRECTIONS}/${PROFILE}/geojson`, {
      method:'POST',
      body:{
        coordinates: [originLonLat, destLonLat],
        preference: PREFERENCE,
        instructions: true,
        instructions_format: 'text',
        language: 'en',
        units: 'km'
      }
    });
  }

  // ---------- Drawing ----------
  function drawRoute(geojson, color) {
    ensureGroup();
    const line = L.geoJSON(geojson, { style: { color, weight: 5, opacity: 0.9 } });
    S.group.addLayer(line);
    return line;
  }
  function addMarker(lat, lon, html, radius=6) {
    ensureGroup();
    const m = L.circleMarker([lat, lon], { radius }).bindPopup(html);
    S.group.addLayer(m);
    return m;
  }

  // ---------- Controls (stacked under Zones) ----------
  const TripControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const el = L.DomUtil.create('div', 'routing-control pd-control');
      el.innerHTML = `
        <div class="routing-header"><strong>Trip Generator</strong></div>
        <div class="routing-actions" style="margin-bottom:8px; display:flex; gap:8px; flex-wrap:wrap;">
          <button id="rt-gen">Generate Trips</button>
          <button id="rt-clr" class="ghost">Clear</button>
        </div>
        <small class="routing-hint">Uses the address from the top search bar. Click a result so the blue pin appears.</small>
        <details style="margin-top:8px;">
          <summary style="cursor:pointer">API keys & options</summary>
          <div class="key-row" style="margin-top:8px;">
            <label for="rt-keys" style="font-weight:600;">OpenRouteService key(s)</label>
            <input id="rt-keys" type="text" placeholder="KEY1,KEY2 (comma-separated)">
            <div class="routing-row">
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
    options: { position: 'topright' },
    onAdd() {
      const el = L.DomUtil.create('div', 'routing-control');
      el.classList.add('report-control');
      el.innerHTML = `
        <div class="routing-header"><strong>Report</strong></div>
        <div class="routing-actions" style="display:flex; gap:8px;">
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

  // ---------- Init ----------
  function init(map) {
    S.map = map;
    S.keys = loadKeys();
    setIndex(getIndex());

    // Add in order so they stack under PD/Zones
    S.map.addControl(new TripControl());
    S.map.addControl(new ReportControl());

    S.els = {
      gen:   document.getElementById('rt-gen'),
      clr:   document.getElementById('rt-clr'),
      print: document.getElementById('rt-print'),
      keys:  document.getElementById('rt-keys'),
      save:  document.getElementById('rt-save'),
      url:   document.getElementById('rt-url')
    };
    if (S.els.keys) S.els.keys.value = S.keys.join(',');

    S.els.gen.onclick   = generateTrips;
    S.els.clr.onclick   = () => clearAll();
    S.els.print.onclick = () => printReport();
    S.els.save.onclick  = () => {
      const arr = (S.els.keys.value || '').split(',').map(s=>s.trim()).filter(Boolean);
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

  // ---------- Generate Trips (Directions for each selected PD) ----------
  async function generateTrips() {
    try {
      // Origin from the top Geocoder search (set in script.js)
      const origin = global.ROUTING_ORIGIN;
      if (!origin) return popup('<b>Routing</b><br>Search an address in the top bar and select a result first.');

      clearAll();
      addMarker(origin.lat, origin.lon, `<b>Origin</b><br>${origin.label}`, 6);

      // PD targets
      let targets = [];
      if (typeof global.getSelectedPDTargets === 'function') targets = global.getSelectedPDTargets(); // [lon, lat, label]
      if (!targets.length) return popup('<b>Routing</b><br>No PDs selected.');

      // Fit to origin + first destination
      try {
        const f = targets[0];
        S.map.fitBounds(L.latLngBounds([[origin.lat, origin.lon], [f[1], f[0]]]), { padding:[24,24] });
      } catch {}

      // Fetch Directions for each PD, draw, cache, popup
      for (let i = 0; i < targets.length; i++) {
        const [dlon, dlat, label] = targets[i];
        try {
          const gj = await getRoute([origin.lon, origin.lat], [dlon, dlat]);
          drawRoute(gj, i === 0 ? COLOR_FIRST : COLOR_OTHERS);

          const seg = gj?.features?.[0]?.properties?.segments?.[0];
          const km  = seg ? (seg.distance / 1000).toFixed(1) : '—';
          const min = seg ? Math.round((seg.duration || 0) / 60) : '—';
          const steps = (seg?.steps || []).map(s => `${s.instruction} — ${(s.distance/1000).toFixed(2)} km`);

          S.results.push({ label, lat: dlat, lon: dlon, km, min, steps, gj });

          const stepsHtml = steps.map(s=>`<li>${s}</li>`).join('');
          const html = `
            <div style="max-height:35vh;overflow:auto;">
              <strong>${label}</strong><br>${km} km • ${min} min
              <ol style="margin:8px 0 0 18px; padding:0;">${stepsHtml}</ol>
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

  // ---------- Print Report (uses cached results only) ----------
  function printReport() {
    if (!S.results.length) return popup('<b>Routing</b><br>Generate trips first.');
    const w = window.open('', '_blank');
    const css = `
      <style>
        body { font: 14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; padding:16px; }
        h1 { margin: 0 0 4px; font-size: 18px; }
        .sub { color:#555; margin-bottom: 12px; }
        .card { border: 1px solid #ddd; border-radius: 10px; padding: 12px; margin: 10px 0; }
        ol { margin: 6px 0 0 18px; }
      </style>`;
    const rows = S.results.map((r, i) => `
      <div class="card">
        <h2>${i+1}. ${r.label}</h2>
        <div class="sub">${r.km} km • ${r.min} min</div>
        <ol>${r.steps.map(s=>`<li>${s}</li>`).join('')}</ol>
      </div>`).join('');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Trip Report</title>${css}</head>
    <body><h1>Trip Report</h1>${rows}<script>window.onload=()=>window.print();</script></body></html>`);
    w.document.close();
  }

  // ---------- Public API ----------
  const Routing = {
    init(map) { init(map); },
    clear() { clearAll(); },
    setApiKeys(arr) { S.keys = [...arr]; saveKeys(S.keys); setIndex(0); }
  };
  global.Routing = Routing;

  document.addEventListener('DOMContentLoaded', ()=>{ if (global.map) Routing.init(global.map); });
})(window);
