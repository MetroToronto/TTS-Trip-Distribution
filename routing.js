/* routing.js — Directions (1x/PD) + Movements (NB/EB/SB/WB)
 * Names: ORS Snap v2 /road → Overpass fallback (1 call/PD).
 * Report uses cached results only (no extra API calls).
 * Smoothing:
 *  - SWITCH_CONFIRM_M: new street must persist before switching
 *  - REJOIN_WINDOW_M: if we switch then return to previous within this distance, merge back (no duplicate row)
 *  - BOUND_AVG_WINDOW_M: initial bound for a street is the average heading over this window
 *  - Repeats allowed later in route; only near-immediate backtracks are merged
 */
(function (global) {
  // ===== Config =====
  const INLINE_DEFAULT_KEY =
    'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=';

  const PROFILE = 'driving-car';
  const PREFERENCE = 'fastest';
  const THROTTLE_MS_DIRECTIONS = 1200;

  const SAMPLE_EVERY_M      = 50;   // sampling distance along route
  const SNAP_BATCH_SIZE     = 200;  // Snap batch size
  const SWITCH_CONFIRM_M    = 150;  // require new street to persist ≥ this to switch
  const REJOIN_WINDOW_M     = 200;  // if we return to previous within this, merge (avoid dup)
  const MIN_FRAGMENT_M      = 60;   // drop tiny fragments
  const MAX_WAY_SNAP_M      = 45;   // accept Overpass nearest only if within this
  const BOUND_AVG_WINDOW_M  = 150;  // distance used to average initial bound

  const COLOR_FIRST  = '#0b3aa5';
  const COLOR_OTHERS = '#2166f3';

  const ORS_BASE = 'https://api.openrouteservice.org';

  const LS_KEYS = 'ORS_KEYS';
  const LS_ACTIVE_INDEX = 'ORS_ACTIVE_INDEX';

  // ===== State =====
  const S = {
    map: null,
    group: null,
    keys: [],
    keyIndex: 0,
    results: [],
    els: {}
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ===== Keys =====
  const parseUrlKeys = () => {
    const raw = new URLSearchParams(location.search).get('orsKey');
    return raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  };
  const loadKeys = () => {
    const u = parseUrlKeys(); if (u.length) return u;
    try { const ls = JSON.parse(localStorage.getItem(LS_KEYS) || '[]'); if (Array.isArray(ls) && ls.length) return ls; } catch {}
    return [INLINE_DEFAULT_KEY];
  };
  const saveKeys = (arr) => localStorage.setItem(LS_KEYS, JSON.stringify(arr));
  const setIndex = (i) => { S.keyIndex = Math.max(0, Math.min(i, S.keys.length - 1)); localStorage.setItem(LS_ACTIVE_INDEX, String(S.keyIndex)); };
  const getIndex = () => Number(localStorage.getItem(LS_ACTIVE_INDEX) || 0);
  const currentKey = () => S.keys[S.keyIndex];
  const rotateKey   = () => (S.keys.length > 1 ? (setIndex((S.keyIndex + 1) % S.keys.length), true) : false);

  // ===== Map helpers =====
  const ensureGroup = () => { if (!S.group) S.group = L.layerGroup().addTo(S.map); };
  const clearAll = () => { if (S.group) S.group.clearLayers(); S.results = []; setReportEnabled(false); };
  const popup = (html, at) => {
    const ll = at || (S.map ? S.map.getCenter() : null);
    if (ll) L.popup().setLatLng(ll).setContent(html).openOn(S.map);
    else alert(html.replace(/<[^>]+>/g, ''));
  };

  // ===== ORS fetch =====
  async function orsFetch(path, { method = 'GET', body, query } = {}) {
    const url = new URL(ORS_BASE + path);
    if (query) Object.entries(query).forEach(([k,v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString(), {
      method,
      headers: { Authorization: currentKey(), ...(method !== 'GET' && { 'Content-Type': 'application/json' }) },
      body: method === 'GET' ? undefined : JSON.stringify(body)
    });
    if ([401,403,429].includes(res.status)) {
      if (rotateKey()) return orsFetch(path, { method, body, query });
    }
    if (!res.ok) throw new Error(`ORS ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    return res.json();
  }

  async function getRoute(originLonLat, destLonLat) {
    return orsFetch(`/v2/directions/${PROFILE}/geojson`, {
      method: 'POST',
      body: {
        coordinates: [originLonLat, destLonLat],
        preference: PREFERENCE,
        instructions: true,
        instructions_format: 'html',
        language: 'en',
        units: 'km'
      }
    });
  }

  // ===== SNAP v2 =====
  async function snapRoad(points) {
    if (!points?.length) return [];
    const url = `${ORS_BASE}/v2/snap/road`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': currentKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ points, locations: points }) // send both to be tenant-proof
    });
    if ([401,403,429].includes(res.status) && rotateKey()) return snapRoad(points);
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json?.features) ? json.features : [];
  }

  // ===== Overpass fallback =====
  async function overpassFetchWays(bbox) {
    const [s,w,n,e] = bbox;
    const q = `
      [out:json][timeout:25];
      way["highway"](${s},${w},${n},${e});
      (._;>;);
      out body geom;`;
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type':'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: q })
    });
    if (!res.ok) throw new Error(`Overpass ${res.status}`);
    const json = await res.json();
    const nodes = new Map();
    for (const el of json.elements || []) if (el.type === 'node') nodes.set(el.id, [el.lon, el.lat]);
    const ways = [];
    for (const el of json.elements || []) {
      if (el.type !== 'way') continue;
      const coords = el.geometry
        ? el.geometry.map(p => [p.lon, p.lat])
        : (el.nodes || []).map(id => nodes.get(id)).filter(Boolean);
      const tags = el.tags || {};
      ways.push({
        coords,
        name: tags['name:en'] || tags.name || '',
        ref: tags.ref || ''
      });
    }
    return ways;
  }

  // ===== Math / geometry =====
  const toRad = d => d*Math.PI/180;
  const toDeg = r => r*180/Math.PI;
  function haversineMeters(a,b){
    const R=6371000;
    const [lng1,lat1]=a, [lng2,lat2]=b;
    const dLat=toRad(lat2-lat1), dLng=toRad(lng2-lng1);
    const s=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
    return 2*R*Math.asin(Math.sqrt(s));
  }
  function lengthFromCoordsKm(coords){
    let km=0; for (let i=0;i<coords.length-1;i++) km += haversineMeters(coords[i], coords[i+1])/1000; return km;
  }
  function sampleLineWithIndex(coords, stepM){
    if (!coords || coords.length<2) return { pts: coords||[], idx: coords?.map((_,i)=>i)||[] };
    const pts=[coords[0]], idx=[0]; let acc=0;
    for (let i=1;i<coords.length;i++){
      const seg=haversineMeters(coords[i-1], coords[i]); acc+=seg;
      if (acc>=stepM){ pts.push(coords[i]); idx.push(i); acc=0; }
    }
    if (pts[pts.length-1]!==coords[coords.length-1]) { pts.push(coords[coords.length-1]); idx.push(coords.length-1); }
    return { pts, idx };
  }
  function bearingDeg(a,b){
    const [lng1,lat1]=[toRad(a[0]),toRad(a[1])], [lng2,lat2]=[toRad(b[0]),toRad(b[1])];
    const y=Math.sin(lng2-lng1)*Math.cos(lat2);
    const x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(lng2-lng1);
    return (toDeg(Math.atan2(y,x))+360)%360;
  }
  function cardinal4(deg){ if (deg>=315||deg<45) return "NB"; if (deg<135) return "EB"; if (deg<225) return "SB"; return "WB"; }

  // Average heading over distance window starting at index i
  function avgHeading(sampled, iStart, windowM) {
    let vx = 0, vy = 0, acc = 0;
    for (let i=iStart; i<sampled.length-1 && acc < windowM; i++) {
      const a = sampled[i], b = sampled[i+1];
      const d = haversineMeters(a,b); if (d <= 0) continue;
      const br = bearingDeg(a,b) * Math.PI/180;
      vx += Math.cos(br) * d;
      vy += Math.sin(br) * d;
      acc += d;
    }
    if (vx === 0 && vy === 0) return cardinal4(bearingDeg(sampled[iStart], sampled[Math.min(sampled.length-1, iStart+1)]));
    const deg = (Math.atan2(vy, vx) * 180/Math.PI + 360) % 360;
    return cardinal4(deg);
  }

  // ===== Helpers =====
  function bboxOfCoords(coords) {
    let w= Infinity, s= Infinity, e=-Infinity, n=-Infinity;
    for (const [x,y] of coords){ if (x<w) w=x; if (x>e) e=x; if (y<s) s=y; if (y>n) n=y; }
    const pad = 0.002; // ~200m
    return [s-pad, w-pad, n+pad, e+pad];
  }

  function normalizeName(s){
    if (!s) return '';
    return String(s)
      .replace(/\b(hwy)\b/ig,'Highway')
      .replace(/\b(hwy)\s*(\d+)\b/ig,'Highway $2')
      .replace(/\b(st)\b\.?/ig,'Street')
      .replace(/\b(rd)\b\.?/ig,'Road')
      .replace(/\b(ave)\b\.?/ig,'Avenue')
      .replace(/\s+/g,' ').trim();
  }
  function pickFromSnapProps(props={}){
    const k = ['name','street','road','way_name','label','ref','display_name','name:en'];
    for (const key of k){ if (props[key]) return normalizeName(props[key]); }
    const tags=props.tags||props.properties||{};
    for (const key of k){ if (tags[key]) return normalizeName(tags[key]); }
    if (props.ref) return normalizeName(`Highway ${props.ref}`);
    return '';
  }

  function nearestWayNameAndDist(point, ways){
    let best=null, bestD=Infinity;
    for (const w of ways){
      const cs = w.coords;
      for (let i=0;i<cs.length-1;i++){
        const d = pointToSegmentMeters(point, cs[i], cs[i+1]);
        if (d < bestD){ bestD = d; best = w; }
      }
    }
    if (!best) return ['', Infinity];
    const nm = normalizeName(best.name || (best.ref ? `Highway ${best.ref}` : ''));
    return [nm, bestD];
  }
  function pointToSegmentMeters(p, a, b){
    const k = Math.cos(toRad((a[1]+b[1])/2)) * 111320;
    const ky = 110540;
    const ax = (a[0])*k, ay = (a[1])*ky, bx=(b[0])*k, by=(b[1])*ky, px=(p[0])*k, py=(p[1])*ky;
    const vx = bx-ax, vy=by-ay, wx=px-ax, wy=py-ay;
    const c1 = vx*wx + vy*wy;
    const c2 = vx*vx + vy*vy;
    let t = c2 ? c1/c2 : 0; t = Math.max(0, Math.min(1,t));
    const cx = ax + t*vx, cy = ay + t*vy;
    const dx = px - cx, dy = py - cy;
    return Math.sqrt(dx*dx + dy*dy);
  }

  // ===== Movements builder =====
  async function buildMovements(coords, segForFallback) {
    const { pts: sampled } = sampleLineWithIndex(coords, SAMPLE_EVERY_M);
    if (sampled.length < 2) return [];

    // Snap
    let snapFeatures = [];
    try { 
      for (let i=0;i<sampled.length;i+=SNAP_BATCH_SIZE){
        const chunk = sampled.slice(i, i+SNAP_BATCH_SIZE);
        const feats = await snapRoad(chunk);
        if (feats.length < chunk.length) for (let k=feats.length;k<chunk.length;k++) feats.push({});
        else if (feats.length > chunk.length) feats.length = chunk.length;
        snapFeatures.push(...feats);
      }
    } catch { snapFeatures = []; }

    const snapNames = snapFeatures.map(f => pickFromSnapProps(f?.properties || {}));
    const namedCount = snapNames.filter(Boolean).length;
    let overpassWays = null;
    if (namedCount < (sampled.length-1) * 0.3) {
      const bbox = bboxOfCoords(coords);
      try { overpassWays = await overpassFetchWays(bbox); }
      catch (e) { console.warn('Overpass failed:', e); }
    }

    const nameAt = (i) => {
      let nm = snapNames[i] || '';
      if (!nm && overpassWays) {
        const [n2, d2] = nearestWayNameAndDist(sampled[i], overpassWays);
        if (d2 <= MAX_WAY_SNAP_M) nm = n2;
      }
      if (!nm && segForFallback?.steps?.length) {
        const steps = segForFallback.steps;
        const idx = Math.floor((i / (sampled.length-1)) * steps.length);
        const st = steps[Math.max(0, Math.min(steps.length-1, idx))];
        nm = normalizeName(st?.name || st?.instruction?.replace(/<[^>]*>/g,'') || '');
      }
      return nm || '(unnamed)';
    };

    const rows = [];

    // Current "appearance"
    let curName = nameAt(0);
    let curBound = avgHeading(sampled, 0, BOUND_AVG_WINDOW_M);
    let curDist  = 0;

    // Pending switch candidate
    let pendName = null;
    let pendDist = 0;
    let pendBoundAvgStartIdx = 0; // index where pending started
    let switchingHold = null; // hold previous segment until rejoin window passes

    // Distance already traversed on the *new* street since switch confirm
    let distOnNewSinceConfirm = 0;

    for (let i=0;i<sampled.length-1;i++){
      const segDist = haversineMeters(sampled[i], sampled[i+1]);
      if (segDist <= 0) continue;

      const obsName = nameAt(i);

      // If a prior switch was confirmed but not yet finalized (rejoin window), check for rejoin
      if (switchingHold) {
        distOnNewSinceConfirm += segDist;
        if (obsName === switchingHold.name && distOnNewSinceConfirm < REJOIN_WINDOW_M) {
          // Rejoin previous before window: cancel switch, continue previous segment
          curName = switchingHold.name;
          curBound = switchingHold.bound;
          curDist  = switchingHold.dist + segDist;
          switchingHold = null;
          pendName = null; pendDist = 0;
          continue;
        }
        if (distOnNewSinceConfirm >= REJOIN_WINDOW_M) {
          // Finalize the previous row
          if (switchingHold.dist >= MIN_FRAGMENT_M)
            rows.push({ dir: switchingHold.bound, name: switchingHold.name, km: +(switchingHold.dist/1000).toFixed(2) });
          switchingHold = null; // firm on new street now
        }
      }

      if (obsName === curName) {
        curDist += segDist;
        pendName = null; pendDist = 0;
        continue;
      }

      // Observe a candidate new street
      if (pendName === obsName) {
        pendDist += segDist;
        if (pendDist >= SWITCH_CONFIRM_M) {
          // Confirm the switch: compute the bound for the new street by averaging ahead
          const newBound = avgHeading(sampled, Math.max(0, i - Math.ceil(pendDist / SAMPLE_EVERY_M)), BOUND_AVG_WINDOW_M);
          // Put current segment on hold (we might rejoin quickly)
          switchingHold = { name: curName, bound: curBound, dist: curDist };
          distOnNewSinceConfirm = 0;
          // Start new current
          curName = pendName;
          curBound = newBound;
          curDist  = pendDist;
          pendName = null; pendDist = 0;
        }
      } else {
        // New candidate replaces old
        pendName = obsName;
        pendDist = segDist;
        pendBoundAvgStartIdx = i; // used by avgHeading upon confirm
      }
    }

    // Finalize any pending switch (beyond rejoin window not reached)
    if (switchingHold) {
      // If we ended before REJOIN_WINDOW_M, merge back
      if (distOnNewSinceConfirm < REJOIN_WINDOW_M) {
        curName = switchingHold.name;
        curBound = switchingHold.bound;
        curDist += switchingHold.dist;
      } else {
        if (switchingHold.dist >= MIN_FRAGMENT_M)
          rows.push({ dir: switchingHold.bound, name: switchingHold.name, km: +(switchingHold.dist/1000).toFixed(2) });
      }
    }

    if (curDist >= MIN_FRAGMENT_M)
      rows.push({ dir: curBound, name: curName, km: +(curDist/1000).toFixed(2) });

    return rows;
  }

  // ===== Drawing =====
  function drawRoute(geojson, color) {
    ensureGroup();
    const line = L.geoJSON(geojson, { style: { color, weight: 5, opacity: 0.9 } });
    S.group.addLayer(line);
    return line;
  }
  function addMarker(lat, lon, html, radius = 6) {
    ensureGroup();
    const m = L.circleMarker([lat, lon], { radius }).bindPopup(html);
    S.group.addLayer(m);
    return m;
  }

  // ===== Controls =====
  const TripControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const el = L.DomUtil.create('div', 'routing-control trip-card');
      el.innerHTML = `
        <div class="routing-header"><strong>Trip Generator</strong></div>
        <div class="routing-actions" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          <button id="rt-gen">Generate Trips</button>
          <button id="rt-clr" class="ghost">Clear</button>
        </div>
        <small class="routing-hint">Uses the address from the top search bar. Click a result so the blue pin appears.</small>
        <details class="routing-section" style="margin-top:8px;">
          <summary style="cursor:pointer">API keys & options</summary>
          <div class="key-row" style="margin-top:8px;display:grid;gap:8px;">
            <label for="rt-keys" style="font-weight:600;">OpenRouteService key(s)</label>
            <input id="rt-keys" type="text" placeholder="KEY1,KEY2 (comma-separated)">
            <div class="routing-row" style="display:flex;gap:10px;flex-wrap:wrap;">
              <button id="rt-save">Save Keys</button>
              <button id="rt-url" class="ghost">Use ?orsKey</button>
            </div>
            <small class="routing-hint">Priority: ?orsKey → saved → inline fallback. Keys auto-rotate on 401/429.</small>
          </div>
        </details>
      `;
      L.DomEvent.disableClickPropagation(el);
      return el;
    }
  });

  const ReportControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const el = L.DomUtil.create('div', 'routing-control report-card');
      el.innerHTML = `
        <div class="routing-header"><strong>Report</strong></div>
        <div class="routing-actions" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          <button id="rt-print" disabled>Print Report</button>
        </div>
        <small class="routing-hint">Prints the directions already generated — no new API calls.</small>
      `;
      L.DomEvent.disableClickPropagation(el);
      return el;
    }
  });

  function setReportEnabled(enabled) {
    const b = document.getElementById('rt-print');
    if (b) b.disabled = !enabled;
  }

  // ===== Init =====
  function init(map) {
    S.map = map;
    S.keys = loadKeys();
    setIndex(getIndex());

    S.map.addControl(new TripControl());
    S.map.addControl(new ReportControl());

    S.els = {
      gen: document.getElementById('rt-gen'),
      clr: document.getElementById('rt-clr'),
      print: document.getElementById('rt-print'),
      keys: document.getElementById('rt-keys'),
      save: document.getElementById('rt-save'),
      url: document.getElementById('rt-url')
    };
    if (S.els.keys) S.els.keys.value = S.keys.join(',');

    if (S.els.gen)   S.els.gen.onclick   = generateTrips;
    if (S.els.clr)   S.els.clr.onclick   = () => clearAll();
    if (S.els.print) S.els.print.onclick = () => printReport();
    if (S.els.save)  S.els.save.onclick  = () => {
      const arr = (S.els.keys.value || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!arr.length) return popup('<b>Routing</b><br>Enter a key.');
      S.keys = arr; saveKeys(arr); setIndex(0);
      popup('<b>Routing</b><br>Keys saved.');
    };
    if (S.els.url)   S.els.url.onclick   = () => {
      const arr = parseUrlKeys();
      if (!arr.length) return popup('<b>Routing</b><br>No <code>?orsKey=</code> in URL.');
      S.keys = arr; setIndex(0);
      popup('<b>Routing</b><br>Using keys from URL.');
    };
  }

  // ===== Generate Trips =====
  async function generateTrips() {
    try {
      const origin = global.ROUTING_ORIGIN;
      if (!origin) return popup('<b>Routing</b><br>Search an address in the top bar and select a result first.');

      clearAll();
      addMarker(origin.lat, origin.lon, `<b>Origin</b><br>${origin.label}`, 6);

      let targets = [];
      if (typeof global.getSelectedPDTargets === 'function') targets = global.getSelectedPDTargets();
      if (!targets.length) return popup('<b>Routing</b><br>No PDs selected.');

      try {
        const f = targets[0];
        S.map.fitBounds(L.latLngBounds([[origin.lat, origin.lon], [f[1], f[0]]]), { padding: [24, 24] });
      } catch {}

      for (let i = 0; i < targets.length; i++) {
        const [dlon, dlat, label] = targets[i];

        let gj = null, feat = null, seg = null, km = '—', min = '—';
        try {
          gj = await getRoute([origin.lon, origin.lat], [dlon, dlat]);
          drawRoute(gj, i === 0 ? COLOR_FIRST : COLOR_OTHERS);

          feat = gj?.features?.[0];
          seg  = feat?.properties?.segments?.[0];

          const coords = feat?.geometry?.coordinates || [];
          const totalKm = (seg && seg.distance > 0) ? (seg.distance / 1000) : lengthFromCoordsKm(coords);
          km  = totalKm.toFixed(1);
          min = seg ? Math.round((seg.duration || 0) / 60) : '—';

          const assignments = await buildMovements(coords, seg);

          const steps = (seg?.steps || []).map(s => {
            const txt = String(s.instruction || '').replace(/<[^>]+>/g, '');
            const dist = ((s.distance || 0) / 1000).toFixed(2);
            return `${txt} — ${dist} km`;
          });

          S.results.push({ label, lat: dlat, lon: dlon, km, min, steps, assignments, gj });

          const preview = assignments.slice(0,6).map(a=>`<li>${a.dir} ${a.name} — ${a.km.toFixed(2)} km</li>`).join('');
          const html = `
            <div style="max-height:35vh;overflow:auto;">
              <strong>${label}</strong><br>${km} km • ${min} min
              <div style="margin-top:6px;">
                <em>Street assignments</em>
                <ul style="margin:6px 0 8px 18px; padding:0;">${preview || '<li><em>No named streets</em></li>'}</ul>
              </div>
            </div>`;
          addMarker(dlat, dlon, html, 5).openPopup();

        } catch (e) {
          console.error(e);
          popup(`<b>Routing</b><br>Route failed for ${label}<br><small>${e.message}</small>`);
        }

        if (i < targets.length - 1) await sleep(THROTTLE_MS_DIRECTIONS);
      }

      setReportEnabled(S.results.length > 0);
      if (S.results.length) popup('<b>Routing</b><br>All routes processed. Popups added at each destination.');
    } catch (e) {
      console.error(e);
      popup(`<b>Routing</b><br>${e.message || 'Unknown error.'}`);
    }
  }

  // ===== Print Report =====
  function printReport() {
    if (!S.results.length) return popup('<b>Routing</b><br>Generate trips first.');
    const w = window.open('', '_blank');
    const css = `
      <style>
        body { font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; padding:16px; }
        h1 { margin:0 0 8px; font-size:20px; }
        .card { border:1px solid #ddd; border-radius:12px; padding:12px; margin:12px 0; }
        .sub { color:#555; margin-bottom:8px; }
        table { width:100%; border-collapse:collapse; margin-top:8px; }
        th, td { text-align:left; padding:6px 8px; border-bottom:1px solid #eee; }
        th { font-weight:700; background:#fafafa; }
        .right { text-align:right; white-space:nowrap; }
      </style>`;
    const rows = S.results.map((r,i) => {
      const lines = (r.assignments && r.assignments.length)
        ? r.assignments.map(a => `<tr><td>${a.dir}</td><td>${a.name}</td><td class="right">${a.km.toFixed(2)} km</td></tr>`).join('')
        : `<tr><td colspan="3"><em>No named streets on route</em></td></tr>`;
      return `
        <div class="card">
          <h2>${i+1}. ${r.label}</h2>
          <div class="sub">Distance: ${r.km} km • ${r.min} min</div>
          <table>
            <thead><tr><th>Bound</th><th>Street</th><th class="right">Distance</th></tr></thead>
            <tbody>${lines}</tbody>
          </table>
        </div>`;
    }).join('');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Trip Report</title>${css}</head>
    <body><h1>Trip Report — Street Assignments</h1>${rows}
    <script>window.onload=()=>window.print();</script></body></html>`);
    w.document.close();
  }

  // ===== Public API =====
  const Routing = {
    init(map) { init(map); },
    clear() { clearAll(); },
    setApiKeys(arr) { S.keys = Array.isArray(arr) ? [...arr] : []; saveKeys(S.keys); setIndex(0); }
  };
  global.Routing = Routing;

  document.addEventListener('DOMContentLoaded', () => { if (global.map) Routing.init(global.map); });
})(window);
