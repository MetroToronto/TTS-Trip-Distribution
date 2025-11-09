// ===== script.js =====
// Uses your existing sidebar DOM. Loads PD/PZ, builds lists, wires buttons.
// Routing & printing are delegated to window.Routing / window.Report.

(() => {
  // ---- Map ----
  const map = L.map("map", { zoomControl: true }).setView([43.6532, -79.3832], 10);
  window.map = map;

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);

  // ---- Origin handling (from your search bar) ----
  let originLatLng = null;
  const originMarker = L.marker([0,0], { draggable: true, opacity: 0 }).addTo(map);

  function setOrigin(ll) {
    originLatLng = ll;
    originMarker.setLatLng(ll).setOpacity(1);
  }
  originMarker.on("dragend", () => setOrigin(originMarker.getLatLng()));

  // Your existing input + button
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

  // ---- Load PDs & PZs ----
  let pdLayer, pzLayer;
  let pdFeatures = [];
  let pzFeatures = [];

  function featureToCentroidCoords(feature) {
    const type = feature.geometry?.type;
    const coords = feature.geometry?.coordinates;
    const pts = [];
    if (type === "Polygon") {
      (coords?.[0] || []).forEach(([x, y]) => pts.push([x, y]));
    } else if (type === "MultiPolygon") {
      (coords || []).forEach(poly => (poly?.[0] || []).forEach(([x, y]) => pts.push([x, y])));
    } else if (type === "Point") {
      const [x, y] = coords || [];
      return [y, x]; // lat,lng
    }
    if (!pts.length) return null;
    let sx = 0, sy = 0;
    for (const [x, y] of pts) { sx += x; sy += y; }
    const cx = sx / pts.length, cy = sy / pts.length;
    return [cy, cx]; // lat,lng
  }

  function loadPDs() {
    return fetch("data/tts_pds.json")
      .then(r => r.json())
      .then(gj => {
        pdFeatures = gj.features || [];
        if (pdLayer) map.removeLayer(pdLayer);
        pdLayer = L.geoJSON(gj, {
          style: { color: "#1e88e5", weight: 1, fillOpacity: 0.05 }
        }).addTo(map);
        Routing.setPDSource(pdFeatures, featureToCentroidCoords);
        buildPDList(pdFeatures);
      })
      .catch(() => Routing.showToast("Failed to load PDs."));
  }

  function loadPZs() {
    return fetch("data/tts_zones.json")
      .then(r => r.json())
      .then(gj => {
        pzFeatures = gj.features || [];
        if (pzLayer) map.removeLayer(pzLayer);
        pzLayer = L.geoJSON(gj, {
          style: { color: "#43a047", weight: 1, fillOpacity: 0.05 }
        }).addTo(map);
        Routing.setPZSource(pzFeatures, featureToCentroidCoords);
        buildPZList(pzFeatures);
      })
      .catch(() => Routing.showToast("Failed to load Zones."));
  }

  // ---- Build PD/PZ lists into your existing containers ----
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
      count.title = "Routes to request (0–3)";

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
      count.title = "Routes to request (0–3)";

      row.appendChild(box);
      row.appendChild(label);
      row.appendChild(count);
      pzListEl.appendChild(row);
    });
  }

  // ---- Helpers for selection/counts (read from your DOM) ----
  function getSelectedPDIds() {
    return [...document.querySelectorAll(".pd-select:checked")].map(el => el.dataset.id);
  }
  function getSelectedPZIds() {
    return [...document.querySelectorAll(".pz-select:checked")].map(el => el.dataset.id);
  }
  function getPDCounts() {
    const m = {};
    document.querySelectorAll(".pd-row").forEach(r => {
      const id = r.querySelector(".pd-select")?.dataset.id;
      const v = parseInt(r.querySelector(".pd-route-count")?.value || "1", 10);
      if (id != null) m[id] = v;
    });
    return m;
  }
  function getPZCounts() {
    const m = {};
    document.querySelectorAll(".pz-row").forEach(r => {
      const id = r.querySelector(".pz-select")?.dataset.id;
      const v = parseInt(r.querySelector(".pz-route-count")?.value || "1", 10);
      if (id != null) m[id] = v;
    });
    return m;
  }

  // ---- Wire your existing buttons ----
  const btnPD = document.querySelector("#btn-generate-pd");
  const btnPZ = document.querySelector("#btn-generate-pz");
  const btnClear = document.querySelector("#btn-clear-routes");
  const btnPrint = document.querySelector("#btn-print-report");
  const reverseToggle = document.querySelector("#toggle-reverse");
  const rankSelect = document.querySelector("#rank-mode"); // "fastest" | "shortest"

  btnPD?.addEventListener("click", () => {
    Routing.generateFor("pd", {
      originLatLng,
      selectedIds: getSelectedPDIds(),
      countsById: getPDCounts(),
      reverse: !!reverseToggle?.checked,
      rankMode: rankSelect?.value === "shortest" ? "shortest" : "fastest",
    });
  });

  btnPZ?.addEventListener("click", () => {
    Routing.generateFor("pz", {
      originLatLng,
      selectedIds: getSelectedPZIds(),
      countsById: getPZCounts(),
      reverse: !!reverseToggle?.checked,
      rankMode: rankSelect?.value === "shortest" ? "shortest" : "fastest",
    });
  });

  btnClear?.addEventListener("click", () => Routing.clearRoutes());
  btnPrint?.addEventListener("click", () => Report.openPrintableModal(Routing.getAllResults()));

  // ---- Bootstrap ----
  Promise.all([loadPDs(), loadPZs()]).then(() => {
    // ready
  });
})();
