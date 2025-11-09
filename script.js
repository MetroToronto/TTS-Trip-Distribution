/* script.js — Leaflet controls for PD & PZ, origin pin + optional geocoder,
   PD route-count (0–3) beside each name, and App getters for routing.js/report.js. */
(function (global) {
  'use strict';

  // ------------------ MAP BOOT (safe) ------------------
  var map = global.map;
  if (!map || typeof map.addLayer !== 'function') {
    var mapHost = document.getElementById('map');
    if (!mapHost) {
      mapHost = document.createElement('div');
      mapHost.id = 'map';
      mapHost.style.position = 'fixed';
      mapHost.style.inset = '0';
      document.body.appendChild(mapHost);
    }
    map = L.map(mapHost, { zoomControl: true });
    global.map = map;
  }
  var START = [43.7000, -79.4000]; // Toronto-ish
  try { map.setView(START, 10); } catch(_) {}

  try {
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 20, attribution: '&copy; OpenStreetMap'
    }).addTo(map);
  } catch(_) {}

  // ------------------ ORIGIN MARKER + GEOCODER ------------------
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
  if (global.ROUTING_ORIGIN && isFinite(global.ROUTING_ORIGIN.lat) && isFinite(global.ROUTING_ORIGIN.lon)) {
    setOrigin(global.ROUTING_ORIGIN.lat, global.ROUTING_ORIGIN.lon);
  } else {
    setOrigin(START[0], START[1]);
  }

  try {
    if (L.Control && L.Control.Geocoder && L.Control.Geocoder.nominatim) {
      L.Control.geocoder({ defaultMarkGeocode: false })
        .on('markgeocode', function (e) {
          var c = e.geocode.center; // {lat,lng}
          map.setView(c, 12);
          setOrigin(c.lat, c.lng);
        })
        .addTo(map);
    }
  } catch(_) {}

  // ------------------ DATA ------------------
  var PD_URL = '/data/tts_pds.json';
  var PZ_URL = '/data/tts_zones.json';

  var PD_FEATURES = [];
  var PZ_FEATURES = [];
  var PD_REGISTRY = Object.create(null);   // key -> { feature, layer }
  var zoneLookup = new Map();              // zoneId(string) -> { feature }

  // Outlines layer groups
  var pdOutlineGroup = L.layerGroup().addTo(map);
  var pzOutlineGroup = L.layerGroup().addTo(map);

  Promise.all([
    fetch(PD_URL).then(function(r){return r.ok?r.json():null}).catch(function(){return null}),
    fetch(PZ_URL).then(function(r){return r.ok?r.json():null}).catch(function(){return null})
  ]).then(function(res){
    var pd = res[0], pz = res[1];

    if (pd && pd.features && pd.features.length) {
      PD_FEATURES = pd.features.slice();
      // draw outlines + build registry
      PD_FEATURES.forEach(function(f){
        var key = String((f.properties && (f.properties.id || f.properties.PD || f.properties.name)) || '');
        var poly = L.geoJSON(f, { style:{ color:'#2E86AB', weight:1, fill:false, opacity:0.5 } }).addTo(pdOutlineGroup);
        PD_REGISTRY[key] = { feature:f, layer: poly.getLayers()[0] || poly };
      });
      addPDControl(); // build the PD Leaflet control
    }

    if (pz && pz.features && pz.features.length) {
      PZ_FEATURES = pz.features.slice();
      PZ_FEATURES.forEach(function(f){
        var zid = String((f.properties && (f.properties.id || f.properties.zone)) || '').trim();
        if (zid) zoneLookup.set(zid, { feature: f });
      });
      addPZControl(); // build the PZ Leaflet control
    }
  });

  // ------------------ PD CONTROL (Leaflet) ------------------
  function addPDControl() {
    var PDControl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        var c = L.DomUtil.create('div', 'leaflet-bar rt-card');
        c.innerHTML =
          '<div class="rt-title">Planning Districts</div>' +
          '<div class="rt-row rt-gap">' +
          '  <button id="pd-select-all" class="rt-btn">Select all</button>' +
          '  <button id="pd-clear-all"  class="rt-btn">Clear all</button>' +
          '</div>' +
          '<div id="pd-list" class="rt-scroll"></div>';
        L.DomEvent.disableClickPropagation(c);

        // Build rows
        var list = c.querySelector('#pd-list');
        var idx = PD_FEATURES.map(function(f){
          var key = String((f.properties && (f.properties.id || f.properties.PD || f.properties.name)) || '');
          var name = String((f.properties && (f.properties.name || f.properties.PD || key)) || key);
          return { key:key, name:name };
        }).sort(function(a,b){ return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });

        list.innerHTML = idx.map(function(i){
          return '' +
          '<div class="pd-item">' +
          '  <input type="checkbox" class="pd-cbx" id="pd-'+ encodeURIComponent(i.key) +'" data-key="'+ encodeURIComponent(i.key) +'" checked>' +
          '  <span class="pd-name" data-key="'+ encodeURIComponent(i.key) +'">'+ esc(i.name) +'</span>' +
          '  <input type="number" class="pd-count" value="1" min="0" max="3" step="1" title="Routes (0–3)">' +
          '</div>';
        }).join('');

        // enable/disable count with checkbox
        list.addEventListener('change', function(e){
          if (!e.target.classList.contains('pd-cbx')) return;
          var row = e.target.closest('.pd-item');
          var cnt = row && row.querySelector('.pd-count');
          if (!cnt) return;
          if (e.target.checked) { cnt.disabled = false; if (cnt.value === '0') cnt.value = '1'; }
          else { cnt.disabled = true; cnt.value = '0'; }
        });

        c.querySelector('#pd-select-all').addEventListener('click', function(){
          list.querySelectorAll('.pd-item').forEach(function(row){
            var cbx = row.querySelector('.pd-cbx');
            var cnt = row.querySelector('.pd-count');
            cbx.checked = true;
            if (cnt) { cnt.disabled = false; if (cnt.value === '0') cnt.value = '1'; }
          });
          // zoom to all PD bounds
          try {
            var layers = Object.keys(PD_REGISTRY).map(function(k){ return PD_REGISTRY[k].layer; });
            map.fitBounds(L.featureGroup(layers).getBounds(), { padding:[18,18] });
          } catch(_) {}
        });

        c.querySelector('#pd-clear-all').addEventListener('click', function(){
          list.querySelectorAll('.pd-item').forEach(function(row){
            var cbx = row.querySelector('.pd-cbx');
            var cnt = row.querySelector('.pd-count');
            cbx.checked = false;
            if (cnt) { cnt.value = '0'; cnt.disabled = true; }
          });
        });

        return c;
      }
    });
    map.addControl(new PDControl());
  }

  // ------------------ PZ CONTROL (Leaflet) ------------------
  // UI is intentionally unchanged: Engage / Disengage + Zone # input
  var pzEngaged = false;
  function addPZControl() {
    var PZControl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        var c = L.DomUtil.create('div', 'leaflet-bar rt-card');
        c.innerHTML =
          '<div class="rt-title">Planning Zones</div>' +
          '<div class="rt-row rt-gap">' +
          '  <button id="pz-engage" class="rt-btn">Engage</button>' +
          '  <button id="pz-disengage" class="rt-btn">Disengage</button>' +
          '</div>' +
          '<input type="text" id="pz-inline-search" class="rt-input" placeholder="Zone #">';
        L.DomEvent.disableClickPropagation(c);

        c.querySelector('#pz-engage').addEventListener('click', function(){
          pzEngaged = true;
          toast('PZ engaged');
        });
        c.querySelector('#pz-disengage').addEventListener('click', function(){
          pzEngaged = false;
          toast('PZ disengaged');
        });
        return c;
      }
    });
    map.addControl(new PZControl());

    // Optional: draw very light outlines on engage (for context)
    // (We leave it empty by default to keep things fast.)
  }

  // ------------------ PUBLIC API FOR ROUTING ------------------
  function clamp(n, lo, hi){ n = Number(n); if (!Number.isFinite(n)) n = lo; return Math.max(lo, Math.min(hi, Math.trunc(n))); }

  // Return array of { id, label, coords:[lon,lat], count }
  function getPDRequests() {
    var rows = Array.from(document.querySelectorAll('.pd-item'));
    return rows.map(function(row){
      var keyEnc = row.querySelector('.pd-cbx')?.dataset?.key || '';
      var key = decodeURIComponent(keyEnc);
      var id  = key;
      var label = (row.querySelector('.pd-name')?.textContent || key).trim();
      var checked = !!row.querySelector('.pd-cbx')?.checked;
      var cntRaw = parseInt(row.querySelector('.pd-count')?.value || '0', 10);
      var cnt = checked ? clamp(cntRaw, 0, 3) : 0;

      var reg = PD_REGISTRY[id];
      var lon = NaN, lat = NaN;
      if (reg && reg.layer) {
        var cen = reg.layer.getBounds().getCenter();
        lon = cen.lng; lat = cen.lat;
      }
      return { id:id, label:label, coords:[lon,lat], count:cnt };
    });
  }

  // Return single PZ target if Zone # present + engaged; else []
  function getPZRequests() {
    if (!pzEngaged) return [];
    var inp = document.getElementById('pz-inline-search');
    var raw = (inp && inp.value || '').trim();
    if (!raw) return [];
    var id = (raw.match(/\d+/) || [null])[0];
    if (!id) return [];
    var hit = zoneLookup.get(String(id));
    if (!hit) return [];
    var poly = L.geoJSON(hit.feature).getLayers()[0];
    var c = poly.getBounds().getCenter();
    return [{ id:String(id), label:'PZ ' + String(id), coords:[c.lng, c.lat], count:1 }];
  }

  global.App = Object.assign({}, global.App, {
    getPDRequests: getPDRequests,
    getPZRequests: getPZRequests
  });

  // ------------------ UTILITIES ------------------
  function toast(msg) {
    var t = document.getElementById('rt-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'rt-toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#222;color:#fff;padding:8px 12px;border-radius:10px;z-index:9999;opacity:0;transition:.25s';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    setTimeout(function(){ t.style.opacity = '0'; }, 1800);
  }

  function esc(s){ return String(s).replace(/[&<>"']/g, function(m){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[m]; }); }

  // Inject minimal styling that matches your cards
  (function injectCSS(){
    var css =
      '.rt-card{background:#fff;border-radius:14px;padding:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);min-width:260px;margin:8px 6px}' +
      '.rt-title{font-weight:700;margin-bottom:8px}' +
      '.rt-row{display:flex;align-items:center}' +
      '.rt-gap{gap:8px;margin-bottom:8px}' +
      '.rt-btn{padding:6px 10px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer}' +
      '.rt-input{width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:10px}' +
      '.rt-scroll{max-height:260px;overflow:auto;border-top:1px solid #eee;padding-top:6px}' +
      '.pd-item{display:flex;align-items:center;gap:8px;padding:4px 2px}' +
      '.pd-item .pd-name{flex:1}' +
      '.pd-item .pd-count{width:48px;text-align:right}';
    var tag = document.createElement('style'); tag.textContent = css; document.head.appendChild(tag);
  })();

})(window);
