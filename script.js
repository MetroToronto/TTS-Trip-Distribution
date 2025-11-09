<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Toronto PD/PZ Router — Safe Boot</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <!-- Leaflet -->
  <link rel="stylesheet" href="https://unpkg.com/leaflet/dist/leaflet.css">
  <script src="https://unpkg.com/leaflet/dist/leaflet.js"></script>

  <!-- App styles -->
  <link rel="stylesheet" href="style.css?v=sb1">
  <style>
    /* Minimal layout so we can see everything */
    html, body { height: 100%; margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial, "Noto Sans"; }
    #app { display: grid; grid-template-columns: 320px 1fr; height: 100%; }
    #sidebar { padding: 12px; overflow: auto; border-right: 1px solid #eee; }
    #map { height: 100%; width: 100%; }
    .card { background:#fff; border:1px solid #eee; border-radius:12px; box-shadow:0 6px 20px rgba(0,0,0,.08); padding:12px; margin-bottom:12px; }
    .card h3 { margin:0 0 8px; font-size:15px; }
    .row { display:flex; gap:8px; align-items:center; }
    .list { max-height:220px; overflow:auto; border:1px solid #eee; border-radius:8px; padding:6px; }
    .pd-row, .pz-row { display:flex; gap:8px; align-items:center; margin:4px 0; }
    .pd-route-count, .pz-route-count { width:48px; text-align:right; padding:2px 4px; }
    button { padding:6px 10px; border-radius:8px; border:1px solid #ccc; background:#fafafa; cursor:pointer; }
    input[type="text"] { flex:1; padding:6px 8px; border:1px solid #ccc; border-radius:8px; }
    select { padding:6px 8px; border:1px solid #ccc; border-radius:8px; }
  </style>
</head>
<body>
  <div id="app">
    <div id="sidebar">
      <div class="card">
        <h3>Origin</h3>
        <div class="row">
          <input id="origin-input" type="text" placeholder="Enter address…" />
          <button id="origin-search-btn">Go</button>
        </div>
        <div style="font-size:12px;color:#666;margin-top:6px">Tip: you can drag the red pin after search.</div>
      </div>

      <div class="card">
        <h3>Planning Districts</h3>
        <div id="pd-list" class="list"></div>
      </div>

      <div class="card">
        <h3>Planning Zones</h3>
        <div id="pz-list" class="list"></div>
      </div>

      <div class="card">
        <h3>Trip Generator</h3>
        <div class="row" style="margin-bottom:8px">
          <label style="font-size:13px"><input type="checkbox" id="toggle-reverse"> Reverse (PD/PZ → Origin)</label>
          <select id="rank-mode" style="margin-left:auto">
            <option value="fastest">Fastest</option>
            <option value="shortest">Shortest</option>
          </select>
        </div>
        <div class="row" style="flex-wrap:wrap">
          <button id="btn-generate-pd">Generate Trips (PDs)</button>
          <button id="btn-generate-pz">Generate Trips (PZs)</button>
          <button id="btn-clear-routes">Clear</button>
        </div>
      </div>

      <div class="card">
        <h3>Report</h3>
        <button id="btn-print-report">Print Report</button>
      </div>
    </div>

    <div id="map"></div>
  </div>

  <!-- Load order matters -->
  <script src="script.js?v=sb1"></script>
  <script src="routing.js?v=sb1"></script>
  <script src="report.js?v=sb1"></script>
</body>
</html>
