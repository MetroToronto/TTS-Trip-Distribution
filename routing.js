/* routing.js — Directions-only with robust highway extraction
   - Uses ORS Directions v2 steps only (no Snap)
   - Parses highway names from step.name OR instruction text
   - Expands Pkwy/Expwy abbreviations; recognizes DVP, QEW, Gardiner
   - Includes the first highway segment (merges ramp + first highway step)
   - Stable NB/EB/SB/WB from the first ≤300 m of each row
*/
(function (global) {
  // ===== Tunables ===========================================================
  const MIN_FRAGMENT_M      = 60;   // drop tiny rows
  const BOUND_LOCK_WINDOW_M = 300;  // meters used to compute a row's bound
  const SAMPLE_EVERY_M      = 50;   // sampling spacing for heading calc

  const PROFILE    = 'driving-car';
  const PREFERENCE = 'fastest';
  const ORS_BASE   = 'https://api.openrouteservice.org';

  const COLOR_FIRST  = '#0b3aa5';
  const COLOR_OTHERS = '#2166f3';

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
    // Initial bearing FROM a TO b, from NORTH clockwise
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

  function avgHeadingBetween(sampled, iStart, iEnd, capM=BOUND_LOCK_WINDOW_M){
    // Correct vector average for bearings from NORTH
    let sumEast=0, sumNorth=0, acc=0;
    for (let i=iStart; i<iEnd && i<sampled.length-1 && acc<capM; i++){
      const a=sampled[i], b=sampled[i+1];
      const d=haversineMeters(a,b); if (d<=0) continue;
      const br=bearingDeg(a,b)*Math.PI/180;
      sumEast  += Math.sin(br)*d;   // x
      sumNorth += Math.cos(br)*d;   // y
      acc      += d;
    }
    if (!sumEast && !sumNorth) {
      const j=Math.min(sampled.length-1, iStart+1);
      return cardinal4(bearingDeg(sampled[iStart], sampled[j]));
    }
    const deg=(Math.atan2(sumEast, sumNorth)*180/Math.PI+360)%360;
    return cardinal4(deg);
  }

  // ===== Name helpers =======================================================
  const cleanHtml = (s) => String(s||'').replace(/<[^>]*>/g,'').trim();

  function normalizeName(raw){
    if (!raw) return '';
    let s=String(raw).trim();
    if (!s || /^unnamed\b/i.test(s) || /^[-–]+$/.test(s)) return '';

    // Expand abbreviations first
    s = s.replace(/\bPkwy\.?\b/ig,'Parkway')
         .replace(/\bPkway\b/ig,'Parkway')
         .replace(/\bExpwy\b/ig,'Expressway')
         .replace(/\bExpy\b/ig,'Expressway');

    // Convert highway variants → "Highway NNN"
    const canon = n => `Highway ${n}`;
    s = s.replace(/\b(?:ON|Ontario)?[-– ]?(?:Hwy|HWY|Highway|RTE|Route)?\s*401\b.*?/ig, canon(401));
    s = s.replace(/\b(?:ON|Ontario)?[-– ]?(?:Hwy|HWY|Highway|RTE|Route)?\s*400\b.*?/ig, canon(400));
    s = s.replace(/\b(?:ON|Ontario)?[-– ]?(?:Hwy|HWY|Highway|RTE|Route)?\s*404\b.*?/ig, canon(404));
    s = s.replace(/\b(?:ON|Ontario)?[-– ]?(?:Hwy|HWY|Highway|RTE|Route)?\s*427\b.*?/ig, canon(427));
    s = s.replace(/\b(?:ON|Ontario)?[-– ]?(?:Hwy|HWY|Highway|RTE|Route)?\s*409\b.*?/ig, canon(409));

    // Expand common street suffixes
    s = s.replace(/\b(st)\b\.?/ig,'Street')
         .replace(/\b(rd)\b\.?/ig,'Road')
         .replace(/\b(ave)\b\.?/ig,'Avenue')
         .replace(/\b(ct)\b\.?/ig,'Court')
         .replace(/\b(blvd)\b\.?/ig,'Boulevard');

    // Trim ramp wording
    s = s.replace(/\b(?:Onramp|Offramp|Ramp)\b.*$/i,'');

    return s.replace(/\s+/g,' ').trim();
  }

  // Extract a HIGHWAY/EXPRESSWAY from instruction text only
  function highwayFromInstruction(instrHtml){
    const t = cleanHtml(instrHtml);

    // Named expressways
    const named = t.match(/\b(Gardiner(?:\s+Expressway)?|Don Valley (?:Parkway|Pkwy)|DVP|QEW)\b/i);
    if (named){
      const n = named[1].toLowerCase();
      if (/gardiner/.test(n)) return 'Gardiner Expressway';
      if (/don valley (?:parkway|pkwy)/.test(n) || /dvp/.test(n)) return 'Don Valley Parkway';
      if (/qew/.test(n)) return 'QEW';
    }

    // Highway numbers: "ON-401", "Hwy 404", "to 427", "ramp to 401 Express"
    const num = t.match(/\b(?:ON|Ontario)?[-– ]?(?:Hwy|HWY|Highway|RTE|Route)?\s*(\d{2,3})(?:\s*(?:Express|Collector))?\b/);
    if (num && num[1]) return `Highway ${num[1]}`;

    return '';
  }

  // Fallback: general street from instruction (if not highway)
  function streetFromInstruction(instrHtml){
    const t = cleanHtml(instrHtml);
    const m = t.match(/\b(?:onto|to|toward|towards)\s+([A-Za-z0-9 .'\-\/&]+)$/i);
    return m ? normalizeName(m[1]) : '';
  }

  function isHighwayName(s=''){
    return /\b(Highway\s?\d{2,3}|Gardiner(?:\s+Expressway)?|Don Valley Parkway|QEW|Expressway|Express\b|Collector\b)\b/i.test(s);
  }

  // ===== Key management =====================================================
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

  // ===== Directions-only movement builder ==================================
  function sliceCoords(fullCoords, i0, i1){
    const s = Math.max(0, Math.min(i0, fullCoords.length-1));
    const e = Math.max(0, Math.min(i1, fullCoords.length-1));
    if (e <= s) return fullCoords.slice(s, s+1);
    return fullCoords.slice(s, e+1);
  }

  function buildMovementsFromDirections(coords, steps){
    if (!coords?.length || !steps?.length) return [];

    const rows = [];
    const pushRow = (name, i0, i1) => {
      const nm = normalizeName(name);
      if (!nm) return;
      const seg = sliceCoords(coords, i0, i1);
      if (seg.length < 2) return;

      let meters = 0; for (let i=1;i<seg.length;i++) meters += haversineMeters(seg[i-1], seg[i]);
      if (meters < MIN_FRAGMENT_M) return;

      const sampled = sampleLine(seg, SAMPLE_EVERY_M);
      const dir = avgHeadingBetween(sampled, 0, sampled.length-1, BOUND_LOCK_WINDOW_M);

      const prev = rows[rows.length-1];
      if (prev && prev.name === nm && prev.dir === dir){
        prev.km = +(prev.km + meters/1000).toFixed(2);
      } else {
        rows.push({ dir, name: nm, km: +(meters/1000).toFixed(2) });
      }
    };

    for (let si=0; si<steps.length; si++){
      const st = steps[si];
      const [i0, i1] = st?.way_points || [0,0];

      // 1) prefer step.name if present & normalized
      let nm = normalizeName(st?.name || '');

      // 2) if name missing/“-”, try to extract a HIGHWAY
      let hw = '';
      if (!nm) hw = highwayFromInstruction(st?.instruction || '');

      // 3) still nothing? try a generic street from instruction
      if (!nm && !hw) nm = streetFromInstruction(st?.instruction || '');

      // If we detected a highway (either from name or instruction), emit and stop.
      // Also try to MERGE the immediate next step if it’s also a highway
      if ( (nm && isHighwayName(nm)) || hw ){
        let highwayName = nm && isHighwayName(nm) ? nm : hw;

        // Look ahead one step (common ramp → highway split)
        let endIdx = i1;
        const next = steps[si+1];
        if (next){
          const nName = normalizeName(next?.name || '');
          const nHigh = nName && isHighwayName(nName) ? nName : highwayFromInstruction(next?.instruction||'');
          if (nHigh){
            const wpn = next.way_points || [0,0];
            endIdx = Math.max(endIdx, wpn[1]);
            highwayName = normalizeName(highwayName) || normalizeName(nHigh);
            si += 1; // consume the next step
          }
        }

        pushRow(highwayName, i0, endIdx);
        break; // cutoff after first highway
      }

      // Normal named street (non-highway)
      if (nm) pushRow(nm, i0, i1);
      // unnamed non-highway step → skip
    }

    // Merge immediate duplicates created by short connector steps
    if (rows.length > 2){
      const merged = [rows[0]];
      for (let i=1;i<rows.length;i++){
        const a = merged[merged.length-1];
        const b = rows[i];
        if (a.name === b.name && a.dir === b.dir){
          a.km = +(a.km + b.km).toFixed(2);
        } else {
          merged.push(b);
        }
      }
      return merged;
    }
    return rows;
  }

  // ===== Drawing & Controls ================================================
  function ensureGroup(){ if (!S.group) S.group = L.layerGroup().addTo(S.map); }
  function drawRoute(geojson, color){ ensureGroup(); const line=L.geoJSON(geojson,{style:{color,weight:5,opacity:0.9}}); S.group.addLayer(line); return line; }
  function addMarker(lat, lon, html, radius=6){ ensureGroup(); const m=L.circleMarker([lat,lon],{radius}).bindPopup(html); S.group.addLayer(m); return m; }

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
        <small class="routing-hint">Prints the routes already generated — no new API calls.</small>`;
      L.DomEvent.disableClickPropagation(el);
      return el;
    }
  });

  function setReportEnabled(enabled){ const b=document.getElementById('rt-print'); if (b) b.disabled=!enabled; }

  // ===== Init / Generate / Print ===========================================
  function init(map){
    S.map=map; S.keys=loadKeys(); setIndex(Number(localStorage.getItem(LS_ACTIVE_INDEX) || 0));
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
      try { const f=targets[0]; S.map.fitBounds(L.latLngBounds([[origin.lat,origin.lon],[f[1],f[0]]]), { padding:[24,24] }); } catch {}

      for (let i=0;i<targets.length;i++){
        const [dlon,dlat,label]=targets[i];
        try{
          const gj = await getRoute([origin.lon,origin.lat],[dlon,dlat]);
          drawRoute(gj, i===0 ? COLOR_FIRST : COLOR_OTHERS);

          const feat = gj?.features?.[0];
          const seg  = feat?.properties?.segments?.[0];
          const coords = feat?.geometry?.coordinates || [];
          const steps  = seg?.steps || [];

          const distKm = seg?.distance ? seg.distance/1000
            : coords.reduce((a,_,j,arr)=> j? a + haversineMeters(arr[j-1],arr[j])/1000 : 0, 0);
          const km  = distKm.toFixed(1);
          const min = seg ? Math.round((seg.duration||0)/60) : '—';

          const assignments = buildMovementsFromDirections(coords, steps);

          const stepsTxt = steps.map(s=>{
            const txt = cleanHtml(s.instruction||'');
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
            </div>`, 5);
        } catch (e) {
          console.error(e);
          popup(`<b>Routing</b><br>Route failed for ${label}<br><small>${e.message}</small>`);
        }
        if (i<targets.length-1) await sleep(1200);
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
    <body><h1>Trip Report — Street Assignments (Directions-only)</h1>${cards}
    <script>window.onload=()=>window.print();</script></body></html>`);
    w.document.close();
  }

  // Public API + boot
  const Routing = { init(map){ init(map); }, clear(){ clearAll(); }, setApiKeys(arr){ S.keys=Array.isArray(arr)?[...arr]:[]; saveKeys(S.keys); setIndex(0); } };
  global.Routing = Routing;
  document.addEventListener('DOMContentLoaded', ()=>{ if (global.map) Routing.init(global.map); });
})(window);

// --- robust lazy bootstrap: ensure controls appear even if map is created later
(function ensureRoutingBoot() {
  // already initialized?
  if (window.Routing && window.Routing.__booted) return;

  // if map exists now, init immediately
  if (window.map && typeof window.map.addControl === 'function') {
    try { window.Routing.init(window.map); window.Routing.__booted = true; } catch (_) {}
    return;
  }

  // otherwise, retry until the Leaflet map is ready
  let tries = 0;
  const timer = setInterval(() => {
    if (window.map && typeof window.map.addControl === 'function') {
      clearInterval(timer);
      try { window.Routing.init(window.map); window.Routing.__booted = true; } catch (_) {}
    } else if (++tries > 40) { // ~20s cap @ 500ms
      clearInterval(timer);
      // no-op: user may init manually with Routing.init(map)
    }
  }, 500);
})();
