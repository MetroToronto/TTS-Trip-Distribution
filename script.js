/* script.js — map init, PD list with count boxes (0–3), PZ panel, origin pin, and App getters for routing.js */
(function (global) {
  'use strict';

  // ---------- SAFE MAP INIT ----------
  let map = global.map;
  try {
    if (!map || typeof map.addLayer !== 'function') {
      map = L.map('map', { zoomControl: true });
      global.map = map;
    }
  } catch (e) {
    // If #map is missing, create one that fills the page (keeps site from going white)
    const mdiv = document.createElement('div');
    mdiv.id = 'map';
    mdiv.style.cssText = 'position:fixed;inset:0;background:#eef';
    document.body.appendChild(mdiv);
    map = L.map('map', { zoomControl: true });
    global.map = map;
  }

  const START = [43.7000, -79.4000]; // Toronto-ish default
  map.setView(START, 10);

  // Basemap (never throws)
  try {
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 20, attribution: '&copy; OpenStreetMap'
    }).addTo(map);
  } catch (_) {}

  // ---------- ORIGIN MARKER + PERSISTENCE ----------
  let originMarker = null;
  function setOrigin(lat, lon) {
    try { if (originMarker) originMarker.remove(); } catch(_) {}
    try {
      originMarker = L.marker([lat, lon], { draggable: true });
      originMarker.addTo(map);
      originMarker.on('dragend', () => {
        const p = originMarker.getLatLng();
        global.ROUTING_ORIGIN = { lat: p.lat, lon: p.lng };
      });
    } catch(_) {}
    global.ROUTING_ORIGIN = { lat, lon };
  }
  // Use existing origin if present, else default
  if (global.ROUTING_ORIGIN && typeof global.ROUTING_ORIGIN.lat === 'number' && typeof global.ROUTING_ORIGIN.lon === 'number') {
    setOrigin(global.ROUTING_ORIGIN.lat, global.ROUTING_ORIGIN.lon);
  } else {
    setOrigin(START[0], START[1]);
  }

  // Optional Leaflet.Geocoder support (harmless if not present)
  try {
    if (L.Control.Geocoder && L.Control.Geocoder.nominatim) {
      L.Control.geocoder({ defaultMarkGeocode: false })
        .on('markgeocode', (e) => {
          const c = e.geocode.center; // {lat, lng}
          map.setView(c, 12);
          setOrigin(c.lat, c.lng);
        })
        .addTo(map);
    }
  } catch(_) {}

  // ---------- DATA LOADING ----------
  const PD_URL = '/data/tts_pds.json';
  const PZ_URL = '/data/tts_zones.json';
  let PD_FEATURES = [];
  let PZ_FEATURES = [];

  Promise.allSettled([
    fetch(PD_URL).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(PZ_URL).then(r => r.ok ? r.json() : null).catch(() => null),
  ]).then(([pdRes, pzRes]) => {
    const pd = pdRes.value;
    const pz = pzRes.value;

    if (pd && Array.isArray(pd.features)) {
      PD_FEATURES = pd.features;
      buildPDPanel(PD_FEATURES);
      // Optional light outlines (non-blocking)
      try { L.geoJSON(pd, { style:{ color:'#2E86AB', weight:1, fill:false, opacity:0.5 } }).addTo(map); } catch(_) {}
    } else {
      safeLog('PD data not found at ' + PD_URL);
    }

    if (pz && Array.isArray(pz.features)) {
      PZ_FEATURES = pz.features;
      buildPZPanel();
    } else {
      safeLog('PZ data not found at ' + PZ_URL);
    }
  });

  // ---------- PD PANEL (checkbox + count box on the right) ----------
  function buildPDPanel(features) {
    const panel = ensureCard('pd-panel', 'Planning Districts');

    panel.innerHTML = `
      <div style="font-weight:700;margin-bottom:8px">Planning Districts</div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <button id="pd-all" class="btn">Select all</button>
        <button id="pd-none" class="btn">Clear all</button>
      </div>
      <div id="pd-list" style="max-height:260px;overflow:auto;border-top:1px solid #eee;padding-top:6px"></div>
    `;

    const list = panel.querySelector('#pd-list');

    const rows = features.slice().sort((a,b)=>{
      const an = String(a.properties?.name ?? a.properties?.PD ?? a.properties?.id ?? '').toLowerCase();
      const bn = String(b.properties?.name ?? b.properties?.PD ?? b.properties?.id ?? '').toLowerCase();
      return an.localeCompare(bn);
    });

    rows.forEach(f => {
      const id = String(f.properties?.id ?? f.properties?.PD ?? f.properties?.name ?? '');
      const label = String(f.properties?.name ?? f.properties?.PD ?? id);
      const cen = polyCentroid(f.geometry);   // [lon,lat]

      const row = document.createElement('div');
      row.className = 'pd-item';
      row.setAttribute('data-id', id);
      row.setAttribute('data-label', label);
      row.setAttribute('data-centroid', `${cen[0]},${cen[1]}`);

      row.innerHTML = `
        <label class="pd-row">
          <input type="checkbox" class="pd-check" checked>
          <span class="pd-name">${escapeHtml(label)}</span>
          <input type="number" class="pd-count" value="1" min="0" max="3" step="1" title="Routes (0–3)">
        </label>
      `;

      const chk = row.querySelector('.pd-check');
      const cnt = row.querySelector('.pd-count');
      chk.addEventListener('change', () => {
        if (chk.checked) { cnt.disabled = false; if (cnt.value === '0') cnt.value = '1'; }
        else { cnt.value = '0'; cnt.disabled = true; }
      });
      list.appendChild(row);
    });

    // top buttons
    panel.querySelector('#pd-all').addEventListener('click', ()=>{
      list.querySelectorAll('.pd-item').forEach(it=>{
        const chk = it.querySelector('.pd-check');
        const cnt = it.querySelector('.pd-count');
        chk.checked = true; cnt.disabled = false; if (cnt.value === '0') cnt.value = '1';
      });
    });
    panel.querySelector('#pd-none').addEventListener('click', ()=>{
      list.querySelectorAll('.pd-item').forEach(it=>{
        const chk = it.querySelector('.pd-check');
        const cnt = it.querySelector('.pd-count');
        chk.checked = false; cnt.value = '0'; cnt.disabled = true;
      });
    });

    injectCSS(`
      #pd-panel{background:#fff;border-radius:14px;padding:12px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
      #pd-panel .btn{padding:6px 10px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer}
      #pd-panel .pd-row{display:flex;align-items:center;gap:8px;padding:4px 2px}
      #pd-panel .pd-name{flex:1}
      #pd-panel .pd-count{width:48px;text-align:right}
    `);
  }

  // ---------- PZ PANEL (unchanged UX) ----------
  function buildPZPanel() {
    const panel = ensureCard('pz-panel', 'Planning Zones');
    panel.innerHTML = `
      <div style="font-weight:700;margin-bottom:8px">Planning Zones</div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <button id="pz-engage" class="btn">Engage</button>
        <button id="pz-disengage" class="btn">Disengage</button>
      </div>
      <input type="text" id="pz-input" placeholder="Zone #" style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:10px">
    `;
    injectCSS(`
      #pz-panel{background:#fff;border-radius:14px;padding:12px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
      #pz-panel .btn{padding:6px 10px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer}
    `);
    // (Your existing engage/disengage logic can hook here if needed)
  }

  // ---------- PUBLIC APP API (used by routing.js) ----------
  global.App = {
    getPDRequests() {
      return Array.from(document.querySelectorAll('#pd-list .pd-item')).map(el => {
        const id = el.getAttribute('data-id') || '';
        const label = el.getAttribute('data-label') || id;
        const coords = (el.getAttribute('data-centroid') || '').split(',').map(Number); // [lon,lat]
        const chk = el.querySelector('.pd-check')?.checked;
        const raw = parseInt(el.querySelector('.pd-count')?.value || '0', 10);
        const count = (!chk ? 0 : clamp(raw, 0, 3));
        return { id, label, coords, count };
      });
    },
    getPZRequests() {
      const z = (document.getElementById('pz-input')?.value || '').trim();
      if (!z) return [];
      // find first feature whose id/zone matches
      const f = PZ_FEATURES.find(gf => {
        const pid = String(gf.properties?.id ?? gf.properties?.zone ?? '').toLowerCase();
        return pid === z.toLowerCase();
      });
      if (!f) return [];
      const c = polyCentroid(f.geometry); // [lon,lat]
      return [{ id: String(z), label: 'PZ ' + String(z), coords: c, count: 1 }];
    }
  };

  // ---------- HELPERS ----------
  function ensureCard(id, title) {
    let el = document.getElementById(id);
    if (!el) {
      // try left column if it exists
      const host = document.getElementById('left-col') || document.body;
      el = document.createElement('div');
      el.id = id;
      el.style.margin = '10px';
      host.appendChild(el);
    }
    return el;
  }

  function clamp(n, lo, hi) {
    n = Number(n); if (!Number.isFinite(n)) n = lo;
    return Math.max(lo, Math.min(hi, Math.trunc(n)));
  }

  function polyCentroid(geom) {
    // area-weighted centroid; falls back to vertex average
    if (!geom) return [NaN, NaN];
    const polys = [];
    if (geom.type === 'Polygon') polys.push(geom.coordinates);
    else if (geom.type === 'MultiPolygon') polys.push(...geom.coordinates);
    else return [NaN, NaN];

    let A = 0, Cx = 0, Cy = 0;
    polys.forEach(rings => {
      const outer = rings[0] || [];
      for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
        const [x1, y1] = outer[j], [x2, y2] = outer[i];
        const cross = x1 * y2 - x2 * y1;
        A += cross; Cx += (x1 + x2) * cross; Cy += (y1 + y2) * cross;
      }
    });
    A = A / 2;
    if (Math.abs(A) < 1e-9) {
      const first = polys[0]?.[0] || [];
      const sx = first.reduce((s, v) => s + v[0], 0);
      const sy = first.reduce((s, v) => s + v[1], 0);
      const n = first.length || 1;
      return [sx / n, sy / n];
    }
    return [Cx / (6 * A), Cy / (6 * A)];
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  function injectCSS(css) {
    const tag = document.createElement('style');
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  function safeLog(...args) { try { console.log(...args); } catch(_) {} }

})(window);
