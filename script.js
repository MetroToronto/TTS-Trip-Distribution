/* script.js — PD/PZ Leaflet controls only.
   - PD: checkbox list + 0–3 route count beside each name
   - PZ: Engage/Disengage + inline "Zone #" search
   - Geocoder sets window.ROUTING_ORIGIN
   - Exposes App.getPDRequests() / App.getPZRequests() (no routing/report UI here)
*/
(function (global) {
  'use strict';

  // ---------------- Map boot (safe) ----------------
  var map = global.map;
  if (!map || typeof map.addLayer !== 'function') {
    var host = document.getElementById('map') || (function () {
      var d = document.createElement('div'); d.id = 'map';
      d.style.cssText = 'position:fixed;inset:0;'; document.body.appendChild(d); return d;
    })();
    map = L.map(host, { zoomControl: true });
    global.map = map;
  }
  var START = [43.7000, -79.4000];
  map.setView(START, 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 20, attribution: '© OpenStreetMap'
  }).addTo(map);

  // ---------------- Origin marker + geocoder ----------------
  var originMarker = null;
  function setOrigin(lat, lon) {
    try { if (originMarker) originMarker.remove(); } catch(_) {}
    originMarker = L.marker([lat, lon], { draggable: true }).addTo(map);
    originMarker.on('dragend', function () {
      var p = originMarker.getLatLng();
      global.ROUTING_ORIGIN = { lat: p.lat, lon: p.lng };
    });
    global.ROUTING_ORIGIN = { lat: lat, lon: lon };
  }
  setOrigin(START[0], START[1]);

  try {
    if (L.Control && L.Control.Geocoder && L.Control.Geocoder.nominatim) {
      L.Control.geocoder({ defaultMarkGeocode: false })
        .on('markgeocode', function (e) {
          var c = e.geocode.center;
          map.setView(c, 12);
          setOrigin(c.lat, c.lng);
        })
        .addTo(map);
    }
  } catch(_) {}

  // ---------------- Data ----------------
  var PD_URL = '/data/tts_pds.json';
  var PZ_URL = '/data/tts_zones.json';

  var PD_FEATURES = [];
  var PD_REGISTRY = Object.create(null); // key -> {feature, layer}
  var ZONES_BY_PD = new Map();           // pdKey -> features[]
  var ZONE_LOOKUP = new Map();           // zoneId(string) -> {feature, pdKey}

  // ---------------- Helpers ----------------
  function pdKey(p){
    return String(p?.PD_no ?? p?.pd_no ?? p?.PD ?? p?.PD_ID ?? p?.PD_name ?? p?.name ?? '').trim();
  }
  function zoneKey(p){
    return String(p?.TTS2022 ?? p?.ZONE ?? p?.ZONE_ID ?? p?.Zone ?? p?.Z_ID ?? '').trim();
  }
  function clamp(n, lo, hi){ n = Number(n); if (!Number.isFinite(n)) n = lo; return Math.max(lo, Math.min(hi, Math.trunc(n))); }
  function esc(s){ return String(s).replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }

  // ---------------- Planning Districts control ----------------
  var pdGroup = L.layerGroup().addTo(map);

  fetch(PD_URL).then(r=>r.ok?r.json():Promise.reject(r.status)).then(function(geo){
    PD_FEATURES = (geo && geo.features) ? geo.features.slice() : [];

    // draw and index
    var baseStyle = { color:'#ff6600', weight:2, fill:false, opacity:0.6 };
    PD_FEATURES.forEach(function(f){
      var key = pdKey(f.properties || {});
      var name = String(f.properties?.PD_name || f.properties?.name || key || 'PD');
      var gj = L.geoJSON(f, { style: baseStyle }).addTo(pdGroup);
      var layer = gj.getLayers()[0] || gj;
      PD_REGISTRY[key] = { feature:f, layer:layer, name:name };
    });

    addPDControl();
    try {
      map.fitBounds(pdGroup.getBounds(), { padding:[20,20] });
    } catch(_) {}
  }).catch(function(e){ console.error('PD load failed', e); });

  function addPDControl(){
    var PDControl = L.Control.extend({
      options:{ position:'topright' },
      onAdd: function(){
        var c = L.DomUtil.create('div', 'rt-card');
        c.innerHTML = [
          '<div class="rt-title">Planning Districts</div>',
          '<div class="rt-row rt-gap">',
          '  <button id="pd-select-all" class="rt-btn">Select all</button>',
          '  <button id="pd-clear-all"  class="rt-btn">Clear all</button>',
          '  <button id="pd-toggle"     class="rt-btn grow">Expand ▾</button>',
          '</div>',
          '<div id="pd-list" class="rt-scroll"></div>'
        ].join('');
        L.DomEvent.disableClickPropagation(c);

        // build rows (sorted by name)
        var list = c.querySelector('#pd-list');
        var rows = Object.keys(PD_REGISTRY).map(function(k){
          return { key:k, name:PD_REGISTRY[k].name };
        }).sort(function(a,b){ return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });

        list.innerHTML = rows.map(function(i){
          return ''+
          '<div class="pd-item">'+
          '  <input type="checkbox" class="pd-cbx" data-key="'+ encodeURIComponent(i.key) +'" checked>'+
          '  <span class="pd-name" data-key="'+ encodeURIComponent(i.key) +'">'+ esc(i.name) +'</span>'+
          '  <input type="number" class="pd-count" value="1" min="0" max="3" step="1" title="Routes (0–3)">'+
          '</div>';
        }).join('');

        // checkbox toggles map + count enabled
        list.addEventListener('change', function(e){
          if (!e.target.classList.contains('pd-cbx')) return;
          var key = decodeURIComponent(e.target.dataset.key || '');
          var row = e.target.closest('.pd-item');
          var cnt = row && row.querySelector('.pd-count');
          var reg = PD_REGISTRY[key];
          if (e.target.checked) {
            if (cnt) { cnt.disabled = false; if (cnt.value === '0') cnt.value = '1'; }
            if (reg && reg.layer && !pdGroup.hasLayer(reg.layer)) reg.layer.addTo(pdGroup);
          } else {
            if (cnt) { cnt.value = '0'; cnt.disabled = true; }
            if (reg && reg.layer && pdGroup.hasLayer(reg.layer)) pdGroup.removeLayer(reg.layer);
          }
        });

        // name click just toggles checkbox + keeps same behavior
        list.addEventListener('click', function(e){
          var nameEl = e.target.closest('.pd-name'); if (!nameEl) return;
          var key = decodeURIComponent(nameEl.dataset.key || '');
          var cbx = list.querySelector('.pd-cbx[data-key="'+ encodeURIComponent(key) +'"]');
          if (!cbx) return;
          cbx.checked = !cbx.checked;
          cbx.dispatchEvent(new Event('change'));
        });

        // buttons
        c.querySelector('#pd-select-all').addEventListener('click', function(){
          list.querySelectorAll('.pd-item').forEach(function(row){
            var cbx = row.querySelector('.pd-cbx');
            var cnt = row.querySelector('.pd-count');
            cbx.checked = true;
            if (cnt) { cnt.disabled = false; if (cnt.value === '0') cnt.value = '1'; }
          });
          Object.keys(PD_REGISTRY).forEach(function(k){
            var reg = PD_REGISTRY[k]; if (reg && reg.layer && !pdGroup.hasLayer(reg.layer)) reg.layer.addTo(pdGroup);
          });
        });
        c.querySelector('#pd-clear-all').addEventListener('click', function(){
          list.querySelectorAll('.pd-item').forEach(function(row){
            var cbx = row.querySelector('.pd-cbx');
            var cnt = row.querySelector('.pd-count');
            cbx.checked = false;
            if (cnt) { cnt.value = '0'; cnt.disabled = true; }
          });
          pdGroup.clearLayers();
        });

        // Expand/Collapse
        var btnT = c.querySelector('#pd-toggle');
        var collapsed = true;
        function setCollapsed(v){
          collapsed = !!v;
          c.querySelector('#pd-list').style.display = collapsed ? 'none' : '';
          btnT.textContent = collapsed ? 'Expand ▾' : 'Collapse ▴';
        }
        btnT.addEventListener('click', function(){ setCollapsed(!collapsed); });
        setCollapsed(true);

        return c;
      }
    });
    map.addControl(new PDControl());
  }

  // ---------------- Planning Zones control ----------------
  var zonesEngaged = false;
  var zonesGroup = L.layerGroup();
  var labelsGroup = L.layerGroup();
  var ZOOM_LABELS = 14;

  fetch(PZ_URL).then(r=>r.ok?r.json():Promise.reject(r.status)).then(function(geo){
    // index by PD and by Zone id
    (geo.features||[]).forEach(function(f){
      var p = f.properties || {};
      var pk = pdKey(p);
      if (!ZONES_BY_PD.has(pk)) ZONES_BY_PD.set(pk, []);
      ZONES_BY_PD.get(pk).push(f);
      var zid = zoneKey(p);
      if (zid) ZONE_LOOKUP.set(String(zid), { feature:f, pdKey:pk });
    });
    addPZControl();
  }).catch(function(e){ console.error('PZ load failed', e); });

  function addPZControl(){
    var PZControl = L.Control.extend({
      options:{ position:'topright' },
      onAdd: function(){
        var c = L.DomUtil.create('div', 'rt-card');
        c.innerHTML = [
          '<div class="rt-title">Planning Zones</div>',
          '<div class="rt-row rt-gap">',
          '  <button id="pz-engage" class="rt-btn">Engage</button>',
          '  <button id="pz-disengage" class="rt-btn">Disengage</button>',
          '</div>',
          '<input id="pz-inline-search" class="rt-input" type="text" placeholder="Zone #">'
        ].join('');
        L.DomEvent.disableClickPropagation(c);
        return c;
      }
    });
    map.addControl(new PZControl());

    var btnOn = document.getElementById('pz-engage');
    var btnOff= document.getElementById('pz-disengage');
    var inp   = document.getElementById('pz-inline-search');

    btnOn.addEventListener('click', function(){ zonesEngaged = true; toast('PZ engaged'); });
    btnOff.addEventListener('click', function(){ zonesEngaged = false; clearZones(); });

    inp.addEventListener('keydown', function(e){
      if (e.key !== 'Enter') return;
      var m = (inp.value||'').match(/\d+/);
      var zid = m ? m[0] : null;
      if (!zid) return;
      var hit = ZONE_LOOKUP.get(String(zid));
      if (!hit) return;
      zonesEngaged = true;
      drawZonesForPD(hit.pdKey, String(zid));
    });

    map.on('zoomend', function(){
      var show = map.getZoom() >= ZOOM_LABELS;
      if (show) { if (!map.hasLayer(labelsGroup)) labelsGroup.addTo(map); }
      else { if (map.hasLayer(labelsGroup)) labelsGroup.remove(); }
    });
  }

  function clearZones(){
    zonesGroup.clearLayers();
    labelsGroup.clearLayers();
    if (map.hasLayer(zonesGroup)) map.removeLayer(zonesGroup);
    if (map.hasLayer(labelsGroup)) map.removeLayer(labelsGroup);
  }

  function drawZonesForPD(pdKey, focusZoneId){
    if (!zonesEngaged) return;
    clearZones();

    var feats = ZONES_BY_PD.get(String(pdKey)) || [];
    feats.forEach(function(f){
      var poly = L.geoJSON(f, { style:{ color:'#2166f3', weight:2, fillOpacity:0.08 } }).getLayers()[0];
      poly.addTo(zonesGroup);

      var c = poly.getBounds().getCenter();
      var zid = zoneKey(f.properties||{});
      var label = L.marker(c, {
        icon: L.divIcon({ className:'zone-label', html:'<span class="zone-tag">'+ esc(zid) +'</span>', iconSize:null })
      });
      label.addTo(labelsGroup);

      if (focusZoneId && String(zid) === String(focusZoneId)) {
        map.fitBounds(poly.getBounds(), { padding:[20,20], maxZoom:16 });
        setTimeout(function(){ label.fire('click'); }, 0);
      }

      label.on('click', function(){
        var props = f.properties||{};
        var html = '<div><b>Planning Zone '+ esc(zid) +'</b><br/>PD: '+ esc(String(props.PD_no ?? props.pd_no ?? '')) +'</div>';
        label.bindPopup(html, { offset: L.point(0,-10) }).openPopup();
      });
    });

    if (!map.hasLayer(zonesGroup)) zonesGroup.addTo(map);
    if (map.getZoom() >= ZOOM_LABELS && !map.hasLayer(labelsGroup)) labelsGroup.addTo(map);
  }

  // ---------------- Public getters for routing.js ----------------
  global.App = Object.assign({}, global.App, {
    // [{ id, label, coords:[lon,lat], count }]
    getPDRequests: function(){
      var rows = Array.from(document.querySelectorAll('#pd-list .pd-item'));
      return rows.map(function(row){
        var key = decodeURIComponent(row.querySelector('.pd-cbx')?.dataset?.key || '');
        var label = (row.querySelector('.pd-name')?.textContent || key).trim();
        var checked = !!row.querySelector('.pd-cbx')?.checked;
        var raw = parseInt(row.querySelector('.pd-count')?.value || '0', 10);
        var count = checked ? clamp(raw, 0, 3) : 0;
        var reg = PD_REGISTRY[key];
        var lon = NaN, lat = NaN;
        if (reg && reg.layer) { var c = reg.layer.getBounds().getCenter(); lon = c.lng; lat = c.lat; }
        return { id:key, label:label, coords:[lon,lat], count:count };
      });
    },
    // 0 or 1 PZ target, depending on Engage + Zone #
    getPZRequests: function(){
      var engaged = zonesEngaged;
      var inp = document.getElementById('pz-inline-search');
      var raw = (inp && inp.value || '').trim();
      if (!engaged || !raw) return [];
      var m = raw.match(/\d+/); var zid = m ? m[0] : null; if (!zid) return [];
      var hit = ZONE_LOOKUP.get(String(zid)); if (!hit) return [];
      var poly = L.geoJSON(hit.feature).getLayers()[0]; var c = poly.getBounds().getCenter();
      return [{ id:String(zid), label:'PZ ' + String(zid), coords:[c.lng, c.lat], count:1 }];
    }
  });

  // legacy helper (if anything still calls it)
  global.getSelectedPDTargets = function(){
    var out = [];
    var rows = Array.from(document.querySelectorAll('#pd-list .pd-item .pd-cbx:checked'));
    rows.forEach(function(cbx){
      var key = decodeURIComponent(cbx.dataset.key || '');
      var reg = PD_REGISTRY[key];
      if (reg && reg.layer) {
        var c = reg.layer.getBounds().getCenter();
        out.push([c.lng, c.lat, reg.name || key]);
      }
    });
    return out;
  };

  // ---------------- Tiny styles ----------------
  (function injectCSS(){
    var css =
      '.rt-card{background:#fff;border-radius:14px;padding:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);min-width:260px;margin:8px 6px}' +
      '.rt-title{font-weight:700;margin-bottom:8px}' +
      '.rt-row{display:flex;align-items:center}' +
      '.rt-gap{gap:8px;margin-bottom:8px}' +
      '.rt-btn{padding:6px 10px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer}' +
      '.rt-input{width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:10px}' +
      '#pd-list.rt-scroll{max-height:260px;overflow:auto;border-top:1px solid #eee;padding-top:6px}' +
      '.pd-item{display:flex;align-items:center;gap:8px;padding:4px 2px}' +
      '.pd-item .pd-name{flex:1}' +
      '.pd-item .pd-count{width:48px;text-align:right}' +
      '.zone-label .zone-tag{background:#fff;border:1px solid #ccc;border-radius:8px;padding:2px 6px;font:12px/1.2 system-ui}' ;
    var tag = document.createElement('style'); tag.textContent = css; document.head.appendChild(tag);
  })();

  // simple toast
  function toast(msg){ var t=document.getElementById('rt-toast'); if(!t){t=document.createElement('div');t.id='rt-toast';t.style.cssText='position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#222;color:#fff;padding:8px 12px;border-radius:10px;z-index:9999;opacity:0;transition:.25s';document.body.appendChild(t);} t.textContent=msg; t.style.opacity='1'; setTimeout(function(){t.style.opacity='0';},1600); }

})(window);
