/* routing.js — lean build (Directions-only, simplified naming, keep highways)
   - One ORS Directions request per PD
   - No Snap v2, no extra_info, no auto-init
   - Minimal normalizeName() (no aggressive rewrites)
   - Permissive isHighwayName() (Hwy/ON-401/Expressway/Parkway/DVP/QEW/Gardiner)
   - Highways are NEVER dropped by the min-length filter
   - Stable NB/EB/SB/WB from geometry
*/
(function (global) {
  // ===== Tunables ===========================================================
  const PROFILE    = 'driving-car';
  const PREFERENCE = 'fastest';
  const ORS_BASE   = 'https://api.openrouteservice.org';

  const MIN_FRAGMENT_M      = 60;   // drop tiny non-highway rows
  const BOUND_LOCK_WINDOW_M = 300;  // meters used to compute a row's bound
  const SAMPLE_EVERY_M      = 50;   // sampling spacing for heading calc

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

  // ===== Minimal naming helpers ============================================
  const cleanText = (s) => String(s||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();

  // Keep this *minimal* — do not rewrite highways
  function normalizeName(raw){
    if (!raw) return '';
    let s = String(raw).trim();
    if (!s || /^unnamed\b/i.test(s) || /^[-–]+$/.test(s)) return '';
    s = s
      .replace(/\bPkwy\.?\b/ig, 'Parkway')
      .replace(/\b(?:Expwy|Expy)\b/ig, 'Expressway')
      .replace(/\s+/g, ' ')
      .trim();
    return s;
  }

  // Permissive highway detector
  function isHighwayName(s=''){
    return /\b((?:ON|Ontario)?-?\s*Hwy\b|Highway\b|Expressway\b|Express\b|Freeway\b|Parkway\b|QEW\b|DVP\b|Gardiner\b|Don Valley\b)/i
      .test(s);
  }

  // Fallback: derive name from instruction when step.name is "-"
  function nameFromInstruction(instrHtml){
    const t = cleanText(instrHtml);
    // common Toronto highways first
    if (/\bGardiner\b/i.test(t)) return 'Gardiner Expressway';
    if (/\b(?:Don Valley (?:Parkway|Pkwy)|\bDVP\b)/i.test(t)) return 'Don Valley Parkway';
    if (/\bQEW\b/i.test(t)) return 'QEW';

    // try highway numbers: ON-401 / Hwy 404 / to 427
    const num = t.match(/\b(?:ON|Ontario)?[-– ]?(?:Hwy|HWY|Highway|RTE|Route)?\s*(\d{2,3})\b/);
    if (num && num[1]) return `Hwy ${num[1]}`;

    // more generic: "onto/toward NAME"
    const m = t.match(/\b(?:onto|to|toward|towards)\s+([A-Za-z0-9 .'\-\/&]+)$/i);
    return m ? normalizeName(m[1]) : '';
  }

  // ===== ORS fetchers =======================================================
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
        // deliberately *no* extra_info — keep it simple
      }
    });
  }

  // ===== Movement builder ===================================================
  function sliceCoords(full, i0, i1){
    const s=Math.max(0,Math.min(i0, full.length-1));
    const e=Math.max(0,Math.min(i1, full.length-1));
    if (e<=s) return full.slice(s,s+1);
    return full.slice(s,e+1);
  }
  function distRange(coords, i0, i1){
    let m=0; const s=Math.max(0,i0), e=Math.min(i1,coords.length-1);
    for (let i=Math.max(1,s); i<=e; i++) m+=haversineMeters(coords[i-1],coords[i]);
    return m;
  }

  function buildMovementsFromDirections(coords, steps){
    if (!coords?.length || !steps?.length) return [];

    const rows=[];
    const pushRow = (name, j0, j1) => {
      const nm = normalizeName(name);
      if (!nm) return;
      const seg = sliceCoords(coords, j0, j1);
      if (seg.length < 2) return;

      const meters = distRange(seg, 0, seg.length-1);
      const highway = isHighwayName(nm);
      if (!highway && meters < MIN_FRAGMENT_M) return;   // highways are ALWAYS kept

      const sampled = sampleLine(seg, SAMPLE_EVERY_M);
      const dir = avgHeadingBetween(sampled, 0, sampled.length-1, BOUND_LOCK_WINDOW_M);

      const prev = rows[rows.length-1];
      if (prev && prev.name === nm && prev.dir === dir){
        prev.km = +(prev.km + meters/1000).toFixed(2);
      } else {
        rows.push({ dir, name: nm, km: +(meters/1000).toFixed(2) });
      }
    };

    // Walk ‘steps’ in order; stop after the first highway row we add
    for (let si=0; si<steps.length; si++){
      const st = steps[si];
      const [i0, i1] = st?.way_points || [0,0];

      let nm = normalizeName(st?.name || '');
      if (!nm) nm = nameFromInstruction(st?.instruction || '');

      if (nm){
        pushRow(nm, i0, i1);
        if (isHighwayName(nm)) break; // cutoff once highway/expressway appears
      }
    }
    return rows;
  }

  // ===== Drawing & Controls ================================================
  function ensureGroup(){ if(!S.group) S.group=L.layerGroup().addTo(S.map); }
  function drawRoute(gj, color){ ensureGroup(); const l=L.geoJSON(gj,{style:{color,weight:5,opacity:.9}}); S.group.addLayer(l); return l; }
  function addMarker(lat,lon,html,r=6){ ensureGroup(); const m=L.circleMarker([lat,lon],{radius:r}).bindPopup(html); S.group.addLayer(m); return m; }
  function popup(html){ L.popup().setLatLng(S.map.getCenter()).setContent(html).openOn(S.map); }

  const TripControl = L.Control.extend({
    options:{position:'topleft'},
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
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              <button id="rt-save">Save Keys</button>
              <button id="rt-url" class="ghost">Use ?orsKey</button>
            </div>
            <small class="routing-hint">Priority: ?orsKey → saved → inline fallback.</small>
          </div>
        </details>`;
      L.DomEvent.disableClickPropagation(el);
      return el;
    }
  });

  const ReportControl = L.Control.extend({
    options:{position:'topleft'},
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

  const setReportEnabled = (on) => { const b=document.getElementById('rt-print'); if(b) b.disabled=!on; };

  // ===== Init / Generate / Print ===========================================
  function init(map){
    S.map=map; S.keys=loadKeys(); S.keyIndex=Number(localStorage.getItem(LS_ACTIVE_INDEX)||0);
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

    S.els.gen.onclick   = generateTrips;
    S.els.clr.onclick   = () => { if (S.group) S.group.clearLayers(); S.results=[]; setReportEnabled(false); };
    S.els.print.onclick = printReport;
    S.els.save.onclick  = () => {
      const arr=(S.els.keys.value||'').split(',').map(s=>s.trim()).filter(Boolean);
      if(!arr.length) return popup('<b>Routing</b><br>Enter a key.');
      S.keys=arr; localStorage.setItem(LS_KEYS, JSON.stringify(arr)); S.keyIndex=0;
      popup('<b>Routing</b><br>Keys saved.');
    };
    S.els.url.onclick   = () => {
      const arr=parseUrlKeys(); if(!arr.length) return popup('<b>Routing</b><br>No <code>?orsKey</code> in URL.');
      S.keys=arr; S.keyIndex=0; popup('<b>Routing</b><br>Using keys from URL.');
    };
  }

  async function generateTrips(){
    const origin = global.ROUTING_ORIGIN;
    if (!origin) return popup('<b>Routing</b><br>Search an address in the top bar and select a result first.');
    if (!global.getSelectedPDTargets) return popup('<b>Routing</b><br>Zone/PD selection isn’t ready.');
    const targets = global.getSelectedPDTargets() || [];
    if (!targets.length) return popup('<b>Routing</b><br>No PDs selected.');

    if (S.group) S.group.clearLayers(); S.results=[]; setReportEnabled(false);
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
          const txt = cleanText(s.instruction||'');
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
      if (i<targets.length-1) await sleep(1200); // respect ORS burst limits
    }

    setReportEnabled(S.results.length>0);
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
        : `<tr><td colspan="3"><em>No named streets</em></td></tr>`;
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

  // ===== Public API (no auto-init) =========================================
  global.Routing = {
    init,
    clear(){ if (S.group) S.group.clearLayers(); S.results=[]; setReportEnabled(false); }
  };
})(window);
