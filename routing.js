(function (global) {
  // ===== Config =====
  const PROFILE    = 'driving-car';
  const PREFERENCE = 'fastest';
  const ORS_BASE   = 'https://api.openrouteservice.org';

  const COLOR_FIRST  = '#0b3aa5';
  const COLOR_OTHERS = '#2166f3';

  // Inline default ORS key (backup)
  const INLINE_DEFAULT_KEY =
    'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=';
  const LS_KEYS         = 'ORS_KEYS';
  const LS_ACTIVE_INDEX = 'ORS_ACTIVE_INDEX';

  const S = {
    map: null,
    group: null,
    keys: [],
    keyIndex: 0,
    lastMode: null,  // 'PD' or 'PZ'
    lastTrips: []    // cached ORS features per destination
  };

  // ===== Small helpers =====
  const byId = (id) => document.getElementById(id);

  const escapeHtml = (str) => String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const qParam = (k) => new URLSearchParams(location.search).get(k) || '';
  const toRad  = (d) => d * Math.PI / 180;
  const isFiniteNum = (n) => Number.isFinite(n) && !Number.isNaN(n);
  const num = (x) => {
    const n = typeof x === 'string' ? parseFloat(x) : +x;
    return Number.isFinite(n) ? n : NaN;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function sanitizeLonLat(input) {
    let arr = Array.isArray(input) ? input : [undefined, undefined];
    let x = num(arr[0]), y = num(arr[1]);
    // Heuristic: if swapped, un-swap.
    if (isFiniteNum(x) && isFiniteNum(y) && Math.abs(x) <= 90 && Math.abs(y) > 90) {
      const t = x; x = y; y = t;
    }
    if (!isFiniteNum(x) || !isFiniteNum(y)) {
      throw new Error(`Invalid coordinate (NaN). Raw: ${JSON.stringify(input)}`);
    }
    x = clamp(x, -180, 180);
    y = clamp(y, -85, 85);
    return [x, y];
  }

  function getOriginLonLat() {
    const o = global.ROUTING_ORIGIN;
    if (!o) {
      const err = new Error('Origin not set');
      err.code = 'NO_ORIGIN';
      throw err;
    }
    if (Array.isArray(o) && o.length >= 2) return sanitizeLonLat([o[0], o[1]]);
    if (typeof o.getLatLng === 'function') {
      const ll = o.getLatLng();
      return sanitizeLonLat([ll.lng, ll.lat]);
    }
    if (isFiniteNum(num(o.lng)) && isFiniteNum(num(o.lat))) {
      return sanitizeLonLat([o.lng, o.lat]);
    }
    if (o.latlng && isFiniteNum(num(o.latlng.lng)) && isFiniteNum(num(o.latlng.lat))) {
      return sanitizeLonLat([o.latlng.lng, o.latlng.lat]);
    }
    if (o.center) {
      if (Array.isArray(o.center) && o.center.length >= 2) {
        return sanitizeLonLat([o.center[0], o.center[1]]);
      }
      if (isFiniteNum(num(o.center.lng)) && isFiniteNum(num(o.center.lat))) {
        return sanitizeLonLat([o.center.lng, o.center.lat]);
      }
    }
    if (o.geometry?.coordinates?.length >= 2) {
      return sanitizeLonLat([o.geometry.coordinates[0], o.geometry.coordinates[1]]);
    }
    const x = o.lon ?? o.x, y = o.lat ?? o.y;
    if (isFiniteNum(num(x)) && isFiniteNum(num(y))) {
      return sanitizeLonLat([x, y]);
    }
    if (typeof o === 'string' && o.includes(',')) {
      const [a, b] = o.split(',').map(s => s.trim());
      try { return sanitizeLonLat([a, b]); } catch {}
      return sanitizeLonLat([b, a]);
    }
    throw new Error(`Origin shape unsupported: ${JSON.stringify(o)}`);
  }

  // ===== ORS key management =====
  function savedKeys() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEYS) || '[]');
    } catch {
      return [];
    }
  }

  function hydrateKeys() {
    const urlKey = qParam('orsKey');
    const saved = savedKeys();
    const inline = [INLINE_DEFAULT_KEY];
    S.keys = (urlKey ? [urlKey] : []).concat(saved.length ? saved : inline);
    S.keyIndex = Math.min(+localStorage.getItem(LS_ACTIVE_INDEX) || 0, Math.max(0, S.keys.length - 1));
  }

  function currentKey() {
    return S.keys[Math.min(Math.max(S.keyIndex, 0), S.keys.length - 1)] || '';
  }

  function rotateKey() {
    if (S.keys.length <= 1) return false;
    S.keyIndex = (S.keyIndex + 1) % S.keys.length;
    localStorage.setItem(LS_ACTIVE_INDEX, String(S.keyIndex));
    return true;
  }

  async function orsFetch(path, { method = 'GET', body } = {}, attempt = 0) {
    const url = new URL(ORS_BASE + path);
    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: currentKey(),
        ...(method !== 'GET' && { 'Content-Type': 'application/json' })
      },
      body: method === 'GET' ? undefined : JSON.stringify(body)
    });

    if ([401, 403, 429].includes(res.status) && rotateKey()) {
      await sleep(150);
      return orsFetch(path, { method, body }, attempt + 1);
    }
    if (res.status === 500 && attempt < 1) {
      await sleep(200);
      return orsFetch(path, { method, body }, attempt + 1);
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => res.statusText);
      throw new Error(`ORS ${res.status}: ${txt}`);
    }
    return res.json();
  }

  // Get 1–3 routes (alternative_routes) from ORS Directions v2 (geojson)
  async function getRoutes(originLonLat, destLonLat, maxCount) {
    const o = sanitizeLonLat(originLonLat);
    const d = sanitizeLonLat(destLonLat);
    const baseBody = {
      coordinates: [o, d],
      preference: PREFERENCE,
      instructions: true,
      instructions_format: 'html',
      language: 'en',
      geometry_simplify: false,
      elevation: false,
      units: 'km'
    };
    if (maxCount > 1) {
      baseBody.alternative_routes = {
        target_count: Math.min(Math.max(1, maxCount), 3),
        share_factor: 0.6
      };
    }
    try {
      return await orsFetch(`/v2/directions/${PROFILE}/geojson`, { method: 'POST', body: baseBody });
    } catch (e) {
      // Handle ORS weird 2099 errors by trying swapped dest coords
      const msg = String(e.message || '');
      const is2099 = msg.includes('ORS 500') && (msg.includes('"code":2099') || msg.includes('code:2099'));
      if (!is2099) throw e;
      const dSwap = sanitizeLonLat([d[1], d[0]]);
      const bodySwap = { ...baseBody, coordinates: [o, dSwap] };
      return await orsFetch(`/v2/directions/${PROFILE}/geojson`, { method: 'POST', body: bodySwap });
    }
  }

  // ===== Drawing =====
  function clearRoutes() {
    if (S.group) {
      try { S.map.removeLayer(S.group); } catch {}
      S.group = null;
    }
    S.lastTrips = [];
    S.lastMode = null;
    global.ROUTING_CACHE = undefined;
  }

  function drawRoute(coords, color) {
    if (!coords?.length) return;
    if (!S.group) S.group = L.layerGroup().addTo(S.map);
    const latlngs = coords.map(([lng, lat]) => [lat, lng]);
    L.polyline(latlngs, { color, weight: 4, opacity: 0.9 }).addTo(S.group);
  }

  // ===== PD route-count + targets =====
  // Expects script.js to have populated window.PD_REGISTRY[key] = { layer, name }.
  // If an <input class="pd-route-count"> exists in a .pd-item, it must be 0–3.
  function collectPDRequests() {
    const registry = global.PD_REGISTRY || {};
    const items = Array.from(document.querySelectorAll('.pd-item'));
    const invalid = [];
    const requests = [];

    // First pass: validate all route-count inputs (0–3, integer).
    for (const item of items) {
      const cbx = item.querySelector('.pd-cbx');
      const input = item.querySelector('.pd-route-count');
      const keyEnc = cbx?.dataset.key || item.dataset.key || '';
      const key = decodeURIComponent(keyEnc || '');
      const reg = registry[key];
      const name = reg?.name || key || 'Unknown PD';

      if (!input) continue; // no route-count UI wired yet

      let raw = input.value.trim();
      if (raw === '') {
        raw = cbx && cbx.checked ? '1' : '0';
        input.value = raw;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || Math.floor(n) !== n || n < 0 || n > 3) {
        invalid.push({ key, name, value: raw });
      }
    }

    if (invalid.length) {
      const err = new Error('Invalid PD route counts');
      err.type = 'validation';
      err.invalid = invalid;
      throw err;
    }

    // Second pass: build PD requests from selected PDs.
    for (const item of items) {
      const cbx = item.querySelector('.pd-cbx');
      if (!cbx || !cbx.checked) continue;

      const keyEnc = cbx.dataset.key || item.dataset.key || '';
      const key = decodeURIComponent(keyEnc || '');
      const reg = registry[key];
      if (!reg || !reg.layer) continue;

      const center = reg.layer.getBounds().getCenter();
      const name = reg.name || key || 'PD';

      let count = 1;
      const input = item.querySelector('.pd-route-count');
      if (input) {
        const raw = input.value.trim() || '1';
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) continue;
        count = Math.min(Math.max(1, Math.floor(n)), 3);
      }

      requests.push({
        key,
        name,
        lon: center.lng,
        lat: center.lat,
        count
      });
    }

    return requests;
  }

  // ===== Zone targets (script.js is expected to provide helper) =====
  // Expected: window.getSelectedZoneTargets() → array of:
  //   [lon, lat, label?]  OR  { lon, lat, label }.
  function collectZoneTargets() {
    if (typeof global.getSelectedZoneTargets !== 'function') {
      const err = new Error('Zone helper missing');
      err.type = 'noZonesHelper';
      throw err;
    }
    const raw = global.getSelectedZoneTargets() || [];
    const out = [];

    for (const t of raw) {
      if (!t) continue;
      if (Array.isArray(t) && t.length >= 2) {
        out.push({
          lon: t[0],
          lat: t[1],
          label: t[2] || 'Zone'
        });
      } else if (typeof t === 'object') {
        const lon = t.lon ?? t.lng ?? t.x ?? (t.center && t.center[0]);
        const lat = t.lat ?? t.y ?? (t.center && t.center[1]);
        if (!isFiniteNum(num(lon)) || !isFiniteNum(num(lat))) continue;
        out.push({
          lon: num(lon),
          lat: num(lat),
          label: t.label || t.name || 'Zone'
        });
      }
    }
    return out;
  }

  // ===== Popup for validation errors =====
  function showValidationPopup(invalid) {
    if (!invalid || !invalid.length) return;
    const existing = document.getElementById('routing-validation-overlay');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'routing-validation-overlay';
    backdrop.style.position = 'fixed';
    backdrop.style.inset = '0';
    backdrop.style.zIndex = '9999';
    backdrop.style.background = 'rgba(0,0,0,0.35)';
    backdrop.style.display = 'flex';
    backdrop.style.alignItems = 'center';
    backdrop.style.justifyContent = 'center';

    const box = document.createElement('div');
    box.style.background = '#fff';
    box.style.padding = '16px 20px';
    box.style.borderRadius = '8px';
    box.style.maxWidth = '420px';
    box.style.width = '90%';
    box.style.boxShadow = '0 8px 20px rgba(0,0,0,0.25)';
    box.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    box.innerHTML = `
      <h3 style="margin:0 0 8px 0;">Trip generation blocked</h3>
      <p style="margin:0 0 8px 0;font-size:0.95em;">
        Trip generation is not possible because the following Planning District(s)
        have an invalid route count. Please use only <strong>0, 1, 2, or 3</strong>.
      </p>
      <ul style="margin:0 0 12px 20px;padding:0;font-size:0.95em;">
        ${invalid.map(i => `<li>${escapeHtml(i.name || i.key || 'PD')} — value: "${escapeHtml(i.value)}"</li>`).join('')}
      </ul>
      <div style="text-align:right;">
        <button id="routing-validation-close">Close</button>
      </div>
    `;

    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    const closeBtn = box.querySelector('#routing-validation-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => backdrop.remove());
    }
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.remove();
    });
  }

  // ===== UI / control wiring =====
  function setBusy(mode, busy) {
    const btnPD = byId('rt-gen-pd');
    const btnPZ = byId('rt-gen-pz');
    const btnClear = byId('rt-clear');

    if (mode === 'PD' && btnPD) {
      btnPD.disabled = busy;
      btnPD.textContent = busy ? 'Generating…' : 'Generate PD Trips';
    }
    if (mode === 'PZ' && btnPZ) {
      btnPZ.disabled = busy;
      btnPZ.textContent = busy ? 'Generating…' : 'Generate PZ Trips';
    }
    if (btnClear) btnClear.disabled = busy;
  }

  // ----- Generate for PDs (with 1–3 alternatives per PD) -----
  async function generateForPDs() {
    try {
      const origin = getOriginLonLat();
      const reverse = !!byId('rt-reverse')?.checked;

      const requests = collectPDRequests();
      if (!requests.length) {
        alert('Select at least one Planning District.');
        return;
      }

      setBusy('PD', true);
      clearRoutes();

      S.lastMode = 'PD';
      S.lastTrips = [];

      const PER_REQUEST_DELAY = 250;

      for (const req of requests) {
        const dest = sanitizeLonLat([req.lon, req.lat]);
        const o = reverse ? dest : origin;
        const d = reverse ? origin : dest;

        const json = await getRoutes(o, d, req.count);
        const feats = Array.isArray(json.featur
