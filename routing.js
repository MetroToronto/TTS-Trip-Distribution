/* routing.js — ORS Directions + Snap v2
   - Street list (not maneuvers)
   - Prefer ORS step names; Snap is fallback
   - Highway/expressway cutoff (uses Snap props + name/ref)
   - ✅ Correct NB/EB/SB/WB bounds: vector average from NORTH baseline
   - One Directions call per PD; Snap batched
   - Print Report uses cached results only
   
   --- FIXES APPLIED ---
   - FIX: Movement (NB/EB/SB/WB) accuracy by correcting how street segments are split.
     The old logic could include geometry from a previous street when calculating the bound
     for a new one. The new logic creates a clean cut at the exact point a street change
     is confirmed, ensuring bounds are calculated correctly.
   - FIX: Highway cutoff reliability by expanding the list of recognizable highway/expressway
     names in the normalization function (DVP, Gardiner, Allen Rd, etc.).
   - TWEAK: Adjusted tunable thresholds for better responsiveness in dense areas.
*/
(function (global) {
  // ===== Tunables (ADJUSTED) ==============================================
  const SWITCH_CONFIRM_M    = 80;   // Name must persist this far to switch (was 200)
  const MIN_FRAGMENT_M      = 50;   // Drop tiny fragments (was 60)
  const SAMPLE_EVERY_M      = 50;   // Route sampling spacing
  const SNAP_BATCH_SIZE     = 180;  // Snap batch size
  const BOUND_LOCK_WINDOW_M = 300;  // Meters used to compute row bound

  const PROFILE    = 'driving-car';
  const PREFERENCE = 'fastest';
  const ORS_BASE   = 'https://api.openrouteservice.org';

  const COLOR_FIRST  = '#0b3aa5';
  const COLOR_OTHERS = '#2166f3';

  // Inline fallback key + localStorage slots
  const INLINE_DEFAULT_KEY =
    'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=';
  const LS_KEYS = 'ORS_KEYS';
  const LS_ACTIVE_INDEX = 'ORS_ACTIVE_INDEX';

  // ===== State ==============================================================
  const S = { map:null, group:null, keys:[], keyIndex:0, results:[], els:{} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // ===== Geometry / math helpers ===========================================
  const toRad = d => d*Math.PI/180;
  function haversineMeters(a,b){
    const R=6371000; const [x1,y1]=a,[x2,y2]=b;
    const dLat=toRad(y2-y1), dLng=toRad(x2-x1);
    const s=Math.sin(dLat/2)**2 + Math.cos(toRad(y1))*Math.cos(toRad(y2))*Math.sin(dLng/2)**2;
    return 2*R*Math.asin(Math.sqrt(s));
  }
  function bearingDeg(a,b){
    // Initial bearing FROM a TO b, measured from NORTH, clockwise
    const [lng1,lat1]=[toRad(a[0]),toRad(a[1])], [lng2,lat2]=[toRad(b[0]),toRad(b[1])];
    const y=Math.sin(lng2-lng1)*Math.cos(lat2);
    const x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(lng2-lng1);
    return (Math.atan2(y,x)*180/Math.PI+360)%360;
  }
  function cardinal4(deg){ if (deg>=315||deg<45) return 'NB'; if (deg<135) return 'EB';
  if (deg<225) return 'SB'; return 'WB'; }

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

  // ✅ Correct vector averaging for bearings measured FROM NORTH (clockwise).
  //   For each segment with bearing θ (from NORTH): east = sinθ, north = cosθ.
  //   Resultant bearing = atan2(sum_east, sum_north), still from NORTH.
  function avgHeadingBetween(sampled, iStart, iEnd, capM=BOUND_LOCK_WINDOW_M){
    let sumEast=0, sumNorth=0, acc=0;
    for (let i=iStart; i<iEnd && i<sampled.length-1 && acc<capM; i++){
      const a=sampled[i], b=sampled[i+1];
      const d=haversineMeters(a,b);
      if (d<=0) continue;
      const br=bearingDeg(a,b)*Math.PI/180; // radians, from NORTH
      sumEast  += Math.sin(br)*d; // x
      sumNorth += Math.cos(br)*d;  // y
      acc += d;
    }
    if (!sumEast && !sumNorth) {
      const j=Math.min(sampled.length-1, iStart+1);
      return cardinal4(bearingDeg(sampled[iStart], sampled[j]));
    }
    const deg=(Math.atan2(sumEast, sumNorth)*180/Math.PI+360)%360; // from NORTH
    return cardinal4(deg);
  }

  // ===== Naming helpers =====================================================
  function normalizeName(raw){
    if (!raw) return '';
    let s = String(raw).trim();
    const canon = (name) => `${name}`;
    s = s.replace(/\b(Gardiner Expressway|Gardiner Expwy|F G Gardiner Expy)\b/ig, canon('Gardiner Expressway'));
    s = s.replace(/\b(Don Valley Parkway|Don Valley Pkwy|DVP)\b/ig, canon('Don Valley Parkway'));
    s = s.replace(/\b(W R Allen Road|Allen Rd)\b/ig, canon('Allen Road'));
    s = s.replace(/\b(Queen Elizabeth Way|QEW)\b/ig, canon('Queen Elizabeth Way'));
    s = s.replace(/\b(?:ON|Ontario)?\s*[-–]?\s*(?:Hwy|HWY|Highway|RTE|Route)?\s*401\b.*?/ig, 'Highway 401');
    s = s.replace(/\b(?:ON|Ontario)?\s*[-–]?\s*(?:Hwy|HWY|Highway|RTE|Route)?\s*400\b.*?/ig, 'Highway 400');
    s = s.replace(/\b(?:ON|Ontario)?\s*[-–]?\s*(?:Hwy|HWY|Highway|RTE|Route)?\s*404\b.*?/ig, 'Highway 404');
    s = s.replace(/\b(?:ON|Ontario)?\s*[-–]?\s*(?:Hwy|HWY|Highway|RTE|Route)?\s*427\b.*?/ig, 'Highway 427');
    s = s.replace(/\b(?:ON|Ontario)?\s*[-–]?\s*(?:Hwy|HWY|Highway|RTE|Route)?\s*409\b.*?/ig, 'Highway 409');
    s = s.replace(/\b(st)\b\.?/ig,'Street').replace(/\b(rd)\b\.?/ig,'Road').replace(/\b(ave)\b\.?/ig,'Avenue');
    s = s.replace(/\b(?:Onramp|Offramp|Ramp)\b.*$/i,'');
    return s.replace(/\s+/g,' ').trim();
  }
  function pickFromSnapProps(props={}){
    const flat = ['name','street','road','way_name','label','display_name','name:en'];
    for (const k of flat) if (props[k]) return normalizeName(props[k]);
    if (props.ref) return normalizeName(`Highway ${props.ref}`);
    const tags = props.tags || props.properties || {};
    for (const k of flat) if (tags[k]) return normalizeName(tags[k]);
    if (tags.ref) return normalizeName(`Highway ${tags.ref}`);
    return '';
  }
  function isHighwayName(s=''){
    return /\b(Highway\s?\d{3}|Expressway|Gardiner|Don Valley Parkway|DVP|QEW|Allen Road)\b/i.test(s);
  }
  function snapRef(props={}) {
    const p = props || {};
    return p.ref || p?.tags?.ref || p?.properties?.ref || '';
  }
  function isHighwayByProps(props={}) {
    const p = { ...props, ...(props.tags||{}), ...(props.properties||{}) };
    const vals = [
      p.highway, p.class, p.road_class, p.category, p.fclass, p.type, p.kind
    ].map(v => String(v||'').toLowerCase()).join('|');
    if (/(motorway|trunk|freeway|express|expressway|motorway_link|trunk_link)/.test(vals)) return true;
    const maxs = Number(p.maxspeed || p.max_speed || 0);
    if (maxs >= 90) return true;
    if (/^\d{3}$/.test(String(snapRef(p)))) return true; // e.g., ref=401
    return false;
  }

  // ===== Key management =====================================================
  const parseUrlKeys = () => {
    const raw=new URLSearchParams(location.search).get('orsKey');
    return raw ? raw.split(',').map(s=>s.trim()).filter(Boolean) : [];
  };
  const loadKeys = () => {
    const u=parseUrlKeys();
    if (u.length) return u;
    try { const ls=JSON.parse(localStorage.getItem(LS_KEYS) || '[]'); if (Array.isArray(ls)&&ls.length) return ls;
    } catch {}
    return [INLINE_DEFAULT_KEY];
  };
  const saveKeys = arr => localStorage.setItem(LS_KEYS, JSON.stringify(arr));
  const setIndex = i => { S.keyIndex=Math.max(0, Math.min(i, S.keys.length-1)); localStorage.setItem(LS_ACTIVE_INDEX, String(S.keyIndex)); };
  const getIndex = () => Number(localStorage.getItem(LS_ACTIVE_INDEX) || 0);
  const currentKey = () => S.keys[S.keyIndex];
  const rotateKey  = () => (S.keys.length>1 ? (setIndex((S.keyIndex+1)%S.keys.length), true) : false);
  // ===== Map helpers ========================================================
  const ensureGroup = () => { if (!S.group) S.group = L.layerGroup().addTo(S.map); };
  const clearAll = () => { if (S.group) S.group.clearLayers(); S.results=[]; setReportEnabled(false); };
  const popup = (html, at) => {
    const ll = at || (S.map ? S.map.getCenter() : null);
    if (ll) L.popup().setLatLng(ll).setContent(html).openOn(S.map);
    else alert(html.replace(/<[^>]+>/g,''));
  };

  // ===== ORS fetchers =======================================================
  async function orsFetch(path, { method='GET', body, query } = {}) {
    const url = new URL(ORS_BASE + path);
    if (query) Object.entries(query).forEach(([k,v]) => url.searchParams.set(k,v));
    const res = await fetch(url.toString(), {
      method,
      headers: { Authorization: currentKey(), ...(method!=='GET' && {'Content-Type':'application/json'}) },
      body: method==='GET' ? undefined : JSON.stringify(body)
    });
    if ([401,403,429].includes(res.status) && rotateKey()) return orsFetch(path, { method, body, query });
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
    const res = await fetch(`${ORS_BASE}/v2/snap/road`, {
      method:'POST',
      headers:{ 'Authorization': currentKey(), 'Content-Type':'application/json' },
      body: JSON.stringify({ points, locations: points })
    });
    if ([401,403,429].includes(res.status) && rotateKey()) return snapRoad(points);
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json?.features) ? json.features : [];
  }

  // ===== Movement builder ===================================================
  async function buildMovements(coords, seg) {
    const sampled = sampleLine(coords, SAMPLE_EVERY_M);
    if (sampled.length < 2) return [];

    const steps = seg?.steps || [];
    const stepNameAt = (i) => {
      if (!steps.length) return '';
      const idx = Math.floor((i / (sampled.length-1)) * steps.length);
      const st  = steps[Math.max(0, Math.min(steps.length-1, idx))];
      const raw = (st?.name || String(st?.instruction||'').replace(/<[^>]*>/g,'')).trim();
      return normalizeName(raw);
    };

    // Snap fallback (batched)
    let snapFeats = [];
    try {
      for (let i=0;i<sampled.length;i+=SNAP_BATCH_SIZE){
        const chunk = sampled.slice(i, i+SNAP_BATCH_SIZE);
        const got = await snapRoad(chunk);
        if (got.length < chunk.length) for (let k=got.length;k<chunk.length;k++) got.push({});
        else if (got.length > chunk.length) got.length = chunk.length;
        snapFeats.push(...got);
      }
    } catch { snapFeats = []; }

    const snapNameAt = (i) => pickFromSnapProps(snapFeats[i]?.properties || {});
    const snapIsHwy  = (i) => isHighwayByProps(snapFeats[i]?.properties || {});
    const snapRefAt  = (i) => {
      const p = snapFeats[i]?.properties || {};
      return p.ref || p?.tags?.ref || p?.properties?.ref || '';
    };

    // per-sample chosen name + highway flag
    const names = [];
    const isHwy = [];
    for (let i=0;i<sampled.length-1;i++){
      const stepNm = stepNameAt(i);
      if (stepNm) {
        names[i] = stepNm;
        isHwy[i]  = isHighwayName(stepNm) || snapIsHwy(i);
        continue;
      }
      const nm = snapNameAt(i);
      if (nm) {
        names[i] = nm;
      } else if (snapIsHwy(i)) {
        const r = snapRefAt(i);
        names[i] = r ? `Highway ${r}` : 'Highway';  // synthesize name on highway
      } else {
        names[i] = '';
      }
      isHwy[i] = snapIsHwy(i) || isHighwayName(names[i]);
    }
    names[names.length-1] = names[names.length-2] || '';
    isHwy[isHwy.length-1] = isHwy[isHwy.length-2] || false;

    const distBetween = (i) => haversineMeters(sampled[i], sampled[i+1]);

    // Find first highway sample → cutoff point
    const firstHwyIdx = isHwy.findIndex(Boolean);
    const lastIdx = (firstHwyIdx > -1 ? firstHwyIdx : sampled.length-1);

    // --- (FIXED) Build row index ranges with more precise switch logic ---
    const rowsIdx = [];
    let curName = names[0] || '(unnamed)';
    let startIdx = 0;
    let pendName = null;
    let pendDist = 0;
    let pendStartIdx = -1; // Index where the pending switch *started*

    for (let i = 0; i < lastIdx; i++) {
        const d = distBetween(i);
        const observed = names[i] || curName;

        if (observed === curName) {
            // Name is stable, so reset any pending switch
            pendName = null;
            pendDist = 0;
            pendStartIdx = -1;
            continue;
        }

        // A different name is observed
        if (pendName === observed) {
            // This name is still pending, accumulate distance
            pendDist += d;
        } else {
            // This is a new potential street name
            pendName = observed;
            pendDist = d;
            pendStartIdx = i; // CRITICAL: Remember where this new segment began
        }

        if (pendName && pendDist >= SWITCH_CONFIRM_M) {
            // The switch is now confirmed!
            // 1. Close out the *previous* street's row. It ends right *before* the new one started.
            if (pendStartIdx > startIdx) {
                rowsIdx.push({ name: curName, i0: startIdx, i1: pendStartIdx });
            }

            // 2. The new street is now the current one. It starts from where it was first observed.
            curName = pendName;
            startIdx = pendStartIdx;

            // 3. Reset the pending state
            pendName = null;
            pendDist = 0;
            pendStartIdx = -1;
        }
    }
    // Push the final local street row
    if (lastIdx > startIdx) {
        rowsIdx.push({ name: curName, i0: startIdx, i1: lastIdx });
    }

    // If a highway was detected, add one final, clean row for it.
    if (firstHwyIdx > -1) {
        const hwySampleIndex = Math.min(firstHwyIdx, names.length - 1);
        const ref = snapRefAt(hwySampleIndex);
        const nameFromList = normalizeName(names[hwySampleIndex] || '');
        const hwyName = isHighwayName(nameFromList) && nameFromList ? nameFromList : (ref ? `Highway ${ref}` : 'Highway');
        rowsIdx.push({ name: hwyName, i0: firstHwyIdx, i1: sampled.length - 1, isHighway: true });
    }

    // Convert indices to final rows with distance and bound
    const rows = [];
    for (const r of rowsIdx) {
      let meters = 0;
      for (let i=r.i0; i<r.i1 && i<sampled.length-1; i++) meters += distBetween(i);
      if (meters < MIN_FRAGMENT_M) continue;

      // ✅ Bound from the first part of THIS row (now using clean geometry)
      const dir = avgHeadingBetween(sampled, r.i0, r.i1, BOUND_LOCK_WINDOW_M);
      const nm  = normalizeName(r.name);
      if (!nm || nm==='(unnamed)') continue;

      rows.push({ dir, name: nm, km: +(meters/1000).toFixed(2) });
      if (r.isHighway) break; // stop after first highway row
    }
    return rows;
  }

  // ===== Drawing & Controls ================================================
  function drawRoute(geojson, color){ ensureGroup(); const line=L.geoJSON(geojson,{style:{color,weight:5,opacity:0.9}}); S.group.addLayer(line); return line;
  }
  function addMarker(lat, lon, html, radius=6){ ensureGroup(); const m=L.circleMarker([lat,lon],{radius}).bindPopup(html); S.group.addLayer(m); return m;
  }

  const TripControl = L.Control.extend({
    options:{ position:'topleft' },
    onAdd(){
      const el=L.DomUtil.create('div','routing-control trip-card');
      el.innerHTML=`
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
      const el=L.DomUtil.create('div','routing-control report-card');
      el.innerHTML=`
        <div class="routing-header"><strong>Report</strong></div>
        <div class="routing-actions" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          <button id="rt-print" disabled>Print Report</button>
        </div>
        <small class="routing-hint">Prints the directions already generated — no new API calls.</small>`;
      L.DomEvent.disableClickPropagation(el);
       return el;
    }
  });

  function setReportEnabled(enabled){ const b=document.getElementById('rt-print'); if (b) b.disabled=!enabled;
  }

  // ===== Init / Generate / Print ===========================================
  function init(map){
    S.map=map; S.keys=loadKeys(); setIndex(getIndex());
    S.map.addControl(new TripControl()); S.map.addControl(new ReportControl());

    S.els = {
      gen:document.getElementById('rt-gen'),
      clr:document.getElementById('rt-clr'),
      print:document.getElementById('rt-print'),
      keys:document.getElementById('rt-keys'),
      save:document.getElementById('rt-save'),
      url:document.getElementById('rt-url')
    };
    if (S.els.keys) S.els.keys.value=S.keys.join(',');

    if (S.els.gen)   S.els.gen.onclick   = generateTrips;
    if (S.els.clr)   S.els.clr.onclick   = () => clearAll();
    if (S.els.print) S.els.print.onclick = () => printReport();
    if (S.els.save)  S.els.save.onclick  = () => {
      const arr=(S.els.keys.value||'').split(',').map(s=>s.trim()).filter(Boolean);
      if(!arr.length) return popup('<b>Routing</b><br>Enter a key.');
      S.keys=arr; saveKeys(arr); setIndex(0);
      popup('<b>Routing</b><br>Keys saved.');
    };
    if (S.els.url)   S.els.url.onclick   = () => {
      const arr=parseUrlKeys();
      if(!arr.length) return popup('<b>Routing</b><br>No <code>?orsKey=</code> in URL.');
      S.keys=arr; setIndex(0);
      popup('<b>Routing</b><br>Using keys from URL.');
    };
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

      try { const f=targets[0]; S.map.fitBounds(L.latLngBounds([[origin.lat,origin.lon],[f[1],f[0]]]), { padding:[24,24] });
      } catch {}

      for (let i=0;i<targets.length;i++){
        const [dlon,dlat,label]=targets[i];
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
          addMarker(dlat, dlon, `
            <div style="max-height:35vh;overflow:auto;">
              <strong>${label}</strong><br>${km} km • ${min} min
              <div style="margin-top:6px;">
                <em>Street assignments</em>
                <ul style="margin:6px 0 8px 18px; padding:0;">${preview || '<li><em>No named streets</em></li>'}</ul>
              </div>
            </div>`, 5).openPopup();
        } catch (e) {
          console.error(e);
          popup(`<b>Routing</b><br>Route failed for ${label}<br><small>${e.message}</small>`);
        }
        if (i<targets.length-1) await sleep(1200); // 40/min
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
    const w=window.open('','_blank');
    const css=`<style>
      body{font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:16px;}
      h1{margin:0 0 8px;font-size:20px;}
      .card{border:1px solid #ddd;border-radius:12px;padding:12px;margin:12px 0;}
      .sub{color:#555;margin-bottom:8px;}
      table{width:100%;border-collapse:collapse;margin-top:8px;}
      th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eee;}
      th{font-weight:700;background:#fafafa;}
      .right{text-align:right;white-space:nowrap;}
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
  const Routing = { init(map){ init(map); }, clear(){ clearAll(); }, setApiKeys(arr){ S.keys=Array.isArray(arr)?[...arr]:[];
  saveKeys(S.keys); setIndex(0); } };
  global.Routing = Routing;
  document.addEventListener('DOMContentLoaded', ()=>{ if (global.map) Routing.init(global.map); });
})(window);
