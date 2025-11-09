/* script.js — map boot, PD panel (with 0–3 count box), PZ panel (unchanged),
   origin pin + optional geocoder, and App getters for routing.js */
(function (global) {
  'use strict';

  // =============== MAP SETUP (safe) ===============
  var map = global.map;
  if (!map || typeof map.addLayer !== 'function') {
    var mapHost = document.getElementById('map');
    if (!mapHost) {
      mapHost = document.createElement('div');
      mapHost.id = 'map';
      mapHost.style.position = 'fixed';
      mapHost.style.left = '0';
      mapHost.style.top = '0';
      mapHost.style.right = '0';
      mapHost.style.bottom = '0';
      document.body.appendChild(mapHost);
    }
    map = L.map(mapHost, { zoomControl: true });
    global.map = map;
  }

  var START = [43.7000, -79.4000]; // Toronto-ish
  try { map.setView(START, 10); } catch (_) {}

  try {
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 20,
      attribution: '&copy; OpenStreetMap'
    }).addTo(map);
  } catch (_) {}

  // =============== ORIGIN MARKER + OPTIONAL GEOCODER ===============
  var originMarker = null;
  function setOrigin(lat, lon) {
    try { if (originMarker) originMarker.remove(); } catch (_) {}
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

  // Only if leaflet-control-geocoder is present; harmless if not.
  try {
    if (L.Control && L.Control.Geocoder && L.Control.Geocoder.nominatim) {
      L.Control.geocoder({ defaultMarkGeocode: false })
        .on('markgeocode', function (e) {
          var c = e.geocode.center; // {lat, lng}
          map.setView(c, 12);
          setOrigin(c.lat, c.lng);
        })
        .addTo(map);
    }
  } catch (_) {}

  // =============== DATA LOAD ===============
  var PD_URL = '/data/tts_pds.json';
  var PZ_URL = '/data/tts_zones.json';

  var PD_FEATURES = [];
  var PZ_FEATURES = [];
  var PZ_INDEX = {}; // zoneId(lowercase) -> feature

  Promise.all([
    fetch(PD_URL).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
    fetch(PZ_URL).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
  ]).then(function (arr) {
    var pd = arr[0], pz = arr[1];

    if (pd && pd.features && pd.features.length) {
      PD_FEATURES = pd.features.slice();
      buildPDPanel();
      // optional outlines
      try { L.geoJSON(pd, { style: { color: '#2E86AB', weight: 1, opacity: 0.5, fill: false } }).addTo(map); } catch (_) {}
    }

    if (pz && pz.features && pz.features.length) {
      PZ_FEATURES = pz.features.slice();
      for (var i = 0; i < PZ_FEATURES.length; i++) {
        var f = PZ_FEATURES[i];
        var zid = String((f.properties && (f.properties.id || f.properties.zone)) || '').trim().toLowerCase();
        if (zid) PZ_INDEX[zid] = f;
      }
      buildPZPanel();
    }
  });

  // =============== PD PANEL (checkbox + count box on the right) ===============
  function buildPDPanel() {
    var panel = document.getElementById('pd-panel') || createCard('pd-panel');
    panel.innerHTML =
      '<div class="card-title">Planning Districts</div>' +
      '<div class="btn-row">' +
      '  <button id="pd-select-all" class="btn">Select all</button>' +
      '  <button id="pd-clear-all"  class="btn">Clear all</button>' +
      '</div>' +
      '<div id="pd-list" class="scroll-list"></div>';

    var list = panel.querySelector('#pd-list');

    var items = PD_FEATURES.slice().sort(function (a, b) {
      var an = String((a.properties && (a.properties.name || a.properties.PD || a.properties.id)) || '').toLowerCase();
      var bn = String((b.properties && (b.properties.name || b.properties.PD || b.properties.id)) || '').toLowerCase();
      return an < bn ? -1 : (an > bn ? 1 : 0);
    });

    for (var i = 0; i < items.length; i++) {
      var f = items[i];
      var id = String((f.properties && (f.properties.id || f.properties.PD || f.properties.name)) || '');
      var label = String((f.properties && (f.properties.name || f.properties.PD || id)) || id);
      var cen = centroidLL(f.geometry); // [lon,lat]

      var row = document.createElement('div');
      row.className = 'pd-item';
      row.setAttribute('data-id', id);
      row.setAttribute('data-label', label);
      row.setAttribute('data-centroid', cen[0] + ',' + cen[1]);

      row.innerHTML =
        '<label class="pd-row">' +
        '  <input type="checkbox" class="pd-check" checked>' +
        '  <span class="pd-name">' + esc(label) + '</span>' +
        '  <input type="number" class="pd-count" value="1" min="0" max="3" step="1" title="Routes (0–3)">' +
        '</label>';

      var chk = row.querySelector('.pd-check');
      var cnt = row.querySelector('.pd-count');
      chk.addEventListener('change', function () {
        var p = this.parentNode;
        var c = p.querySelector('.pd-count');
        if (this.checked) { c.disabled = false; if (c.value === '0') c.value = '1'; }
        else { c.value = '0'; c.disabled = true; }
      });

      list.appendChild(row);
    }

    var selAll = panel.querySelector('#pd-select-all');
    var clrAll = panel.querySelector('#pd-clear-all');

    selAll.addEventListener('click', function () {
      var rows = list.querySelectorAll('.pd-item');
      for (var j = 0; j < rows.length; j++) {
        var r = rows[j];
        var chk = r.querySelector('.pd-check');
        var cnt = r.querySelector('.pd-count');
        chk.checked = true;
        cnt.disabled = false;
        if (cnt.value === '0') cnt.value = '1';
      }
    });

    clrAll.addEventListener('click', function () {
      var rows = list.querySelectorAll('.pd-item');
      for (var j = 0; j < rows.length; j++) {
        var r = rows[j];
        var chk = r.querySelector('.pd-check');
        var cnt = r.querySelector('.pd-count');
        chk.checked = false;
        cnt.value = '0';
        cnt.disabled = true;
      }
    });

    injectCSS(
      '#pd-panel{background:#fff;border-radius:14px;padding:12px;box-shadow:0 2px 12px rgba(0,0,0,.08)}' +
      '#pd-panel .card-title{font-weight:700;margin-bottom:8px}' +
      '#pd-panel .btn-row{display:flex;gap:8px;margin-bottom:8px}' +
      '#pd-panel .btn{padding:6px 10px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer}' +
      '#pd-panel .scroll-list{max-height:260px;overflow:auto;border-top:1px solid #eee;padding-top:6px}' +
      '#pd-panel .pd-row{display:flex;align-items:center;gap:8px;padding:4px 2px}' +
      '#pd-panel .pd-name{flex:1}' +
      '#pd-panel .pd-count{width:48px;text-align:right}'
    );
  }

  // =============== PZ PANEL (unchanged UI) ===============
  function buildPZPanel() {
    var panel = document.getElementById('pz-panel') || createCard('pz-panel');
    panel.innerHTML =
      '<div class="card-title">Planning Zones</div>' +
      '<div class="btn-row">' +
      '  <button id="pz-engage" class="btn">Engage</button>' +
      '  <button id="pz-disengage" class="btn">Disengage</button>' +
      '</div>' +
      '<input type="text" id="pz-input" placeholder="Zone #" class="pz-input">';

    injectCSS(
      '#pz-panel{background:#fff;border-radius:14px;padding:12px;box-shadow:0 2px 12px rgba(0,0,0,.08)}' +
      '#pz-panel .card-title{font-weight:700;margin-bottom:8px}' +
      '#pz-panel .btn-row{display:flex;gap:8px;margin-bottom:8px}' +
      '#pz-panel .btn{padding:6px 10px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer}' +
      '#pz-panel .pz-input{width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:10px}'
    );
  }

  // =============== PUBLIC API (used by routing.js) ===============
  global.App = {
    // returns [{ id, label, coords:[lon,lat], count }]
    getPDRequests: function () {
      var rows = document.querySelectorAll('#pd-list .pd-item');
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        var el = rows[i];
        var id = el.getAttribute('data-id') || '';
        var label = el.getAttribute('data-label') || id;
        var parts = (el.getAttribute('data-centroid') || '').split(',');
        var lon = Number(parts[0]), lat = Number(parts[1]);
        var checked = el.querySelector('.pd-check') && el.querySelector('.pd-check').checked;
        var cntRaw = parseInt((el.querySelector('.pd-count') && el.querySelector('.pd-count').value) || '0', 10);
        var cnt = checked ? clamp(cntRaw, 0, 3) : 0;
        out.push({ id: id, label: label, coords: [lon, lat], count: cnt });
      }
      return out;
    },
    // returns single item array if zone # is valid, else []
    getPZRequests: function () {
      var input = document.getElementById('pz-input');
      if (!input) return [];
      var v = (input.value || '').trim();
      if (!v) return [];
      var hit = PZ_INDEX[v.toLowerCase()];
      if (!hit) return [];
      var cen = centroidLL(hit.geometry);
      return [{ id: v, label: 'PZ ' + v, coords: cen, count: 1 }];
    }
  };

  // =============== HELPERS ===============
  function createCard(id) {
    var host = document.getElementById('left-col') || document.body;
    var el = document.createElement('div');
    el.id = id;
    el.style.margin = '10px';
    host.appendChild(el);
    return el;
  }

  function centroidLL(geom) {
    if (!geom) return [NaN, NaN];
    var polys = [];
    if (geom.type === 'Polygon') polys.push(geom.coordinates);
    else if (geom.type === 'MultiPolygon') {
      for (var i = 0; i < geom.coordinates.length; i++) polys.push(geom.coordinates[i]);
    } else return [NaN, NaN];

    var A = 0, Cx = 0, Cy = 0;
    for (var p = 0; p < polys.length; p++) {
      var outer = polys[p][0] || [];
      for (var i = 0, j = outer.length - 1; i < outer.length; j = i++) {
        var x1 = outer[j][0], y1 = outer[j][1];
        var x2 = outer[i][0], y2 = outer[i][1];
        var cross = x1 * y2 - x2 * y1;
        A += cross;
        Cx += (x1 + x2) * cross;
        Cy += (y1 + y2) * cross;
      }
    }
    A = A / 2;
    if (Math.abs(A) < 1e-9) {
      var first = polys[0] && polys[0][0] ? polys[0][0] : [];
      var sx = 0, sy = 0, n = first.length || 1;
      for (var k = 0; k < first.length; k++) { sx += first[k][0]; sy += first[k][1]; }
      return [sx / n, sy / n];
    }
    return [Cx / (6 * A), Cy / (6 * A)];
  }

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) n = lo;
    if (n < lo) n = lo;
    if (n > hi) n = hi;
    return Math.trunc(n);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
    });
  }

  function injectCSS(cssText) {
    var tag = document.createElement('style');
    tag.appendChild(document.createTextNode(cssText));
    document.head.appendChild(tag);
  }

})(window);
