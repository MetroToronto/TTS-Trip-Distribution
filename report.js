// ===== report.js =====
(function () {
  function openPrintableModal(results) {
    const list = (results || []).filter(r => (r.routes || []).length > 0);
    if (!list.length) { Routing.showToast("No routes to print yet."); return; }

    const rows = [];
    list.forEach(rec => {
      rec.routes.forEach((r, i) => {
        const km = (r.distance / 1000).toFixed(2);
        const min = (r.duration / 60).toFixed(1);
        rows.push(`
          <tr>
            <td>${rec.type.toUpperCase()}</td>
            <td>${rec.name}</td>
            <td style="text-align:right">${i + 1}</td>
            <td>${rec.rankMode}</td>
            <td>${rec.reverse ? "PD/PZ → Origin" : "Origin → PD/PZ"}</td>
            <td style="text-align:right">${km}</td>
            <td style="text-align:right">${min}</td>
          </tr>
        `);
      });
    });

    const html = `
      <div style="font:14px/1.4 system-ui">
        <h2 style="margin:0 0 12px">Trip Summary Report</h2>
        <p style="margin:0 0 16px">One row per alternative route. Distances in km; times in minutes.</p>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr>
              <th style="text-align:left;border-bottom:1px solid #ddd;padding:6px 4px">Type</th>
              <th style="text-align:left;border-bottom:1px solid #ddd;padding:6px 4px">PD/PZ</th>
              <th style="text-align:right;border-bottom:1px solid #ddd;padding:6px 4px">Alt #</th>
              <th style="text-align:left;border-bottom:1px solid #ddd;padding:6px 4px">Ranked By</th>
              <th style="text-align:left;border-bottom:1px solid #ddd;padding:6px 4px">Direction</th>
              <th style="text-align:right;border-bottom:1px solid #ddd;padding:6px 4px">Distance (km)</th>
              <th style="text-align:right;border-bottom:1px solid #ddd;padding:6px 4px">Time (min)</th>
            </tr>
          </thead>
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>
    `;

    const mask = document.createElement("div");
    mask.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:99998;";
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:99999;";
    const panel = document.createElement("div");
    panel.style.cssText = "background:#fff;max-width:900px;width:calc(100% - 48px);max-height:85vh;overflow:auto;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);";
    panel.innerHTML = `
      <div style="padding:16px 20px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;gap:12px;align-items:center">
        <div style="font:600 16px system-ui">Printable Report</div>
        <div style="display:flex;gap:8px">
          <button id="rep-print" style="padding:8px 12px;border-radius:8px;border:1px solid #ccc;background:#fafafa;cursor:pointer">Print</button>
          <button id="rep-close" style="padding:8px 12px;border-radius:8px;border:1px solid #ccc;background:#fafafa;cursor:pointer">Close</button>
        </div>
      </div>
      <div style="padding:16px 20px">${html}</div>
    `;
    function close() { mask.remove(); box.remove(); }
    box.appendChild(panel);
    mask.addEventListener("click", close);
    panel.querySelector("#rep-close").addEventListener("click", close);
    panel.querySelector("#rep-print").addEventListener("click", () => {
      const w = window.open("", "_blank", "width=900,height=700");
      if (!w) { Routing.showToast("Popup blocked. Allow popups to print."); return; }
      w.document.write(`
        <html><head><title>Trip Report</title>
        <style>
          body{font:14px/1.4 system-ui;padding:16px}
          table{width:100%;border-collapse:collapse}
          th,td{padding:6px 4px;border-bottom:1px solid #ddd}
          th{text-align:left}
          td:nth-child(3),td:nth-child(6),td:nth-child(7){text-align:right}
        </style></head>
        <body>${html}</body></html>`);
      w.document.close(); w.focus(); w.print();
    });
    document.body.appendChild(mask);
    document.body.appendChild(box);
  }

  window.Report = { openPrintableModal };
})();
