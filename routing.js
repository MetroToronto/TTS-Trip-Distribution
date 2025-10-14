/* routing.js — Directions-only flow with cached results + printable report
 * Inline fallback key:
 * eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=
 * You can still override via ?orsKey=K1,K2 or save in the UI.
 */

(function (global) {
  // ---------- Config ----------
  const INLINE_DEFAULT_KEY =
    'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=';

  const UI_POS = 'topright';
  const PROFILE = 'driving-car';
  const PREFERENCE = 'fastest';
  const THROTTLE_MS = 1500; // stay under 40 req/min

  const COLOR_FIRST = '#0b3aa5';
  const COLOR_OTHERS = '#2166f3';

  const LS_KEYS = 'ORS_KEYS';
  const LS_ACTIVE_INDEX = 'ORS_ACTIVE_INDEX';

  const ORS_BASE = 'https://api.openrouteservice.org';
  const EP = { GEOCODE:'/geocode/search', DIRECTIONS:'/v2/directions' };

  // Runtime state (includes cache for reuse on "Print Report")
  const S = {
    map:null, group:null, keys:[], keyIndex:0, els:{},
    origin:null,                    // {lon,lat,label}
    results:[]                      // [{label, lat, lon, km, min, steps[], gj}]
  };

  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

  // ---------- Key handling ----------
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
  const clearAll = ()=> { if (S.group) S.group.clearLayers(); S.origin=null; S.results=[]; };
  const popup = (html, ll)=> {
    const at = ll || (S.map ? S.map.getCenter() : null);
    if (at) L.popup().setLatLng(at).setContent(html).openOn(S.map);
    else alert(html.replace(/<[^>]+>/g,''));
  };

  // ---------- ORS fetch with rotation ----------
  async function orsFetch(path, { method='GET', params={}, body } = {}) {
    const url = new URL(ORS_BASE + path);
    if (method==='GET') for (const [k,v] of Object.entries(params)) if (v!=null) url.searchParams.set(k,v);
    const res = await fetch(url.toString(), {
      method,
      headers: { Authorization: currentKey(), ...(method!=='GET' && { 'Content-Type':'application/json' }) },
      body: method==='GET' ? undefined : JSON.stringify(body)
    });
    if ([401,403,429].includes(res.status)) {
      if (rotateKey()) return orsFetch(path, { method, params, body });
    }
    if (!res.ok) throw new Error(`ORS ${res.status}: ${await res.text().catch(()=>res.statusText)}`);
    return res.json();
  }

  // ---------- ORS APIs ----------
  async function geocode(address) {
    const d = await orsFetch(EP.GEOCODE, { params: { text: address, size: 1, boundary_country: 'CA' } });
    const f = d?.features?.[0];
    if (!f) throw new Error('Address not found. Try a fuller address (city, province).');
    const [lon, lat] = f.geometry.coordinates;
    return { lon, lat, label: f.properties?.label || address };
  }

  async function getRoute(origin, dest) {
    return orsFetch(`${EP.DIRECTIONS}/${PROFILE}/geojson`, {
      method:'POST',
      body:{
        coordinates: [origin, dest],
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

  // ---------- UI ----------
  const Control = L.Control.extend({
    options: { position: UI_POS },
    onAdd() {
      const el = L.DomUtil.create('div', 'routing-control');
      el.innerHTML = `
        <div class="routing-header">
          <strong>Trip Generator</strong>
          <div class="routing-actions">
            <button id="rt-gen">Generate Trips</button>
            <button id="rt-print" class="ghost" disabled>Print Report</button>
            <button id="rt-clr" class="ghost">Clear</button>
          </div>
        </div>

        <div class="routing-section">
          <label for="rt-origin" style="font-weight:600">Start address</label>
          <input id="rt-origin" type="text" placeholder="e.g., 100 Queen St W, Toronto">
          <small class="routing-hint">
            Generates full routes & turn-by-turn for each selected PD (Directions API only).
          </small>
        </div>

        <div class="routing-section">
          <details>
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
        </div>`;
      L.DomEvent.disableClickPropagation(el);
      return el;
    }
  });

  function setPrintEnabled(enabled) {
    const b = document.getElementById('rt-print');
    if (b) b.disabled = !enabled;
  }

  function init(map) {
    S.map = map;
    S.keys = loadKeys();
    setIndex(getIndex());
    S.map.addControl(new Control());

    S.els = {
      gen: document.getElementById('rt-gen'),
      clr: document.getElementById('rt-clr'),
      print: document.getElementById('rt-print'),
      origin: document.getElementById('rt-origin'),
      keys: document.getElementById('rt-keys'),
      save: document.getElementById('rt-save'),
      url: document.getElementById('rt-url')
    };
    if (S.els.keys) S.els.keys.value = S.keys.join(',');

    const qs = new URLSearchParams(location.search);
    if (qs.get('origin')) S.els.origin.value = qs.get('origin');

    S.els.gen.onclick = generateTrips;
    S.els.print.onclick = printReport;  // uses cached results only
    S.els.clr.onclick = ()=> clearAll();
    S.els.save.onclick = saveKeysUI;
    S.els.url.onclick  = useUrlKeys;
  }

  function saveKeysUI() {
    const arr = (S.els.keys.value || '').split(',').map(s=>s.trim()).filter(Boolean);
    if (!arr.length) return popup('<b>Routing</b><br>Enter at least one key.');
    S.keys = arr; saveKeys(arr); setIndex(0);
    popup('<b>Routing</b><br>Keys saved. Using the first key.');
  }
  function useUrlKeys() {
    const arr = parseUrlKeys();
    if (!arr.length) return popup('<b>Routing</b><br>No <code>?orsKey=</code> in URL.');
    S.keys = arr; setIndex(0);
    popup('<b>Routing</b><br>Using keys from URL.');
  }

  // ---------- Generate Trips (Directions for each selected PD) ----------
  async function generateTrips() {
    try {
      const addr = (S.els.origin.value || '').trim();
      if (!addr) return popup('<b>Routing</b><br>Please enter a start address.');
      const g = await geocode(addr);

      clearAll();
      S.origin = g;
      addMarker(g.lat, g.lon, `<b>Origin</b><br>${g.label}`, 6);

      // Collect PD targets
      let targets = [];
      if (typeof global.getSelectedPDTargets === 'function') {
        targets = global.getSelectedPDTargets(); // [[lon,lat,label], ...]
      }
      if (!targets.length) return popup('<b>Routing</b><br>No PDs selected.');

      // Fit to origin + first destination
      try {
        const f = targets[0];
        S.map.fitBounds(L.latLngBounds([[g.lat, g.lon], [f[1], f[0]]]), { padding:[24,24] });
      } catch {}

      // Fetch Directions for each PD, draw, cache, and open a popup at each destination
      for (let i = 0; i < targets.length; i++) {
        const [dlon, dlat, label] = targets[i];
        try {
          const gj = await getRoute([g.lon, g.lat], [dlon, dlat]);
          drawRoute(gj, i === 0 ? COLOR_FIRST : COLOR_OTHERS);

          const seg = gj?.features?.[0]?.properties?.segments?.[0];
          const km  = seg ? (seg.distance / 1000).toFixed(1) : '—';
          const min = seg ? Math.round((seg.duration || 0) / 60) : '—';
          const steps = (seg?.steps || []).map(s => {
            const skm = (s.distance / 1000).toFixed(2);
            return `${s.instruction} — ${skm} km`;
          });

          // Cache the full result for reuse (print etc.)
          S.results.push({ label, lat: dlat, lon: dlon, km, min, steps, gj });

          // Destination marker with a popup of step-by-step directions
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

      setPrintEnabled(S.results.length > 0);
      popup('<b>Routing</b><br>All routes generated. Popups added at each destination.');

    } catch (e) {
      console.error(e);
      popup(`<b>Routing</b><br>${e.message || 'Unknown error.'}`);
    }
  }

  // ---------- Print Report (no new API calls; uses S.results cache) ----------
  function printReport() {
    if (!S.origin || !S.results.length) {
      return popup('<b>Routing</b><br>Generate trips first.');
    }

    // Simple printable window
    const w = window.open('', '_blank');
    const css = `
      <style>
        body { font: 14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; padding:16px; }
        h1 { margin: 0 0 4px; font-size: 18px; }
        .sub { color:#555; margin-bottom: 12px; }
        .card { border: 1px solid #ddd; border-radius: 10px; padding: 12px; margin: 10px 0; }
        ol { margin: 6px 0 0 18px; }
      </style>
    `;
    const rows = S.results.map((r, idx) => {
      const steps = r.steps.map(s => `<li>${s}</li>`).join('');
      return `
        <div class="card">
          <h2>${idx+1}. ${r.label}</h2>
          <div class="sub">${r.km} km • ${r.min} min</div>
          <ol>${steps}</ol>
        </div>`;
    }).join('');

    w.document.write(`
      <!doctype html>
      <html><head><meta charset="utf-8"><title>Trip Report</title>${css}</head>
      <body>
        <h1>Trip Report</h1>
        <div class="sub">Origin: ${S.origin.label}</div>
        ${rows}
        <script>window.onload = () => window.print();</script>
      </body></html>
    `);
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
