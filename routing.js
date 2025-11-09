/* routing.js — simplified routing with ORS Directions v2, PD/PZ centroids, alternatives, and reverse toggle */
(function (global) {
  'use strict';

  // ---------- Config ----------
  const ORS_BASE = 'https://api.openrouteservice.org/v2/directions/driving-car/json';
  const ORS_PROFILE = 'driving-car';
  const MAX_ALTS = 3;           // 0..3 (0 means "skip this PD/PZ")
  const CONCURRENCY = 2;        // parallel calls to stay friendly with rate limits
  const ALT_SHARE = 0.6;        // ORS alternative share_factor (0..1). Higher = more difference.

  // Colors for best/second/third
  const ALT_STYLES = [
    { weight: 5, opacity: 0.9 },  // best
    { weight: 4, opacity: 0.7, dashArray: '6,6' }, // 2nd
    { weight: 3, opacity: 0.6, dashArray: '2,6' }  // 3rd
  ];

  // ---------- Internal State ----------
  const S = {
    reverse: false,                 // address -> PD/PZ or PD/PZ -> address
    results: [],                    // [{ target:{id,label,coords}, routes:[{geom, distance, duration, rank}], kind:'pd'|'pz' }]
    layerGroup: null,               // L.LayerGroup for routes
    busy: false,                    // routing in progress flag
  };

  // ---------- Utilities ----------
  function byId(id) { return document.getElementById(id); }
  function toFixed2(n) { return (n || 0).toFixed(2); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function getApiKeys() {
    // Priority: window.ORS_KEYS (array), window.ORS_KEY (string), localStorage('orsKeys' or 'orsKey'), query param ?orsKey=
    if (Array.isArray(global.ORS_KEYS) && global.ORS_KEYS.length) return [...global.ORS_KEYS];
    if (typeof global.ORS_KEY === 'string' && global.ORS_KEY) return [global.ORS_KEY];

    const qs = new URLSearchParams(global.location.search);
    const fromQS = qs.get('orsKey');
    if (fromQS) return fromQS.split(',').map(s => s.trim()).filter(Boolean);

    try {
      const lsMulti = JSON.parse(localStorage.getItem('orsKeys') || '[]').filter(Boolean);
      if (lsMulti.length) return lsMulti;
      const lsOne = localStorage.getItem('orsKey');
      if (lsOne) return [lsOne];
    } catch (_) {}
    return [];
  }

  function rotateKey(keys) {
    if (!keys.length) return null;
    const k = keys.shift();
    keys.push(k);
    return k;
  }

  function getOriginLonLat() {
    const o = global.ROUTING_ORIGIN;
    if (!o || typeof o.lat !== 'number' || typeof o.lon !== 'number') return null;
    return [o.lon, o.lat];
  }

  // Accept either App getters or DOM fallbacks
  function getRequests(kind) {
    // Kind: 'pd' or 'pz'
    // Try App API first
    if (global.App) {
      const fn = kind === 'pd' ? global.App.getPDRequests : global.App.getPZRequests;
      if (typeof fn === 'function') {
        const arr = fn() || [];
        return normalizeRequestArray(arr, kind);
      }
    }
    // DOM fallback: inputs with .pd-count / .pz-count and data attributes
    const cls = kind === 'pd' ? '.pd-count' : '.pz-count';
    const inputs = Array.from(document.querySelectorAll(cls));
    const res = inputs.map(inp => {
      const host = inp.closest('[data-id]');
      if (!host) return null;
      const id = host.getAttribute('data-id') || '';
      const label = host.getAttribute('data-label') || id;
      const centroidStr = host.getAttribute('data-centroid') || '';
      const count = parseInt(inp.value, 10);
      const coords = centroidStr.split(',').map(Number); // [lon,lat]
      if (coords.length !== 2 || coords.some(n => Number.isNaN(n))) return null;
      return { id, label, coords, count };
    }).filter(Boolean);
    return normalizeRequestArray(res, kind);
  }

  function normalizeRequestArray(arr, kind) {
    // Ensure shape: { id, label, coords:[lon,lat], count, kind }
    return arr.map(x => ({
      id: String(x.id ?? ''),
      label: String(x.label ?? x.id ?? ''),
      coords: Array.isArray(x.coords) ? x.coords.slice(0,2).map(Number) : [NaN, NaN],
      count: clampInt(x.count, 0, MAX_ALTS),
      kind
    }));
  }

  function clampInt(val, min, max) {
    const n = Number(val);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, Math.trunc(n)));
  }

  function validateCounts(reqs) {
    const bad = [];
    for (const r of reqs) {
      if (!Array.isArray(r.coords) || r.coords.length !== 2 || r.coords.some(Number.isNaN)) {
        bad.push(`${r.label} (invalid centroid)`);
      } else if (!Number.isInteger(r.count) || r.count < 0 || r.count > MAX_ALTS) {
        bad.push(`${r.label} (count ${r.count})`);
      }
    }
    return bad;
  }

  function showModal(title, lines) {
    let modal = byId('routing-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'routing-modal';
      modal.innerHTML = `
        <div style="
            position:fixed;inset:0;background:rgba(0,0,0,0.35);
            display:flex;align-items:center;justify-content:center;z-index:9999;">
          <div style="background:#fff;max-width:560px;width:92%;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,0.2);overflow:hidden;">
            <div style="padding:14px 16px;border-bottom:1px solid #eee;font-weight:600" id="routing-modal-title"></div>
            <div style="padding:14px 16px" id="routing-modal-body"></div>
            <div style="padding:12px 16px;border-top:1px solid #eee;display:flex;justify-content:flex-end;gap:10px;">
              <button id="routing-modal-close" style="padding:8px 12px;border:1px solid #ccc;border-radius:8px;background:#f7f7f7;cursor:pointer">Close</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.querySelector('#routing-modal-close').addEventListener('click', () => modal.remove());
    }
    modal.querySelector('#routing-modal-title').textContent = title || 'Notice';
    modal.querySelector('#routing-modal-body').innerHTML = `<ul style="margin:0;padding-left:18px">${lines.map(li => `<li>${li}</li>`).join('')}</ul>`;
  }

  function rankAlternatives(features) {
    // Sort by (duration asc, distance asc). ORS returns already ordered, but we ensure.
    return [...features].sort((a, b) => {
      const d = (a.properties?.summary?.duration ?? Infinity) - (b.properties?.summary?.duration ?? Infinity);
      if (Math.abs(d) > 1e-9) return d;
      return (a.properties?.summary?.distance ?? Infinity) - (b.properties?.summary?.distance ?? Infinity);
    });
  }

  function toLeafletCoords(geometry) {
    // ORS returns [lon,lat]; Leaflet expects [lat,lon]
    if (!geometry || !Array.isArray(geometry.coordinates)) return [];
    return geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  }

  function ensureLayerGroup() {
    if (!S.layerGroup) {
      S.layerGroup = L.layerGroup().addTo(global.map);
    }
    return S.layerGroup;
  }

  function clearRoutes() {
    if (S.layerGroup) S.layerGroup.clearLayers();
    S.results = [];
  }

  // ---------- ORS Call ----------
  async function callORSRoute(apiKeys, coordsPair, altCount) {
    // coordsPair: [[lon,lat],[lon,lat]]
    // altCount: 1..3 (how many ranked routes to return)
    const body = {
      coordinates: coordsPair,
      preference: 'fastest',
      instructions: false,
      elevation: false,
      radiuses: [-1, -1],
      units: 'km'
    };

    if (altCount > 1) {
      body.alternative_routes = {
        target_count: Math.min(altCount, 3),
        share_factor: ALT_SHARE,
        weight_factor: 1.2
      };
    }

    // rotate keys on 401/403/429
    let attempts = apiKeys.length || 1;
    while (attempts--) {
      const key = rotateKey(apiKeys) || '';
      const res = await fetch(ORS_BASE, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': key
        },
        body: JSON.stringify(body)
      });
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        // try next key after a short backoff
        await sleep(600);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`ORS error ${res.status}: ${text.slice(0,200)}`);
      }
      const data = await res.json();
      return data;
    }
    throw new Error('All ORS keys exhausted or invalid.');
  }

  // ---------- Work Queue ----------
  async function processRequests(kind, requests) {
    const keys = getApiKeys();
    if (!keys.length) throw new Error('No ORS API key(s) available. Provide ?orsKey=... or set window.ORS_KEY/ORS_KEYS.');

    const oLonLat = getOriginLonLat();
    if (!oLonLat) throw new Error('Origin address is missing. Pick an address in the search bar first.');

    clearRoutes();
    ensureLayerGroup();
    S.busy = true;

    const tasks = [];
    const invalids = [];

    for (const r of requests) {
      if (r.count <= 0) continue;
      if (!r.coords || r.coords.length !== 2 || r.coords.some(Number.isNaN)) {
        invalids.push(`${r.label} (missing/invalid centroid)`);
        continue;
      }
      tasks.push({ kind, target: r, altCount: r.count });
    }

    if (invalids.length) {
      showModal('Can’t start trip generation', invalids);
      S.busy = false;
      return;
    }

    // Concurrency pool
    const queue = tasks.slice();
    const runners = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker());

    async function worker() {
      while (queue.length) {
        const job = queue.shift();
        await handleJob(job, keys, oLonLat);
        await sleep(150); // light pacing to be nice
      }
    }

    await Promise.all(runners);
    S.busy = false;

    // enable report buttons (if present)
    Routing.enableReportButtons?.();
  }

  async function handleJob(job, keys, originLonLat) {
    const { target, altCount } = job;

    const a = originLonLat;
    const b = target.coords; // [lon,lat]

    const coordsPair = S.reverse ? [b, a] : [a, b];

    try {
      const data = await callORSRoute(keys, coordsPair, altCount);
      const feats = (data?.features || []);
      const ranked = rankAlternatives(feats).slice(0, altCount);

      const polyLayers = [];
      ranked.forEach((f, idx) => {
        const coords = toLeafletCoords(f.geometry);
        const style = ALT_STYLES[idx] || ALT_STYLES[ALT_STYLES.length - 1];
        const line = L.polyline(coords, Object.assign({ color: '#0074D9' }, style));
        line.addTo(S.layerGroup);
        line.bindPopup(renderPopup(target.label, f, idx));
        polyLayers.push(line);
      });

      // Collect for report
      const routes = ranked.map((f, idx) => {
        const sum = f.properties?.summary || {};
        return {
          rank: idx + 1,
          distanceKm: Number(sum.distance || 0),
          durationSec: Number(sum.duration || 0),
          geometry: f.geometry
        };
      });

      S.results.push({
        kind: job.kind,
        target: { id: target.id, label: target.label, coords: target.coords },
        routes
      });
    } catch (err) {
      console.error('Routing failed for', target.label, err);
      showToast(`Routing failed for ${target.label}: ${String(err.message || err)}`);
    }
  }

  function renderPopup(label, feature, idx) {
    const sum = feature?.properties?.summary || {};
    const dist = toFixed2(sum.distance || 0);
    const mins = toFixed2((sum.duration || 0) / 60);
    return `<div style="min-width:180px">
      <div style="font-weight:600;margin-bottom:4px">${label}</div>
      <div>Route #${idx + 1}</div>
      <div>Distance: ${dist} km</div>
      <div>Duration: ${mins} min</div>
    </div>`;
  }

  function showToast(msg) {
    let t = byId('routing-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'routing-toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#222;color:#fff;padding:10px 14px;border-radius:10px;z-index:9999;opacity:0;transition:.25s';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    setTimeout(() => t.style.opacity = '0', 2200);
  }

  // ---------- Leaflet Control (UI) ----------
  const RoutingControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const c = L.DomUtil.create('div', 'leaflet-bar');
      c.style.background = '#fff';
      c.style.padding = '10px';
      c.style.width = '250px';
      c.style.boxShadow = '0 2px 12px rgba(0,0,0,0.12)';
      c.style.borderRadius = '12px';
      c.style.lineHeight = '1.2';

      c.innerHTML = `
        <div style="font-weight:700;margin-bottom:8px;">Trip Generator</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <input type="checkbox" id="rt-reverse" ${S.reverse ? 'checked' : ''} />
          <label for="rt-reverse" title="Reverse: PD/PZ ➜ Address">Reverse direction</label>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <button id="rt-gen-pd" class="rt-btn" style="flex:1">Generate Trips (PDs)</button>
          <button id="rt-gen-pz" class="rt-btn" style="flex:1">Generate Trips (PZs)</button>
        </div>
        <div style="display:flex;gap:8px">
          <button id="rt-clear" class="rt-btn" style="flex:1;background:#f7f7f7;border:1px solid #ddd">Clear</button>
          <button id="rt-print" class="rt-btn" style="flex:1" disabled>Print Report</button>
        </div>
        <div style="margin-top:8px">
          <button id="rt-debug" class="rt-btn" style="width:100%" disabled>Report — Raw Steps</button>
        </div>
        <div id="rt-hint" style="margin-top:8px;color:#666;font-size:12px">
          Set route counts (0–3) beside PD/PZ names, then click a Generate button.
        </div>
      `;

      // Prevent map drag when interacting
      L.DomEvent.disableClickPropagation(c);

      // Wire events
      c.querySelector('#rt-reverse').addEventListener('change', (e) => {
        S.reverse = !!e.target.checked;
        showToast(S.reverse ? 'Direction: PD/PZ ➜ Address' : 'Direction: Address ➜ PD/PZ');
      });

      c.querySelector('#rt-gen-pd').addEventListener('click', async () => {
        if (S.busy) return;
        const reqs = getRequests('pd');
        const bad = validateCounts(reqs).filter(s => !/invalid centroid/i.test(s) ? ![0,1,2,3].includes( (reqs.find(r=>s.includes(r.label))||{}).count ) : true);
        if (bad.length) {
          showModal('Trip generation not possible', bad.map(b => `${b} — value must be 0, 1, 2, or 3`));
          return;
        }
        await processRequests('pd', reqs);
      });

      c.querySelector('#rt-gen-pz').addEventListener('click', async () => {
        if (S.busy) return;
        const reqs = getRequests('pz');
        const bad = validateCounts(reqs).filter(s => !/invalid centroid/i.test(s) ? ![0,1,2,3].includes( (reqs.find(r=>s.includes(r.label))||{}).count ) : true);
        if (bad.length) {
          showModal('Trip generation not possible', bad.map(b => `${b} — value must be 0, 1, 2, or 3`));
          return;
        }
        await processRequests('pz', reqs);
      });

      c.querySelector('#rt-clear').addEventListener('click', () => {
        clearRoutes();
        const printBtn = byId('rt-print'); if (printBtn) printBtn.disabled = true;
        const debugBtn = byId('rt-debug'); if (debugBtn) debugBtn.disabled = true;
      });

      return c;
    }
  });

  // Add control once map is ready
  if (global.map && typeof global.map.addControl === 'function') {
    global.map.addControl(new RoutingControl());
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      if (global.map && typeof global.map.addControl === 'function') {
        global.map.addControl(new RoutingControl());
      }
    });
  }

  // ---------- Public API for report.js ----------
  const Routing = {
    // results snapshot for reporting
    getResults: () => S.results.slice(),
    // report.js can call this once trips exist
    enableReportButtons: function () {
      const printBtn = byId('rt-print'); if (printBtn) printBtn.disabled = false;
      const debugBtn = byId('rt-debug'); if (debugBtn) debugBtn.disabled = false;
    },
    // handy if you need to programmatically trigger
    generatePDTrips: async function () {
      const reqs = getRequests('pd');
      const bad = validateCounts(reqs);
      if (bad.length) { showModal('Trip generation not possible', bad); return; }
      await processRequests('pd', reqs);
    },
    generatePZTrips: async function () {
      const reqs = getRequests('pz');
      const bad = validateCounts(reqs);
      if (bad.length) { showModal('Trip generation not possible', bad); return; }
      await processRequests('pz', reqs);
    },
    clear: clearRoutes
  };

  global.Routing = Routing;
})(window);
