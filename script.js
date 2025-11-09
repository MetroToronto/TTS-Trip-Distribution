/* script.js — initializes Leaflet map, PD list with 0–3 count boxes, and exposes App.getPDRequests() / App.getPZRequests() */
(function (global) {
  'use strict';

  // === MAP INITIALIZATION ===
  const map = L.map('map').setView([43.7, -79.4], 10);
  global.map = map;

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  // === ORIGIN MARKER (from geocoder click or manual) ===
  let originMarker = null;
  function setOrigin(lat, lon) {
    if (originMarker) originMarker.remove();
    originMarker = L.marker([lat, lon], { draggable: true }).addTo(map);
    originMarker.on('dragend', e => {
      const p = e.target.getLatLng();
      global.ROUTING_ORIGIN = { lat: p.lat, lon: p.lng };
    });
    global.ROUTING_ORIGIN = { lat, lon };
  }
  setOrigin(43.7, -79.4); // default Toronto center

  // === LOAD PD & PZ GEOJSON ===
  const PD_URL = '/data/tts_pds.json';
  const PZ_URL = '/data/tts_zones.json';
  let PD_FEATURES = [], PZ_FEATURES = [];

  Promise.all([fetch(PD_URL).then(r=>r.json()).catch(()=>null),
               fetch(PZ_URL).then(r=>r.json()).catch(()=>null)])
  .then(([pd, pz])=>{
    if (pd && pd.features) {
      PD_FEATURES = pd.features;
      buildPDPanel(PD_FEATURES);
    }
    if (pz && pz.features) {
      PZ_FEATURES = pz.features;
      buildPZPanel();
    }
  });

  // === BUILD PD PANEL WITH COUNT BOXES ===
  function buildPDPanel(features) {
    const wrap = document.getElementById('pd-panel');
    if (!wrap) return;
    wrap.innerHTML = `<h3>Planning Districts</h3>
      <div><button id="pd-all">Select all</button>
           <button id="pd-none">Clear all</button></div>
      <div id="pd-list" style="max-height:250px;overflow:auto;margin-top:6px;"></div>`;

    const list = document.getElementById('pd-list');

    features.forEach(f=>{
      const id = f.properties.id || f.properties.PD || f.properties.name;
      const name = f.properties.name || id;
      const c = centroid(f.geometry);
      const div = document.createElement('div');
      div.className = 'pd-item';
      div.dataset.id = id;
      div.dataset.label = name;
      div.dataset.centroid = `${c[0]},${c[1]}`; // lon,lat
      div.innerHTML = `
        <label style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" class="pd-check" checked>
          <span style="flex:1">${name}</span>
          <input type="number" class="pd-count" value="1" min="0" max="3" style="width:40px;text-align:right">
        </label>`;
      list.appendChild(div);
      const chk = div.querySelector('.pd-check');
      const cnt = div.querySelector('.pd-count');
      chk.addEventListener('change', ()=>{
        cnt.disabled = !chk.checked;
        cnt.value = chk.checked ? (cnt.value==='0'?'1':cnt.value) : '0';
      });
    });

    document.getElementById('pd-all').onclick = ()=>{
      list.querySelectorAll('.pd-item').forEach(it=>{
        it.querySelector('.pd-check').checked = true;
        it.querySelector('.pd-count').disabled = false;
        if (it.querySelector('.pd-count').value==='0') it.querySelector('.pd-count').value='1';
      });
    };
    document.getElementById('pd-none').onclick = ()=>{
      list.querySelectorAll('.pd-item').forEach(it=>{
        it.querySelector('.pd-check').checked = false;
        it.querySelector('.pd-count').value='0';
        it.querySelector('.pd-count').disabled = true;
      });
    };
  }

  // === BUILD PZ PANEL (unchanged) ===
  function buildPZPanel(){
    const wrap = document.getElementById('pz-panel');
    if (!wrap) return;
    wrap.innerHTML = `<h3>Planning Zones</h3>
      <button id="pz-engage">Engage</button>
      <button id="pz-disengage">Disengage</button>
      <input id="pz-input" placeholder="Zone #"
             style="width:100%;margin-top:6px;border:1px solid #ccc;border-radius:6px;padding:4px 6px">`;
  }

  // === PUBLIC APP GETTERS FOR routing.js ===
  global.App = {
    getPDRequests(){
      return Array.from(document.querySelectorAll('.pd-item')).map(div=>{
        const chk = div.querySelector('.pd-check');
        const cnt = parseInt(div.querySelector('.pd-count').value||'0');
        const coords = div.dataset.centroid.split(',').map(Number);
        return {
          id: div.dataset.id,
          label: div.dataset.label,
          coords,
          count: chk.checked ? Math.min(Math.max(cnt,0),3) : 0
        };
      });
    },
    getPZRequests(){
      const val = (document.getElementById('pz-input')?.value||'').trim();
      if(!val) return [];
      const f = PZ_FEATURES.find(z=>{
        const pid = String(z.properties.id||z.properties.zone||'').toLowerCase();
        return pid===val.toLowerCase();
      });
      if(!f) return [];
      const c = centroid(f.geometry);
      return [{id:val,label:`PZ ${val}`,coords:c,count:1}];
    }
  };

  // === SIMPLE POLYGON CENTROID ===
  function centroid(g){
    if(!g) return [NaN,NaN];
    const arr = (g.type==='Polygon') ? [g.coordinates[0]]
                : (g.type==='MultiPolygon') ? g.coordinates.map(r=>r[0]) : [];
    let sx=0,sy=0,n=0;
    arr.forEach(r=>r.forEach(([x,y])=>{sx+=x;sy+=y;n++;}));
    return n?[sx/n,sy/n]:[NaN,NaN];
  }

})(window);
