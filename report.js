(function (global) {
  'use strict';

  // ===== Small helpers =====
  function toRad(d) { return d * Math.PI / 180; }
  function isFiniteNum(n) { return Number.isFinite(n) && !Number.isNaN(n); }

  function haversineMeters(a, b) {
    if (!a || !b || a.length < 2 || b.length < 2) return 0;
    const R = 6371000; // metres
    const lon1 = toRad(a[0]), lat1 = toRad(a[1]);
    const lon2 = toRad(b[0]), lat2 = toRad(b[1]);
    const dLat = lat2 - lat1;
    const dLon = lon2 - lon1;
    const sa = Math.sin(dLat / 2) ** 2 +
               Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(sa), Math.sqrt(1 - sa));
    return R * c;
  }

  function bearingDeg(a, b) {
    if (!a || !b || a.length < 2 || b.length < 2) return 0;
    const lon1 = toRad(a[0]), lat1 = toRad(a[1]);
    const lon2 = toRad(b[0]), lat2 = toRad(b[1]);
    const dLon = lon2 - lon1;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.cos(lat2) -
              Math.sin(lat1) * Math.sin(lat2) * Math.cos(dLon);
    let brng = Math.atan2(y, x) * 180 / Math.PI;
    if (!isFiniteNum(brng)) return 0;
    brng = (brng + 360) % 360;
    return brng;
  }

  function boundFrom(deg) {
    if (deg >= 315 || deg < 45) return 'NB';
    if (deg >= 45 && deg < 135) return 'EB';
    if (deg >= 135 && deg < 225) return 'SB';
    return 'WB';
  }

  function km2(v) {
    return (v || 0).toFixed(2);
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function cleanHtml(s) {
    return String(s || '').replace(/<[^>]*>/g, '').trim();
  }

  function normalizeName(raw) {
    if (!raw) return '';
    const s = String(raw).trim().replace(/\s+/g, ' ');
    if (!s || /^unnamed\b/i.test(s) || /^[-–]+$/.test(s)) return '';
    return s;
  }

  // Try to pull a usable street name out of ORS step fields
  function stepNameNatural(step) {
    if (!step) return '';
    const primary = normalizeName(step.name || step.road);
    if (primary) return primary;

    const instr = cleanHtml(step.instruction || '');
    if (!instr) return '';

    // Try patterns like "Turn left onto Main St" / "Continue via Highway 401"
    let m = instr.match(/\bonto\s+([^,]+?)(?:\s+for\b|,|$)/i);
    if (!m) m = instr.match(/\bvia\s+([^,]+?)(?:\s+for\b|,|$)/i);
    if (!m) m = instr.match(/\bonto\s+(.+)$/i);
    if (!m) m = instr.match(/\bvia\s+(.+)$/i);
    const cand = m ? m[1] : instr;
    return normalizeName(cand);
  }

  function mergeConsecutive(movs) {
    const out = [];
    for (const m of movs) {
      if (!m) continue;
      if (!m.name || !m.km || m.km <= 0) continue;
      if (out.length) {
        const last = out[out.length - 1];
        if (last.name === m.name && last.dir === m.dir) {
          last.km += m.km;
          continue;
        }
      }
      out.push({ dir: m.dir, name: m.name, km: m.km });
    }
    return out;
  }

  // Build NB/EB/SB/WB street rows from ORS coords + steps
  function buildMovementsFromDirections(coords, steps) {
    if (!coords || !coords.length || !steps || !steps.length) return [];

    const MIN_SEG_KM = 0.03; // drop < 30 m to avoid ghosts
    const result = [];

    for (const step of steps) {
      if (!step) continue;
      const wp = step.way_points || step.wayPoints || [];
      const a = wp[0] ?? 0;
      const b = wp[1] ?? (coords.length - 1);
      const startIdx = Math.max(0, Math.min(coords.length - 1, a));
      const endIdx   = Math.max(startIdx, Math.min(coords.length - 1, b));

      let distanceM = Number(step.distance);
      if (!isFiniteNum(distanceM) || distanceM <= 0) {
        distanceM = 0;
        for (let i = startIdx + 1; i <= endIdx; i++) {
          distanceM += haversineMeters(coords[i - 1], coords[i]);
        }
      }
      const km = distanceM / 1000;
      if (!isFiniteNum(km) || km < MIN_SEG_KM) continue;

      // find a bearing along this subsegment
      let bearing = 0;
      let found = false;
      for (let i = endIdx; i > startIdx; i--) {
        const bDeg = bearingDeg(coords[i - 1], coords[i]);
        if (isFiniteNum(bDeg)) {
          bearing = bDeg;
          found = true;
          break;
        }
      }
      if (!found) bearing = bearingDeg(coords[startIdx], coords[endIdx]);
      const dir = boundFrom(bearing);

      const name = stepNameNatural(step) || 'Unnamed segment';

      result.push({ dir, name, km });
    }

    return mergeConsecutive(result);
  }

  function extractStepsFromFeature(feature) {
    if (!feature || !feature.properties) return [];
    const props = feature.properties;
    if (Array.isArray(props.steps) && props.steps.length) return props.steps;
    const segments = Array.isArray(props.segments) ? props.segments : [];
    const out = [];
    for (const seg of segments) {
      if (seg && Array.isArray(seg.steps)) {
        out.push(...seg.steps);
      }
    }
    return out;
  }

  // Build one or more tables for a single trip (PD/PZ, 1–3 routes)
  function buildTablesForTrip(trip) {
    const pieces = [];
    const features = Array.isArray(trip.features) ? trip.features : [];
    if (!features.length) return '';

    features.forEach((feat, idx) => {
      const coords = feat.geometry && Array.isArray(feat.geometry.coordinates)
        ? feat.geometry.coordinates
        : [];
      const steps = extractStepsFromFeature(feat);
      const movs = buildMovementsFromDirections(coords, steps);
      if (!movs.length) return;

      const props = feat.properties || {};
      const summary = props.summary ||
                      (Array.isArray(props.segments) && props.segments[0]) ||
                      {};
      const distKm = Number(summary.distance) / 1000;
      const durMin = Number(summary.duration) / 60;

      const routeLabel =
        features.length === 1
          ? 'Route'
          : (idx === 0 ? 'Route 1 (fastest)' : `Route ${idx + 1}`);

      const linesHtml = movs.map(m =>
        `<tr><td>${escapeHtml(m.dir || '')}</td><td>${escapeHtml(m.name || '')}</td><td style="text-align:right">${km2(m.km)}</td></tr>`
      ).join('');

      const metaPieces = [];
      if (isFiniteNum(distKm)) metaPieces.push(`${km2(distKm)} km`);
      if (isFiniteNum(durMin)) metaPieces.push(`${durMin.toFixed(1)} min`);
      const meta = metaPieces.length ? metaPieces.join(' · ') : '';

      pieces.push(`
        <h3>${escapeHtml(routeLabel)}</h3>
        ${meta ? `<p class="meta">${escapeHtml(meta)}</p>` : ''}
        <table>
          <thead><tr><th>Dir</th><th>Street</th><th style="text-align:right">km</th></tr></thead>
          <tbody>${linesHtml}</tbody>
        </table>
      `);
    });

    return pieces.join('');
  }

  function buildCardsHtml(cache) {
    if (!cache || !Array.isArray(cache.trips) || !cache.trips.length) return '';

    return cache.trips.map((trip) => {
      const isPD = trip.type === 'PD';
      const title = isPD
        ? (trip.name || trip.key || 'Planning District')
        : (trip.label || 'Planning Zone');

      const originLabel = trip.origin && (trip.origin.label || `${trip.origin.lon},${trip.origin.lat}`) || '';
      const destLabel   = trip.destination && (trip.destination.label || `${trip.destination.lon},${trip.destination.lat}`) || '';
      const dirLabel    = trip.reverse ? 'Destination → Origin' : 'Origin → Destination';

      const pathsHtml = buildTablesForTrip(trip);
      if (!pathsHtml) return '';

      const metaLine = originLabel && destLabel
        ? `${originLabel} → ${destLabel} (${dirLabel})`
        : '';

      return `
        <div class="card">
          <h2>${escapeHtml(title)}</h2>
          ${metaLine ? `<p class="meta">${escapeHtml(metaLine)}</p>` : ''}
          ${pathsHtml}
        </div>
      `;
    }).join('');
  }

  function printReport() {
    const cache = global.ROUTING_CACHE;
    if (!cache || !cache.trips || !cache.trips.length) {
      alert('No trips available. Please generate trips first.');
      return;
    }

    const cardsHtml = buildCardsHtml(cache);
    if (!cardsHtml) {
      alert('Unable to build report. Trip data is missing or incomplete.');
      return;
    }

    const css = `
      <style>
        * { box-sizing: border-box; }
        body {
          margin: 0;
          padding: 16px 20px;
          font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }
        h1 {
          font-size: 20px;
          margin: 0 0 16px 0;
        }
        h2 {
          font-size: 16px;
          margin: 14px 0 6px 0;
        }
        h3 {
          font-size: 14px;
          margin: 10px 0 4px 0;
        }
        p.meta {
          margin: 0 0 8px 0;
          font-size: 12px;
          color: #555;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 16px;
        }
        th, td {
          border: 1px solid #ddd;
          padding: 6px 8px;
          font-size: 12px;
        }
        thead th {
          background: #f7f7f7;
        }
        .card {
          page-break-inside: avoid;
          margin-bottom: 22px;
          padding-bottom: 8px;
          border-bottom: 1px solid #eee;
        }
      </style>
    `;

    const w = window.open('', '_blank');
    if (!w) {
      alert('Popup blocked. Please allow popups for this site to print the report.');
      return;
    }

    const title = cache.mode === 'PZ'
      ? 'Zone Trip Street Report'
      : 'PD Trip Street Report';

    w.document.write(
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<title>' + escapeHtml(title) + '</title>' +
      css +
      '</head><body>' +
      '<h1>' + escapeHtml(title) + '</h1>' +
      cardsHtml +
      '<script>window.onload = function(){ window.print(); }<\/script>' +
      '</body></html>'
    );
    w.document.close();
  }

  // ===== Leaflet Report control =====
  const ReportControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
      const div = L.DomUtil.create('div', 'report-control');
      div.innerHTML = `
        <div class="routing-header"><strong>Report</strong></div>
        <div class="routing-row">
          <button type="button" id="rt-print-report">Print Report</button>
        </div>
        <small style="font-size:11px;color:#555;display:block;margin-top:6px;">
          Uses the most recently generated trips from the Trip Generator.
        </small>
      `;
      const btn = div.querySelector('#rt-print-report');
      if (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          printReport();
        });
      }
      L.DomEvent.disableClickPropagation(div);
      return div;
    }
  });

  function initWhenReady() {
    if (global.map && (global.map._loaded || global.map._size)) {
      try {
        global.map.addControl(new ReportControl());
      } catch (e) {
        console.error('Failed to add Report control:', e);
      }
    } else {
      setTimeout(initWhenReady, 80);
    }
  }

  // Expose a simple hook if you ever want to call it manually
  global.Report = {
    print: printReport
  };

  document.addEventListener('DOMContentLoaded', function () {
    initWhenReady();
  });

})(window);
