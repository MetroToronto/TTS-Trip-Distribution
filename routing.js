// ===== routing.js =====
// OpenRouteService Directions v2 routing with alternatives (max 3), reverse toggle,
// per-PD/PZ route counts validation, a simple request queue, and a small in-page modal.
// Exposes a global window.Routing.

(function () {
  const DEFAULT_ORS_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=";

  // ---- Key management (URL ?orsKey= overrides; else localStorage 'orsKey'; else default) ----
  function readKey() {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get("orsKey");
    if (fromUrl) return fromUrl;
    const fromLS = localStorage.getItem("orsKey");
    if (fromLS) return fromLS;
    return DEFAULT_ORS_KEY;
  }

  // ---- Simple toast + modal ----
  function ensureToastHost() {
    let host = document.querySelector("#routing-toast-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "routing-toast-host";
      host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:99999;display:flex;flex-direction:column;gap:8px;";
      document.body.appendChild(host);
    }
    return host;
  }
  function showToast(msg, ms = 3000) {
    const host = ensureToastHost();
    const card = document.createElement("div");
    card.textContent = msg;
    card.style.cssText = "background:#323232;color:#fff;padding:8px 12px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.25);font:14px/1.4 system-ui;";
    host.appendChild(card);
    setTimeout(() => { card.remove(); }, ms);
  }

  function openModal(opts) {
    const { title = "Notice", html = "", onClose } = opts || {};
    let mask = document.createElement("div");
    mask.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:99998;";
    let box = document.createElement("div");
    box.style.cssText = "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:99999;";
    let panel = document.createElement("div");
    panel.style.cssText = "background:#fff;max-width:720px;width:calc(100% - 48px);max-height:80vh;overflow:auto;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);";
    panel.innerHTML = `
      <div style="padding:16px 20px;border-bottom:1px solid #eee;font:600 16px system-ui">${title}</div>
      <div style="padding:16px 20px;font:14px/1.5 system-ui">${html}</div>
      <div style="padding:12px 20px;border-top:1px solid #eee;display:flex;justify-content:flex-end;gap:8px">
        <button id="routing-modal-close" style="padding:8px 12px;border-radius:8px;border:1px solid #ccc;background:#fafafa;cursor:pointer">Close</button>
      </div>`;
    box.appendChild(panel);
    function close() {
      mask.remove();
      box.remove();
      onClose && onClose();
    }
    mask.addEventListener("click", close);
    box.querySelector("#routing-modal-close").addEventListener("click", close);
    document.body.appendChild(mask);
    document.body.appendChild(box);
    return { close };
  }

  // ---- PD/PZ sources from script.js ----
  let PD_FEATURES = [];
  let PZ_FEATURES = [];
  let centroidFromFeature = null;

  function setPDSource(features, centroidFn) {
    PD_FEATURES = features || [];
    centroidFromFeature = centroidFn;
  }
  function setPZSource(features, centroidFn) {
    PZ_FEATURES = features || [];
    centroidFromFeature = centroidFn;
  }
  function findFeatureById(list, idKey, idVal) {
    return list.find(f => String(f.properties?.[idKey]) === String(idVal)) ||
           list.find((_, i) => String(i) === String(idVal));
  }

  // ---- Routing queue (throttle ~1.6s to respect ~40 req/min) ----
  const QUEUE = [];
  let queueRunning = false;
  const SPACING_MS = 1600;

  async function pumpQueue() {
    if (queueRunning) return;
    queueRunning = true;
    while (QUEUE.length) {
      const job = QUEUE.shift();
      try {
        // eslint-disable-next-line no-await-in-loop
        await job();
      } catch (e) {
        console.error(e);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, SPACING_MS));
    }
    queueRunning = false;
  }

  function enqueue(fn) {
    QUEUE.push(fn);
    pumpQueue();
  }

  // ---- Draw layers & cache ----
  const routeGroup = L.layerGroup().addTo(window.map);
  const Results = []; // array of { type:'pd'|'pz', id, name, count, rankMode, reverse, routes:[{distance,duration,coordinates,line}] }

  function clearRoutes() {
    routeGroup.clearLayers();
    Results.length = 0;
    showToast("Cleared routes.");
  }

  function getAllResults() {
    return Results.map(x => ({
      type: x.type, id: x.id, name: x.name, count: x.count, rankMode: x.rankMode, reverse: x.reverse,
      routes: x.routes.map(r => ({ distance: r.distance, duration: r.duration }))
    }));
  }

  // ---- ORS Directions v2 call with alternatives ----
  async function orsDirections({ originLngLat, destLngLat, count, rankMode }) {
    const key = readKey();
    const preference = (rankMode === "shortest") ? "shortest" : "fastest";

    const body = {
      coordinates: [originLngLat, destLngLat],
      preference,
      instructions: false,
      geometry: true,
      elevation: false,
      alternative_routes: {
        target_count: Math.max(1, Math.min(3, count || 1)),
        share_factor: 0.6,
        weight_factor: 2
      }
    };

    const r = await fetch("https://api.openrouteservice.org/v2/directions/driving-car/geojson", {
      method: "POST",
      headers: {
        "Authorization": key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const text = await r.text();
      throw new Error(`ORS error ${r.status}: ${text}`);
    }

    const gj = await r.json();
    // ORS returns FeatureCollection with 1..N features (alternatives)
    const features = gj.features || [];
    // Map to {distance,duration,coordinates}
    return features.map(feat => ({
      distance: feat.properties?.summary?.distance ?? 0,
      duration: feat.properties?.summary?.duration ?? 0,
      coordinates: feat.geometry?.coordinates ?? []
    }));
  }

  function latLngToLngLat(ll) { return [ll[1], ll[0]]; }

  function addPolyline(coords, colorIndex) {
    // coords: [ [lng,lat], ... ]
    const latlngs = coords.map(([lng, lat]) => [lat, lng]);
    const colors = ["#2962ff", "#00b8d4", "#7c4dff"];
    const dashes = [null, "6,6", "2,8"];
    const line = L.polyline(latlngs, {
      color: colors[colorIndex % colors.length],
      weight: colorIndex === 0 ? 4 : 3,
      opacity: 0.9,
      dashArray: dashes[colorIndex] || null
    }).addTo(routeGroup);
    return line;
  }

  function validateCounts(selectedIds, countsById, labelById) {
    const bad = [];
    selectedIds.forEach(id => {
      const n = countsById?.[id];
      if (![0,1,2,3].includes(Number(n))) {
        bad.push(`${labelById[id] ?? id} (value: ${n})`);
      }
    });
    if (bad.length) {
      openModal({
        title: "Trip generation not possible",
        html: `<p>Please use only <strong>0, 1, 2, or 3</strong> in the route-count boxes.</p>
               <p>Invalid entries:</p>
               <ul>${bad.map(x => `<li>${x}</li>`).join("")}</ul>`
      });
      return false;
    }
    return true;
  }

  // ---- Main entry ----
  async function generateFor(type, { originLatLng, selectedIds, countsById, reverse, rankMode }) {
    if (!window.map) { showToast("Map not ready."); return; }
    if (!originLatLng || !isFinite(originLatLng[0]) || !isFinite(originLatLng[1])) {
      showToast("Set an origin address first.");
      return;
    }

    const isPD = type === "pd";
    const list = isPD ? PD_FEATURES : PZ_FEATURES;
    const idKey = isPD ? "PD_ID" : "ZONE_ID";
    const nameKey = isPD ? "PD_NAME" : "ZONE_NAME";

    const labelById = {};
    const centroidById = {};

    selectedIds.forEach(id => {
      const feat = findFeatureById(list, idKey, id);
      if (!feat) return;
      labelById[id] = feat.properties?.[nameKey] ?? `${isPD ? "PD" : "Zone"} ${id}`;
      const c = centroidFromFeature?.(feat);
      if (c) centroidById[id] = c;
    });

    // Validate counts
    if (!validateCounts(selectedIds, countsById, labelById)) return;

    // Build jobs
    let jobs = 0;
    selectedIds.forEach(id => {
      const count = Number(countsById?.[id] ?? 1);
      if (count === 0) return; // skip
      const dest = centroidById[id];
      if (!dest) return;
      jobs += 1;

      enqueue(async () => {
        const originLL = originLatLng;
        const destLL = dest;

        const a = latLngToLngLat(originLL);
        const b = latLngToLngLat(destLL);
        const originLngLat = reverse ? b : a;
        const destLngLat = reverse ? a : b;

        try {
          const alts = await orsDirections({ originLngLat, destLngLat, count, rankMode });
          const rec = {
            type, id, name: labelById[id], count, rankMode, reverse,
            routes: []
          };
          // draw
          alts.slice(0, count).forEach((r, idx) => {
            const line = addPolyline(r.coordinates, idx);
            rec.routes.push({
              distance: r.distance,
              duration: r.duration,
              line
            });
          });
          Results.push(rec);
          showToast(`${labelById[id]}: ${rec.routes.length} route(s) added.`);
        } catch (e) {
          console.error(e);
          showToast(`${labelById[id]}: routing failed.`);
        }
      });
    });

    if (jobs === 0) {
      showToast("Nothing to route (check selections and counts).");
    } else {
      showToast(`Queued ${jobs} routing job(s).`);
    }
  }

  // ---- Public API ----
  window.Routing = {
    setPDSource,
    setPZSource,
    generateFor,
    clearRoutes,
    getAllResults,
    showToast
  };
})();
