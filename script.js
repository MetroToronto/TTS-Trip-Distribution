// ===================== Map boot =====================
const map = L.map('map').setView([43.6532, -79.3832], 11);
window.map = map; // expose for routing.js

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap'
}).addTo(map);

// Geocoder (non-fatal if missing)
try {
  const geocoderCtl = L.Control.geocoder({ collapsed: false, defaultMarkGeocode: true }).addTo(map);

  // >>> NEW: remember the last picked address for routing.js to use
  geocoderCtl.on('markgeocode', (e) => {
    const c = e.geocode.center;
    window.ROUTING_ORIGIN = {
      lat: c.lat,
      lon: c.lng,
      label: e.geocode.name || e.geocode.html || `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`
    };
  });
} catch (e) {
  console.warn('Geocoder not loaded:', e);
}

// ===================== Helpers =====================
function pdKeyFromProps(p) {
  const cand =
    p?.PD_no ?? p?.pd_no ?? p?.PDID ?? p?.PD_ID ?? p?.PD ?? p?.pd ??
    p?.PD_NAME ?? p?.PD_name ?? null;
  if (cand != null) return String(cand).trim();
  return String(p?.PD_name || p?.PD_NAME || p?.name || 'PD').trim();
}
function zoneKeyFromProps(p) {
  const cand =
    p?.TTS2022 ?? p?.ZONE ?? p?.ZONE_ID ?? p?.ZN_ID ?? p?.TTS_ZONE ??
    p?.Zone ?? p?.Z_no ?? p?.Z_ID ?? p?.ZONE_NO ?? p?.ZONE_NUM ?? null;
  return String(cand ?? 'Zone').trim();
}

// Give PD section a way to call Zones section, and vice-versa
window._pdSelectByKey  = undefined; // (key, {zoom}) -> void
window._pdClearSelection = undefined;
window._zonesShowFor   = undefined; // (pdKey, focusZoneId?) -> void
window._zonesClear     = undefined; // () -> void

// ===================== Planning Districts =====================
const PD_URL = 'data/tts_pds.json?v=' + Date.now();

fetch(PD_URL)
  .then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${r.url || PD_URL}`);
    return r.text();
  })
  .then(txt => {
    try { return JSON.parse(txt); }
    catch (e) {
      console.error('PD JSON parse error:', e, txt.slice(0, 200));
      throw new Error('Invalid PD GeoJSON');
    }
  })
  .then(geo => {
    const baseStyle     = { color: '#ff6600', weight: 2, fillOpacity: 0.15 };
    const selectedStyle = { color: '#d40000', weight: 4, fillOpacity: 0.25 };

    const group = L.featureGroup().addTo(map);

    let selectedKey = null;
    let selectedItem = null;

    // Always-visible PD label when selected
    const selectedLabel = L.marker([0, 0], { opacity: 0 });
    function showPDLabel(item) {
      const center = item.bounds.getCenter();
      if (!map.hasLayer(selectedLabel)) selectedLabel.addTo(map);
      selectedLabel
        .setLatLng(center)
        .bindTooltip(item.name, {
          permanent: true,
          direction: 'center',
          className: 'pd-label'
        })
        .openTooltip();
    }
    function hidePDLabel() { try { selectedLabel.remove(); } catch {} }

    function clearListSelection() {
      document.querySelectorAll('.pd-item.selected').forEach(el => el.classList.remove('selected'));
    }
    function markListSelected(key) {
      clearListSelection();
      const cbx = document.getElementById(`pd-${encodeURIComponent(key)}`);
      if (cbx) cbx.closest('.pd-item')?.classList.add('selected');
    }

    const pdIndex = [];
    L.geoJSON(geo, {
      style: baseStyle,
      onEachFeature: (f, layer) => {
        const p = f.properties || {};
        const name = (p.PD_name || p.PD_no || 'Planning District').toString();
        const key  = pdKeyFromProps(p);
        pdIndex.push({ key, name, no: (p.PD_no ?? null), layer, bounds: layer.getBounds() });

        layer.on('click', () => {
          const item = pdIndex.find(i => i.layer === layer);
          if (!item) return;
          if (selectedKey === item.key) clearPDSelection();
          else selectPD(item, { zoom: true });
        });
      }
    });

    // Sort by number then name
    pdIndex.sort((a,b) => {
      const ah = a.no !== null, bh = b.no !== null;
      if (ah && bh) return Number(a.no) - Number(b.no);
      if (ah && !bh) return -1;
      if (!ah && bh) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    const show  = i => { if (!map.hasLayer(i.layer)) i.layer.addTo(group); };
    const hide  = i => { if (map.hasLayer(i.layer))  group.removeLayer(i.layer); };
    const reset = () => { pdIndex.forEach(i => i.layer.setStyle(baseStyle)); };

    function clearPDSelection() {
      reset();
      hidePDLabel();
      map.closePopup();
      clearListSelection();
      selectedKey = null;
      selectedItem = null;
      if (typeof window._zonesClear === 'function') window._zonesClear();
    }
    window._pdClearSelection = clearPDSelection;

    function selectPD(item, { zoom = false } = {}) {
      if (!map.hasLayer(item.layer)) item.layer.addTo(group);
      reset();
      item.layer.setStyle(selectedStyle);
      try { item.layer.bringToFront?.(); } catch {}
      showPDLabel(item);
      if (zoom) map.fitBounds(item.bounds, { padding: [30, 30] });
      selectedKey  = item.key;
      selectedItem = item;
      markListSelected(item.key);
      if (typeof window._zonesShowFor === 'function') window._zonesShowFor(item.key);
    }

    // Expose PD select-by-key for Zone Search to call
    window._pdSelectByKey = function _pdSelectByKey(key, { zoom = true } = {}) {
      const item = pdIndex.find(i => String(i.key) === String(key));
      if (item) selectPD(item, { zoom });
    };

    // Build the PD list UI
    const itemsHTML = pdIndex.map(i => `
      <div class="pd-item">
        <input type="checkbox" class="pd-cbx" id="pd-${encodeURIComponent(i.key)}"
               data-key="${encodeURIComponent(i.key)}" checked>
        <span class="pd-name" data-key="${encodeURIComponent(i.key)}">${i.name}</span>
      </div>
    `).join('');

    // PD Control
    const PDControl = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        const div = L.DomUtil.create('div', 'pd-control collapsed');
        div.innerHTML = `
          <div class="pd-header">
            <strong>Planning Districts</strong>
            <div class="pd-actions">
              <button type="button" id="pd-select-all">Select all</button>
              <button type="button" id="pd-clear-all">Clear all</button>
              <button type="button" id="pd-toggle" class="grow">Expand ▾</button>
            </div>
          </div>
          <div class="pd-list" id="pd-list">${itemsHTML}</div>
        `;
        const geocoderEl = document.querySelector('.leaflet-control-geocoder');
        if (geocoderEl) div.style.width = geocoderEl.offsetWidth + 'px';
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div.querySelector('#pd-list'));
        return div;
      }
    });
    map.addControl(new PDControl());

    const listEl = document.getElementById('pd-list');
    const btnAll = document.getElementById('pd-select-all');
    const btnClr = document.getElementById('pd-clear-all');
    const btnTgl = document.getElementById('pd-toggle');
    const controlRoot = listEl.closest('.pd-control');

    // Show all PDs initially + fit
    pdIndex.forEach(show);
    try {
      map.fitBounds(L.featureGroup(pdIndex.map(i => i.layer)).getBounds(), { padding: [20, 20] });
    } catch {}

    // Checkbox visibility
    listEl.addEventListener('change', e => {
      const cbx = e.target.closest('.pd-cbx');
      if (!cbx) return;
      const key = decodeURIComponent(cbx.dataset.key);
      const item = pdIndex.find(i => i.key === key);
      if (!item) return;
      if (cbx.checked) show(item);
      else {
        hide(item);
        if (selectedKey === key) clearPDSelection();
      }
    });

    // Click name to toggle select
    listEl.addEventListener('click', e => {
      const nameEl = e.target.closest('.pd-name');
      if (!nameEl) return;
      const key = decodeURIComponent(nameEl.dataset.key);
      const item = pdIndex.find(i => i.key === key);
      if (!item) return;
      const cbx = document.getElementById(`pd-${encodeURIComponent(key)}`);
      if (cbx && !cbx.checked) { cbx.checked = true; show(item); }
      if (selectedKey === key) clearPDSelection();
      else selectPD(item, { zoom: true });
    });

    // Buttons
    btnAll.addEventListener('click', () => {
      document.querySelectorAll('.pd-cbx').forEach(c => c.checked = true);
      pdIndex.forEach(show);
      try {
        map.fitBounds(L.featureGroup(pdIndex.map(i => i.layer)).getBounds(), { padding: [20, 20] });
      } catch {}
    });
    btnClr.addEventListener('click', () => {
      document.querySelectorAll('.pd-cbx').forEach(c => c.checked = false);
      pdIndex.forEach(hide);
      clearPDSelection();
    });

    btnTgl.addEventListener('click', () => {
      const collapsed = controlRoot.classList.toggle('collapsed');
      btnTgl.textContent = collapsed ? 'Expand ▾' : 'Collapse ▴';
    });

    const PD_LABEL_HIDE_ZOOM = 14;
    map.on('zoomend', () => {
      const zoom = map.getZoom();
      if (zoom >= PD_LABEL_HIDE_ZOOM) {
        if (map.hasLayer(selectedLabel)) selectedLabel.remove();
      } else {
        if (selectedItem && !map.hasLayer(selectedLabel)) showPDLabel(selectedItem);
      }
    });

    // === Routing hooks (NEW) ===
    // 1) Registry of PD layers for routing.js to reference by key
    window.PD_REGISTRY = {};
    pdIndex.forEach(i => {
      window.PD_REGISTRY[i.key] = { layer: i.layer, name: i.name };
    });

    // 2) Helper to return [lon, lat, label] for every CHECKED PD
    window.getSelectedPDTargets = function () {
      const boxes = Array.from(document.querySelectorAll('.pd-cbx:checked'));
      const out = [];
      for (const box of boxes) {
        const key = decodeURIComponent(box.dataset.key || '');
        const item = pdIndex.find(i => i.key === key);
        if (!item || !item.layer) continue;
        const c = item.bounds.getCenter();
        out.push([c.lng, c.lat, item.name || key]);
      }
      return out;
    };

  }).catch(err => {
    console.error('Failed to load PDs:', err);
    alert('Could not load PDs. See console for details.');
  });

// ===================== Planning Zones =====================
const ZONES_URL = 'data/tts_zones.json?v=' + Date.now();
const ZONE_LABEL_ZOOM = 14;

let zonesEngaged = false;
const zonesGroup      = L.featureGroup(); // polygons for current PD
const zonesLabelGroup = L.featureGroup(); // label markers for current PD
const zonesByKey      = new Map();        // PD key -> [raw feature,...]
const zoneLookup      = new Map();        // zoneId -> {feature, pdKey}
let selectedZoneLayer = null;

const zoneBaseStyle     = { color: '#2166f3', weight: 2, fillOpacity: 0.08 };
const zoneSelectedStyle = { color: '#0b3aa5', weight: 4, fillOpacity: 0.25 };

// Build indices
fetch(ZONES_URL)
  .then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${r.url || ZONES_URL}`);
    return r.text();
  })
  .then(txt => {
    try { return JSON.parse(txt); }
    catch (e) {
      console.error('Zones JSON parse error:', e, txt.slice(0, 200));
      throw new Error('Invalid Zones GeoJSON');
    }
  })
  .then(zGeo => {
    L.geoJSON(zGeo, {
      onEachFeature: f => {
        const props = f.properties || {};
        const pdKey = pdKeyFromProps(props);
        if (!pdKey) return;

        if (!zonesByKey.has(pdKey)) zonesByKey.set(pdKey, []);
        zonesByKey.get(pdKey).push(f);

        const zId = zoneKeyFromProps(props);
        if (!zoneLookup.has(String(zId))) zoneLookup.set(String(zId), { feature: f, pdKey });
      }
    });

    // Zones control (Engage / Disengage) with inline search on header right
    const ZonesControl = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        const div = L.DomUtil.create('div', 'pd-control');
        div.innerHTML = `
          <div class="pd-header">
            <strong>Planning Zones</strong>
            <div class="pd-actions">
              <button type="button" id="pz-engage">Engage</button>
              <button type="button" id="pz-disengage">Disengage</button>
              <input id="pz-inline-search" class="pz-inline-search" type="text" placeholder="Zone #">
            </div>
          </div>
        `;
        const geocoderEl = document.querySelector('.leaflet-control-geocoder');
        if (geocoderEl) div.style.width = geocoderEl.offsetWidth + 'px';
        L.DomEvent.disableClickPropagation(div);
        return div;
      }
    });
    map.addControl(new ZonesControl());

    const btnEng  = document.getElementById('pz-engage');
    const btnDis  = document.getElementById('pz-disengage');
    const inpZone = document.getElementById('pz-inline-search');

    function setMode(engaged) {
      zonesEngaged = engaged;
      btnEng.classList.toggle('active', engaged);
      btnDis.classList.toggle('active', !engaged);
      if (!engaged) _zonesClear();
    }

    function clearZoneSelection() {
      if (selectedZoneLayer) selectedZoneLayer.setStyle(zoneBaseStyle);
      selectedZoneLayer = null;
      try { map.closePopup(); } catch {}
    }

    function selectZone(layer) {
      if (selectedZoneLayer === layer) { // toggle off
        clearZoneSelection();
        return;
      }
      if (selectedZoneLayer) selectedZoneLayer.setStyle(zoneBaseStyle);
      selectedZoneLayer = layer;
      layer.setStyle(zoneSelectedStyle);
      try { layer.bringToFront?.(); } catch {}
    }

    function updateZoneLabels() {
      const show = map.getZoom() >= ZONE_LABEL_ZOOM;
      if (show) {
        if (!map.hasLayer(zonesLabelGroup)) zonesLabelGroup.addTo(map);
      } else {
        if (map.hasLayer(zonesLabelGroup)) zonesLabelGroup.remove();
      }
    }
    map.on('zoomend', updateZoneLabels);

    // Exposed helpers PD code calls
    window._zonesClear = function _zonesClear() {
      clearZoneSelection();
      zonesGroup.clearLayers();
      zonesLabelGroup.clearLayers();
      if (map.hasLayer(zonesGroup))      zonesGroup.remove();
      if (map.hasLayer(zonesLabelGroup)) zonesLabelGroup.remove();
      try { map.closePopup(); } catch {}
    };

    // Optional focusZoneId triggers highlight + popup + fit to zone
    window._zonesShowFor = function _zonesShowFor(pdKey, focusZoneId = null) {
      if (!zonesEngaged) return;
      const feats = zonesByKey.get(String(pdKey)) || [];

      zonesGroup.clearLayers();
      zonesLabelGroup.clearLayers();
      clearZoneSelection();

      let pendingOpen = null;
      let pendingBounds = null;

      feats.forEach(f => {
        // 1) Polygon
        const poly = L.geoJSON(f, { style: zoneBaseStyle }).getLayers()[0];

        poly.on('click', () => selectZone(poly));
        poly.on('dblclick', (e) => {
          if (typeof window._pdClearSelection === 'function') window._pdClearSelection();
          clearZoneSelection();
          L.DomEvent.stop(e);
          if (e.originalEvent?.preventDefault) e.originalEvent.preventDefault();
        });

        poly.addTo(zonesGroup);

        // 2) Label marker (boxed chip). Popup opens only from label.
        const center = poly.getBounds().getCenter();
        const zName  = zoneKeyFromProps(f.properties || {});
        const labelHtml = `<span class="zone-tag">${String(zName)}</span>`;

        let labelIcon = L.divIcon({
          className: 'zone-label',
          html: labelHtml,
          iconSize: null
        });

        const labelMarker = L.marker(center, {
          icon: labelIcon,
          riseOnHover: true,
          zIndexOffset: 1000
        });

        // Measure chip then center the anchor
        labelMarker.once('add', () => {
          const el = labelMarker.getElement();
          if (!el) return;
          const w = el.offsetWidth  || 24;
          const h = el.offsetHeight || 16;
          const centered = L.divIcon({
            className: 'zone-label',
            html: labelHtml,
            iconSize: [w, h],
            iconAnchor: [w / 2, h / 2]
          });
          labelMarker.setIcon(centered);
        });

        const POPUP_OFFSET_Y = -10;

        labelMarker.on('click', () => {
          const props = f.properties || {};
          if (selectedZoneLayer !== poly) selectZone(poly);
          else poly.setStyle(zoneSelectedStyle);

          const content = `
            <div>
              <strong><u>Planning Zone ${zoneKeyFromProps(props)}</u></strong><br/>
              ${(props?.Reg_name ?? '')}<br/>
              PD: ${(props?.PD_no ?? props?.pd_no ?? '')}
            </div>
          `;
          try { labelMarker.unbindPopup(); } catch {}
          labelMarker
            .bindPopup(content, {
              offset: L.point(0, POPUP_OFFSET_Y),
              autoPan: true,
              closeButton: true,
              keepInView: false,
              maxWidth: 280,
              className: 'zone-popup'
            })
            .openPopup();
        });

        labelMarker.on('dblclick', (e) => {
          if (typeof window._pdClearSelection === 'function') window._pdClearSelection();
          clearZoneSelection();
          try { labelMarker.closePopup(); } catch {}
          L.DomEvent.stop(e);
          if (e.originalEvent?.preventDefault) e.originalEvent.preventDefault();
        });

        // If this is the requested zone: preselect + remember bounds + plan to open popup
        if (focusZoneId && String(zName) === String(focusZoneId)) {
          pendingOpen = () => labelMarker.fire('click');
          pendingBounds = poly.getBounds();
          selectZone(poly);
        }

        labelMarker.addTo(zonesLabelGroup);
      });

      if (zonesGroup.getLayers().length && !map.hasLayer(zonesGroup)) zonesGroup.addTo(map);
      updateZoneLabels();

      if (pendingOpen) setTimeout(pendingOpen, 0);
      if (pendingBounds) {
        map.fitBounds(pendingBounds, { padding: [30, 30], maxZoom: 16 });
      }
    };

    // ---- Inline search (Enter to run) ----
    function parseZoneId(raw) {
      if (!raw) return null;
      const m = String(raw).match(/\d+/);
      return m ? m[0] : null;
    }

    function runZoneSearch() {
      const zId = parseZoneId(inpZone.value);
      if (!zId) return;

      const found = zoneLookup.get(String(zId));
      if (!found) return;

      if (!zonesEngaged) setMode(true);

      const { pdKey } = found;

      // Select PD (zooms to PD)…
      if (typeof window._pdSelectByKey === 'function') {
        window._pdSelectByKey(pdKey, { zoom: true });
      }
      // …then draw zones with focus on zId (highlight + popup + fit to zone)
      if (typeof window._zonesShowFor === 'function') {
        window._zonesShowFor(pdKey, String(zId));
      }
    }

    inpZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runZoneSearch();
    });

    // Start disengaged; buttons toggle
    btnEng.addEventListener('click', () => setMode(true));
    btnDis.addEventListener('click', () => setMode(false));
    setMode(false);
  })
  .catch(err => {
    console.error('Failed to load Planning Zones:', err);
  });
