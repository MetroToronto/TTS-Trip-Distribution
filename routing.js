/* routing.js — ORS Directions v2 routing for PDs & PZs with reverse toggle and 0–3 alternatives per PD */
(function (global) {
  'use strict';

  // ---------------- Config ----------------
  const ORS_URL = 'https://api.openrouteservice.org/v2/directions/driving-car/geojson';
  const CONCURRENCY = 2;        // parallel API calls
  const ALT_SHARE = 0.6;        // difference between alternatives (0..1)
  const STYLES = [
    { color: '#0b74de', weight: 5, opacity: 0.9 },                     // best
    { color: '#0b74de', weight: 4, opacity: 0.7, dashArray: '6,6' },    // 2nd
    { color: '#0b74de', weight: 3, opacity: 0.6, dashArray: '2,6' }     // 3rd
  ];

  // ---------------- State ----------------
  const S = {
    reverse: false,               // Address -> PD/PZ (false) or PD/PZ -> Address (true)
    busy: false,
    layerGroup: null,
    results: []                   // [{kind:'pd'|'pz', target:{id,label,coords}, routes:[{rank,distanceKm,durationSec,geometry,steps?}]}]
  };

  // ---------------- DOM helpers ----------------
  function byId(id) { return document.getElementById(id); }
  function toFixed2(n){ return (n||0).toFixed(2); }
  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

  function ensureLayerGroup() {
    if (!S.layerGroup) S.layerGroup = L.layerGroup().addTo(global.map);
    return S.layerGroup;
  }
  function clearRoutes() {
    if (S.layerGroup) S.layerGroup.clearLayers();
    S.results = [];
  }

  // ---------------- Keys & origin ----------------
  function getApiKeys() {
    // Priority: window.ORS_KEYS (array) -> window.ORS_KEY (string) -> ?orsKey=a,b in URL -> localStorage
    if (Array.isArray(global.ORS_KEYS) && global.ORS_KEYS.length) return [...global.ORS_KEYS];
    if (typeof global.ORS_KEY === 'string' && global.ORS_KEY) return [global.ORS_KEY];

    const qs = new URLSearchParams(location.search);
    const fromQS = qs.get('orsKey');
    if (fromQS) return fromQS.split(',').map(s => s.trim()).filter(Boolean);

    try {
      const multi = JSON.parse(localStorage.getItem('orsKeys') || '[]').filter(Boolean);
      if (multi.length) return multi;
      const single = localStorage.getItem('orsKey');
      if (single) return [single];
    } catch(_) {}
    return [];
  }
  function rotateKey(keys) {
    if (!keys.length) return null;
    const k = keys.shift(); keys.push(k); return k;
  }
  function getOriginLonLat() {
    const o = global.ROUTING_ORIGIN;
    if (!o || typeof o.lat !== 'number' || typeof o.lon !== 'number') return null;
    return [o.lon, o.lat];
  }

  // ---------------- UI: modal & toast ----------------
  function showModal(title, lines) {
    let modal = byId('routing-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'routing-modal';
      modal.innerHTML = `
        <div style="position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:9999">
          <div style="background:#fff;max-width:560px;width:92%;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.2);overflow:hidden">
            <div id="rm-title" style="padding:12px 14px;border-bottom:1px solid #eee;font-weight:600"></div>
            <div id="rm-body"  style="padding:14px 14px;max-height:55vh;overflow:auto"></div>
            <div style="padding:12px 14px;border-top:1px solid #eee;display:flex;justify-content:flex-end">
              <button id="rm-close" style="padding:8px 12px;border:1px solid #ccc;border-radius:8px;background:#f7f7f7;cursor:pointer">Close</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.querySelector('#rm-close').addEventListener('click', () => modal.remove());
    }
    modal.querySelector('#rm-title').textContent = title || 'Notice';
    const body = modal.querySelector('#rm-body');
    body.innerHTML = `<ul style="margin:0;padding-left:18px">${(lines||[]).map(li=>`<li>${li}</li>`).join('')}</ul>`;
  }
  function toast(msg) {
    let t = byId('rt-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'rt-toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#222;color:#fff;padding:8px 12px;border-radius:10px;z-index:9999;opacity:0;transition:.25s';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    setTimeout(()=>t.style.opacity='0', 2000);
  }

  // ---------------- Validation ----------------
  function clampInt(n, lo, hi){ n = Number(n); if (!Number.isFinite(n)) n = lo; return Math.max(lo, Math.min(hi, Math.trunc(n))); }
  function normalizeRequests(arr, kind){
    return (arr||[]).map(x => ({
      id: String(x.id ?? ''),
      label: String(x.label ?? x.id ?? ''),
      coords: Array.isArray(x.coords) ? x.coords.slice(0,2).map(Number) : [NaN,NaN],
      count: clampInt(x.count, 0, 3),
      kind
    }));
  }
  function validate(reqs) {
    const bad = [];
    for (const r of reqs) {
      if (!r.coords || r.coords.length !== 2 || r.coords.some(Number.isNaN)) bad.push(`${r.label} — invalid centroid`);
      else if (![0,1,2,3].includes(r.count)) bad.push(`${r.label} — count must be 0, 1, 2, or 3`);
    }
    return bad;
  }

  // ---------------- ORS ----------------
  async function callORS(keys, coordsPair, altCount) {
    const body = {
      coordinates: coordsPair,            // [[lon,lat],[lon,lat]]
      preference: 'fastest',
      instructions: false,                // geometry only; report.js can infer directions
      units: 'km'
    };
    if (altCount > 1) {
      body.alternative_routes = {
        target_count: Math.min(altCount, 3),
        share_factor: ALT_SHARE,
        weight_factor: 1.2
      };
    }

    let attempts = Math.max(keys.length, 1);
    while (attempts--) {
      const key = rotateKey(keys) || '';
      const res = await fetch(ORS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': key },
        body: JSON.stringify(body)
      });
      if ([401,403,429].includes(res.status)) { await sleep(600); continue; }
      if (!res.ok) {
        const txt = await res.text().catch(()=> '');
        throw new Error(`ORS ${res.status}: ${txt.slice(0,200)}`);
      }
      const data = await res.json();
      return data;
    }
    throw new Error('No valid ORS keys.');
  }

  function rankFeatures(features) {
    // sort by (duration asc, distance asc)
    return [...features].sort((a,b) => {
      const sa = a.properties?.summary || {}, sb = b.properties?.summary || {};
      const d = (sa.duration ?? Infinity) - (sb.duration ?? Infinity);
      if (Math.abs(d) > 1e-9) return d;
      return (sa.distance ?? Infinity) - (sb.distance ?? Infinity);
    });
  }

  // ---------------- Core routing ----------------
  async function process(kind) {
    if (S.busy) return;
    const keys = getApiKeys();
    if (!keys.length) return showModal('Missing ORS key', ['Provide ?orsKey=YOUR_KEY in the URL, or set window.ORS_KEY / window.ORS_KEYS.']);

    const origin = getOriginLonLat();
    if (!origin) return showModal('Missing origin', ['Pick an address first (search bar or drag the origin pin).']);

    // Gather requests from App API
    const raw = (kind === 'pd')
      ? (global.App?.getPDRequests?.() || [])
      : (global.App?.getPZRequests?.() || []);
    const reqs = normalizeRequests(raw, kind);

    const invalid = validate(reqs);
    if (invalid.length) return showModal('Trip generation not possible', invalid);

    // keep only count>0
    const jobs = reqs.filter(r => r.count > 0).map(r => ({ kind, target: r }));
    if (!jobs.length) return showModal('Nothing to route', ['All selected targets have count = 0.']);

    S.busy = true;
    clearRoutes();
    ensureLayerGroup();
    toast(`Routing ${jobs.length} ${kind.toUpperCase()} target${jobs.length>1?'s':''}…`);

    // Concurrency pool
    const queue = jobs.slice();
    const workers = Array.from({length: Math.min(CONCURRENCY, queue.length)}, () => worker());

    async function worker() {
      while (queue.length) {
        const job = queue.shift();
        await routeOne(job, keys, origin);
        await sleep(150); // be nice to ORS
      }
    }

    await Promise.all(workers);
    S.busy = false;

    // Enable report button
    Routing.enableReportButtons?.();
    toast('Routing complete');
  }

  async function routeOne(job, keys, originLonLat) {
    const target = job.target; // {id,label,coords,count}
    const a = originLonLat;
    const b = target.coords; // [lon,lat]
    const coordsPair = S.reverse ? [b, a] : [a, b];

    try {
      const data = await callORS(keys, coordsPair, target.count);
      const feats = Array.isArray(data?.features) ? data.features : (Array.isArray(data?.routes) ? data.routes : []);
      const ranked = rankFeatures(feats).slice(0, target.count);

      const polyLayers = [];
      ranked.forEach((f, idx) => {
        const g = f.geometry;
        const coords = (g?.coordinates || []).map(([lon,lat]) => [lat,lon]);
        const style = STYLES[idx] || STYLES[STYLES.length - 1];
        const line = L.polyline(coords, style).addTo(S.layerGroup);
        line.bindPopup(popupHTML(target.label, f, idx));
        polyLayers.push(line);
      });

      // collect for report
      const routes = ranked.map((f, idx) => {
        const sum = f.properties?.summary || {};
        return {
          rank: idx + 1,
          distanceKm: Number(sum.distance || 0),
          durationSec: Number(sum.duration || 0),
          geometry: f.geometry,
          steps: f.properties?.segments // rare in geojson; usually we used instructions:false
        };
      });

      S.results.push({ kind: job.kind, target: { id: target.id, label: target.label, coords: target.coords }, routes });
    } catch (err) {
      console.error('Routing failed for', target.label, err);
      toast(`Failed: ${target.label}`);
    }
  }

  function popupHTML(label, feature, idx) {
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

  // ---------------- Leaflet Control (UI) ----------------
  const Control = L.Control.extend({
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
        <div style="font-weight:700;margin-bottom:8px">Trip Generator</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <input type="checkbox" id="rt-reverse" ${S.reverse ? 'checked' : ''}/>
          <label for="rt-reverse" title="Reverse: PD/PZ ➜ Address">Reverse direction</label>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <button id="rt-gen-pd" class="rt-btn" style="flex:1">Generate Trips (PDs)</button>
          <button id="rt-gen-pz" class="rt-btn" style="flex:1">Generate Trips (PZs)</button>
        </div>
        <div style="display:flex;gap:8px">
          <button id="rt-clear" class="rt-btn" style="flex:1;background:#f7f7f7;border:1px solid #ddd">Clear</button>
          <button id="rt-print" class="rt-btn" style="flex:1" disabled>Generate Report</button>
        </div>
      `;

      // stop map drag while interacting
      L.DomEvent.disableClickPropagation(c);

      c.querySelector('#rt-reverse').addEventListener('change', (e) => {
        S.reverse = !!e.target.checked;
        toast(S.reverse ? 'Direction: PD/PZ ➜ Address' : 'Direction: Address ➜ PD/PZ');
      });
      c.querySelector('#rt-gen-pd').addEventListener('click', () => process('pd'));
      c.querySelector('#rt-gen-pz').addEventListener('click', () => process('pz'));
      c.querySelector('#rt-clear').addEventListener('click', () => {
        clearRoutes();
        const btn = byId('rt-print'); if (btn) btn.disabled = true;
      });

      return c;
    }
  });

  function addControlWhenReady() {
    if (global.map && typeof global.map.addControl === 'function') {
      global.map.addControl(new Control());
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        if (global.map && typeof global.map.addControl === 'function') {
          global.map.addControl(new Control());
        }
      });
    }
  }
  addControlWhenReady();

  // ---------------- Public API for report.js ----------------
  const Routing = {
    getResults: () => S.results.slice(),
    enableReportButtons: function () {
      const b = byId('rt-print'); if (b) b.disabled = false;
    },
    // optional programmatic triggers
    generatePDTrips: () => process('pd'),
    generatePZTrips: () => process('pz'),
    clear: clearRoutes
  };

  global.Routing = Routing;
})(window);
