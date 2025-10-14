/* routing.js — ORS Directions + Snap v2 street movements
 * - One Directions request per PD
 * - Naming from ORS Snap v2 (/v2/snap/road) with highway normalization
 * - Collapse tiny detours (rejoin window), allow real repeats later
 * - Street bound locked from the FIRST N meters of that street's appearance
 * - Print Report uses cached results only (no extra API calls)
 */
(function (global) {
  // ==== Tunables ============================================================
  const SWITCH_CONFIRM_M    = 200;  // new street must persist >= this to switch
  const REJOIN_WINDOW_M     = 600;  // if we rejoin previous within this, merge (no duplicate row)
  const MIN_FRAGMENT_M      = 60;   // drop tiny slivers
  const SAMPLE_EVERY_M      = 50;   // polyline sampling for Snap
  const SNAP_BATCH_SIZE     = 200;  // Snap batch size
  const BOUND_LOCK_WINDOW_M = 300;  // average heading over FIRST N meters to lock NB/EB/SB/WB
  const TAIL_REPAIR_MAX_GAP = 3;    // max unnamed samples to fill at the end

  const PROFILE    = 'driving-car';
  const PREFERENCE = 'fastest';
  const ORS_BASE   = 'https://api.openrouteservice.org';

  const COLOR_FIRST  = '#0b3aa5';
  const COLOR_OTHERS = '#2166f3';

  // Inline fallback + key mgmt
  const INLINE_DEFAULT_KEY =
    'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=';
  const LS_KEYS = 'ORS_KEYS';
  const LS_ACTIVE_INDEX = 'ORS_ACTIVE_INDEX';

  // ==== State ===============================================================
  const S = { map:null, group:null, keys:[], keyIndex:0, results:[], els:{} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ==== Math helpers ========================================================
  const toRad = d => d*Math.PI/180;
  function haversineMeters(a,b){
    const R=6371000;
    const [x1,y1]=a,[x2,y2]=b;
    const dLat=toRad(y2-y1), dLng=toRad(x2-x1);
    const s=Math.sin(dLat/2)**2 + Math.cos(toRad(y1))*Math.cos(toRad(y2))*Math.sin(dLng/2)**2;
    return 2*R*Math.asin(Math.sqrt(s));
  }
  function bearingDeg(a,b){
    const [lng1,lat1]=[toRad(a[0]),toRad(a[1])], [lng2,lat2]=[toRad(b[0]),toRad(b[1])];
    const y=Math.sin(lng2-lng1)*Math.cos(lat2);
    const x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(lng2-lng1);
    return (Math.atan2(y,x)*180/Math.PI+360)%360;
  }
  function cardinal4(deg){ if (deg>=315||deg<45) return 'NB'; if (deg<135) return 'EB'; if (deg<225) return 'SB'; return 'WB'; }
  function sampleLine(coords, stepM){
    if (!coords || coords.length<2) return coords||[];
    const pts=[coords[0]]; let acc=0;
    for (let i=1;i<coords.length;i++){
      const seg=haversineMeters(coords[i-1], coords[i]); acc+=seg;
      if (acc>=stepM){ pts.push(coords[i]); acc=0; }
    }
    if (pts[pts.length-1]!==coords[coords.length-1]) pts.push(coords[coords.length-1]);
    return pts;
  }
  // Average heading from index forward, up to windowM meters
  function avgHeadingFrom(sampled, iStart, windowM) {
    let vx=0, vy=0, acc=0;
    for (let i=iStart; i<sampled.length-1 && acc<windowM; i++){
      const a=sampled[i], b=sampled[i+1];
      const d=haversineMeters(a,b); if (d<=0) continue;
      const br=bearingDeg(a,b)*Math.PI/180;
      vx += Math.cos(br)*d; vy += Math.sin(br)*d; acc += d;
    }
    if (!vx && !vy) {
      const j=Math.min(sampled.length-1, iStart+1);
      return cardinal4(bearingDeg(sampled[iStart], sampled[j]));
    }
    const deg=(Math.atan2(vy,vx)*180/Math.PI+360)%360;
    return cardinal4(deg);
  }

  // ==== Name handling (Snap) ===============================================
  function normalizeName(raw){
    if (!raw) return '';
    let s=String(raw).trim();

    // Ontario 400-series → canonical Highway NNN (handles ON-401, 401 Express/Collector, ref=401, etc.)
    const canon = n => `Highway ${n}`;
    s = s.replace(/\b(?:ON|Ontario)?\s*[-–]?\s*(?:Hwy|HWY|Highway|RTE|Route)?\s*401\b.*?/ig, canon(401));
    s = s.replace(/\b(?:ON|Ontario)?\s*[-–]?\s*(?:Hwy|HWY|Highway|RTE|Route)?\s*400\b.*?/ig, canon(400));
    s = s.replace(/\b(?:ON|Ontario)?\s*[-–]?\s*(?:Hwy|HWY|Highway|RTE|Route)?\s*404\b.*?/ig, canon(404));
    s = s.replace(/\b(?:ON|Ontario)?\s*[-–]?\s*(?:Hwy|HWY|Highway|RTE|Route)?\s*427\b.*?/ig, canon(427));
    s = s.replace(/\b(?:ON|Ontario)?\s*[-–]?\s*(?:Hwy|HWY|Highway|RTE|Route)?\s*409\b.*?/ig, canon(409));

    // Common abbrevs
    s = s.replace(/\b(st)\b\.?/ig,'Street')
         .replace(/\b(rd)\b\.?/ig,'Road')
         .replace(/\b(ave)\b\.?/ig,'Avenue');

    // Strip ramp fluff
    s = s.replace(/\b(?:Onramp|Offramp|Ramp)\b.*$/i,'');

    return s.replace(/\s+/g,' ').trim();
  }
  function pickFromSnapProps(props={}){
    const flatKeys = ['name','street','road','way_name','label','display_name','name:en'];
    for (const k of flatKeys) if (props[k]) return normalizeName(props[k]);
    if (props.ref) return normalizeName(`Highway ${props.ref}`);
    const tags = props.tags || props.properties || {};
    for (const k of flatKeys) if (tags[k]) return normalizeName(tags[k]);
    if (tags.ref) return normalizeName(`Highway ${tags.ref}`);
    return '';
  }
  // Repair small end gaps so tail isn't unnamed
  function repairTail(names){
    const out = names.slice();
    // forward fill single gaps
    for (let i=1;i<out.length;i++){
      if ((!out[i] || out[i]==='(unnamed)') && out[i-1] && out[i-1] !== '(unnamed)') out[i]=out[i-1];
    }
    // backfill tail if small gap
    let trailing=0;
    for (let i=out.length-1;i>=0;i--){
      if (!out[i] || out[i]==='(unnamed)') trailing++; else break;
    }
    if (trailing>0 && trailing<=TAIL_REPAIR_MAX_GAP){
      const lastNamed = out[out.length-1-trailing-1];
      if (lastNamed) for (let j=out.length-trailing;j<out.length;j++) out[j]=lastNamed;
    }
    return out;
  }

  // ==== Keys ================================================================
  const parseUrlKeys = () => {
    const raw=new URLSearchParams(location.search).get('orsKey');
    return raw ? raw.split(',').map(s=>s.trim()).filter(Boolean) : [];
  };
  const loadKeys = () => {
    const u=parseUrlKeys(); if (u.length) return u;
    try { const ls=JSON.parse(localStorage.getItem(LS_KEYS) || '[]'); if (Array.isArray(ls)&&ls.length) return ls; } catch {}
    return [INLINE_DEFAULT_KEY];
  };
  const saveKeys = arr => localStorage.setItem(LS_KEYS, JSON.stringify(arr));
  const setIndex = i => { S.keyIndex=Math.max(0, Math.min(i, S.keys.length-1)); localStorage.setItem(LS_ACTIVE_INDEX, String(S.keyIndex)); };
  const getIndex = () => Number(localStorage.getItem(LS_ACTIVE_INDEX) || 0);
  const currentKey = () => S.keys[S.keyIndex];
  const rotateKey  = () => (S.keys.length>1 ? (setIndex((S.keyIndex+1)%S.keys.length), true) : false);

  // ==== Map helpers =========================================================
  const ensureGroup = () => { if (!S.group) S.group = L.layerGroup().addTo(S.map); };
  const clearAll = () => { if (S.group) S.group.clearLayers(); S.results=[]; setReportEnabled(false); };
  const popup = (html, at) => {
    const ll = at || (S.map ? S.map.getCenter() : null);
    if (ll) L.popup().setLatLng(ll).setContent(html).openOn(S.map);
    else alert(html.replace(/<[^>]+>/g,''));
  };

  // ==== ORS fetch ===========================================================
  async function orsFetch(path, { method='GET', body, query } = {}) {
    const url = new URL(ORS_BASE + path);
    if (query) Object.entries(query).forEach(([k,v]) => url.searchParams.set(k,v));
    const res = await fetch(url.toString(), {
      method,
      headers: { Authorization: currentKey(), ...(method!=='GET' && {'Content-Type':'application/json'}) },
      body: method==='GET' ? undefined : JSON.stringify(body)
    });
    if ([401,403,429].includes(res.status) && rotateKey()) {
      return orsFetch(path, { method, body, query });
    }
    if (!res.ok) throw new Error(`ORS ${res.status}: ${await res.text().catch(()=>res.statusText)}`);
    return res.json();
  }
  async function getRoute(originLonLat, destLonLat){
    return orsFetch(`/v2/directions/${PROFILE}/geojson`, {
      method:'POST',
      body:{
        coordinates:[originLonLat, destLonLat],
        preference:PREFERENCE,
        instructions:true,
        instructions_format:'html',
        language:'en',
        units:'km'
      }
    });
  }
  async function snapRoad(points){
    if (!points?.length) return [];
    const url = `${ORS_BASE}/v2/snap/road`;
    const res = await fetch(url, {
      method:'POST',
      headers:{ 'Authorization': currentKey(), 'Content-Type':'application/json' },
      body: JSON.stringify({ points, locations: points })
    });
    if ([401,403,429].includes(res.status) && rotateKey()) return snapRoad(points);
    if (!res.ok) return []; // treat as missing info
    const json = await res.json();
    return Array.isArray(json?.features) ? json.features : [];
  }

  // ==== Movements (Snap-only + bound lock on first N meters) ===============
  async function buildMovements(coords, segForFallback){
    const sampled = sampleLine(coords, SAMPLE_EVERY_M);
    if (sampled.length < 2) return [];

    // Snap names
    let feats = [];
    try {
      for (let i=0;i<sampled.length;i+=SNAP_BATCH_SIZE){
        const chunk = sampled.slice(i, i+SNAP_BATCH_SIZE);
        const got = await snapRoad(chunk);
        if (got.length < chunk.length) for (let k=got.length;k<chunk.length;k++) got.push({});
        else if (got.length > chunk.length) got.length = chunk.length;
        feats.push(...got);
      }
    } catch { feats = []; }

    // Extract names; fallback to ORS steps only for unnamed samples
    const steps = segForFallback?.steps || [];
    const stepNameAt = (i) => {
      if (!steps.length) return '';
      const idx = Math.floor((i / (sampled.length-1)) * steps.length);
      const st = steps[Math.max(0, Math.min(steps.length-1, idx))];
      const raw = (st?.name || String(st?.instruction||'').replace(/<[^>]*>/g,'')).trim();
      return normalizeName(raw);
    };

    let names = feats.map(f => pickFromSnapProps(f?.properties || ''));
    names = names.map((n,i)=> n || stepNameAt(i) || '(unnamed)');
    names = repairTail(names);

    // Build rows (switch-confirm + rejoin-window + bound lock from FIRST N m)
    const rows = [];
    let curName  = names[0];
    let curDist  = 0;
    let curBound = avgHeadingFrom(sampled, 0, BOUND_LOCK_WINDOW_M);

    let pendName = null;
    let pendDist = 0;

    let holdPrev = null;           // { name, bound, dist }
    let distOnNewSinceConfirm = 0; // meters after confirming switch

    for (let i=0;i<sampled.length-1;i++){
      const segDist = haversineMeters(sampled[i], sampled[i+1]);
      if (segDist <= 0) continue;

      const observedName = names[i];

      if (holdPrev) {
        distOnNewSinceConfirm += segDist;
        if (observedName === holdPrev.name && distOnNewSinceConfirm < REJOIN_WINDOW_M) {
          // Snap back quickly → merge
          curName = holdPrev.name;
          curBound = holdPrev.bound;
          curDist  = holdPrev.dist + segDist;
          holdPrev = null; pendName = null; pendDist = 0;
          continue;
        }
        if (distOnNewSinceConfirm >= REJOIN_WINDOW_M) {
          if (holdPrev.dist >= MIN_FRAGMENT_M)
            rows.push({ dir: holdPrev.bound, name: holdPrev.name, km: +(holdPrev.dist/1000).toFixed(2) });
          holdPrev = null;
        }
      }

      if (observedName === curName) {
        curDist += segDist;
        pendName = null; pendDist = 0;
        continue;
      }

      if (pendName === observedName) {
        pendDist += segDist;
        if (pendDist >= SWITCH_CONFIRM_M) {
          // Confirm switch → lock new bound from first N meters of NEW appearance
          const backSamples = Math.max(0, Math.ceil(pendDist / SAMPLE_EVERY_M));
          const startIdx = Math.max(0, i - backSamples);
          const newBound = avgHeadingFrom(sampled, startIdx, BOUND_LOCK_WINDOW_M);

          holdPrev = { name: curName, bound: curBound, dist: curDist };
          distOnNewSinceConfirm = 0;

          curName  = pendName;
          curBound = newBound;
          curDist  = pendDist;
          pendName = null; pendDist = 0;
        }
      } else {
        // new candidate
        pendName = observedName;
        pendDist = segDist;
      }
    }

    if (holdPrev) {
      if (distOnNewSinceConfirm < REJOIN_WINDOW_M) {
        curName  = holdPrev.name;
        curBound = holdPrev.bound;
        curDist += holdPrev.dist;
      } else {
        if (holdPrev.dist >= MIN_FRAGMENT_M)
          rows.push({ dir: holdPrev.bound, name: holdPrev.name, km: +(holdPrev.dist/1000).toFixed(2) });
      }
    }
    if (curDist >= MIN_FRAGMENT_M)
      rows.push({ dir: curBound, name: curName, km: +(curDist/1000).toFixed(2) });

    return rows;
  }

  // ==== Drawing & Controls ==================================================
  function drawRoute(geojson, color) {
    ensureGroup();
    const line = L.geoJSON(geojson, { style: { color, weight:5, opacity:0.9 } });
    S.group.addLayer(line);
    return line;
  }
  function addMarker(lat, lon, html, radius=6){
    ensureGroup();
    const m = L.circleMarker([lat, lon], { radius }).bindPopup(html);
    S.group.addLayer(m);
    return m;
  }

  const TripControl = L.Control.extend({
    options:{ position:'topleft' },
    onAdd(){
      const el = L.DomUtil.create('div','routing-control trip-card');
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
        </details>`;
      L.DomEvent.disableClickPropagation(el);
      return el;
    }
  });

  const ReportControl = L.Control.extend({
    options:{ position:'topleft' },
    onAdd(){
      const el = L.DomUtil.create('div','routing-control report-card');
      el.innerHTML = `
        <div class="routing-header"><strong>Report</strong></div>
        <div class="routing-actions" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          <button id="rt-print" disabled>Print Report</button>
        </div>
        <small class="routing-hint">Prints the directions already generated — no new API calls.</small>`;
      L.DomEvent.disableClickPropagation(el);
      return el;
    }
  });

  function setReportEnabled(enabled){
    const b=document.getElementById('rt-print');
    if (b) b.disabled = !enabled;
  }

  // ==== Init / Generate / Print ============================================
  function init(map){
    S.map = map;
    S.keys = loadKeys();
    setIndex(getIndex());

    S.map.addControl(new TripControl());
    S.map.addControl(new ReportControl());

    S.els = {
      gen:document.getElementById('rt-gen'),
      clr:document.getElementById('rt-clr'),
      print:document.getElementById('rt-print'),
      keys:document.getElementById('rt-keys'),
      save:document.getElementById('rt-save'),
      url:document.getElementById('rt-url')
    };
    if (S.els.keys) S.els.keys.value = S.keys.join(',');

    S.els.gen && (S.els.gen.onclick   = generateTrips);
    S.els.clr && (S.els.clr.onclick   = () => clearAll());
    S.els.print && (S.els.print.onclick = () => printReport());
    S.els.save && (S.els.save.onclick  = () => {
      const arr=(S.els.keys.value||'').split(',').map(s=>s.trim()).filter(Boolean);
      if (!arr.length) return popup('<b>Routing</b><br>Enter a key.');
      S.keys=arr; saveKeys(arr); setIndex(0);
      popup('<b>Routing</b><br>Keys saved.');
    });
    S.els.url && (S.els.url.onclick   = () => {
      const arr=parseUrlKeys();
      if (!arr.length) return popup('<b>Routing</b><br>No <code>?orsKey=</code> in URL.');
      S.keys=arr; setIndex(0);
      popup('<b>Routing</b><br>Using keys from URL.');
    });
  }

  async function generateTrips(){
    try{
      const origin = global.ROUTING_ORIGIN;
      if (!origin) return popup('<b>Routing</b><br>Search an address in the top bar and select a result first.');
      if (!global.getSelectedPDTargets) return popup('<b>Routing</b><br>Zone/PD selection isn\'t ready.');
      const targets = global.getSelectedPDTargets() || [];
      if (!targets.length) return popup('<b>Routing</b><br>No PDs selected.');

      clearAll();
      addMarker(origin.lat, origin.lon, `<b>Origin</b><br>${origin.label}`, 6);

      try {
        const f=targets[0];
        S.map.fitBounds(L.latLngBounds([[origin.lat,origin.lon],[f[1],f[0]]]), { padding:[24,24] });
      } catch {}

      for (let i=0;i<targets.length;i++){
        const [dlon,dlat,label] = targets[i];
        try{
          const gj = await getRoute([origin.lon,origin.lat],[dlon,dlat]);
          drawRoute(gj, i===0 ? COLOR_FIRST : COLOR_OTHERS);

          const feat = gj?.features?.[0];
          const seg  = feat?.properties?.segments?.[0];
          const coords = feat?.geometry?.coordinates || [];

          const distKm = seg?.distance ? seg.distance/1000
            : coords.reduce((a,_,j,arr)=> j? a + haversineMeters(arr[j-1],arr[j])/1000 : 0, 0);
          const km  = distKm.toFixed(1);
          const min = seg ? Math.round((seg.duration||0)/60) : '—';

          const assignments = await buildMovements(coords, seg);

          const stepsTxt = (seg?.steps||[]).map(s=>{
            const txt = String(s.instruction||'').replace(/<[^>]+>/g,'');
            const d = ((s.distance||0)/1000).toFixed(2);
            return `${txt} — ${d} km`;
          });

          S.results.push({ label, lat:dlat, lon:dlon, km, min, steps:stepsTxt, assignments, gj });

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
        if (i<targets.length-1) await sleep(1200); // rate limit 40/min
      }

      setReportEnabled(S.results.length>0);
      if (S.results.length) popup('<b>Routing</b><br>All routes processed. Popups added at each destination.');
    } catch (e) {
      console.error(e);
      popup(`<b>Routing</b><br>${e.message||'Unknown error.'}`);
    }
  }

  function printReport(){
    if (!S.results.length) return popup('<b>Routing</b><br>Generate trips first.');
    const w = window.open('','_blank');
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
    const cards = S.results.map((r,i)=>{
      const lines = (r.assignments && r.assignments.length)
        ? r.assignments.map(a=>`<tr><td>${a.dir}</td><td>${a.name}</td><td class="right">${a.km.toFixed(2)} km</td></tr>`).join('')
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
    <body><h1>Trip Report — Street Assignments</h1>${cards}
    <script>window.onload=()=>window.print();</script></body></html>`);
    w.document.close();
  }

  // Public API + boot
  const Routing = { init(map){ init(map); }, clear(){ clearAll(); }, setApiKeys(arr){ S.keys=Array.isArray(arr)?[...arr]:[]; saveKeys(S.keys); setIndex(0); } };
  global.Routing = Routing;
  document.addEventListener('DOMContentLoaded', () => { if (global.map) Routing.init(global.map); });
})(window);
