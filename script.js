// ===== script.js =====
(function () {
  // ---- Map ----
  var map = L.map("map", { zoomControl: true }).setView([43.6532, -79.3832], 10);
  window.map = map;

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);

  // ---- Local toast (fallback if Routing isn't loaded yet) ----
  function toast(msg) {
    var host = document.getElementById("routing-toast-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "routing-toast-host";
      host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:99999;display:flex;flex-direction:column;gap:8px;";
      document.body.appendChild(host);
    }
    var card = document.createElement("div");
    card.textContent = msg;
    card.style.cssText = "background:#323232;color:#fff;padding:8px 12px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.25);font:14px/1.4 system-ui;";
    host.appendChild(card);
    setTimeout(function () { if (card && card.parentNode) card.parentNode.removeChild(card); }, 3000);
  }
  function safeRoutingCall(fnName, argsArray) {
    if (!window.Routing || typeof window.Routing[fnName] !== "function") {
      toast("App is still loading… try again in a moment.");
      return;
    }
    return window.Routing[fnName].apply(window.Routing, argsArray || []);
  }

  // ---- Origin handling ----
  var originLatLng = null;
  var originMarker = L.marker([0,0], { draggable: true, opacity: 0 }).addTo(map);
  function setOrigin(ll) {
    originLatLng = ll;
    originMarker.setLatLng(ll).setOpacity(1);
  }
  originMarker.on("dragend", function () { setOrigin(originMarker.getLatLng()); });

  var searchInput = document.getElementById("origin-input");
  var searchBtn = document.getElementById("origin-search-btn");
  if (searchBtn) {
    searchBtn.addEventListener("click", function () {
      var q = (searchInput && searchInput.value ? searchInput.value : "").trim();
      if (!q) return;
      fetch("https://nominatim.openstreetmap.org/search?format=json&q=" + encodeURIComponent(q))
        .then(function (r) { return r.json(); })
        .then(function (rows) {
          if (rows && rows.length) {
            var lat = parseFloat(rows[0].lat);
            var lon = parseFloat(rows[0].lon);
            var ll = [lat, lon];
            setOrigin(ll);
            map.setView(ll, 12);
          } else {
            if (window.Routing && window.Routing.showToast) window.Routing.showToast("Address not found.");
            else toast("Address not found.");
          }
        })
        .catch(function () {
          if (window.Routing && window.Routing.showToast) window.Routing.showToast("Geocoding failed.");
          else toast("Geocoding failed.");
        });
    });
  }

  // ---- Data loading ----
  var pdLayer, pzLayer;
  var pdFeatures = [];
  var pzFeatures = [];

  function featureToCentroidCoords(feature) {
    var type = feature && feature.geometry ? feature.geometry.type : null;
    var coords = feature && feature.geometry ? feature.geometry.coordinates : null;
    var pts = [];
    if (type === "Polygon" && coords && coords[0]) {
      for (var i=0;i<coords[0].length;i++) { pts.push([coords[0][i][0], coords[0][i][1]]); }
    } else if (type === "MultiPolygon" && coords) {
      for (var p=0;p<coords.length;p++) {
        var poly = coords[p];
        if (poly && poly[0]) {
          for (var j=0;j<poly[0].length;j++) { pts.push([poly[0][j][0], poly[0][j][1]]); }
        }
      }
    } else if (type === "Point" && coords && coords.length === 2) {
      return [coords[1], coords[0]]; // lat,lng
    }
    if (!pts.length) return null;
    var sx = 0, sy = 0;
    for (var k=0;k<pts.length;k++) { sx += pts[k][0]; sy += pts[k][1]; }
    var cx = sx / pts.length, cy = sy / pts.length;
    return [cy, cx];
  }

  function loadPDs() {
    return fetch("data/tts_pds.json")
      .then(function (r) { return r.json(); })
      .then(function (gj) {
        pdFeatures = gj && gj.features ? gj.features : [];
        if (pdLayer) map.removeLayer(pdLayer);
        pdLayer = L.geoJSON(gj, { style: { color: "#1e88e5", weight: 1, fillOpacity: 0.05 } }).addTo(map);
        safeRoutingCall("setPDSource", [pdFeatures, featureToCentroidCoords]);
        buildPDList(pdFeatures);
      })
      .catch(function () {
        if (window.Routing && window.Routing.showToast) window.Routing.showToast("Failed to load PDs.");
        else toast("Failed to load PDs.");
      });
  }

  function loadPZs() {
    return fetch("data/tts_zones.json")
      .then(function (r) { return r.json(); })
      .then(function (gj) {
        pzFeatures = gj && gj.features ? gj.features : [];
        if (pzLayer) map.removeLayer(pzLayer);
        pzLayer = L.geoJSON(gj, { style: { color: "#43a047", weight: 1, fillOpacity: 0.05 } }).addTo(map);
        safeRoutingCall("setPZSource", [pzFeatures, featureToCentroidCoords]);
        buildPZList(pzFeatures);
      })
      .catch(function () {
        if (window.Routing && window.Routing.showToast) window.Routing.showToast("Failed to load Zones.");
        else toast("Failed to load Zones.");
      });
  }

  // ---- Build lists into existing containers ----
  var pdListEl = document.getElementById("pd-list");
  var pzListEl = document.getElementById("pz-list");

  function buildPDList(features) {
    if (!pdListEl) return;
    pdListEl.innerHTML = "";
    for (var i=0;i<features.length;i++) {
      var f = features[i];
      var id = (f.properties && f.properties.PD_ID != null) ? f.properties.PD_ID : i;
      var name = (f.properties && f.properties.PD_NAME) ? f.properties.PD_NAME : ("PD " + id);

      var row = document.createElement("div");
      row.className = "pd-row";

      var box = document.createElement("input");
      box.type = "checkbox";
      box.className = "pd-select";
      box.setAttribute("data-id", String(id));

      var label = document.createElement("label");
      label.textContent = name;

      var count = document.createElement("input");
      count.type = "number";
      count.min = "0"; count.max = "3"; count.step = "1";
      count.value = "1";
      count.className = "pd-route-count";
      count.title = "Routes to request (0–3)";

      row.appendChild(box);
      row.appendChild(label);
      row.appendChild(count);
      pdListEl.appendChild(row);
    }
  }

  function buildPZList(features) {
    if (!pzListEl) return;
    pzListEl.innerHTML = "";
    for (var i=0;i<features.length;i++) {
      var f = features[i];
      var id = (f.properties && f.properties.ZONE_ID != null) ? f.properties.ZONE_ID : i;
      var name = (f.properties && f.properties.ZONE_NAME) ? f.properties.ZONE_NAME : ("Zone " + id);

      var row = document.createElement("div");
      row.className = "pz-row";

      var box = document.createElement("input");
      box.type = "checkbox";
      box.className = "pz-select";
      box.setAttribute("data-id", String(id));

      var label = document.createElement("label");
      label.textContent = name;

      var count = document.createElement("input");
      count.type = "number";
      count.min = "0"; count.max = "3"; count.step = "1";
      count.value = "1";
      count.className = "pz-route-count";
      count.title = "Routes to request (0–3)";

      row.appendChild(box);
      row.appendChild(label);
      row.appendChild(count);
      pzListEl.appendChild(row);
    }
  }

  // ---- Helpers to read selection/counts ----
  function getSelectedPDIds() {
    var els = document.querySelectorAll(".pd-select:checked");
    var out = [];
    for (var i=0;i<els.length;i++) out.push(els[i].getAttribute("data-id"));
    return out;
  }
  function getSelectedPZIds() {
    var els = document.querySelectorAll(".pz-select:checked");
    var out = [];
    for (var i=0;i<els.length;i++) out.push(els[i].getAttribute("data-id"));
    return out;
  }
  function getPDCounts() {
    var out = {};
    var rows = document.querySelectorAll(".pd-row");
    for (var i=0;i<rows.length;i++) {
      var row = rows[i];
      var sel = row.querySelector(".pd-select");
      var cnt = row.querySelector(".pd-route-count");
      if (sel) {
        var id = sel.getAttribute("data-id");
        var v = parseInt(cnt && cnt.value ? cnt.value : "1", 10);
        out[id] = v;
      }
    }
    return out;
  }
  function getPZCounts() {
    var out = {};
    var rows = document.querySelectorAll(".pz-row");
    for (var i=0;i<rows.length;i++) {
      var row = rows[i];
      var sel = row.querySelector(".pz-select");
      var cnt = row.querySelector(".pz-route-count");
      if (sel) {
        var id = sel.getAttribute("data-id");
        var v = parseInt(cnt && cnt.value ? cnt.value : "1", 10);
        out[id] = v;
      }
    }
    return out;
  }

  // ---- Wire buttons (no optional chaining) ----
  var btnPD = document.getElementById("btn-generate-pd");
  var btnPZ = document.getElementById("btn-generate-pz");
  var btnClear = document.getElementById("btn-clear-routes");
  var btnPrint = document.getElementById("btn-print-report");
  var reverseToggle = document.getElementById("toggle-reverse");
  var rankSelect = document.getElementById("rank-mode");

  if (btnPD) btnPD.addEventListener("click", function () {
    safeRoutingCall("generateFor", ["pd", {
      originLatLng: originLatLng,
      selectedIds: getSelectedPDIds(),
      countsById: getPDCounts(),
      reverse: !!(reverseToggle && reverseToggle.checked),
      rankMode: (rankSelect && rankSelect.value === "shortest") ? "shortest" : "fastest"
    }]);
  });

  if (btnPZ) btnPZ.addEventListener("click", function () {
    safeRoutingCall("generateFor", ["pz", {
      originLatLng: originLatLng,
      selectedIds: getSelectedPZIds(),
      countsById: getPZCounts(),
      reverse: !!(reverseToggle && reverseToggle.checked),
      rankMode: (rankSelect && rankSelect.value === "shortest") ? "shortest" : "fastest"
    }]);
  });

  if (btnClear) btnClear.addEventListener("click", function () {
    safeRoutingCall("clearRoutes", []);
  });

  if (btnPrint) btnPrint.addEventListener("click", function () {
    if (!window.Report || typeof window.Report.openPrintableModal !== "function") {
      toast("Report module is still loading…");
      return;
    }
    var results = safeRoutingCall("getAllResults", []);
    window.Report.openPrintableModal(results || []);
  });

  // ---- Bootstrap ----
  Promise.all([loadPDs(), loadPZs()]).then(function () { /* ready */ });
})();
