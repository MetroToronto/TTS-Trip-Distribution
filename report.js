/* report.js — print-ready outputs fed by routing results */
(function (global) {
  function byId(id){ return document.getElementById(id); }
  function km2(n){ return (n || 0).toFixed(2); }

  function ensureReady(){
    if (!global.Routing || typeof global.Routing.getResults !== 'function') {
      throw new Error('Routing API not available');
    }
  }

  function printReport(){
    ensureReady();
    const results = global.Routing.getResults();
    if (!results.length){ alert('No trips generated yet.'); return; }

    const { buildMovementsFromDirections } = global.Routing.utils;

    const rowsHtml = results.map((r) => {
      const mov = buildMovementsFromDirections(r.route.coords, r.route.steps);
      const lines = mov.map(m =>
        `<tr><td>${m.dir || ''}</td><td>${m.name || ''}</td><td style="text-align:right">${km2(m.km)}</td></tr>`
      ).join('');
      return `
        <div class="card">
          <h2>Destination: ${r.dest.label || (r.dest.lon + ',' + r.dest.lat)}</h2>
          <table>
            <thead><tr><th>Dir</th><th>Street</th><th style="text-align:right">km</th></tr></thead>
            <tbody>${lines}</tbody>
          </table>
        </div>`;
    }).join('');

    const css = `
      <style>
        body{font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;}
        h1{font-size:18px;margin:16px 0;}
        h2{font-size:16px;margin:14px 0 8px;}
        table{width:100%;border-collapse:collapse;margin-bottom:18px;}
        th,td{border:1px solid #ddd;padding:6px 8px;}
        thead th{background:#f7f7f7;}
        .card{page-break-inside:avoid;margin-bottom:22px;}
      </style>
    `;

    const w = window.open('', '_blank');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>Street-by-Street Report</title>${css}<h1>Street-by-Street Report</h1>${rowsHtml}<script>onload=()=>print();</script>`);
    w.document.close();
  }

  function printDebugSteps(){
    ensureReady();
    const results = global.Routing.getResults();
    if (!results.length){ alert('No trips generated yet.'); return; }

    const { stepNameNatural, normalizeName, cleanHtml } = global.Routing.utils;

    const cards = results.map((r) => {
      const steps = r.route.steps || [];
      const rows = steps.map((st, i) => {
        const nameField = normalizeName(st?.name || st?.road || '');
        const chosen   = stepNameNatural(st) || '(generic)';
        const instr    = cleanHtml(st?.instruction || '');
        const distKm   = ((st?.distance || 0) / 1000).toFixed(3);
        return `<tr>
          <td style="text-align:right">${i}</td>
          <td style="text-align:right">${distKm}</td>
          <td>${nameField}</td>
          <td>${chosen}</td>
          <td>${instr}</td>
        </tr>`;
      }).join('');
      return `
        <div class="card">
          <h2>Debug — ${r.dest.label || (r.dest.lon+','+r.dest.lat)}</h2>
          <table>
            <thead><tr>
              <th style="text-align:right">#</th>
              <th style="text-align:right">km</th>
              <th>step.name</th>
              <th>chosen name</th>
              <th>instruction (raw)</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }).join('');

    const css = `
      <style>
        body{font:13px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;}
        h1{font-size:18px;margin:16px 0;}
        h2{font-size:15px;margin:12px 0 8px;}
        table{width:100%;border-collapse:collapse;margin-bottom:18px;}
        th,td{border:1px solid #ddd;padding:4px 6px;vertical-align:top;}
        thead th{background:#f7f7f7;}
        .card{page-break-inside:avoid;margin-bottom:22px;}
        td:nth-child(3), td:nth-child(4) {white-space:nowrap;}
      </style>
    `;

    const w = window.open('', '_blank');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>Report — Raw Steps</title>${css}<h1>Report — Raw Steps</h1>${cards}<script>onload=()=>print();</script>`);
    w.document.close();
  }

  // Wire up buttons (created by routing.js control)
  function wireReportButtons(){
    const btnPrint = byId('rt-print');
    const btnDebug = byId('rt-debug');
    if (btnPrint) btnPrint.addEventListener('click', printReport);
    if (btnDebug) btnDebug.addEventListener('click', printDebugSteps);
  }

  document.addEventListener('DOMContentLoaded', () => {
    // buttons might be injected slightly later by the Routing control
    const poll = () => {
      const ok = byId('rt-print') && byId('rt-debug');
      if (ok) wireReportButtons(); else setTimeout(poll, 80);
    };
    poll();
  });
})(window);
