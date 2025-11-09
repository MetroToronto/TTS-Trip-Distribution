/* routing.js — ORS Directions v2 (Oct-13 style) with built-in fallback key, key rotation,
   and printable report. Works with your original PD/PZ UI: it reads PDs via
   getSelectedPDTargets() and the origin via window.ROUTING_ORIGIN. */
(function (global) {
  // ---------- Config ----------
  const ORS_BASE = 'https://api.openrouteservice.org';
  const PROFILE  = 'driving-car';
  const PREFERENCE = 'fastest';
  const COLOR_MAIN = '#0b3aa5', COLOR_ALT = '#2166f3';

  // Your fallback key so the “Missing key” modal never appears
  const INLINE_DEFAULT_KEY =
    'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijk5NWI5MTE5OTM2YTRmYjNhNDRiZTZjNDRjODhhNTRhIiwiaCI6Im11cm11cjY0In0=';

  // ---------- State ----------
  const S = { map:null, group:null, keys:[], keyIdx:0, results:[] };
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

  // ---------- Key mgmt (URL → saved → inline fallback) ----------
  function urlKeys(){
    const raw = new URLSearchParams(location.search).get('orsKey');
    return raw ? raw.split(',').map(s=>s.trim()).filter(Boolean) : [];
  }
  function loadKeys(){
    const fromUrl = urlKeys(); if (fromUrl.length) return fromUrl;
    try {
      const saved = JSON.parse(localStorage.getItem('ORS_KEYS')||'[]');
      if (Array.isArray(saved) && saved.length) return saved;
    } catch {}
    // fallback to your embedded key
    return [INLINE_DEFAULT_KEY];
  }
  function saveKeys(arr){ localStorage.setItem('ORS_KEYS', JSON.stringify(arr)); }
  function currentKey(){ return S.keys[S.keyIdx] || INLINE_DEFAULT_KEY; }
  function rotateKey(){
    if (S.keys.length < 2) return false;
    S.keyIdx = (S.keyIdx + 1) % S.keys.length;
    return true;
  }

  // ---------- UI bits ----------
  function ensureGroup(){ if (!S.group) S.group = L.layerGroup().addTo(S.map); }
  function clearAll(){ if (S.group) S.group.clearLayers(); S.results.length = 0; setReportEnabled(false); }
  function popup(html){
    if (S.map) L.popup().setLatLng(S.map.getCenter()).setContent(html).openOn(S.map);
    else alert(html.replace(/<[^>]+>/g,''));
  }

  // Trip + Report controls (same look/flow as Oct-13)
  const TripCtl = L.Control.extend({
    options:{ position:'topleft' },
    onAdd(){
      const el = L.DomUtil.create('div','routing-control');
      el.innerHTML = `
        <div class="routing-header"><strong>Trip Generator</strong></div>
        <div class="routing-actions" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          <button id="rt-gen">Generate Trips</button>
          <button id="rt-clr" class="ghost">Clear</button>
        </div>
        <details class="routing-section">
          <summary>API keys & options</summary>
          <div style="margin-top:8px;display:grid;gap:8px;">
            <input id="rt-keys" type="text" placeholder="KEY1,KEY2 (comma-separated)">
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              <button id="rt-save">Save Keys</button>
              <button id="rt-url" class="ghost">Use ?orsKey</button>
            </div>
            <small>Priority: ?orsKey → saved → built-in fallback (yours). Keys auto-rotate on 401/429.</small>
          </div>
        </details>`;
      L.DomEvent.disableClickPropagation(el);
      return el;
    }
  });
  const ReportCtl = L.Control.extend({
    options:{ position:'topleft' },
    onAdd(){
      const el = L.DomUtil.create('div','routing-control');
      el.innerHTML = `
        <div class="routing-header"><strong>Report</strong></div>
        <div class="routing-actions" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          <button id="rt-print" disabled>Print Report</button>
        </div>
        <small>Prints what’s already generated. No new API calls.</small>`;
      L.DomEvent.disableClickPropagation(el);
      return el;
    }
  });
  function setReportEnabled(on){ const b=document.getElementById('rt-print'); if (b) b.disabled=!on; }

  // ---------- ORS helpers ----------
  async function ors(path, { method='GET', body } = {}){
    const res = await fetch(`${ORS_BASE}${path}`, {
      method,
      headers: { Authorization: currentKey(), ...(method!=='GET' && {'Content-Type':'application/json'}) },
      body: method==='GET' ? undefined : JSON.stringify(body)
    });
    if ([401,403,429].includes(res.status) && rotateKey()) return ors(path, { method, body });
    if (!res.ok) throw new Error(`ORS ${res.status}: ${await res.text().catch(()=>res.statusText)}`);
    return res.json();
  }
  async function getRoute(originLonLat, destLonLat){
    return ors(`/v2/directions/${PROFILE}/geojson`, {
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

  // ---------- Simple street summary from ORS steps ----------
  function summarize(feat){
    const seg = feat?.properties?.segments?.[0];
    const steps = seg?.steps || [];
    const distKm = (seg?.distance||0)/1000;
    const durMin = Math.round((seg?.duration||0)/60);
    const parts = steps.map(s => {
      const t = String(s.instruction||'').replace(/<[^>]*>/g,'');
      return t.replace(/\s+/g,' ').trim();
    });
    return { distKm, durMin, text: parts.join(', ') };
  }

  // ---------- Init ----------
  function init(map){
    S.map = map;
    S.keys = loadKeys();

    map.addControl(new TripCtl());
    map.addControl(new ReportCtl());

    const els = {
      gen:   document.getElementById('rt-gen'),
      clr:   document.getElementById('rt-clr'),
      print: document.getElementById('rt-print'),
      keys:  document.getElementById('rt-keys'),
      save:  document.getElementById('rt-save'),
      url:   document.getElementById('rt-url')
    };
    if (els.keys) els.keys.value = S.keys.join(',');

    if (els.gen)   els.gen.onclick   = generateTrips;
    if (els.clr)   els.clr.onclick   = () => clearAll();
    if (els.print) els.print.onclick = () => printReport();
    if (els.save)  els.save.onclick  = () => { const arr=(els.keys.value||'').split(',').map(s=>s.trim()).filter(Boolean); if(arr.length){ S.keys=arr; saveKeys(arr); S.keyIdx=0; popup('<b>Routing</b><br>Keys saved.'); } };
    if (els.url)   els.url.onclick   = () => { const arr=urlKeys(); if(arr.length){ S.keys=arr; S.keyIdx=0; popup('<b>Routing</b><br>Using keys from URL.'); } };
  }

  // ---------- Generate ----------
  async function generateTrips(){
    const origin = global.ROUTING_ORIGIN;
    if (!origin) return popup('<b>Routing</b><br>Pick an address from the top geocoder first.');

    // Use your existing PD UI selection (unchanged)
    if (typeof global.getSelectedPDTargets !== 'function') {
      return popup('<b>Routing</b><br>PD selection UI is not ready.');
    }
    const targets = global.getSelectedPDTargets();
    if (!targets || !targets.length) return popup('<b>Routing</b><br>No PDs selected.');

    clearAll();
    ensureGroup();

    // Origin marker
    L.circleMarker([origin.lat, origin.lon], { radius:6 }).addTo(S.group)
      .bindPopup(`<b>Origin</b><br>${origin.label || (origin.lat.toFixed(5)+', '+origin.lon.toFixed(5))}`);

    // Zoom roughly to first target
    try {
      const f = targets[0];
      S.map.fitBounds(L.latLngBounds([[origin.lat,origin.lon],[f[1],f[0]]]), { padding:[24,24] });
    } catch {}

    // Rate-limit to ~40/min
    for (let i=0;i<targets.length;i++){
      const [dlon,dlat,label] = targets[i];
      try{
        const gj   = await getRoute([origin.lon, origin.lat], [dlon, dlat]);
        const feat = gj?.features?.[0];
        const coords = feat?.geometry?.coordinates || [];
        const latlngs = coords.map(([x,y]) => [y,x]);

        // Draw
        L.polyline(latlngs, { color: i===0 ? COLOR_MAIN : COLOR_ALT, weight:5, opacity:0.9 }).addTo(S.group);
        L.circleMarker([dlat, dlon], { radius:5 }).addTo(S.group);

        // Summary
        const sum = summarize(feat);
        S.results.push({ label, km: sum.distKm.toFixed(1), min: sum.durMin, text: sum.text });

      } catch (e) {
        console.error('Route failed for', label, e);
        popup(`<b>Routing</b><br>Route failed for ${label}<br><small>${e.message}</small>`);
      }
      if (i < targets.length-1) await sleep(1200); // ~40/minute
    }

    setReportEnabled(S.results.length > 0);
    popup('<b>Routing</b><br>All routes processed. Popups added at each destination.');
  }

  // ---------- Report (comma-separated narrative) ----------
  function printReport(){
    if (!S.results.length) return popup('<b>Report</b><br>Generate trips first.');
    const w = window.open('', '_blank');
    const css = `<style>
      body{font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:16px}
      h1{margin:0 0 8px;font-size:20px}
      .card{border:1px solid #ddd;border-radius:12px;padding:12px;margin:12px 0}
      .sub{color:#555;margin-bottom:8px}
    </style>`;
    const cards = S.results.map((r,i)=>`
      <div class="card">
        <h2>${i+1}. ${r.label}</h2>
        <div class="sub">Distance: ${r.km} km • ${r.min} min</div>
        <div>${r.text || '<em>No step text available</em>'}</div>
      </div>`).join('');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>Trip Report</title>${css}<h1>Trip Report</h1>${cards}<script>window.onload=()=>window.print();</script>`);
    w.document.close();
  }

  // ---------- Boot ----------
  const Routing = { init(map){ init(map); } };
  global.Routing = Routing;
  document.addEventListener('DOMContentLoaded', ()=>{ if (global.map) Routing.init(global.map); });
})(window);
