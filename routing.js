/* routing.js — resilient UI mount + same-page PD printing
   - Robust init: retries until map ready; guarded addControl(); visible fail-safe banner on error
   - PD/PZ generation as before; PZ print disabled; PD print via in-page print pane
   - Route style: black casing + white center
   - Highway label resolver unchanged
*/
(function (global) {
  // ========================= Tunables =========================
  const PROFILE    = 'driving-car';
  const PREFERENCE = 'fastest';
  const ORS_BASE   = 'https://api.openrouteservice.org';

  const GENERIC_REGEX       = /\b(keep (right|left)|continue|head (east|west|north|south))\b/i;
  const SAMPLE_EVERY_M      = 500;
  const MATCH_BUFFER_M      = 260;
  const CONF_REQ_SHARE      = 0.60;
  const CONF_REQ_MEAN_M     = 120;
  const BOUND_LOCK_WINDOW_M = 300;
  const MIN_FRAGMENT_M      = 30;
  const RAMP_SKIP_M         = 100;
  const PER_REQUEST_DELAY   = 80;

  const HIGHWAY_URLS = [
    'data/highway_centerlines_wgs84.geojson',
    'data/highway_centrelines.json',
    'data/highway_centerlines.json',
    'data/toronto_highways.geojson'
  ];
  const CENTERLINE_COLOR = '#ff0080';

  // ======================== State/Keys ========================
  const INLINE_DEFAULT_KEY =
    'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0='; // harmless fallback
  const LS_KEYS = 'ORS_KEYS';
  const LS_ACTIVE_INDEX = 'ORS_ACTIVE_INDEX';

  const S = {
    map:null,
    group:null,
    results:[],  // [{dest:{lon,lat,label}, route:{coords,steps}}]
    mode:'PD',   // 'PD' | 'PZ'
    highwaysOn:true,
    highwayFeatures:[],
    highwayLayer:null,
    resultsRouteCoordsRef:null,
    keys:[],
    keyIndex:0
  };

  // ======================= Small helpers ======================
  const byId = (id)=>document.getElementById(id);
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  const qParam=(k)=>new URLSearchParams(location.search).get(k)||'';
  const toRad=(d)=>d*Math.PI/180;
  const isNum=(n)=>Number.isFinite(n)&&!Number.isNaN(n);
  const num =(x)=>{const n=typeof x==='string'?parseFloat(x):+x;return Number.isFinite(n)?n:NaN;};
  const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
  const km2  =(n)=>(n||0).toFixed(2);

  function banner(msg, withRetry=false){
    let el=document.getElementById('rt-failsafe');
    if(!el){
      el=document.createElement('div');
      el.id='rt-failsafe';
      el.style.cssText='position:fixed;left:10px;bottom:10px;z-index:2147483001;background:#b00020;color:#fff;padding:8px 10px;border-radius:8px;font:12px/1.2 system-ui;box-shadow:0 6px 20px rgba(0,0,0,.25)';
      document.body.appendChild(el);
    }
    el.innerHTML = withRetry
      ? `${msg} <button id="rt-failsafe-retry" style="margin-left:8px;background:#fff;color:#b00020;border:0;border-radius:6px;padding:4px 8px;cursor:pointer">Retry</button>`
      : msg;
    const btn=byId('rt-failsafe-retry');
    if(btn) btn.onclick=()=>{ el.remove(); tryInitControls(); };
  }

  function sanitizeLonLat(input){
    let a=Array.isArray(input)?input:[undefined,undefined];
    let x=num(a[0]), y=num(a[1]);
    // swap if lat/lon reversed
    if (isNum(x)&&isNum(y)&&Math.abs(x)<=90&&Math.abs(y)>90){const t=x;x=y;y=t;}
    if(!isNum(x)||!isNum(y)) throw new Error(`Invalid coordinate: ${JSON.stringify(input)}`);
    x=clamp(x,-180,180); y=clamp(y,-85,85);
    return [x,y];
  }

  function getOriginLonLat(){
    const o=global.ROUTING_ORIGIN;
    if(!o) throw new Error('Origin not set');
    if(Array.isArray(o)&&o.length>=2) return sanitizeLonLat([o[0],o[1]]);
    if(typeof o.getLatLng==='function'){const ll=o.getLatLng();return sanitizeLonLat([ll.lng,ll.lat]);}
    if(isNum(num(o.lng))&&isNum(num(o.lat))) return sanitizeLonLat([o.lng,o.lat]);
    if(o.latlng&&isNum(num(o.latlng.lng))&&isNum(num(o.latlng.lat))) return sanitizeLonLat([o.latlng.lng,o.latlng.lat]);
    if(o.center){
      if(Array.isArray(o.center)&&o.center.length>=2) return sanitizeLonLat([o.center[0],o.center[1]]);
      if(isNum(num(o.center.lng))&&isNum(num(o.center.lat))) return sanitizeLonLat([o.center.lng,o.center.lat]);
    }
    if(o.geometry?.coordinates?.length>=2) return sanitizeLonLat([o.geometry.coordinates[0],o.geometry.coordinates[1]]);
    const x=o.lon??o.x, y=o.lat??o.y;
    if(isNum(num(x))&&isNum(num(y))) return sanitizeLonLat([x,y]);
    if(typeof o==='string'&&o.includes(',')){
      const [a,b]=o.split(',').map(s=>s.trim());
      try{return sanitizeLonLat([a,b]);}catch{}
      return sanitizeLonLat([b,a]);
    }
    throw new Error(`Unsupported origin: ${JSON.stringify(o)}`);
  }

  // ==================== Distance / Bearings ===================
  function haversineMeters(a,b){const R=6371000;const[lon1,lat1]=a,[lon2,lat2]=b;const dLat=toRad(lat2-lat1),dLon=toRad(lon2-lon1);const s=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(s));}
  function bearingDeg(a,b){
    const [lng1,lat1]=[toRad(a[0]),toRad(a[1])],
          [lng2,lat2]=[toRad(b[0]),toRad(b[1])];
    const y=Math.sin(lng2-lng1)*Math.cos(lat2);
    const x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(lng2-lng1);
    return (Math.atan2(y,x)*180/Math.PI+360)%360;
  }
  function circularMean(ds){const sx=ds.reduce((a,d)=>a+Math.cos(toRad(d)),0);const sy=ds.reduce((a,d)=>a+Math.sin(toRad(d)),0);return (Math.atan2(sy,sx)*180/Math.PI+360)%360;}
  function boundFrom(deg){if(deg>=315||deg<45)return'NB';if(deg<135)return'EB';if(deg<225)return'SB';return'WB';}
  function resampleByDistance(cs,every){if(!cs||cs.length<2)return cs||[];const out=[cs[0]];let acc=0;for(let i=1;i<cs.length;i++){const d=haversineMeters(cs[i-1],cs[i]);acc+=d;if(acc>=every){out.push(cs[i]);acc=0;}}if(out[out.length-1]!==cs[cs.length-1])out.push(cs[cs.length-1]);return out;}
  function haversinePolyline(coords){let m=0;for(let i=1;i<coords.length;i++)m+=haversineMeters(coords[i-1],coords[i]);return m;}

  // ===================== ORS + key rotate =====================
  function savedKeys(){try{return JSON.parse(localStorage.getItem(LS_KEYS)||'[]');}catch{return[];}}
  function hydrateKeys(){const urlKey=qParam('orsKey');const saved=savedKeys();const inline=[INLINE_DEFAULT_KEY];S.keys=(urlKey?[urlKey]:[]).concat(saved.length?saved:inline);S.keyIndex=Math.min(+localStorage.getItem(LS_ACTIVE_INDEX)||0,Math.max(0,S.keys.length-1));}
  function currentKey(){return S.keys[Math.min(Math.max(S.keyIndex,0),S.keys.length-1)]||'';}
  function rotateKey(){if(S.keys.length<=1)return false;S.keyIndex=(S.keyIndex+1)%S.keys.length;localStorage.setItem(LS_ACTIVE_INDEX,String(S.keyIndex));return true;}

  async function orsFetch(path,{method='GET',body}={},attempt=0){
    const url=new URL(ORS_BASE+path);
    const res=await fetch(url.toString(),{
      method,
      headers:{Authorization:currentKey(),...(method!=='GET'&&{'Content-Type':'application/json'})},
      body:method==='GET'?undefined:JSON.stringify(body)
    });
    if([401,403,429].includes(res.status)&&rotateKey()){await sleep(150);return orsFetch(path,{method,body},attempt+1);}
    if(res.status===500&&attempt<1){await sleep(200);return orsFetch(path,{method,body},attempt+1);}
    if(!res.ok){const txt=await res.text().catch(()=>res.statusText);throw new Error(`ORS ${res.status}: ${txt}`);}
    return res.json();
  }

  function generateProbePoints(lon, lat){
    const set=[]; const R=[100,200,300]; const bearings=[...Array(16)].map((_,i)=>i*22.5);
    for(const r of R){ for(const b of bearings){
      const br=toRad(b);
      const dy=r/110540;
      const dx=(r/(111320*Math.cos(toRad(lat))));
      set.push([lon + dx*Math.sin(br), lat + dy*Math.cos(br)]);
    } }
    return set;
  }

  async function getRouteRaw(oLonLat,dLonLat){
    let o=sanitizeLonLat(oLonLat), d=sanitizeLonLat(dLonLat);
    const body={coordinates:[o,d],preference:PREFERENCE,instructions:true,instructions_format:'html',language:'en',geometry_simplify:false,elevation:false,units:'km'};
    try{
      return await orsFetch(`/v2/directions/${PROFILE}/geojson`,{method:'POST',body});
    }catch(e){
      const msg=String(e.message||'');
      const is2099=msg.includes('ORS 500')&&(msg.includes('"code":2099')||msg.includes('code:2099'));
      if(!is2099) throw e;
      const dSwap=sanitizeLonLat([d[1],d[0]]);
      return await orsFetch(`/v2/directions/${PROFILE}/geojson`,{method:'POST',body:{...body,coordinates:[o,dSwap]}});
    }
  }

  async function routeOrNudge(originLonLat, destLonLat){
    try{
      return await getRouteRaw(originLonLat, destLonLat);
    }catch(e){
      const msg=String(e.message||'');
      const is2010 = msg.includes('code":2010') || /not routable point within a radius/i.test(msg);
      if(!is2010) throw e;
      const [dlon,dlat]=sanitizeLonLat(destLonLat);
      const probes=generateProbePoints(dlon,dlat);
      for(const p of probes){
        try{ return await getRouteRaw(originLonLat, p); }
        catch(err){ if(/2010/.test(String(err.message))) continue; }
      }
      throw e;
    }
  }

  // =================== Naming / Highway match =================
  function cleanHtml(s){return String(s||'').replace(/<[^>]*>/g,'').trim();}
  function normalizeName(raw){if(!raw)return'';const s=String(raw).trim().replace(/\s+/g,' ');if(!s||/^unnamed\b/i.test(s)||/^[-–]+$/.test(s))return'';return s;}

  function stepNameNatural(step){
    const field=normalizeName(step?.name||step?.road||''); if(field) return field;
    const t=cleanHtml(step?.instruction||''); if(!t) return '';
    const token=t.match(/\b(?:ON[- ]?)?(?:HWY|Hwy|Highway)?[- ]?\d{2,3}\b(?:\s*[ENSW][BW]?)?/i)||
                t.match(/\b(QEW|DVP|Gardiner(?:\s+Expressway)?|Don Valley Parkway|Allen Road|Black Creek Drive)\b/i);
    if(token) return normalizeName(token[0]);
    if(GENERIC_REGEX.test(t)) return '';
    const m=t.match(/\b(?:onto|on|to|toward|towards)\s+([A-Za-z0-9 .,'\-\/&()]+)$/i);
    if(m) return normalizeName(m[1]);
    return normalizeName(t);
  }

  const HighwayResolver=(()=>{
    function isHighwayLabel(label){const s=String(label||'').toUpperCase();return /(^|\b)(HWY|HIGHWAY|PARKWAY|EXPRESSWAY|QEW|DVP|DON VALLEY|GARDINER|ALLEN|BLACK CREEK|401|404|427|409|410|403|407)\b/.test(s);}
    function labelFromProps(p){return normalizeName(p?.Name||p?.name||p?.official_name||p?.short||p?.ref);}
    function pointSegDistM(p,a,b){const kx=111320*Math.cos(toRad((a[1]+b[1])/2)), ky=110540;const ax=a[0]*kx,ay=a[1]*ky,bx=b[0]*kx,by=b[1]*ky,px=p[0]*kx,py=p[1]*ky;const vx=bx-ax,vy=by-ay,wx=px-ax,wy=py-ay;const c1=vx*wx+vy*wy,c2=vx*vx+vy*vy;const t=c2?Math.max(0,Math.min(1,c1/c2)):0;const nx=ax+t*vx,ny=ay+t*vy,dx=px-nx,dy=py-ny;return Math.sqrt(dx*dx+dy*dy);}
    function bestLabelForSegment(features, seg){
      if(!features?.length||!seg||seg.length<2)return'';
      const sampled=resampleByDistance(seg,SAMPLE_EVERY_M);
      const tallies=new Map();
      for(const p of sampled){
        let best={d:1e12,label:''};
        for(const f of features){
          const cs=f.coords;
          for(let i=1;i<cs.length;i++){
            const d=pointSegDistM(p,cs[i-1],cs[i]);
            if(d<best.d) best={d,label:f.label};
          }
        }
        if(best.label&&best.d<=MATCH_BUFFER_M){
          const t=tallies.get(best.label)||{near:0,sum:0};
          t.near++; t.sum+=best.d; tallies.set(best.label,t);
        }
      }
      let winner='',wNear=0,wMean=1e12;
      for(const [label,t] of tallies){ if(t.near>wNear){winner=label;wNear=t.near;wMean=t.sum/t.near;} }
      const share=sampled.length?(wNear/sampled.length):0;
      return (winner&&share>=CONF_REQ_SHARE&&wMean<=CONF_REQ_MEAN_M&&isHighwayLabel(winner))?winner:'';
    }
    async function loadFirstAvailable(urls){
      for(const url of urls){
        try{
          const res=await fetch(url,{cache:'no-store'}); if(!res.ok) continue;
          const data=await res.json(); const arr=[];
          if(Array.isArray(data?.features)){
            for(const f of data.features){
              const g=f.geometry||{},p=f.properties||{};
              const label=labelFromProps(p); if(!label||!isHighwayLabel(label)) continue;
              if(g.type==='LineString') arr.push({label,coords:g.coordinates});
              else if(g.type==='MultiLineString') (g.coordinates||[]).forEach(cs=>arr.push({label,coords:cs}));
            }
          }
          if(arr.length) return arr;
        }catch{}
      }
      return [];
    }
    return { loadFirstAvailable, bestLabelForSegment };
  })();

  // ==================== Movement building =====================
  function sliceCoords(full,i0,i1){const s=Math.max(0,Math.min(i0,full.length-1));const e=Math.max(0,Math.min(i1,full.length-1));return e<=s?full.slice(s,s+1):full.slice(s,e+1);}
  function cutAfterDistance(coords,startIdx,endIdx,m){if(m<=0)return startIdx;let acc=0;for(let i=startIdx+1;i<=endIdx;i++){acc+=haversineMeters(coords[i-1],coords[i]);if(acc>=m)return i;}return endIdx;}
  function stableBoundForStep(full,wp,limit=BOUND_LOCK_WINDOW_M){
    if(!Array.isArray(wp)||wp.length!==2)return'';
    const[w0,w1]=wp; const s=Math.max(0,Math.min(w0,full.length-1)); const e=Math.max(0,Math.min(w1,full.length-1));
    if(e<=s+1)return'';
    let acc=0,cut=s+1;
    for(let i=s+1;i<=e;i++){acc+=haversineMeters(full[i-1],full[i]); if(acc>=limit){cut=i;break;}}
    const seg=full.slice(s,Math.max(cut,s+1)+1);
    const samp=resampleByDistance(seg,50); if(samp.length<2)return'';
    const bearings=[]; for(let i=1;i<samp.length;i++) bearings.push(bearingDeg(samp[i-1],samp[i]));
    return boundFrom(circularMean(bearings));
  }
  function wholeStepBound(seg){
    const s=resampleByDistance(seg,50); if(s.length<2)return'';
    const b=[]; for(let i=1;i<s.length;i++) b.push(bearingDeg(s[i-1],s[i]));
    return boundFrom(circularMean(b));
  }

  function canonicalHighwayKey(name){
    if(!name) return null;
    const s=String(name).trim();
    const numTok=s.match(/(?:HWY|HIGHWAY|ROUTE|RTE)?\s*([0-9]{2,3})\b/)||s.match(/,\s*([0-9]{2,3})\b/);
    if(numTok) return {key:`RTE-${numTok[1]}`,num:numTok[1]};
    const up=s.toUpperCase();
    const named=up.match(/\b(QEW|DVP|GARDINER|DON VALLEY PARKWAY|ALLEN ROAD|BLACK CREEK DRIVE)\b/);
    if(named) return {key:`NAMED-${named[1]}`,num:null};
    return null;
  }

  function mergeConsecutiveSameCorridor(rows){
    if(!rows.length) return rows;
    const out=[]; let i=0;
    while(i<rows.length){
      const r=rows[i]; const key=canonicalHighwayKey(r?.name||'');
      if(!key){ out.push(r); i++; continue; }
      let j=i, kmByDir=new Map(), total=0, bestName=r.name, bestKm=r.km||0;
      while(j<rows.length){
        const rij=rows[j], kj=canonicalHighwayKey(rij?.name||'');
        if(!kj||kj.key!==key.key) break;
        total+=(rij.km||0);
        kmByDir.set(rij.dir||'',(kmByDir.get(rij.dir||'')||0)+(rij.km||0));
        if((rij.km||0)>bestKm){bestKm=rij.km||0;bestName=rij.name;}
        j++;
      }
      let domDir='', dom=-1; for(const [d,km] of kmByDir.entries()){if(km>dom){dom=km;domDir=d;}}
      out.push({dir:domDir,name:bestName,km:+total.toFixed(2)});
      i=j;
    }
    return out;
  }

  function buildMovementsFromDirections(coords, steps){
    if(!coords?.length||!steps?.length) return [];
    const rows=[];
    const push=(name,i0,i1,isHwy=false)=>{
      const nm=normalizeName(name); if(!nm) return;
      const seg=sliceCoords(coords,i0,i1); if(seg.length<2) return;
      const m=haversinePolyline(seg); if(m<MIN_FRAGMENT_M) return;
      let dir='';
      if(isHwy){
        const cut=cutAfterDistance(coords,i0,i1,RAMP_SKIP_M);
        const segAfter=sliceCoords(coords,cut,i1);
        dir=stableBoundForStep(coords,[cut,i1],BOUND_LOCK_WINDOW_M)||wholeStepBound(segAfter);
      } else {
        dir=stableBoundForStep(coords,[i0,i1],BOUND_LOCK_WINDOW_M)||wholeStepBound(seg);
      }
      rows.push({dir,name:nm,km:+(m/1000).toFixed(2)});
    };

    for(let i=0;i<steps.length;i++){
      const st=steps[i]||{};
      const wp=st.way_points||st.wayPoints||st.waypoints||[0,0];
      const [i0=0,i1=0]=wp;
      let name=stepNameNatural(st);
      const instr=cleanHtml(st?.instruction||'');
      const generic=!name&&GENERIC_REGEX.test(instr);

      let isHwy=false;
      if(S.highwaysOn&&(!name||generic)){
        const cut=cutAfterDistance(S.resultsRouteCoordsRef||[],i0,i1,RAMP_SKIP_M);
        const segAfter=sliceCoords(S.resultsRouteCoordsRef||[],cut,i1);
        const lbl=HighwayResolver.bestLabelForSegment(S.highwayFeatures, segAfter.length?segAfter:sliceCoords(S.resultsRouteCoordsRef||[],i0,i1));
        if(lbl){name=lbl;isHwy=true;}
      }
      if(!name) name=normalizeName(instr);
      push(name,i0,i1,isHwy);
    }
    return mergeConsecutiveSameCorridor(rows).filter(Boolean);
  }

  // ========================= Map draw =========================
  function clearAll(){
    S.results=[];
    if(S.group) S.group.clearLayers();
    setPrintEnabled(false,'Generate PD trips to enable printing.');
    const d=byId('rt-debug'); if(d) d.disabled=true;
  }

  function drawRoute(coords){
    if(!coords?.length) return;
    if(!S.group) S.group=L.layerGroup().addTo(S.map);
    const latlngs = coords.map(([x,y])=>[y,x]);

    // black casing
    L.polyline(latlngs, {
      color:'#000',
      weight:9,
      opacity:0.95,
      lineCap:'round',
      lineJoin:'round'
    }).addTo(S.group);

    // white centerline
    L.polyline(latlngs, {
      color:'#fff',
      weight:5,
      opacity:1.0,
      lineCap:'round',
      lineJoin:'round'
    }).addTo(S.group);
  }

  function updateCenterlineLayer(){
    if(S.highwayLayer){ try{S.map.removeLayer(S.highwayLayer);}catch{} S.highwayLayer=null; }
    if(!S.highwaysOn||!S.highwayFeatures.length) return;
    const grp=L.layerGroup();
    for(const f of S.highwayFeatures){
      L.polyline(f.coords.map(([x,y])=>[y,x]),{
        color:CENTERLINE_COLOR, weight:2, opacity:0.45, dashArray:'6,6'
      }).addTo(grp);
    }
    S.highwayLayer=grp.addTo(S.map);
  }

  // ==================== Harvest polygons ======================
  function harvestPolygonsFromMap(){
    const polys=[]; if(!S.map||!S.map._layers) return polys;
    const pushFeat=f=>{if(!f||f.type!=='Feature')return;const g=f.geometry;if(!g)return;if(g.type==='Polygon'||g.type==='MultiPolygon')polys.push({type:'Feature',geometry:g,properties:(f.properties||{})});};
    Object.values(S.map._layers).forEach(layer=>{
      if(!layer)return;
      if(layer.feature) pushFeat(layer.feature);
      if(typeof layer.toGeoJSON==='function'){try{const gj=layer.toGeoJSON(); if(gj){if(Array.isArray(gj.features)) gj.features.forEach(pushFeat); else pushFeat(gj);}}catch{}}
      if(typeof layer.eachLayer==='function'){try{layer.eachLayer(l=>{if(l&&l.feature)pushFeat(l.feature);});}catch{}}
    });
    return polys;
  }
  function centroidWGS84(geom){
    function ringCentroid(coords){let area=0,x=0,y=0;const pts=coords[0];if(!pts||pts.length<3)return null;for(let i=0;i<pts.length-1;i++){const[x0,y0]=pts[i],[x1,y1]=pts[i+1];const a=x0*y1-x1*y0;area+=a;x+=(x0+x1)*a;y+=(y0+y1)*a;}area*=0.5;if(Math.abs(area)<1e-12)return null;return [x/(6*area),y/(6*area)];}
    if(!geom)return null; if(geom.type==='Polygon')return ringCentroid(geom.coordinates);
    if(geom.type==='MultiPolygon'){for(const p of geom.coordinates){const c=ringCentroid(p);if(c)return c;}} return null;
  }
  function pointInPolygon(pt,geom){
    const[x,y]=pt;
    const inRing=(ring)=>{let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const xi=ring[i][0],yi=ring[i][1],xj=ring[j][0],yj=ring[j][1];const inter=((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi+1e-20)+xi);if(inter)inside=!inside;}return inside;};
    if(geom.type==='Polygon'){const rings=geom.coordinates||[];if(!rings.length)return false;if(!inRing(rings[0]))return false;for(let k=1;k<rings.length;k++){if(inRing(rings[k]))return false;}return true;}
    if(geom.type==='MultiPolygon'){for(const poly of geom.coordinates){if(!poly.length)continue;if(inRing(poly[0])){let hole=false;for(let k=1;k<poly.length;k++){if(inRing(poly[k])){hole=true;break;}}if(!hole)return true;}}}
    return false;
  }

  // =================== PD/PZ geo helpers ======================
  function pickProp(obj,keys,fallback){for(const k of keys){if(obj&&obj[k]!=null&&obj[k]!=='')return obj[k];}return fallback;}
  function looksLikePDFeature(f){const p=f.properties||{};const j=Object.keys(p).join('|').toLowerCase();return /pd|district|planning/.test(j);}
  function looksLikeZoneFeature(f){const p=f.properties||{};const j=Object.keys(p).join('|').toLowerCase();return /zone/.test(j)||'tts'in p||'id'in p||true;}
  function parsePDIdFromLabel(lbl){const m=String(lbl||'').match(/\b(?:PD|Planning\s*District)\s*([0-9]+)\b/i);return m?m[1]:null;}
  function findPDPolygonById(pdId){
    const polys=harvestPolygonsFromMap();
    return polys.find(f=>{
      if(!looksLikePDFeature(f))return false;
      const p=f.properties||{};
      const val=pickProp(p,['PD','PD_ID','PDID','DISTRICT','PlanningDistrict','PD_NAME','name','label'],null);
      if(val==null)return false;
      const clean=String(val).trim().replace(/^PD\s*/i,'');
      return clean===String(pdId);
    })?.geometry||null;
  }
  function findPDPolygonByPoint(ptLonLat){
    const polys=harvestPolygonsFromMap().filter(looksLikePDFeature);
    let best=null, bestArea=-1;
    const areaOf=(geom)=>{
      const ringArea=(ring)=>{let a=0;for(let i=0;i<ring.length-1;i++){const[x0,y0]=ring[i],[x1,y1]=ring[i+1];a+=x0*y1-x1*y0;}return Math.abs(a)/2;};
      if(geom.type==='Polygon') return ringArea(geom.coordinates[0]||[]);
      if(geom.type==='MultiPolygon'){return (geom.coordinates||[]).reduce((s,poly)=>s+ringArea(poly[0]||[]),0);}
      return 0;
    };
    for(const f of polys){
      if(pointInPolygon(ptLonLat,f.geometry)){
        const a=areaOf(f.geometry);
        if(a>bestArea){best=f.geometry;bestArea=a;}
      }
    }
    return best;
  }

  // ==================== Generation routines ===================
  async function generate(){
    let originLonLat; try{originLonLat=getOriginLonLat();}catch(e){alert('Origin has invalid coordinates. Please re-select the address.');return;}
    setBusy(true); clearAll();

    try{
      if(S.mode==='PZ'){
        // Collect zone targets
        let zoneTargets=[];
        if(typeof global.getSelectedPZTargets==='function'){
          const raw=await Promise.resolve(global.getSelectedPZTargets())||[];
          raw.forEach((t,i)=>{try{
            if(Array.isArray(t)){const p=sanitizeLonLat([t[0],t[1]]);zoneTargets.push({lon:p[0],lat:p[1],label:t[2]??`Zone ${i+1}`});}
            else if(t&&typeof t==='object'){const p=sanitizeLonLat([t.lon??t.lng??t.x,t.lat??t.y]);zoneTargets.push({lon:p[0],lat:p[1],label:t.label??t.name??`Zone ${i+1}`});}
          }catch{}});
        }
        if(!zoneTargets.length){
          const pdSel=(global.getSelectedPDTargets&&global.getSelectedPDTargets())||[];
          if(pdSel.length!==1){alert('PZ mode: select exactly one PD (or provide zones via getSelectedPZTargets).');setBusy(false);return;}
          const one=pdSel[0];
          const label=Array.isArray(one)?(one[2]||''):(one.label||one.name||'');
          const pdId=parsePDIdFromLabel(label) || one.pdId || one.PD || one.PD_ID;
          const pdPoint=Array.isArray(one)?sanitizeLonLat([one[0],one[1]]):sanitizeLonLat([one.lon??one.lng??one.x, one.lat??one.y]);
          let pdGeom=null; if(pdId) pdGeom=findPDPolygonById(String(pdId)); if(!pdGeom) pdGeom=findPDPolygonByPoint(pdPoint);
          if(!pdGeom){ alert('PZ mode: could not locate the selected PD on the map.'); setBusy(false); return; }
          const candidates=harvestPolygonsFromMap().filter(looksLikeZoneFeature);
          for(let i=0;i<candidates.length;i++){
            const f=candidates[i]; const c=centroidWGS84(f.geometry); if(!c) continue;
            const lonlat=sanitizeLonLat([c[0],c[1]]);
            if(pointInPolygon(lonlat,pdGeom)){
              const p=f.properties||{};
              const labelZ=String(p.ZONE??p.ZONE_ID??p.TTS_ZONE??p.TTS??p.ID??p.Name??p.name??p.label??`Zone ${i+1}`);
              zoneTargets.push({lon:lonlat[0],lat:lonlat[1],label:labelZ});
            }
          }
          if(!zoneTargets.length){alert('PZ mode: no zones found inside the selected PD on the map.');setBusy(false);return;}
        }

        for(let i=0;i<zoneTargets.length;i++){
          const z=zoneTargets[i];
          try{
            const json=await routeOrNudge(originLonLat,[z.lon,z.lat]);
            const feat=json.features?.[0]; const coords=feat?.geometry?.coordinates||[]; const steps=feat?.properties?.segments?.[0]?.steps||[];
            S.resultsRouteCoordsRef=coords;
            S.results.push({dest:{lon:z.lon,lat:z.lat,label:z.label},route:{coords,steps}});
            drawRoute(coords);
          }catch(err){
            console.warn('PZ trip skipped:', z.label, err);
          }
          await sleep(PER_REQUEST_DELAY);
        }
        setPrintEnabled(false,'Print Report is available for PD trips only.');
        const dbg=byId('rt-debug'); if(dbg) dbg.disabled=false;
        setBusy(false); return;
      }

      // ---- PD mode
      const rawTargets=(global.getSelectedPDTargets&&global.getSelectedPDTargets())||[];
      const targets=[];
      (rawTargets||[]).forEach((t,i)=>{try{
        if(Array.isArray(t)){const p=sanitizeLonLat([t[0],t[1]]);targets.push([p[0],p[1],t[2]??`PD ${i+1}`]);}
        else if(t&&typeof t==='object'){const p=sanitizeLonLat([t.lon??t.lng??t.x,t.lat??t.y]);targets.push([p[0],p[1],t.label??t.name??`PD ${i+1}`]);}
      }catch{}});
      if(!targets.length){alert('PD mode: select at least one PD with valid coordinates.');setBusy(false);return;}

      for(let i=0;i<targets.length;i++){
        const[lon,lat,label]=targets[i];
        try{
          const json=await routeOrNudge(originLonLat,[lon,lat]);
          const feat=json.features?.[0]; const coords=feat?.geometry?.coordinates||[]; const steps=feat?.properties?.segments?.[0]?.steps||[];
          S.resultsRouteCoordsRef=coords;
          S.results.push({dest:{lon,lat,label},route:{coords,steps}});
          drawRoute(coords);
        }catch(err){
          console.warn('PD trip skipped:', label, err);
        }
        await sleep(PER_REQUEST_DELAY);
      }
      setPrintEnabled(true,'Open printable report for the current PD trips');
      const dbg=byId('rt-debug'); if(dbg) dbg.disabled=false;

    }catch(e){alert('Routing error: '+e.message);}finally{setBusy(false);}
  }

  // ===================== Print (same-page) ====================
  function setPrintEnabled(enabled, title){
    const btn=byId('rt-print');
    if(!btn) return;
    btn.disabled=!enabled;
    if(title) btn.title=title;
  }

  function buildReportHTML(results){
    const section = results.map(r=>{
      const mov=(buildMovementsFromDirections(r.route.coords,r.route.steps)||[]).filter(m=>m&&m.name);
      const lines=mov.map(m=>`<tr><td>${m.dir||''}</td><td>${m.name}</td><td style="text-align:right">${km2(m.km)}</td></tr>`).join('');
      return `<section class="rt-card">
        <h2>Destination: ${r.dest.label||(r.dest.lon+','+r.dest.lat)}</h2>
        <table>
          <thead><tr><th>Dir</th><th>Street</th><th style="text-align:right">km</th></tr></thead>
          <tbody>${lines}</tbody>
        </table>
      </section>`;
    }).join('');
    return `<div class="rt-print-root"><h1>Trip Report — Street List</h1>${section}</div>`;
  }

  function ensurePrintPane(){
    let pane=document.getElementById('rt-print-pane');
    if(!pane){
      pane=document.createElement('div');
      pane.id='rt-print-pane';
      pane.setAttribute('aria-hidden','true');
      pane.innerHTML=`<div class="rt-print-sheet"></div>`;
      document.body.appendChild(pane);
      const style=document.createElement('style');
      style.id='rt-print-style';
      style.textContent=`
        #rt-print-pane{position:fixed;inset:0;z-index:2147483000;background:#fff;display:none;overflow:auto;}
        #rt-print-pane.active{display:block;}
        #rt-print-pane .rt-print-root{padding:24px 28px; font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial;}
        #rt-print-pane h1{font-size:20px;margin:8px 0 16px;}
        #rt-print-pane h2{font-size:16px;margin:18px 0 8px;}
        #rt-print-pane table{width:100%;border-collapse:collapse;margin-bottom:18px;}
        #rt-print-pane th,#rt-print-pane td{border:1px solid #ddd;padding:6px 8px;}
        #rt-print-pane thead th{background:#f7f7f7;}
        #rt-print-pane .rt-card{page-break-inside:avoid;margin-bottom:22px;}
        @media print {
          #rt-print-pane{display:block !important;}
          body > :not(#rt-print-pane){display:none !important;}
          html, body { background:#fff; }
        }
      `;
      document.head.appendChild(style);
    }
    return pane;
  }

  function printReport(){
    if(S.mode!=='PD'){ alert('Print Report is available for PD trips only.'); return; }
    if(!S.results.length){ alert('No PD trips generated yet.'); return; }
    const pane=ensurePrintPane();
    const sheet=pane.querySelector('.rt-print-sheet');
    sheet.innerHTML = buildReportHTML(S.results);
    pane.classList.add('active');

    const cleanup=()=>{
      pane.classList.remove('active');
      sheet.innerHTML='';
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    setTimeout(()=>{ try{window.print();}catch(e){cleanup();} }, 60);
    setTimeout(()=>{ if(pane.classList.contains('active')) cleanup(); }, 5000);
  }

  function printDebugSteps(){
    if(!S.results.length){alert('No trips generated yet.');return;}
    const cards=S.results.map(r=>{
      const steps=r.route.steps||[];
      const rows=steps.map((st,i)=>{
        const nameField=normalizeName(st?.name||st?.road||'');
        const chosen=stepNameNatural(st)||'(generic)';
        const instr=cleanHtml(st?.instruction||'');
        const km=((st?.distance||0)/1000).toFixed(3);
        return `<tr><td style="text-align:right">${i}</td><td style="text-align:right">${km}</td><td>${nameField}</td><td>${chosen}</td><td>${instr}</td></tr>`;
      }).join('');
      return `<section class="rt-card">
        <h2>Debug — ${r.dest.label||(r.dest.lon+','+r.dest.lat)}</h2>
        <table><thead><tr><th style="text-align:right">#</th><th style="text-align:right">km</th><th>step.name</th><th>chosen name</th><th>instruction (raw)</th></tr></thead><tbody>${rows}</tbody></table>
      </section>`;
    }).join('');
    const pane=ensurePrintPane();
    pane.querySelector('.rt-print-sheet').innerHTML=`
      <div class="rt-print-root"><h1>OpenRouteService — Raw Steps</h1>${cards}</div>
    `;
    pane.classList.add('active');
    const cleanup=()=>{
      pane.classList.remove('active');
      pane.querySelector('.rt-print-sheet').innerHTML='';
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    setTimeout(()=>{ try{window.print();}catch(e){cleanup();} }, 60);
    setTimeout(()=>{ if(pane.classList.contains('active')) cleanup(); }, 5000);
  }

  // ====================== UI / Controls =======================
  const GeneratorControl=L.Control.extend({
    options:{position:'topleft'},
    onAdd(){
      const el=L.DomUtil.create('div','routing-control');
      // minimal defensive style so it's visible even if site CSS changes
      el.style.background='#fff'; el.style.padding='8px'; el.style.borderRadius='10px'; el.style.boxShadow='0 6px 16px rgba(0,0,0,.15)';
      el.innerHTML=`
        <div class="routing-header" style="font-weight:700;margin-bottom:6px;">Routing</div>
        <div class="routing-actions" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          <button id="rt-mode" class="ghost">Mode: PD</button>
          <button id="rt-generate">Generate Trips</button>
          <button id="rt-clear" class="ghost">Clear</button>
          <button id="rt-print" disabled title="Generate PD trips to enable printing.">Print Report</button>
          <button id="rt-debug" class="ghost" disabled>Debug Steps</button>
          <button id="rt-toggle-highways" class="ghost">Highways: ON</button>
          <button id="rt-pz" class="ghost">PZ report</button>
        </div>
        <details><summary><strong>Keys</strong></summary>
          <div class="routing-card" style="margin-top:6px;">
            <label for="rt-keys" style="font-weight:600;">OpenRouteService key(s)</label>
            <input id="rt-keys" type="text" placeholder="KEY1,KEY2 (comma-separated)" style="width:260px;">
            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:6px;">
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

  function wireControls(){
    const m=byId('rt-mode'), g=byId('rt-generate'), c=byId('rt-clear'), p=byId('rt-print'),
          d=byId('rt-debug'), t=byId('rt-toggle-highways'), z=byId('rt-pz'),
          s=byId('rt-save'), u=byId('rt-url'), inp=byId('rt-keys');

    if(m) m.onclick=()=>{ S.mode=(S.mode==='PD')?'PZ':'PD'; m.textContent=`Mode: ${S.mode}`; setPrintEnabled(S.mode==='PD', S.mode==='PD'?'Open printable report for the current PD trips':'Print Report is available for PD trips only.'); };
    if(g) g.onclick=()=>generate();
    if(c) c.onclick=()=>clearAll();
    if(p) p.onclick=()=>printReport();
    if(d) d.onclick=()=>printDebugSteps();
    if(t) t.onclick=()=>{S.highwaysOn=!S.highwaysOn; t.textContent=`Highways: ${S.highwaysOn?'ON':'OFF'}`; updateCenterlineLayer();};
    if(z) z.onclick=()=>pzReport();
    if(s&&inp) s.onclick=()=>{const arr=inp.value.split(',').map(x=>x.trim()).filter(Boolean);localStorage.setItem(LS_KEYS,JSON.stringify(arr));hydrateKeys();alert(`Saved ${S.keys.length} key(s).`);};
    if(u) u.onclick=()=>{const k=qParam('orsKey'); if(!k) alert('Add ?orsKey=YOUR_KEY to the URL.'); else {localStorage.setItem(LS_KEYS,JSON.stringify([k]));hydrateKeys();alert('Using orsKey from URL.');}};
  }

  function setBusy(b){
    const g=byId('rt-generate');
    if(g){ g.disabled=b; g.textContent=b?`Generating… (${S.mode})`:'Generate Trips'; }
  }

  // ========================= PZ Report ========================
  async function pzReport(){
    const pdTargets=(global.getSelectedPDTargets&&global.getSelectedPDTargets())||[];
    if(!pdTargets.length){alert('Please select exactly one PD to run a PZ report.');return;}
    if(pdTargets.length>1){alert('Only one PD can be selected for a PZ report.');return;}

    const one=pdTargets[0];
    const label=Array.isArray(one)?(one[2]||''):(one.label||one.name||'');
    const pdId=parsePDIdFromLabel(label)||one.pdId||one.PD||one.PD_ID;

    let originLonLat; try{originLonLat=getOriginLonLat();}catch(e){alert('Origin has invalid coordinates.');return;}

    const pdPoint=Array.isArray(one)?sanitizeLonLat([one[0],one[1]]):sanitizeLonLat([one.lon??one.lng??one.x,one.lat??one.y]);
    let pdGeom=null; if(pdId) pdGeom=findPDPolygonById(String(pdId)); if(!pdGeom) pdGeom=findPDPolygonByPoint(pdPoint);
    if(!pdGeom){alert('PZ report error: PD boundary not found on the map.');return;}

    const zones=harvestPolygonsFromMap().filter(looksLikeZoneFeature);
    const zoneTargets=[];
    for(let i=0;i<zones.length;i++){
      const f=zones[i]; const c=centroidWGS84(f.geometry); if(!c) continue;
      const ll=sanitizeLonLat([c[0],c[1]]);
      if(pointInPolygon(ll,pdGeom)){const p=f.properties||{};const labelZ=String(p.ZONE??p.ZONE_ID??p.TTS_ZONE??p.TTS??p.ID??p.Name??p.name??p.label??`Zone ${i+1}`);zoneTargets.push({lon:ll[0],lat:ll[1],label:labelZ});}
    }
    if(!zoneTargets.length){alert('PZ report error: No zones found inside the selected PD on the map.');return;}

    const results=[]; const failures=[];
    for(let i=0;i<zoneTargets.length;i++){
      const z=zoneTargets[i];
      try{
        const json=await routeOrNudge(originLonLat,[z.lon,z.lat]);
        const feat=json.features?.[0]; const coords=feat?.geometry?.coordinates||[]; const steps=feat?.properties?.segments?.[0]?.steps||[];
        S.resultsRouteCoordsRef=coords; results.push({dest:{lon:z.lon,lat:z.lat,label:z.label},route:{coords,steps}});
      }catch(err){
        failures.push(z.label||`Zone #${i+1}`);
        console.warn('PZ report skipped zone:', z.label, err);
      }
      await sleep(PER_REQUEST_DELAY);
    }

    if(!results.length){ alert('PZ report error: all zones failed to fetch routes.'); return; }

    const html = `
      <div class="rt-print-root">
        <h1>PZ Report</h1>
        ${results.map(r=>{
          const mov=(buildMovementsFromDirections(r.route.coords,r.route.steps)||[]).filter(m=>m&&m.name);
          const lines=mov.map(m=>`<tr><td>${m.dir||''}</td><td>${m.name}</td><td style="text-align:right">${km2(m.km)}</td></tr>`).join('');
          return `<section class="rt-card"><h2>Destination: ${r.dest.label}</h2>
            <table><thead><tr><th>Dir</th><th>Street</th><th style="text-align:right">km</th></tr></thead><tbody>${lines}</tbody></table>
          </section>`;
        }).join('')}
      </div>`;
    const pane=ensurePrintPane();
    pane.querySelector('.rt-print-sheet').innerHTML=html;
    pane.classList.add('active');
    const cleanup=()=>{
      pane.classList.remove('active');
      pane.querySelector('.rt-print-sheet').innerHTML='';
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    setTimeout(()=>{ try{window.print();}catch(e){cleanup();} }, 60);
    setTimeout(()=>{ if(pane.classList.contains('active')) cleanup(); }, 5000);

    if(failures.length){
      setTimeout(()=>alert(`PZ report finished: ${results.length} succeeded, ${failures.length} failed.\nSkipped: ${failures.slice(0,12).join(', ')}${failures.length>12?' …':''}`), 300);
    }
  }

  // ========================= Init =============================
  function wireControlsSafe(){
    try { wireControls(); }
    catch(e){ console.error('wireControls error', e); banner('Routing UI wiring failed.', true); }
  }

  async function innerInit(map){
    try{
      S.map=map; hydrateKeys();
      if(!S.group) S.group=L.layerGroup().addTo(map);
      map.addControl(new GeneratorControl());
    }catch(e){
      console.error('addControl failed', e);
      banner('Routing box failed to mount. Click Retry.', true);
      return; // stop here; retry will re-enter
    }
    setTimeout(wireControlsSafe,0);
    try{ S.highwayFeatures=await HighwayResolver.loadFirstAvailable(HIGHWAY_URLS); }catch{ S.highwayFeatures=[]; }
    updateCenterlineLayer();
  }

  function tryInitControls(attempt=0){
    const mapRef = global.map || S.map;
    if(mapRef && (mapRef._loaded || mapRef._size)){
      innerInit(mapRef);
      return;
    }
    if(attempt>200){ // ~16s max
      banner('Leaflet map did not load in time. Routing UI paused.', true);
      return;
    }
    setTimeout(()=>tryInitControls(attempt+1), 80);
  }

  const Routing={ init(map){
    if(map) S.map=map;
    tryInitControls(0);
  }};
  global.Routing=Routing;

  // Clean up any stuck print pane from prior runs
  document.addEventListener('DOMContentLoaded',()=>{
    const stuck=document.getElementById('rt-print-pane');
    if(stuck){ stuck.classList.remove('active'); const sheet=stuck.querySelector('.rt-print-sheet'); if(sheet) sheet.innerHTML=''; }
    tryInitControls(0);
  });
})(window);
