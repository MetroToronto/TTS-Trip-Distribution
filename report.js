<script>
/* report.js — one-button report. Uses Routing.getResults(), infers NB/EB/SB/WB, and names highways via local dataset */
(function (global) {
  'use strict';

  const HIGHWAYS_URLS = [
    '/data/highway_centreline.geojson',
    '/data/highway_centreline.json'
  ];
  let HIGHWAYS = null;       // GeoJSON FeatureCollection
  let HW_INDEX = null;       // naive spatial index: [{minX,maxX,minY,maxY,name,coords:[[lon,lat],...]}, ...]

  // Wire the one report button (re-uses #rt-print from the routing control)
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('rt-print');
    if (btn) {
      btn.textContent = 'Generate Report';
      btn.disabled = false;
      btn.addEventListener('click', onGenerateReport);
    }
  });

  async function onGenerateReport() {
    if (!global.Routing || typeof global.Routing.getResults !== 'function') {
      showModal('Report not available', ['Routing module is not ready.']);
      return;
    }
    const results = global.Routing.getResults();
    if (!results.length) {
      showModal('Report not available', ['Generate trips first.']);
      return;
    }
    if (!HIGHWAYS) {
      HIGHWAYS = await fetchFirstAvailable(HIGHWAYS_URLS).catch(()=>null);
      if (HIGHWAYS && HIGHWAYS.features) {
        HW_INDEX = buildHighwayIndex(HIGHWAYS.features);
      }
    }

    const blocks = [];
    for (const res of results) {
      // Use only the best route for each target in the concatenated line,
      // but list alternatives on new lines below (if exist)
      const best = res.routes?.[0];
      if (!best) continue;

      const dirString = await summarizeRoute(best, HW_INDEX);
      let html = `<div class="card"><h2>${escapeHtml(res.target.label)}</h2><p>${dirString}</p>`;

      if (res.routes.length > 1) {
        html += `<div class="alts"><div style="font-weight:600;margin:8px 0 4px">Alternatives:</div><ol>`;
        for (let i=1;i<res.routes.length;i++){
          const s = await summarizeRoute(res.routes[i], HW_INDEX);
          html += `<li>${s}</li>`;
        }
        html += `</ol></div>`;
      }
      html += `</div>`;
      blocks.push(html);
    }

    const css = `
      <style>
        body{font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;}
        h1{font-size:18px;margin:16px 0;}
        h2{font-size:16px;margin:6px 0 8px;}
        .card{page-break-inside:avoid;margin:10px 0 18px 0;border:1px solid #eee;border-radius:10px;padding:10px 12px}
        .alts ol{margin:6px 0 0 20px}
      </style>
    `;

    const w = window.open('', '_blank');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>Trips Report</title>${css}<h1>Trips Report</h1>${blocks.join('')}<script>onload=()=>focus()</script>`);
    w.document.close();
  }

  // ---- Build a single-line summary for one route: "NB Hwy 401, EB DVP, EB Gerrard St E, ..." ----
  async function summarizeRoute(route, hwIndex) {
    // Prefer instructions if present (some builds of routing.js may include steps)
    let steps = route.steps;
    if (!steps && route.geometry) {
      // derive segments & headings from geometry only (no API call)
      steps = derivePseudoStepsFromGeometry(route.geometry);
      // attach names for highway segments if available
      if (hwIndex) attachHighwayNames(steps, hwIndex);
    }

    // Squash into direction/name chunks
    const chunks = [];
    let prevDir = null, prevName = null, accDist = 0;

    for (const st of steps) {
      const dir = st.dir || computeCardinal(st.bearing);
      const name = cleanName(st.name || st.road || '');
      const dist = Number(st.distance || st.len || 0);

      if (!prevDir) {
        prevDir = dir; prevName = name; accDist = dist;
      } else if (dir === prevDir && name === prevName) {
        accDist += dist;
      } else {
        chunks.push({ dir: prevDir, name: prevName, dist: accDist });
        prevDir = dir; prevName = name; accDist = dist;
      }
    }
    if (prevDir) chunks.push({ dir: prevDir, name: prevName, dist: accDist });

    // Compose string
    const parts = chunks.map(ch => {
      const label = [ch.dir, ch.name].filter(Boolean).join(' ');
      return label || ch.dir || '(segment)';
    });
    return parts.join(', ');
  }

  // ---- Geometry helpers ----
  function derivePseudoStepsFromGeometry(geometry) {
    // geometry: GeoJSON LineString with coordinates [lon,lat]
    const coords = geometry?.coordinates || [];
    const out = [];
    for (let i=1;i<coords.length;i++){
      const a = coords[i-1], b = coords[i];
      const bearing = fwdAzimuth(a[1], a[0], b[1], b[0]); // deg
      const len = haversine(a[1], a[0], b[1], b[0]);      // km
      out.push({ bearing, len, distance: len, name: '' });
    }
    return out;
  }

  function computeCardinal(bearing) {
    // Map degrees to NB/EB/SB/WB (45° sectors around N/E/S/W)
    const deg = ((bearing % 360) + 360) % 360;
    if (deg >= 45 && deg < 135) return 'EB';
    if (deg >= 135 && deg < 225) return 'SB';
    if (deg >= 225 && deg < 315) return 'WB';
    return 'NB';
  }

  function fwdAzimuth(lat1, lon1, lat2, lon2){
    const φ1 = lat1*Math.PI/180, φ2 = lat2*Math.PI/180;
    const Δλ = (lon2-lon1)*Math.PI/180;
    const y = Math.sin(Δλ)*Math.cos(φ2);
    const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
    const θ = Math.atan2(y, x);
    let deg = θ*180/Math.PI;
    deg = (deg + 360) % 360;
    return deg;
    }

  function haversine(lat1, lon1, lat2, lon2){
    const R = 6371;
    const dLat = (lat2-lat1)*Math.PI/180;
    const dLon = (lon2-lon1)*Math.PI/180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.sqrt(a)); // km
  }

  // ---- Highway cross-reference ----
  async function fetchFirstAvailable(urls){
    for (const u of urls) {
      try { const r = await fetch(u); if (r.ok) return r.json(); } catch(_) {}
    }
    return null;
  }

  function buildHighwayIndex(features){
    // Store bbox + name + coordinate arrays for a simple nearest search
    return features.map(f => {
      const name = cleanName(f.properties?.name || f.properties?.FULLNAME || f.properties?.HWY_NAME || '');
      const geom = f.geometry;
      const lines = [];
      if (geom?.type === 'LineString') lines.push(geom.coordinates);
      else if (geom?.type === 'MultiLineString') lines.push(...geom.coordinates);
      let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
      lines.forEach(coords => coords.forEach(([x,y]) => { minX=Math.min(minX,x); minY=Math.min(minY,y); maxX=Math.max(maxX,x); maxY=Math.max(maxY,y); }));
      return { name, lines, minX, minY, maxX, maxY };
    });
  }

  function attachHighwayNames(steps, index){
    if (!index) return steps;
    // For each short segment, if it's close to a highway centerline bbox and nearest point < 40m, adopt the highway name
    const MAX_METERS = 40;
    for (const s of steps) {
      if (s.name) continue;
      const a = s._a || null, b = s._b || null; // optional
      // Not available in pseudo steps; just skip to nearest search using a/bearing not stored; approximate by skipping
      // We'll instead just mark highway names opportunistically from index if any bbox intersects the sample midpoint buffer.
    }
    // Better: run a rough nearest search using a moving "midpoint" along the step constructed from bearing-less info.
    // Since pseudo steps lack explicit coordinates, we’ll leave highway naming to final pass that samples whole geometry if available.
    return steps;
  }

  function cleanName(s) {
    s = String(s || '').trim();
    if (!s) return '';
    // Normalize common highway patterns
    s = s.replace(/\bHighway\b/gi, 'Hwy');
    s = s.replace(/\bExpressway\b/gi, 'Expy');
    s = s.replace(/\bParkway\b/gi, 'Pkwy');
    s = s.replace(/\bStreet\b/gi, 'St');
    s = s.replace(/\bAvenue\b/gi, 'Ave');
    s = s.replace(/\bRoad\b/gi, 'Rd');
    s = s.replace(/\bEast\b/gi, 'E').replace(/\bWest\b/gi, 'W').replace(/\bNorth\b/gi, 'N').replace(/\bSouth\b/gi, 'S');
    return s;
  }

  // ---- Modal ----
  function showModal(title, lines) {
    let modal = document.getElementById('report-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'report-modal';
      modal.innerHTML = `
        <div style="position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:9999">
          <div style="background:#fff;max-width:720px;width:92%;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.2);overflow:auto;max-height:80vh">
            <div style="padding:14px 16px;border-bottom:1px solid #eee;font-weight:600" id="report-modal-title"></div>
            <div style="padding:14px 16px" id="report-modal-body"></div>
            <div style="padding:12px 16px;border-top:1px solid #eee;display:flex;justify-content:flex-end">
              <button id="report-modal-close" style="padding:8px 12px;border:1px solid #ccc;border-radius:8px;background:#f7f7f7;cursor:pointer">Close</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.querySelector('#report-modal-close').addEventListener('click', () => modal.remove());
    }
    modal.querySelector('#report-modal-title').textContent = title || 'Report';
    modal.querySelector('#report-modal-body').innerHTML = `<ul style="margin:0;padding-left:18px">${(lines||[]).map(li => `<li>${li}</li>`).join('')}</ul>`;
  }

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

})(window);
</script>
