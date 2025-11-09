/* script.js — PD list (with 0–3 count boxes), unchanged PZ panel, origin pin + geocoder,
   and App getters consumed by routing.js. No routing logic in this file. */
(function (global) {
  'use strict';

  // ===== Map bootstrap (safe) =====
  let map = global.map;
  if (!map || typeof map.addLayer !== 'function') {
    const host = document.getElementById('map') || (() => {
      const d = document.createElement('div'); d.id = 'map';
      d.style.cssText = 'position:fixed;inset:0;';
      document.body.appendChild(d); return d;
    })();
    map = L.map(host, { zoomControl: true });
    global.map = map;
  }
  const START = [43.7, -79.4]; // Toronto-ish
  map.setView(START, 10);
  try {
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 20, attribution: '&copy; OpenStreetMap'
    }).addTo(map);
  } catch (_) {}

  // ===== Origin marker + optional geocoder =====
  let originMarker = null;
  function setOrigin(lat, lon) {
    try { if (originMarker) originMarker.remove(); } catch(_) {}
    originMarker = L.marker([lat, lon], { draggable: true }).addTo(map);
    originMarker.on('dragend', () => {
      const p = originMarker.getLatLng();
      global.ROUTING_ORIGIN = { lat: p.lat, lon: p.lng };
    });
    global.ROUTING_ORIGIN = { lat, lon };
  }
  // If an origin was already set by your page, keep it; otherwise default.
  if (global.ROUTING_ORIGIN && Number.isFinite(global.ROUTING_ORIGIN.lat) && Number.isFinite(global.ROUTING_ORIGIN.lon)) {
    setOrigin(global.ROUTING_ORIGIN.lat, global.ROUTING_ORIGIN.lon);
  } else {
    setOrigin(START[0], START[1]);
  }

  // Optional Leaflet.Geocoder support (won't crash if absent)
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

  // ===== Data =====
  const PD_URL = '/data/tts_pds.json';
  const PZ_URL = '/data/tts_zones.json';

  let PD_FEATURES = [];
  let PZ_FEATURES = [];
  let PZ_INDEX = new Map();   // zoneId(string) -> { feature }

  Promise.allSettled([
    fetch(PD_URL).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(PZ_URL).then(r => r.ok ? r.json() : null).catch(() => null)
  ]).then(([pdRes, pzRes]) => {
    const pd = pdRes.value, pz = pzRes.value;

    if (pd && Array.isArray(pd.features)) {
      PD_FEATURES = pd.features;
      buildPDPanel();
      // Optional outlines
      try { L.geoJSON(pd, { style:{ color:'#2E86AB', weight:1, fill:false, opacity:0.5 } }).addTo(map); } catch(_) {}
    }

    if (pz && Array.isArray(pz.features)) {
      PZ_FEATURES = pz.features;
      for (const f of PZ_FEATURES) {
        const id = String(f.properties?.id ?? f.properties?.zone ?? '').trim();
        if (id) PZ_INDEX.set(id.toLowerCase(), { feature: f });
      }
      buildPZPanel();
    }
  });

  // ===== PD panel (checkbox + count box to the right) =====
  function buildPDPanel() {
    const panel = document.getElementById('pd-panel') || createCard('pd-panel');
    panel.innerHTML = `
      <div class="card-title">Planning Districts</div>
      <div class="btn-row">
        <button id="pd-select-all" class="btn">Select all</button>
        <button id="pd-clear-all"  class="btn">Clear all</button>
      </div>
      <div id="pd-list" class="scroll-list"></div>
    `;

    const list = panel.querySelector('#pd-list');

    const rows = PD_FEATURES.slice().sort((a,b)=>{
      const an = String(a.properties?.name ?? a.properties?.PD ?? a.properties?.id ?? '').toLowerCase();
      const bn = String(b.properties?.name ?? b.properties?.PD ?? b.properties?.id ?? '').toLowerCase();
      return an.localeCompare(bn);
    });

    rows.forEach(f => {
      const id = String(f.properties?.id ?? f.properties?.PD ?? f.properties?.name ?? '');
      const label = String(f.properties?.name ?? f.properties?.PD ?? id);
      const cen = centroidLL(f.geometry); // [lon,lat]

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

    panel.querySelector('#pd-select-all').addEventListener('click', () => {
      list.querySelectorAll('.pd-item').forEach(el => {
        const chk = el.querySelector('.pd-check');
        const cnt = el.querySelector('.pd-count');
        chk.checked = true; cnt.disabled = false; if (cnt.value === '0') cnt.value = '1';
      });
    });
    panel.querySelector('#pd-clear-all').addEventListener('click', () => {
      list.querySelectorAll('.pd-item').forEach(el => {
        const chk = el.querySelector('.pd-check');
        const cnt = el.querySelector('.pd-count');
        chk.checked = false; cnt.value = '0'; cnt.disabled = true;
      });
    });

    injectCSS(`
      #pd-panel{background:#fff;border-radius:14px;padding:12px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
      #pd-panel .card-title{font-weight:700;margin-bottom:8px}
      #pd-panel .btn-row{display:flex;gap:8px;margin-bottom:8px}
      #pd-panel .btn{padding:6px 10px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer}
      #pd-panel .scroll-list{max-height:260px;overflow:auto;border-top:1px solid #eee;padding-top:6px}
      #pd-panel .pd-row{display:flex;align-items:center;gap:8px;padding:4px 2px}
      #pd-panel .pd-name{flex:1}
      #pd-panel .pd-count{width:48px;text-align:right}
    `);
  }

  // ===== PZ panel (unchanged UI) =====
  function buildPZPanel() {
    const panel = document.getElementById('pz-panel') || createCard('pz-panel');
    panel.innerHTML = `
      <div class="card-title">Planning Zones</div>
      <div class="btn-row">
        <button id="pz-engage" class="btn">Engage</button>
        <button id="pz-disengage" class="btn">Disengage</button>
      </div>
      <input type="text" id="pz-input" placeholder="Zone #" class="pz-input">
    `;
    injectCSS(`
      #pz-panel{background:#fff;border-radius:14px;padding:12px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
      #pz-panel .card-title{font-weight:700;margin-bottom:8px}
      #pz-panel .btn-row{display:flex;gap:8px;margin-bottom:8px}
      #pz-panel .btn{padding:6px 10px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer}
      #pz-panel .pz-input{width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:10px}
    `);
  }

  // ===== Public API — consumed by routing.js =====
  global.App = {
    // Array of { id, label, coords:[lon,lat], count }
    getPDRequests() {
      return Array.from(document.querySelectorAll('#pd-list .pd-item')).map(el => {
        const id    = el.getAttribute('data-id') || '';
        const label = el.getAttribute('data-label') || id;
        const [lon, lat] = (el.getAttribute('data-centroid') || '').split(',').map(Number);
        const checked = el.querySelector('.pd-check')?.checked;
        const raw = parseInt(el.querySelector('.pd-count')?.value || '0', 10);
        const count = checked ? clamp(raw, 0, 3) : 0;
        return { id, label, coords: [lon, lat], count };
      });
    },
    // Single target (if user typed a valid Zone #). Always count = 1.
    getPZRequests() {
      const v = (document.getElementById('pz-input')?.value || '').trim();
      if (!v) return [];
      const hit = PZ_INDEX.get(v.toLowerCase());
      if (!hit) return [];
      const c = centroidLL(hit.feature.geometry); // [lon,lat]
      return [{ id: v, label: `PZ ${v}`, coords: c, count: 1 }];
    }
  };

  // ===== helpers =====
  function createCard(id){
    const el = document.createElement('div');
    el.id = id;
    (document.getElementById('left-col') || document.body).appendChild(el);
    return el;
  }
  function centroidLL(geom) {
    // area-weighted centroid; fallback to vertex mean
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
      const sx = first.reduce((s,v)=>s+v[0],0), sy = first.reduce((s,v)=>s+v[1],0);
      const n = first.length || 1;
      return [sx/n, sy/n];
    }
    return [Cx / (6 * A), Cy / (6 * A)];
  }
  function clamp(n, lo, hi){ n = Number(n); if (!Number.isFinite(n)) n = lo; return Math.max(lo, Math.min(hi, Math.trunc(n))); }
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
})(window);
