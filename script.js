// ===================== Map boot ===================== /* routing.js — minimal, clean build (Directions-only + highway via extra_info)
   - No Snap v2, no polling/bootstrap tricks
   - You must call Routing.init(map) ONCE after creating the Leaflet map
*/
(function (global) {
  // ---------- Tunables ----------
  const PROFILE    = 'driving-car';
  const PREFERENCE = 'fastest';
  const ORS_BASE   = 'https://api.openrouteservice.org';

  const MIN_FRAGMENT_M      = 60;   // drop tiny non-highway rows
  const BOUND_LOCK_WINDOW_M = 300;  // meters used to compute row bound
  const SAMPLE_EVERY_M      = 50;   // sampling spacing for heading calc

  const COLOR_FIRST  = '#0b3aa5';
  const COLOR_OTHERS = '#2166f3';

  // Fallback key + localStorage slots
  const INLINE_DEFAULT_KEY =
    'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=';
  const LS_KEYS = 'ORS_KEYS';
  const LS_ACTIVE_INDEX = 'ORS_ACTIVE_INDEX';

  // ---------- State ----------
  const S = { map:null, group:null, keys:[], keyIndex:0, results:[], els:{} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ---------- Small geo helpers ----------
  const toRad = d => d*Math.PI/180;
  function haversineMeters(a,b){
    const R=6371000; const [x1,y1]=a,[x2,y2]=b;
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
  function avgHeadingBetween(sampled, iStart, iEnd, capM=BOUND_LOCK_WINDOW_M){
    let sumEast=0, sumNorth=0, acc=0;
    for (let i=iStart; i<iEnd && i<sampled.length-1 && acc<capM; i++){
      const a=sampled[i], b=sampled[i+1];
      const d=haversineMeters(a,b); if (d<=0) continue;
      const br=bearingDeg(a,b)*Math.PI/180;
      sumEast  += Math.sin(br)*d;
      sumNorth += Math.cos(br)*d;
      acc      += d;
    }
    if (!sumEast && !sumNorth) {
      const j=Math.min(sampled.length-1, iStart+1);
      return cardinal4(bearingDeg(sampled[iStart], sampled[j]));
    }
    const deg=(Math.atan2(sumEast, sumNorth)*180/Math.PI+360)%360;
    return cardinal4(deg);
  }

  // ---------- Name helpers ----------
  const cleanText = (s) => String(s||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
  function normalizeName(raw){
    if (!raw) return '';
    let s=String(raw).trim();
    if (!s || /^unnamed\b/i.test(s) || /^[-–]+$/.test(s)) return '';
    s = s.replace(/\bPkwy\.?\b/ig,'Parkway')
         .replace(/\bPkway\b/ig,'Parkway')
         .replace(/\bExpwy\b/ig,'Expressway')
         .replace(/\bExpy\b/ig,'Expressway');
    const canon = n => `Highway ${n}`;
    s = s.replace(/\b(?:ON|Ontario)?[-– ]?(?:Hwy|HWY|Highway|RTE|Route)?\s*(401|400|404|427|409)\b.*?/ig,
                  (_,n)=>canon(n));
    s = s.replace(/\b(st)\b\.?/ig,'Street')
         .replace(/\b(rd)\b\.?/ig,'Road')
         .replace(/\b(ave)\b\.?/ig,'Avenue')
         .replace(/\b(ct)\b\.?/ig,'Court')
         .replace(/\b(blvd)\b\.?/ig,'Boulevard');
    s = s.replace(/\b(?:Onramp|Offramp|Ramp)\b.*$/i,'');
    return s.replace(/\s+/g,' ').trim();
  }
  function nameHighwayFromInstruction(instrHtml){
    const t = cleanText(instrHtml);
    if (/\bGardiner\b/i.test(t)) return 'Gardiner Expressway';
    if (/\b(?:Don Valley (?:Parkway|Pkwy)|\bDVP\b)/i.test(t)) return 'Don Valley Parkway';
    if (/\bQEW\b/i.test(t)) return 'QEW';
    const num = t.match(/\b(?:ON|Ontario)?[-– ]?(?:Hwy|HWY|Highway|RTE|Route)?\s*(\d{2,3})\b/);
    if (num && num[1]) return `Highway ${num[1]}`;
    const toward = t.match(/\b(?:to|onto|toward|towards)\s*(\d{2,3})\b/);
    if (toward && toward[1]) return `Highway ${toward[1]}`;
    return 'Expressway';
  }
  function streetFromInstruction(instrHtml){
    const t = cleanText(instrHtml);
    const m = t.match(/\b(?:onto|to|toward|towards)\s+([A-Za-z0-9 .'\-\/&]+)$/i);
    return m ? normalizeName(m[1]) : '';
  }
  const isHighwayName = s => /\b(Highway\s?\d{2,3}|Gardiner|Don Valley Parkway|QEW|Expressway)\b/i.test(s||'');

  // ---------- ORS helpers ----------
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

  // Ask ORS to annotate geometry by road class; no extra calls
  async function getRoute(originLonLat, destLonLat){
    return orsFetch(`/v2/directions/${PROFILE}/geojson`, {
      method:'POST',
      body:{
        coordinates:[originLonLat, destLonLat],
        preference:PREFERENCE,
        instructions:true,
        instructions_format:'html',
        language:'en',
        units:'km',
        extra_info:['roadclass'] // detect motorway/trunk
      }
    });
  }

  // ---------- extra_info: first highway span ----------
  // roadclass codes: 0=motorway, 1=trunk, 2=primary, ...
  function firstHighwayInterval(feature){
    const vals = feature?.properties?.extras?.roadclass?.values || []; // [[from,to,code],...]
    let best=null;
    for (const [from,to,code] of vals){
      if (code===0 || code===1) { if (!best || from<best.from) best={from,to,code}; }
    }
    return best; // {from,to,code}|null
  }

  // ---------- movement builder ----------
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

  function buildMovementsFromDirections(coords, steps, feature){
    if (!coords?.length || !steps?.length) return [];
    const rows=[];
    function pushRow(name, j0, j1, {force=false}={}){
      const nm=normalizeName(name); if(!nm) return;
      const seg=sliceCoords(coords, j0, j1); if (seg.length<2) return;
      const meters=distRange(seg,0,seg.length-1);
      const isHwy=isHighwayName(nm);
      if (!isHwy && !force && meters<MIN_FRAGMENT_M) return;
      const sampled=sampleLine(seg, SAMPLE_EVERY_M);
      const dir=avgHeadingBetween(sampled,0,sampled.length-1,BOUND_LOCK_WINDOW_M);
      const prev=rows[rows.length-1];
      if (prev && prev.name===nm && prev.dir===dir){ prev.km=+(prev.km+meters/1000).toFixed(2); }
      else rows.push({dir,name:nm,km:+(meters/1000).toFixed(2)});
    }

    const hwy=firstHighwayInterval(feature); // {from,to,code}|null

    for (let si=0; si<steps.length; si++){
      const st=steps[si]; const [i0,i1]=st?.way_points || [0,0];

      // If we reached the highway index, add one highway row and stop
      if (hwy && i1>=hwy.from){
        let endIdx=Math.max(i1,hwy.to);
        const next=steps[si+1];
        if (next){
          const [ni0,ni1]=next.way_points || [0,0];
          if (ni0<=hwy.to+1) endIdx=Math.max(endIdx,ni1);
        }
        let hwyName=nameHighwayFromInstruction(st?.instruction||'');
        if ((!hwyName || hwyName==='Expressway') && next) {
          const guess=nameHighwayFromInstruction(next?.instruction||''); if(guess) hwyName=guess;
        }
        pushRow(hwyName, Math.max(i0,hwy.from), endIdx, {force:true});
        break; // cutoff after highway
      }

      // Pre-highway named streets
      let nm=normalizeName(st?.name || '');
      if (!nm){
        const guess=streetFromInstruction(st?.instruction||'');
        if (guess && !isHighwayName(guess)) nm=guess;
      }
      if (nm) pushRow(nm, i0, i1);
    }
    return rows;
  }

  // ---------- drawing & controls ----------
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

  // ---------- init / generate / print ----------
  function parseUrlKeys(){ const raw=new URLSearchParams(location.search).get('orsKey'); return raw?raw.split(',').map(s=>s.trim()).filter(Boolean):[]; }
  function loadKeys(){ const u=parseUrlKeys(); if(u.length) return u; try{const ls=JSON.parse(localStorage.getItem(LS_KEYS)||'[]'); if(Array.isArray(ls)&&ls.length) return ls;}catch{} return [INLINE_DEFAULT_KEY]; }
  function currentKey(){ return S.keys[S.keyIndex]; }
  function rotateKey(){ if(S.keys.length>1){ S.keyIndex=(S.keyIndex+1)%S.keys.length; localStorage.setItem(LS_ACTIVE_INDEX,String(S.keyIndex)); return true; } return false; }

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

  async function orsFetchWithKeys(url, options){
    try { return await orsFetch(url, options); }
    catch(e){
      if (String(e.message).includes('401') || String(e.message).includes('403') || String(e.message).includes('429')){
        if (rotateKey()) return await orsFetch(url, options);
      }
      throw e;
    }
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

        const assignments = buildMovementsFromDirections(coords, steps, feat);

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
      if (i<targets.length-1) await sleep(1200); // respect ORS burst limit
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

  // ---------- Public API (no auto-init) ----------
  global.Routing = { init, clear(){ if(S.group) S.group.clearLayers(); S.results=[]; setReportEnabled(false); } };
})(window);

const map = L.map('map').setView([43.6532, -79.3832], 11);
window.map = map; // expose for routing.js

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap'
}).addTo(map);

// Geocoder (non-fatal if missing)
try {
  const geocoderCtl = L.Control.geocoder({ collapsed: false, defaultMarkGeocode: true }).addTo(map);

  // >>> NEW: remember the last picked address for routing.js to use
  geocoderCtl.on('markgeocode', (e) => {
    const c = e.geocode.center;
    window.ROUTING_ORIGIN = {
      lat: c.lat,
      lon: c.lng,
      label: e.geocode.name || e.geocode.html || `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`
    };
  });
} catch (e) {
  console.warn('Geocoder not loaded:', e);
}

// ===================== Helpers =====================
function pdKeyFromProps(p) {
  const cand =
    p?.PD_no ?? p?.pd_no ?? p?.PDID ?? p?.PD_ID ?? p?.PD ?? p?.pd ??
    p?.PD_NAME ?? p?.PD_name ?? null;
  if (cand != null) return String(cand).trim();
  return String(p?.PD_name || p?.PD_NAME || p?.name || 'PD').trim();
}
function zoneKeyFromProps(p) {
  const cand =
    p?.TTS2022 ?? p?.ZONE ?? p?.ZONE_ID ?? p?.ZN_ID ?? p?.TTS_ZONE ??
    p?.Zone ?? p?.Z_no ?? p?.Z_ID ?? p?.ZONE_NO ?? p?.ZONE_NUM ?? null;
  return String(cand ?? 'Zone').trim();
}

// Give PD section a way to call Zones section, and vice-versa
window._pdSelectByKey  = undefined; // (key, {zoom}) -> void
window._pdClearSelection = undefined;
window._zonesShowFor   = undefined; // (pdKey, focusZoneId?) -> void
window._zonesClear     = undefined; // () -> void

// ===================== Planning Districts =====================
const PD_URL = 'data/tts_pds.json?v=' + Date.now();

fetch(PD_URL)
  .then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${r.url || PD_URL}`);
    return r.text();
  })
  .then(txt => {
    try { return JSON.parse(txt); }
    catch (e) {
      console.error('PD JSON parse error:', e, txt.slice(0, 200));
      throw new Error('Invalid PD GeoJSON');
    }
  })
  .then(geo => {
    const baseStyle     = { color: '#ff6600', weight: 2, fillOpacity: 0.15 };
    const selectedStyle = { color: '#d40000', weight: 4, fillOpacity: 0.25 };

    const group = L.featureGroup().addTo(map);

    let selectedKey = null;
    let selectedItem = null;

    // Always-visible PD label when selected
    const selectedLabel = L.marker([0, 0], { opacity: 0 });
    function showPDLabel(item) {
      const center = item.bounds.getCenter();
      if (!map.hasLayer(selectedLabel)) selectedLabel.addTo(map);
      selectedLabel
        .setLatLng(center)
        .bindTooltip(item.name, {
          permanent: true,
          direction: 'center',
          className: 'pd-label'
        })
        .openTooltip();
    }
    function hidePDLabel() { try { selectedLabel.remove(); } catch {} }

    function clearListSelection() {
      document.querySelectorAll('.pd-item.selected').forEach(el => el.classList.remove('selected'));
    }
    function markListSelected(key) {
      clearListSelection();
      const cbx = document.getElementById(`pd-${encodeURIComponent(key)}`);
      if (cbx) cbx.closest('.pd-item')?.classList.add('selected');
    }

    const pdIndex = [];
    L.geoJSON(geo, {
      style: baseStyle,
      onEachFeature: (f, layer) => {
        const p = f.properties || {};
        const name = (p.PD_name || p.PD_no || 'Planning District').toString();
        const key  = pdKeyFromProps(p);
        pdIndex.push({ key, name, no: (p.PD_no ?? null), layer, bounds: layer.getBounds() });

        layer.on('click', () => {
          const item = pdIndex.find(i => i.layer === layer);
          if (!item) return;
          if (selectedKey === item.key) clearPDSelection();
          else selectPD(item, { zoom: true });
        });
      }
    });

    // Sort by number then name
    pdIndex.sort((a,b) => {
      const ah = a.no !== null, bh = b.no !== null;
      if (ah && bh) return Number(a.no) - Number(b.no);
      if (ah && !bh) return -1;
      if (!ah && bh) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    const show  = i => { if (!map.hasLayer(i.layer)) i.layer.addTo(group); };
    const hide  = i => { if (map.hasLayer(i.layer))  group.removeLayer(i.layer); };
    const reset = () => { pdIndex.forEach(i => i.layer.setStyle(baseStyle)); };

    function clearPDSelection() {
      reset();
      hidePDLabel();
      map.closePopup();
      clearListSelection();
      selectedKey = null;
      selectedItem = null;
      if (typeof window._zonesClear === 'function') window._zonesClear();
    }
    window._pdClearSelection = clearPDSelection;

    function selectPD(item, { zoom = false } = {}) {
      if (!map.hasLayer(item.layer)) item.layer.addTo(group);
      reset();
      item.layer.setStyle(selectedStyle);
      try { item.layer.bringToFront?.(); } catch {}
      showPDLabel(item);
      if (zoom) map.fitBounds(item.bounds, { padding: [30, 30] });
      selectedKey  = item.key;
      selectedItem = item;
      markListSelected(item.key);
      if (typeof window._zonesShowFor === 'function') window._zonesShowFor(item.key);
    }

    // Expose PD select-by-key for Zone Search to call
    window._pdSelectByKey = function _pdSelectByKey(key, { zoom = true } = {}) {
      const item = pdIndex.find(i => String(i.key) === String(key));
      if (item) selectPD(item, { zoom });
    };

    // Build the PD list UI
    const itemsHTML = pdIndex.map(i => `
      <div class="pd-item">
        <input type="checkbox" class="pd-cbx" id="pd-${encodeURIComponent(i.key)}"
               data-key="${encodeURIComponent(i.key)}" checked>
        <span class="pd-name" data-key="${encodeURIComponent(i.key)}">${i.name}</span>
      </div>
    `).join('');

    // PD Control
    const PDControl = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        const div = L.DomUtil.create('div', 'pd-control collapsed');
        div.innerHTML = `
          <div class="pd-header">
            <strong>Planning Districts</strong>
            <div class="pd-actions">
              <button type="button" id="pd-select-all">Select all</button>
              <button type="button" id="pd-clear-all">Clear all</button>
              <button type="button" id="pd-toggle" class="grow">Expand ▾</button>
            </div>
          </div>
          <div class="pd-list" id="pd-list">${itemsHTML}</div>
        `;
        const geocoderEl = document.querySelector('.leaflet-control-geocoder');
        if (geocoderEl) div.style.width = geocoderEl.offsetWidth + 'px';
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div.querySelector('#pd-list'));
        return div;
      }
    });
    map.addControl(new PDControl());

    const listEl = document.getElementById('pd-list');
    const btnAll = document.getElementById('pd-select-all');
    const btnClr = document.getElementById('pd-clear-all');
    const btnTgl = document.getElementById('pd-toggle');
    const controlRoot = listEl.closest('.pd-control');

    // Show all PDs initially + fit
    pdIndex.forEach(show);
    try {
      map.fitBounds(L.featureGroup(pdIndex.map(i => i.layer)).getBounds(), { padding: [20, 20] });
    } catch {}

    // Checkbox visibility
    listEl.addEventListener('change', e => {
      const cbx = e.target.closest('.pd-cbx');
      if (!cbx) return;
      const key = decodeURIComponent(cbx.dataset.key);
      const item = pdIndex.find(i => i.key === key);
      if (!item) return;
      if (cbx.checked) show(item);
      else {
        hide(item);
        if (selectedKey === key) clearPDSelection();
      }
    });

    // Click name to toggle select
    listEl.addEventListener('click', e => {
      const nameEl = e.target.closest('.pd-name');
      if (!nameEl) return;
      const key = decodeURIComponent(nameEl.dataset.key);
      const item = pdIndex.find(i => i.key === key);
      if (!item) return;
      const cbx = document.getElementById(`pd-${encodeURIComponent(key)}`);
      if (cbx && !cbx.checked) { cbx.checked = true; show(item); }
      if (selectedKey === key) clearPDSelection();
      else selectPD(item, { zoom: true });
    });

    // Buttons
    btnAll.addEventListener('click', () => {
      document.querySelectorAll('.pd-cbx').forEach(c => c.checked = true);
      pdIndex.forEach(show);
      try {
        map.fitBounds(L.featureGroup(pdIndex.map(i => i.layer)).getBounds(), { padding: [20, 20] });
      } catch {}
    });
    btnClr.addEventListener('click', () => {
      document.querySelectorAll('.pd-cbx').forEach(c => c.checked = false);
      pdIndex.forEach(hide);
      clearPDSelection();
    });

    // --- FIXED Expand / Collapse logic ---
    btnTgl.addEventListener('click', () => {
      const collapsed = controlRoot.classList.toggle('collapsed');
    
      // Inline style ensures visibility works regardless of CSS overrides
      listEl.style.display = collapsed ? 'none' : '';
    
      btnTgl.textContent = collapsed ? 'Expand ▾' : 'Collapse ▴';
      btnTgl.setAttribute('aria-expanded', String(!collapsed));
    });
    
    // Ensure initial visibility matches class on load
    if (controlRoot.classList.contains('collapsed')) {
      listEl.style.display = 'none';
      btnTgl.textContent = 'Expand ▾';
    } else {
      listEl.style.display = '';
      btnTgl.textContent = 'Collapse ▴';
    }

    const PD_LABEL_HIDE_ZOOM = 14;
    map.on('zoomend', () => {
      const zoom = map.getZoom();
      if (zoom >= PD_LABEL_HIDE_ZOOM) {
        if (map.hasLayer(selectedLabel)) selectedLabel.remove();
      } else {
        if (selectedItem && !map.hasLayer(selectedLabel)) showPDLabel(selectedItem);
      }
    });

    // === Routing hooks (NEW) ===
    // 1) Registry of PD layers for routing.js to reference by key
    window.PD_REGISTRY = {};
    pdIndex.forEach(i => {
      window.PD_REGISTRY[i.key] = { layer: i.layer, name: i.name };
    });

    // 2) Helper to return [lon, lat, label] for every CHECKED PD
    window.getSelectedPDTargets = function () {
      const boxes = Array.from(document.querySelectorAll('.pd-cbx:checked'));
      const out = [];
      for (const box of boxes) {
        const key = decodeURIComponent(box.dataset.key || '');
        const item = pdIndex.find(i => i.key === key);
        if (!item || !item.layer) continue;
        const c = item.bounds.getCenter();
        out.push([c.lng, c.lat, item.name || key]);
      }
      return out;
    };

  }).catch(err => {
    console.error('Failed to load PDs:', err);
    alert('Could not load PDs. See console for details.');
  });

// ===================== Planning Zones =====================
const ZONES_URL = 'data/tts_zones.json?v=' + Date.now();
const ZONE_LABEL_ZOOM = 14;

let zonesEngaged = false;
const zonesGroup      = L.featureGroup(); // polygons for current PD
const zonesLabelGroup = L.featureGroup(); // label markers for current PD
const zonesByKey      = new Map();        // PD key -> [raw feature,...]
const zoneLookup      = new Map();        // zoneId -> {feature, pdKey}
let selectedZoneLayer = null;

const zoneBaseStyle     = { color: '#2166f3', weight: 2, fillOpacity: 0.08 };
const zoneSelectedStyle = { color: '#0b3aa5', weight: 4, fillOpacity: 0.25 };

// Build indices
fetch(ZONES_URL)
  .then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${r.url || ZONES_URL}`);
    return r.text();
  })
  .then(txt => {
    try { return JSON.parse(txt); }
    catch (e) {
      console.error('Zones JSON parse error:', e, txt.slice(0, 200));
      throw new Error('Invalid Zones GeoJSON');
    }
  })
  .then(zGeo => {
    L.geoJSON(zGeo, {
      onEachFeature: f => {
        const props = f.properties || {};
        const pdKey = pdKeyFromProps(props);
        if (!pdKey) return;

        if (!zonesByKey.has(pdKey)) zonesByKey.set(pdKey, []);
        zonesByKey.get(pdKey).push(f);

        const zId = zoneKeyFromProps(props);
        if (!zoneLookup.has(String(zId))) zoneLookup.set(String(zId), { feature: f, pdKey });
      }
    });

    // Zones control (Engage / Disengage) with inline search on header right
    const ZonesControl = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        const div = L.DomUtil.create('div', 'pd-control');
        div.innerHTML = `
          <div class="pd-header">
            <strong>Planning Zones</strong>
            <div class="pd-actions">
              <button type="button" id="pz-engage">Engage</button>
              <button type="button" id="pz-disengage">Disengage</button>
              <input id="pz-inline-search" class="pz-inline-search" type="text" placeholder="Zone #">
            </div>
          </div>
        `;
        const geocoderEl = document.querySelector('.leaflet-control-geocoder');
        if (geocoderEl) div.style.width = geocoderEl.offsetWidth + 'px';
        L.DomEvent.disableClickPropagation(div);
        return div;
      }
    });
    map.addControl(new ZonesControl());

    const btnEng  = document.getElementById('pz-engage');
    const btnDis  = document.getElementById('pz-disengage');
    const inpZone = document.getElementById('pz-inline-search');

    function setMode(engaged) {
      zonesEngaged = engaged;
      btnEng.classList.toggle('active', engaged);
      btnDis.classList.toggle('active', !engaged);
      if (!engaged) _zonesClear();
    }

    function clearZoneSelection() {
      if (selectedZoneLayer) selectedZoneLayer.setStyle(zoneBaseStyle);
      selectedZoneLayer = null;
      try { map.closePopup(); } catch {}
    }

    function selectZone(layer) {
      if (selectedZoneLayer === layer) { // toggle off
        clearZoneSelection();
        return;
      }
      if (selectedZoneLayer) selectedZoneLayer.setStyle(zoneBaseStyle);
      selectedZoneLayer = layer;
      layer.setStyle(zoneSelectedStyle);
      try { layer.bringToFront?.(); } catch {}
    }

    function updateZoneLabels() {
      const show = map.getZoom() >= ZONE_LABEL_ZOOM;
      if (show) {
        if (!map.hasLayer(zonesLabelGroup)) zonesLabelGroup.addTo(map);
      } else {
        if (map.hasLayer(zonesLabelGroup)) zonesLabelGroup.remove();
      }
    }
    map.on('zoomend', updateZoneLabels);

    // Exposed helpers PD code calls
    window._zonesClear = function _zonesClear() {
      clearZoneSelection();
      zonesGroup.clearLayers();
      zonesLabelGroup.clearLayers();
      if (map.hasLayer(zonesGroup))      zonesGroup.remove();
      if (map.hasLayer(zonesLabelGroup)) zonesLabelGroup.remove();
      try { map.closePopup(); } catch {}
    };

    // Optional focusZoneId triggers highlight + popup + fit to zone
    window._zonesShowFor = function _zonesShowFor(pdKey, focusZoneId = null) {
      if (!zonesEngaged) return;
      const feats = zonesByKey.get(String(pdKey)) || [];

      zonesGroup.clearLayers();
      zonesLabelGroup.clearLayers();
      clearZoneSelection();

      let pendingOpen = null;
      let pendingBounds = null;

      feats.forEach(f => {
        // 1) Polygon
        const poly = L.geoJSON(f, { style: zoneBaseStyle }).getLayers()[0];

        poly.on('click', () => selectZone(poly));
        poly.on('dblclick', (e) => {
          if (typeof window._pdClearSelection === 'function') window._pdClearSelection();
          clearZoneSelection();
          L.DomEvent.stop(e);
          if (e.originalEvent?.preventDefault) e.originalEvent.preventDefault();
        });

        poly.addTo(zonesGroup);

        // 2) Label marker (boxed chip). Popup opens only from label.
        const center = poly.getBounds().getCenter();
        const zName  = zoneKeyFromProps(f.properties || {});
        const labelHtml = `<span class="zone-tag">${String(zName)}</span>`;

        let labelIcon = L.divIcon({
          className: 'zone-label',
          html: labelHtml,
          iconSize: null
        });

        const labelMarker = L.marker(center, {
          icon: labelIcon,
          riseOnHover: true,
          zIndexOffset: 1000
        });

        // Measure chip then center the anchor
        labelMarker.once('add', () => {
          const el = labelMarker.getElement();
          if (!el) return;
          const w = el.offsetWidth  || 24;
          const h = el.offsetHeight || 16;
          const centered = L.divIcon({
            className: 'zone-label',
            html: labelHtml,
            iconSize: [w, h],
            iconAnchor: [w / 2, h / 2]
          });
          labelMarker.setIcon(centered);
        });

        const POPUP_OFFSET_Y = -10;

        labelMarker.on('click', () => {
          const props = f.properties || {};
          if (selectedZoneLayer !== poly) selectZone(poly);
          else poly.setStyle(zoneSelectedStyle);

          const content = `
            <div>
              <strong><u>Planning Zone ${zoneKeyFromProps(props)}</u></strong><br/>
              ${(props?.Reg_name ?? '')}<br/>
              PD: ${(props?.PD_no ?? props?.pd_no ?? '')}
            </div>
          `;
          try { labelMarker.unbindPopup(); } catch {}
          labelMarker
            .bindPopup(content, {
              offset: L.point(0, POPUP_OFFSET_Y),
              autoPan: true,
              closeButton: true,
              keepInView: false,
              maxWidth: 280,
              className: 'zone-popup'
            })
            .openPopup();
        });

        labelMarker.on('dblclick', (e) => {
          if (typeof window._pdClearSelection === 'function') window._pdClearSelection();
          clearZoneSelection();
          try { labelMarker.closePopup(); } catch {}
          L.DomEvent.stop(e);
          if (e.originalEvent?.preventDefault) e.originalEvent.preventDefault();
        });

        // If this is the requested zone: preselect + remember bounds + plan to open popup
        if (focusZoneId && String(zName) === String(focusZoneId)) {
          pendingOpen = () => labelMarker.fire('click');
          pendingBounds = poly.getBounds();
          selectZone(poly);
        }

        labelMarker.addTo(zonesLabelGroup);
      });

      if (zonesGroup.getLayers().length && !map.hasLayer(zonesGroup)) zonesGroup.addTo(map);
      updateZoneLabels();

      if (pendingOpen) setTimeout(pendingOpen, 0);
      if (pendingBounds) {
        map.fitBounds(pendingBounds, { padding: [30, 30], maxZoom: 16 });
      }
    };

    // ---- Inline search (Enter to run) ----
    function parseZoneId(raw) {
      if (!raw) return null;
      const m = String(raw).match(/\d+/);
      return m ? m[0] : null;
    }

    function runZoneSearch() {
      const zId = parseZoneId(inpZone.value);
      if (!zId) return;

      const found = zoneLookup.get(String(zId));
      if (!found) return;

      if (!zonesEngaged) setMode(true);

      const { pdKey } = found;

      // Select PD (zooms to PD)…
      if (typeof window._pdSelectByKey === 'function') {
        window._pdSelectByKey(pdKey, { zoom: true });
      }
      // …then draw zones with focus on zId (highlight + popup + fit to zone)
      if (typeof window._zonesShowFor === 'function') {
        window._zonesShowFor(pdKey, String(zId));
      }
    }

    inpZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runZoneSearch();
    });

    // Start disengaged; buttons toggle
    btnEng.addEventListener('click', () => setMode(true));
    btnDis.addEventListener('click', () => setMode(false));
    setMode(false);
  })
  .catch(err => {
    console.error('Failed to load Planning Zones:', err);
  });
