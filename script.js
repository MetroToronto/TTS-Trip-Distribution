<!-- Ensure Leaflet & (optional) geocoder are already loaded in index.html -->
<script>
/* script.js — map init, PD dropdown with count boxes, PZ engage/disengage, origin pin, and App getters */
(function (global) {
  'use strict';

  // ---- Map init (expects a <div id="map"> in index.html) ----
  const map = L.map('map', { zoomControl: true }).setView([43.653, -79.383], 10);
  global.map = map;

  // Basemap
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  // ---- Geocoder (optional) ----
  // If you already have this in index.html, remove this small block
  let geocoderControl;
  if (L.Control.Geocoder && L.Control.Geocoder.nominatim) {
    geocoderControl = L.Control.geocoder({
      defaultMarkGeocode: false
    }).on('markgeocode', function(e) {
      const c = e.geocode.center; // {lat, lng}
      setOrigin([c.lat, c.lng]);
      map.setView(c, 12);
    }).addTo(map);
  }

  // ---- Origin pin + persistence for routing.js ----
  let originMarker = null;
  function setOrigin(latlonArr) {
    const [lat, lon] = latlonArr;
    if (originMarker) originMarker.remove();
    originMarker = L.marker([lat, lon], { draggable: true }).addTo(map);
    originMarker.on('dragend', () => {
      const ll = originMarker.getLatLng();
      global.ROUTING_ORIGIN = { lat: ll.lat, lon: ll.lng };
    });
    global.ROUTING_ORIGIN = { lat, lon };
  }
  // Try to restore an initial origin (downtown Toronto) if not set yet
  if (!global.ROUTING_ORIGIN) {
    setOrigin([43.653, -79.383]);
  }

  // ---- Data loading ----
  const PD_URL  = '/data/tts_pds.json';    // polygons with properties.id & properties.name
  const PZ_URL  = '/data/tts_zones.json';  // polygons with properties.zone or properties.id

  let PD_FEATURES = [];
  let PZ_FEATURES = [];

  // Fetch PD & PZ once, draw light outlines
  Promise.all([
    fetch(PD_URL).then(r => r.json()).catch(() => null),
    fetch(PZ_URL).then(r => r.json()).catch(() => null)
  ]).then(([pd, pz]) => {
    if (pd && pd.features) {
      PD_FEATURES = pd.features;
      drawPDBorders(pd);
      buildPDPanel(pd);
    }
    if (pz && pz.features) {
      PZ_FEATURES = pz.features;
      buildPZPanel();
    }
  });

  function drawPDBorders(geojson) {
    L.geoJSON(geojson, {
      style: { color:'#2E86AB', weight:1, fill:false, opacity:0.6 }
    }).addTo(map);
  }

  // ---- UI: PD dropdown with checkboxes + count boxes on the right ----
  function buildPDPanel(pdGeo) {
    // Container
    const wrap = document.getElementById('pd-panel') || createCard('pd-panel', 'Planning Districts');
    // Controls row (Select/Clear/Collapse buttons you already had)
    const controlsRow = document.createElement('div');
    controlsRow.style.display = 'flex';
    controlsRow.style.gap = '8px';
    controlsRow.style.marginBottom = '8px';
    controlsRow.innerHTML = `
      <button id="pd-select-all" class="btn">Select all</button>
      <button id="pd-clear-all"  class="btn">Clear all</button>
      <div class="dropdown">
        <button id="pd-collapse" class="btn">Collapse ▾</button>
      </div>
    `;
    wrap.appendChild(controlsRow);

    const list = document.createElement('div');
    list.id = 'pd-list';
    list.style.maxHeight = '260px';
    list.style.overflow = 'auto';
    list.style.borderTop = '1px solid #e8e8e8';
    list.style.paddingTop = '8px';
    wrap.appendChild(list);

    // Build rows
    const feats = pdGeo.features.slice().sort((a,b) => {
      const an = (a.properties?.name ?? a.properties?.id ?? '').toString().toLowerCase();
      const bn = (b.properties?.name ?? b.properties?.id ?? '').toString().toLowerCase();
      return an.localeCompare(bn);
    });

    feats.forEach(f => {
      const id = String(f.properties?.id ?? f.properties?.PD ?? f.properties?.name ?? '');
      const label = String(f.properties?.name ?? f.properties?.PD ?? id);
      const centroid = polygonCentroid(f.geometry);
      const host = document.createElement('div');
      host.className = 'pd-item';
      host.setAttribute('data-id', id);
      host.setAttribute('data-label', label);
      host.setAttribute('data-centroid', `${centroid[0]},${centroid[1]}`); // lon,lat

      host.innerHTML = `
        <label class="row">
          <input type="checkbox" class="pd-check" checked>
          <span class="pd-name">${escapeHtml(label)}</span>
          <input type="number" class="pd-count" value="1" min="0" max="3" step="1" title="Routes (0–3)">
        </label>
      `;
      // checkbox behavior: disable count when unchecked, set to 0
      const chk = host.querySelector('.pd-check');
      const cnt = host.querySelector('.pd-count');
      chk.addEventListener('change', () => {
        if (chk.checked) {
          cnt.disabled = false;
          if (Number(cnt.value) === 0) cnt.value = 1;
        } else {
          cnt.value = 0;
          cnt.disabled = true;
        }
      });
      list.appendChild(host);
    });

    // Wire top buttons
    document.getElementById('pd-select-all').addEventListener('click', () => {
      list.querySelectorAll('.pd-item').forEach(item => {
        const chk = item.querySelector('.pd-check');
        const cnt = item.querySelector('.pd-count');
        chk.checked = true;
        cnt.disabled = false;
        if (Number(cnt.value) === 0) cnt.value = 1;
      });
    });
    document.getElementById('pd-clear-all').addEventListener('click', () => {
      list.querySelectorAll('.pd-item').forEach(item => {
        const chk = item.querySelector('.pd-check');
        const cnt = item.querySelector('.pd-count');
        chk.checked = false;
        cnt.value = 0;
        cnt.disabled = true;
      });
    });

    // Minimal styles
    injectCSS(`
      #pd-panel .row{display:flex;align-items:center;gap:8px;padding:4px 2px}
      #pd-panel .pd-name{flex:1}
      #pd-panel .pd-count{width:48px;text-align:right}
      #pd-panel .btn{padding:6px 10px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer}
      #pd-panel{background:#fff;border-radius:14px;padding:12px 12px 10px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
    `);
  }

  // ---- UI: PZ panel (unchanged: Engage/Disengage + Zone #) ----
  function buildPZPanel() {
    const wrap = document.getElementById('pz-panel') || createCard('pz-panel', 'Planning Zones');
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.marginBottom = '8px';
    row.innerHTML = `
      <button id="pz-engage" class="btn">Engage</button>
      <button id="pz-disengage" class="btn">Disengage</button>
    `;
    wrap.appendChild(row);

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'pz-input';
    input.placeholder = 'Zone #';
    input.style.width = '100%';
    input.style.padding = '8px 10px';
    input.style.border = '1px solid #ddd';
    input.style.borderRadius = '10px';
    wrap.appendChild(input);

    injectCSS(`
      #pz-panel{background:#fff;border-radius:14px;padding:12px 12px 10px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
      #pz-panel .btn{padding:6px 10px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer}
    `);

    // Very light "engage/disengage" visuals (you already have your own behavior)
    const engaged = new Set();
    byId('pz-engage').addEventListener('click', () => {
      const val = input.value.trim();
      if (val) { engaged.add(val); toast(`PZ ${val} engaged`); }
    });
    byId('pz-disengage').addEventListener('click', () => {
      const val = input.value.trim();
      if (val && engaged.has(val)) { engaged.delete(val); toast(`PZ ${val} disengaged`); }
    });
  }

  // ---- Public API for routing.js to pull requests ----
  const App = {
    getPDRequests() {
      // Collect from DOM
      const items = Array.from(document.querySelectorAll('#pd-list .pd-item'));
      return items.map(el => {
        const id = el.getAttribute('data-id');
        const label = el.getAttribute('data-label') || id;
        const centroid = (el.getAttribute('data-centroid') || '').split(',').map(Number); // [lon,lat]
        const cnt = parseInt(el.querySelector('.pd-count').value, 10);
        const chk = el.querySelector('.pd-check').checked;
        return { id, label, coords: centroid, count: chk ? clamp(cnt, 0, 3) : 0 };
      });
    },
    getPZRequests() {
      // Use the current Zone # in the input; return a single target (best route only)
      const val = (byId('pz-input')?.value || '').trim();
      if (!val) return [];
      // Find zone by id or property match
      const f = PZ_FEATURES.find(z => {
        const pid = String(z.properties?.id ?? z.properties?.zone ?? '').toLowerCase();
        return pid === val.toLowerCase();
      }) || null;
      if (!f) return [];
      const centroid = polygonCentroid(f.geometry); // [lon,lat]
      const id = String(f.properties?.id ?? f.properties?.zone ?? val);
      const label = `PZ ${id}`;
      return [{ id, label, coords: centroid, count: 1 }];
    }
  };
  global.App = App;

  // ---- Helpers ----
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
  function byId(id){ return document.getElementById(id); }
  function clamp(n, lo, hi){ n = Number(n); if (!Number.isFinite(n)) n = lo; return Math.max(lo, Math.min(hi, Math.trunc(n))); }
  function toast(msg){
    let t = byId('app-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'app-toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#222;color:#fff;padding:10px 14px;border-radius:10px;z-index:9999;opacity:0;transition:.25s';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    setTimeout(()=> t.style.opacity='0', 2000);
  }

  function createCard(id, titleText){
    const card = document.createElement('div');
    card.id = id;
    card.innerHTML = `<div style="font-weight:700;margin-bottom:8px">${titleText}</div>`;
    // Place into a left column container if you have one, otherwise append to body
    (document.getElementById('left-col') || document.body).appendChild(card);
    return card;
  }

  function injectCSS(css){
    const tag = document.createElement('style');
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  // Geo centroid for Polygon/MultiPolygon (lon/lat)
  function polygonCentroid(geom) {
    // simple area-weighted centroid; adequate for PD/PZ scales
    const polys = [];
    if (!geom) return [NaN, NaN];
    if (geom.type === 'Polygon') polys.push(geom.coordinates);
    else if (geom.type === 'MultiPolygon') polys.push(...geom.coordinates);
    else return [NaN, NaN];

    let A = 0, Cx = 0, Cy = 0;
    polys.forEach(rings => {
      const outer = rings[0];
      for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
        const [x1, y1] = outer[j];
        const [x2, y2] = outer[i];
        const cross = x1 * y2 - x2 * y1;
        A += cross;
        Cx += (x1 + x2) * cross;
        Cy += (y1 + y2) * cross;
      }
    });
    A = A / 2;
    if (Math.abs(A) < 1e-9) {
      // fallback: average of vertices of the first ring
      const first = polys[0]?.[0] || [];
      const sx = first.reduce((s,v)=>s+v[0],0), sy = first.reduce((s,v)=>s+v[1],0);
      return [sx/first.length, sy/first.length];
    }
    return [Cx / (6 * A), Cy / (6 * A)];
  }
})(window);
</script>
