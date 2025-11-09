// ===== routing.js =====
(function () {
  var DEFAULT_ORS_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=";

  function readKey() {
    var url = new URL(window.location.href);
    var fromUrl = url.searchParams.get("orsKey");
    if (fromUrl) return fromUrl;
    var fromLS = localStorage.getItem("orsKey");
    if (fromLS) return fromLS;
    return DEFAULT_ORS_KEY;
  }

  function ensureToastHost() {
    var host = document.getElementById("routing-toast-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "routing-toast-host";
      host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:99999;display:flex;flex-direction:column;gap:8px;";
      document.body.appendChild(host);
    }
    return host;
  }
  function showToast(msg, ms) {
    if (ms == null) ms = 3000;
    var host = ensureToastHost();
    var card = document.createElement("div");
    card.textContent = msg;
    card.style.cssText = "background:#323232;color:#fff;padding:8px 12px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.25);font:14px/1.4 system-ui;";
    host.appendChild(card);
    setTimeout(function () { if (card && card.parentNode) card.parentNode.removeChild(card); }, ms);
  }

  function openModal(opts) {
    opts = opts || {};
    var title = opts.title || "Notice";
    var html = opts.html || "";
    var onClose = opts.onClose;

    var mask = document.createElement("div");
    mask.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:99998;";
    var box = document.createElement("div");
    box.style.cssText = "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:99999;";
    var panel = document.createElement("div");
    panel.style.cssText = "background:#fff;max-width:720px;width:calc(100% - 48px);max-height:80vh;overflow:auto;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);";
    panel.innerHTML = '' +
      '<div style="padding:16px 20px;border-bottom:1px solid #eee;font:600 16px system-ui">' + title + '</div>' +
      '<div style="padding:16px 20px;font:14px/1.5 system-ui">' + html + '</div>' +
      '<div style="padding:12px 20px;border-top:1px solid #eee;display:flex;justify-content:flex-end;gap:8px">' +
      '  <button id="routing-modal-close" style="padding:8px 12px;border-radius:8px;border:1px solid #ccc;background:#fafafa;cursor:pointer">Close</button>' +
      '</div>';
    box.appendChild(panel);
    function close() {
      if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
      if (box && box.parentNode) box.parentNode.removeChild(box);
      if (onClose) onClose();
    }
    mask.addEventListener("click", close);
    panel.querySelector("#routing-modal-close").addEventListener("click", close);
    document.body.appendChild(mask);
    document.body.appendChild(box);
    return { close: close };
  }

  // Guard: don’t proceed until the map exists
  if (!window.map) {
    // Defer registration very slightly to let script.js run first
    return setTimeout(function () { if (!window.Routing) (function(){})(); }, 50);
  }

  // Sources provided by script.js
  var PD_FEATURES = [];
  var PZ_FEATURES = [];
  var centroidFromFeature = null;

  function setPDSource(features, centroidFn) {
    PD_FEATURES = features || [];
    centroidFromFeature = centroidFn;
  }
  function setPZSource(features, centroidFn) {
    PZ_FEATURES = features || [];
    centroidFromFeature = centroidFn;
  }
  function findFeatureById(list, idKey, idVal) {
    for (var i=0;i<list.length;i++) {
      var f = list[i];
      if (String(f.properties && f.properties[idKey]) === String(idVal)) return f;
    }
    for (var j=0;j<list.length;j++) {
      if (String(j) === String(idVal)) return list[j];
    }
    return null;
  }

  // Request queue
  var QUEUE = [];
  var queueRunning = false;
  var SPACING_MS = 1600;

  function pumpQueue() {
    if (queueRunning) return;
    queueRunning = true;
    (function next() {
      if (!QUEUE.length) { queueRunning = false; return; }
      var job = QUEUE.shift();
      Promise.resolve()
        .then(job)
        .catch(function(e){ console.error(e); })
        .then(function(){ setTimeout(next, SPACING_MS); });
    })();
  }
  function enqueue(fn) { QUEUE.push(fn); pumpQueue(); }

  // Layers + cache
  var routeGroup = L.layerGroup().addTo(window.map);
  var Results = [];

  function clearRoutes() {
    routeGroup.clearLayers();
    Results.length = 0;
    showToast("Cleared routes.");
  }
  function getAllResults() {
    var out = [];
    for (var i=0;i<Results.length;i++) {
      var x = Results[i];
      var rr = [];
      for (var j=0;j<x.routes.length;j++) {
        rr.push({ distance: x.routes[j].distance, duration: x.routes[j].duration });
      }
      out.push({ type: x.type, id: x.id, name: x.name, count: x.count, rankMode: x.rankMode, reverse: x.reverse, routes: rr });
    }
    return out;
  }

  // ORS
  function orsDirections(opts) {
    var key = readKey();
    var count = Math.max(1, Math.min(3, (opts.count || 1)));
    var preference = (opts.rankMode === "shortest") ? "shortest" : "fastest";
    var body = {
      coordinates: [opts.originLngLat, opts.destLngLat],
      preference: preference,
      instructions: false,
      geometry: true,
      elevation: false,
      alternative_routes: { target_count: count, share_factor: 0.6, weight_factor: 2 }
    };
    return fetch("https://api.openrouteservice.org/v2/directions/driving-car/geojson", {
      method: "POST",
      headers: { "Authorization": key, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
    .then(function (r) {
      if (!r.ok) return r.text().then(function(t){ throw new Error("ORS error " + r.status + ": " + t); });
      return r.json();
    })
    .then(function (gj) {
      var features = (gj && gj.features) ? gj.features : [];
      var out = [];
      for (var i=0;i<features.length;i++) {
        var f = features[i];
        out.push({
          distance: f.properties && f.properties.summary ? f.properties.summary.distance : 0,
          duration: f.properties && f.properties.summary ? f.properties.summary.duration : 0,
          coordinates: f.geometry && f.geometry.coordinates ? f.geometry.coordinates : []
        });
      }
      return out;
    });
  }

  function latLngToLngLat(ll) { return [ll[1], ll[0]]; }

  function addPolyline(coords, colorIndex) {
    var latlngs = [];
    for (var i=0;i<coords.length;i++) latlngs.push([coords[i][1], coords[i][0]]);
    var colors = ["#2962ff", "#00b8d4", "#7c4dff"];
    var dashes = [null, "6,6", "2,8"];
    return L.polyline(latlngs, {
      color: colors[colorIndex % colors.length],
      weight: colorIndex === 0 ? 4 : 3,
      opacity: 0.9,
      dashArray: dashes[colorIndex] || null
    }).addTo(routeGroup);
  }

  function validateCounts(selectedIds, countsById, labelById) {
    var bad = [];
    for (var i=0;i<selectedIds.length;i++) {
      var id = selectedIds[i];
      var n = countsById && countsById[id];
      if ([0,1,2,3].indexOf(Number(n)) === -1) {
        bad.push((labelById[id] || id) + " (value: " + n + ")");
      }
    }
    if (bad.length) {
      openModal({
        title: "Trip generation not possible",
        html: '<p>Please use only <strong>0, 1, 2, or 3</strong> in the route-count boxes.</p>' +
              '<p>Invalid entries:</p><ul><li>' + bad.join("</li><li>") + "</li></ul>"
      });
      return false;
    }
    return true;
  }

  function generateFor(type, cfg) {
    if (!window.map) { showToast("Map not ready."); return; }
    if (!cfg || !cfg.originLatLng || !isFinite(cfg.originLatLng[0]) || !isFinite(cfg.originLatLng[1])) {
      showToast("Set an origin address first.");
      return;
    }
    var originLatLng = cfg.originLatLng;
    var selectedIds = cfg.selectedIds || [];
    var countsById = cfg.countsById || {};
    var reverse = !!cfg.reverse;
    var rankMode = (cfg.rankMode === "shortest") ? "shortest" : "fastest";

    var isPD = (type === "pd");
    var list = isPD ? PD_FEATURES : PZ_FEATURES;
    var idKey = isPD ? "PD_ID" : "ZONE_ID";
    var nameKey = isPD ? "PD_NAME" : "ZONE_NAME";

    var labelById = {};
    var centroidById = {};

    for (var i=0;i<selectedIds.length;i++) {
      var id = selectedIds[i];
      var feat = findFeatureById(list, idKey, id);
      if (!feat) continue;
      labelById[id] = (feat.properties && feat.properties[nameKey]) ? feat.properties[nameKey] : ((isPD ? "PD " : "Zone ") + id);
      var c = centroidFromFeature ? centroidFromFeature(feat) : null;
      if (c) centroidById[id] = c;
    }

    if (!validateCounts(selectedIds, countsById, labelById)) return;

    var jobs = 0;
    for (var j=0;j<selectedIds.length;j++) {
      (function () {
        var id = selectedIds[j];
        var count = Number(countsById[id] != null ? countsById[id] : 1);
        if (count === 0) return;
        var dest = centroidById[id];
        if (!dest) return;
        jobs++;

        enqueue(function () {
          var a = latLngToLngLat(originLatLng);
          var b = latLngToLngLat(dest);
          var originLngLat = reverse ? b : a;
          var destLngLat = reverse ? a : b;

          return orsDirections({ originLngLat: originLngLat, destLngLat: destLngLat, count: count, rankMode: rankMode })
            .then(function (alts) {
              var rec = { type: type, id: id, name: labelById[id], count: count, rankMode: rankMode, reverse: reverse, routes: [] };
              for (var k=0;k<Math.min(count, alts.length);k++) {
                var r = alts[k];
                var line = addPolyline(r.coordinates, k);
                rec.routes.push({ distance: r.distance, duration: r.duration, line: line });
              }
              Results.push(rec);
              showToast(labelById[id] + ": " + rec.routes.length + " route(s) added.");
            })
            .catch(function (e) {
              console.error(e);
              showToast(labelById[id] + ": routing failed.");
            });
        });
      })();
    }

    if (jobs === 0) showToast("Nothing to route (check selections and counts).");
    else showToast("Queued " + jobs + " routing job(s).");
  }

  // Public API
  window.Routing = {
    setPDSource: setPDSource,
    setPZSource: setPZSource,
    generateFor: generateFor,
    clearRoutes: clearRoutes,
    getAllResults: getAllResults,
    showToast: showToast
  };
})();
