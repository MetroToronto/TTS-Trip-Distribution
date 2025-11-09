/* report.js — one-button report that lists "NB/EB/SB/WB + road name" comma-separated per destination.
   Uses Routing.getResults(); names highways by cross-referencing /data/highway_centreline.(geo)json; non-highways => "local road". */
(function (global) {
  'use strict';

  const HWY_CANDIDATES = [
    '/data/highway_centreline.geojson',
    '/data/highway_centreline.json'
  ];
  let HWY = null;            // FeatureCollection
  let HWY_INDEX = null;      // [{name, bboxes:[{minX,minY,maxX,maxY}], lines:[[ [lon,lat], ... ]]}]
  const SNAP_METERS = 60;    // max distance to consider a highway near a route sample
  const SAMPLE_EVERY_METERS = 120; // sample along route

  // Retitle + wire the existing routing control button
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('rt-print');
    if (!btn) return;
    btn.textContent = 'Generate Report';
    btn.addEventListener('click', async () => {
      try { await ensureHighwaysLoaded(); } catch(_) {}
      generateReport();
    });
  });

  async function ensureHighwaysLoaded() {
    if (HWY) return;
    for (const url of HWY_CANDIDATES) {
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const j = await r.json();
        if (j && Array.isArray(j.features)) { HWY = j; break; }
      } catch (_) {}
    }
    if (HWY) HWY_INDEX = buildHighwayIndex(HWY.features);
  }

  function generateReport() {
    if (!global.Routing || typeof global.Routing.getResults !== 'function') {
      return alert('Routing not ready. Generate trips first.');
    }
    const results = global.Routing.getResults();
    if (!results.length) return alert('No trips generated.');

    const blocks = results.map(r => {
      const best = r.routes?.[0];
      if (!best || !best.geometry || !Array.isArray(best.geometry.coordinates)) return '';
      const summary = summarizeRoute(best.geometry.coordinates);
      return `<div class="card"><b>${escapeHtml(r.target.label)}</b>: ${summary}</div>`;
    }).filter(Boolean);

    const css = `
      <style>
        body{font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;padding:16px}
        .card{margin:8px 0}
      </style>`;

    const w = window.open('', '_blank');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>Trips Report</title>${css}${blocks.join('')}`);
    w.document.close();
  }

  // ---- Build "NB Hwy 401, EB DVP, EB Gerrard St E, ..." from raw geometry ----
  function summarizeRoute(coordsLonLat) {
    // 1) Sample the polyline at ~SAMPLE_EVERY_METERS; compute bearing for each step
    const samples = resampleForBearings(coordsLonLat, SAMPLE_EVERY_METERS);

    // 2) Name each sample: highway name (if near), else "local road"
    const named = samples.map(s => ({
      dir: bearingToCardinal(s.bearing),
      name: (HWY_INDEX ? nearestHighwayName([s.lon, s.lat], SNAP_METERS) : '') || 'local road'
    }));

    // 3) Collapse consecutive same (dir+name)
    const chunks = [];
    for (const s of named) {
      const last = chunks[chunks.length - 1];
      if (last && last.dir === s.dir && last.name === s.name) continue;
      chunks.push(s);
    }

    // 4) Compose single line
    return chunks.map(c => `${c.dir} ${c.name}`).join(', ');
  }

  // ---- Geometry utilities ----
  function resampleForBearings(coords, stepMeters) {
    const out = [];
    if (!coords || coords.length < 2) return out;
    let acc = 0;
    let prev = coords[0];
    for (let i = 1; i < coords.length; i++) {
      const cur = coords[i];
      const segLen = haversine(prev[1], prev[0], cur[1], cur[0]) * 1000; // m
      acc += segLen;
      if (acc >= stepMeters) {
        const b = azimuth(prev, cur);
        out.push({ lat: (prev[1] + cur[1]) / 2, lon: (prev[0] + cur[0]) / 2, bearing: b });
        acc = 0;
      }
      prev = cur;
    }
    // ensure at least one sample
    if (!out.length) {
      const a = coords[0], b = coords[coords.length - 1];
      out.push({ lat: (a[1] + b[1]) / 2, lon: (a[0] + b[0]) / 2, bearing: azimuth(a, b) });
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

  function bearingToCardinal(deg) {
    const d = ((deg % 360) + 360) % 360;
    if (d >= 45 && d < 135) return 'EB';
    if (d >= 135 && d < 225) return 'SB';
    if (d >= 225 && d < 315) return 'WB';
    return 'NB';
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // ---- Highway cross-reference ----
  function buildHighwayIndex(features) {
    const idx = [];
    for (const f of features) {
      const name = cleanHwyName(f.properties?.name || f.properties?.FULLNAME || f.properties?.HWY_NAME || '');
      const g = f.geometry;
      const lines = [];
      if (g?.type === 'LineString') lines.push(g.coordinates);
      else if (g?.type === 'MultiLineString') lines.push(...g.coordinates);
      if (!lines.length) continue;

      // store per-linestring bbox for quick rejects
      const bboxes = lines.map(ls => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of ls) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
        return { minX, minY, maxX, maxY };
      });
      idx.push({ name, lines, bboxes });
    }
    return idx;
  }

  function nearestHighwayName([lon, lat], tolMeters) {
    if (!HWY_INDEX) return '';
    let best = { name: '', d: Infinity };
    for (const h of HWY_INDEX) {
      for (let i = 0; i < h.lines.length; i++) {
        const bb = h.bboxes[i];
        if (!bb) continue;
        // quick bbox expansion test (~tol)
        const DX = tolMeters / 111320; // deg per meter approx lon
        const DY = tolMeters / 110540; // deg per meter approx lat
        if (lon < bb.minX - DX || lon > bb.maxX + DX || lat < bb.minY - DY || lat > bb.maxY + DY) continue;

        // compute nearest distance to polyline
        const d = pointToPolylineMeters([lon, lat], h.lines[i]);
        if (d < best.d) best = { name: h.name, d };
      }
    }
    return (best.d <= tolMeters) ? best.name : '';
  }

  function pointToPolylineMeters(p, line) {
    let best = Infinity;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      const d = segmentDistanceMeters(p, a, b);
      if (d < best) best = d;
    }
    return best;
  }

  function segmentDistanceMeters(p, a, b) {
    // approximate by densifying segment to small pieces and measuring haversine to nearest point
    const N = 8; // enough for centerlines
    let best = Infinity;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const x = a[0] + t * (b[0] - a[0]);
      const y = a[1] + t * (b[1] - a[1]);
      const d = haversine(p[1], p[0], y, x) * 1000;
      if (d < best) best = d;
    }
    return best;
  }

  function cleanHwyName(s) {
    s = String(s || '').trim();
    if (!s) return '';
    return s
      .replace(/\bHighway\b/gi, 'Hwy')
      .replace(/\bExpressway\b/gi, 'Expy')
      .replace(/\bParkway\b/gi, 'Pkwy')
      .replace(/\s+/g, ' ');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

})(window);
