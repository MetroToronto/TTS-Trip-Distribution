/* report.js — one-button "Generate Report".
   Reads routes from Routing.getResults(), creates a per-destination line:
   "NB Hwy 401, EB Don Valley Pkwy, EB Gerrard St E, …"
   Uses ORS steps if present; otherwise derives headings from geometry and
   cross-references a local highways centerline file for names. */
(function (global) {
  'use strict';

  // Prefer .geojson file if you renamed it; fallback to .json.
  const HWY_SOURCES = [
    '/data/highway_centreline.geojson',
    '/data/highway_centreline.json'
  ];
  let HWY = null;      // FeatureCollection
  let HWY_IDX = null;  // lightweight index

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('rt-print');
    if (!btn) return;
    btn.textContent = 'Generate Report';
    btn.disabled = false;
    btn.addEventListener('click', async () => {
      if (!HWY) { try { HWY = await fetchFirst(HWY_SOURCES); } catch(_) {} }
      if (HWY && Array.isArray(HWY.features) && !HWY_IDX) HWY_IDX = buildHighwayIndex(HWY.features);
      generate();
    });
  });

  function generate() {
    if (!global.Routing || typeof global.Routing.getResults !== 'function') {
      return alert('Routing not ready. Generate trips first.');
    }
    const results = global.Routing.getResults();
    if (!results.length) return alert('No trips generated.');

    const cards = results.map(r => {
      const best = r.routes?.[0];
      if (!best) return '';
      const line = summarize(best);
      const alts = (r.routes || []).slice(1);
      let html = `<div class="card"><b>${escapeHtml(r.target.label)}</b>: ${line}`;
      if (alts.length) {
        const more = alts.map(a => summarize(a)).map(s => `<li>${s}</li>`).join('');
        html += `<div class="alts"><div style="font-weight:600;margin-top:6px">Alternatives</div><ol>${more}</ol></div>`;
      }
      html += `</div>`;
      return html;
    }).filter(Boolean);

    const css = `
      <style>
        body{font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;padding:16px}
        .card{margin:10px 0;padding:10px 12px;border:1px solid #eee;border-radius:10px}
        .alts ol{margin:6px 0 0 20px}
      </style>`;
    const w = window.open('', '_blank');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>Trips Report</title>${css}${cards.join('')}`);
    w.document.close();
  }

  // ---- Build the single comma-separated line for one route ----
  function summarize(route) {
    // 1) Use steps if present (some ORS configs include them). Otherwise derive from geometry.
    let segments = [];
    if (Array.isArray(route.steps) && route.steps.length) {
      segments = route.steps.map(st => ({
        dir: cardinalFromBearing(st.bearing ?? bearingFromInstruction(st.instruction)),
        name: normalizeName(st.name || st.road || '')
      }));
    } else if (route.geometry && Array.isArray(route.geometry.coordinates)) {
      segments = deriveFromGeometry(route.geometry.coordinates);
    }

    // 2) If highway index exists and a segment lacks a name, try nearest highway
    if (HWY_IDX) {
      segments.forEach(seg => {
        if (!seg.name) seg.name = nearestHighwayName(seg.midLonLat || null, HWY_IDX) || '';
      });
    }

    // 3) Default unlabeled segments to "local road" so the string never has blanks
    const labeled = segments.map(s => ({ dir: s.dir, name: s.name || 'local road' }));

    // 4) Merge consecutive identical (dir + name)
    const merged = [];
    for (const s of labeled) {
      const last = merged[merged.length - 1];
      if (last && last.dir === s.dir && last.name === s.name) continue;
      merged.push(s);
    }

    // 5) Compose
    return merged.map(m => `${m.dir} ${m.name}`.trim()).join(', ');
  }

  // ---- Geometry path → segments with headings ----
  function deriveFromGeometry(coordsLonLat) {
    const out = [];
    for (let i = 1; i < coordsLonLat.length; i++) {
      const a = coordsLonLat[i - 1], b = coordsLonLat[i];
      const bearing = azimuth(a, b);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      out.push({ dir: cardinalFromBearing(bearing), name: '', midLonLat: mid });
    }
    return out;
  }

  function azimuth(a, b) {
    const [lon1, lat1] = a, [lon2, lat2] = b;
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180, Δλ = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  }
  function cardinalFromBearing(deg) {
    const d = ((deg % 360) + 360) % 360;
    if (d >= 45 && d < 135) return 'EB';
    if (d >= 135 && d < 225) return 'SB';
    if (d >= 225 && d < 315) return 'WB';
    return 'NB';
  }
  function bearingFromInstruction(txt) {
    // crude fallback if ORS gave an instruction string
    txt = String(txt || '').toLowerCase();
    if (/(east|e\b)/.test(txt)) return  90;
    if (/(south|s\b)/.test(txt)) return 180;
    if (/(west|w\b)/.test(txt)) return 270;
    if (/(north|n\b)/.test(txt)) return   0;
    return NaN;
  }

  // ---- Highway cross-reference ----
  async function fetchFirst(urls){
    for (const u of urls) { try { const r = await fetch(u); if (r.ok) return r.json(); } catch(_) {} }
    return null;
  }
  function buildHighwayIndex(features) {
    return features.map(f => {
      const name = normalizeName(f.properties?.name || f.properties?.FULLNAME || f.properties?.HWY_NAME || '');
      const g = f.geometry;
      const lines = [];
      if (g?.type === 'LineString') lines.push(g.coordinates);
      else if (g?.type === 'MultiLineString') lines.push(...g.coordinates);
      // compute bbox per line for quick reject
      const bboxes = lines.map(ls => {
        let minX= Infinity, minY= Infinity, maxX= -Infinity, maxY= -Infinity;
        for (const [x,y] of ls) { if (x<minX) minX=x; if (y<minY) minY=y; if (x>maxX) maxX=x; if (y>maxY) maxY=y; }
        return { minX, minY, maxX, maxY };
      });
      return { name, lines, bboxes };
    });
  }
  function nearestHighwayName(midLonLat, idx) {
    if (!midLonLat || !idx) return '';
    const [lon, lat] = midLonLat;
    const TOL = 60; // meters
    const dx = TOL / 111320, dy = TOL / 110540; // deg tolerance
    let best = { name: '', d: Infinity };
    for (const h of idx) {
      for (let i=0;i<h.lines.length;i++){
        const bb = h.bboxes[i];
        if (!bb) continue;
        if (lon < bb.minX - dx || lon > bb.maxX + dx || lat < bb.minY - dy || lat > bb.maxY + dy) continue;
        const d = pointToPolylineMeters([lon, lat], h.lines[i]);
        if (d < best.d) best = { name: h.name, d };
      }
    }
    return best.d <= TOL ? best.name : '';
  }
  function pointToPolylineMeters(p, line) {
    let best = Infinity;
    for (let i=1;i<line.length;i++) {
      const a=line[i-1], b=line[i];
      const d = densifiedNearestMeters(p, a, b, 8);
      if (d < best) best = d;
    }
    return best;
  }
  function densifiedNearestMeters(p, a, b, N) {
    let best = Infinity;
    for (let i=0;i<=N;i++){
      const t = i/N;
      const x = a[0] + t*(b[0]-a[0]), y = a[1] + t*(b[1]-a[1]);
      const d = haversine(p[1], p[0], y, x) * 1000;
      if (d < best) best = d;
    }
    return best;
  }
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.sqrt(a));
  }

  // ---- misc ----
  function normalizeName(s) {
    s = String(s || '').trim(); if (!s) return '';
    return s.replace(/\bHighway\b/gi,'Hwy')
            .replace(/\bExpressway\b/gi,'Expy')
            .replace(/\bParkway\b/gi,'Pkwy')
            .replace(/\bStreet\b/gi,'St')
            .replace(/\bAvenue\b/gi,'Ave')
            .replace(/\bRoad\b/gi,'Rd')
            .replace(/\s+/g,' ');
  }
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
})(window);
