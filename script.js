// ===== script.js =====
// Map init + PD/PZ controls + origin search.
// Routing & reporting are delegated to window.Routing and window.Report (see routing.js/report.js).

(() => {
  // ---- Map ----
  const map = L.map("map", { zoomControl: true }).setView([43.6532, -79.3832], 10);
  window.map = map; // expose for other modules

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);

  // ---- Geocoder / Origin ----
  let originLatLng = null;
  const originMarker = L.marker([0,0], { draggable: true, opacity: 0 }).addTo(map);

  function setOrigin(latlng) {
    originLatLng = latlng;
    originMarker.setLatLng(latlng).setOpacity(1);
  }

  // Simple input search (use your existing geocoder if you have it)
  const searchInput = document.querySelector("#origin-input");
  const searchBtn = document.querySelector("#origin-search-btn");
  searchBtn?.addEventListener("click", async () => {
    const q = (searchInput?.value || "").trim();
    if (!q) return;
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}`);
      const rows = await r.json();
      if (rows?.length) {
        const { lat, lon } = rows[0];
        const ll = [parseFloat(lat), parseFloat(lon)];
        setOrigin(ll);
        map.setView(ll, 12);
      } else {
        Routing.showToast("Address not found.");
      }
    } catch (e) {
      Routing.showToast("Geocoding failed.");
    }
  });

  // ---- Load PDs & PZs (GeoJSON) ----
  let pdLayer, pzLayer;
  let pdFeatures = [];
  let pzFeatures = [];

  function featureToCentroidCoords(feature) {
    // fallback centroid (simple average) for polygons/multipolygons
    const type = feature.geometry?.type;
    const coords = feature.geometry?.coordinates;
    const collect = [];

    if (type === "Polygon") {
      coords[0].forEach(([x, y]) => collect.push([x, y]));
    } else if (type === "MultiPolygon") {
      coords.forEach(poly => poly[0].forEach(([x, y]) => collect.push([x, y])));
    } else if (type === "Point") {
      const [x, y] = coords;
      return [y, x]; // Leaflet lat,lng
    }

    if (!collect.length) return null;
    let sx = 0, sy = 0;
    for (const [x, y] of collect) { sx += x; sy += y; }
    const cx = sx / collect.length;
    const cy = sy / collect.length;
    return [cy, cx]; // Leaflet lat,lng
  }

  function loadPDs() {
    return fetch("data/tts_pds.json")
      .then(r => r.json())
      .then(gj => {
        pdFeatures = gj.features || [];
        pdLayer = L.geoJSON(gj, {
          style: { color: "#1e88e5", weight: 1, fillOpacity: 0.05 }
        }).addTo(map);
        Routing.setPDSource(pdFeatures, featureToCentroidCoords);
        buildPDList(pdFeatures);
      });
  }

  function loadPZs() {
    return fetch("data/tts_zones.json")
      .then(r => r.json())
      .then(gj => {
        pzFeatures = gj.features || [];
        pzLayer = L.geoJSON(gj, {
          style: { color: "#43a047", weight: 1, fillOpacity: 0.05 }
        }).addTo(map);
        Routing.setPZSource(pzFeatures, featureToCentroidCoords);
        buildPZList(pzFeatures);
      });
  }

  // ---- PD & PZ selection UIs ----
  const pdListEl = document.querySelector("#pd-list");
  const pzListEl = document.querySelector("#pz-list");

  function buildPDList(features) {
    if (!pdListEl) return;
    pdListEl.innerHTML = "";
    features.forEach((f, idx) => {
      const id = f.properties?.PD_ID ?? idx;
      const name = f.properties?.PD_NAME ?? `PD ${id}`;
      const row = document.createElement("div");
      row.className = "pd-row";

      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "pd-select";
      box.dataset.id = String(id);

      const label = document.createElement("label");
      label.textContent = name;

      const count = document.createElement("input");
      count.type = "number";
      count.min = "0"; count.max = "3"; count.step = "1";
      count.value = "1";
      count.className = "pd-route-count";
      count.title = "0–3 alternative routes to request for this PD";

      row.appendChild(box);
      row.appendChild(label);
      row.appendChild(count);
      pdListEl.appendChild(row);
    });
  }

  function buildPZList(features) {
    if (!pzListEl) return;
    pzListEl.innerHTML = "";
    features.forEach((f, idx) => {
      const id = f.properties?.ZONE_ID ?? idx;
      const name = f.properties?.ZONE_NAME ?? `Zone ${id}`;
      const row = document.createElement("div");
      row.className = "pz-row";

      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "pz-select";
      box.dataset.id = String(id);

      const label = document.createElement("label");
      label.textContent = name;

      const count = document.createElement("input");
      count.type = "number";
      count.min = "0"; count.max = "3"; count.step = "1";
      count.value = "1";
      count.className = "pz-route-count";
      count.title = "0–3 alternative routes to request for this Zone";

      row.appendChild(box);
      row.appendChild(label);
      row.appendChild(count);
      pzListEl.appendChild(row);
    });
  }

  function getSelectedPDIds() {
    return [...document.querySelectorAll(".pd-select:checked")].map(el => el.dataset.id);
  }
  function getSelectedPZIds() {
    return [...document.querySelectorAll(".pz-select:checked")].map(el => el.dataset.id);
  }

  function getPDRouteCounts() {
    const mapCounts = {};
    document.querySelectorAll(".pd-row").forEach(row => {
      const id = row.querySelector(".pd-select")?.dataset.id;
      const num = parseInt(row.querySelector(".pd-route-count")?.value || "1", 10);
      if (id != null) mapCounts[id] = num;
    });
    return mapCounts;
  }

  function getPZRouteCounts() {
    const mapCounts = {};
    document.querySelectorAll(".pz-row").forEach(row => {
      const id = row.querySelector(".pz-select")?.dataset.id;
      const num = parseInt(row.querySelector(".pz-route-count")?.value || "1", 10);
      if (id != null) mapCounts[id] = num;
    });
    return mapCounts;
  }

  // ---- Routing controls (buttons + reverse + ranking) ----
  const btnPD = document.querySelector("#btn-generate-pd");
  const btnPZ = document.querySelector("#btn-generate-pz");
  const reverseToggle = document.querySelector("#toggle-reverse");
  const rankSelect = document.querySelector("#rank-mode"); // "fastest" | "shortest"
  const btnClearRoutes = document.querySelector("#btn-clear-routes");
  const btnPrint = document.querySelector("#btn-print-report");

  btnPD?.addEventListener("click", () => {
    Routing.generateFor("pd", {
      originLatLng,
      selectedIds: getSelectedPDIds(),
      countsById: getPDRouteCounts(),
      reverse: !!reverseToggle?.checked,
      rankMode: rankSelect?.value === "shortest" ? "shortest" : "fastest",
    });
  });

  btnPZ?.addEventListener("click", () => {
    Routing.generateFor("pz", {
      originLatLng,
      selectedIds: getSelectedPZIds(),
      countsById: getPZRouteCounts(),
      reverse: !!reverseToggle?.checked,
      rankMode: rankSelect?.value === "shortest" ? "shortest" : "fastest",
    });
  });

  btnClearRoutes?.addEventListener("click", () => {
    Routing.clearRoutes();
  });

  btnPrint?.addEventListener("click", () => {
    Report.openPrintableModal(Routing.getAllResults());
  });

  // ---- Bootstrap ----
  Promise.all([loadPDs(), loadPZs()]).then(() => {
    // ready
  });

})();
