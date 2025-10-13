// ---------- Geometry helpers ----------
function toRad(d){ return d * Math.PI / 180; }
function toDeg(r){ return r * 180 / Math.PI; }

function haversineMeters(a, b){
  const R = 6371000;
  const [lng1, lat1] = a.map(toRad);
  const [lng2, lat2] = b.map(toRad);
  const dLat = lat2 - lat1, dLng = lng2 - lng1;
  const s = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function bearingDeg(a, b){
  const [lng1, lat1] = a.map(toRad);
  const [lng2, lat2] = b.map(toRad);
  const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
  const x = Math.cos(lat1)*Math.sin(lat2) - Math.sin(lat1)*Math.cos(lat2)*Math.cos(lng2 - lng1);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function cardinal4(deg){
  if (deg >= 315 || deg < 45) return "NB";
  if (deg >= 45 && deg < 135) return "EB";
  if (deg >= 135 && deg < 225) return "SB";
  return "WB";
}

// Sample a LineString every ~X meters (fast geodesic spacing)
function sampleLine(lngLats, stepMeters = 50){
  if (!lngLats || lngLats.length < 2) return lngLats || [];
  const out = [lngLats[0]];
  let acc = 0;
  for (let i = 1; i < lngLats.length; i++){
    const seg = haversineMeters(lngLats[i-1], lngLats[i]);
    acc += seg;
    if (acc >= stepMeters){
      out.push(lngLats[i]);
      acc = 0;
    }
  }
  if (out[out.length-1] !== lngLats[lngLats.length-1]) out.push(lngLats[lngLats.length-1]);
  return out;
}

// ---------- Snap v2 batching ----------
async function snapPointsBatch(pointsLngLat, { key, endpoint = "https://api.openrouteservice.org/v2/snap/road", batchSize = 150 } = {}){
  const headers = { "Content-Type": "application/json", "Authorization": key };
  const chunks = [];
  for (let i = 0; i < pointsLngLat.length; i += batchSize) chunks.push(pointsLngLat.slice(i, i + batchSize));
  const features = [];
  for (const chunk of chunks){
    const body = JSON.stringify({ points: chunk.map(([lng, lat]) => [lng, lat]) });
    const res = await fetch(endpoint, { method: "POST", headers, body });
    if (!res.ok) throw new Error(`Snap error ${res.status}`);
    const json = await res.json();
    if (Array.isArray(json.features)) features.push(...json.features);
  }
  return features; // aligned 1:1 with input points
}

// ---------- Street name picking & normalization ----------
function pickStreetName(props = {}){
  const cands = [
    props.name, props.road, props.street, props.way_name, props.label,
    props.ref_name, props.display_name
  ].filter(Boolean).map(String);

  // Prefer human names over bare refs; normalize abbreviations
  const norm = (s) => s
    .replace(/\b(hwy|highwy)\b/gi, "Highway")
    .replace(/\b(hwy)\s*(\d+)\b/gi, "Highway $2")
    .replace(/\b(st)\b\.?/gi, "Street")
    .replace(/\b(rd)\b\.?/gi, "Road")
    .replace(/\b(ave)\b\.?/gi, "Avenue")
    .replace(/\s+/g, " ")
    .trim();

  const seen = new Set();
  const uniq = [];
  for (const s of cands.map(norm)) if (!seen.has(s)) { seen.add(s); uniq.push(s); }
  if (!uniq.length) {
    // Fallbacks using ref or highway class
    if (props.ref && /^\d+[A-Z]?$/.test(String(props.ref))) return `Highway ${props.ref}`;
    return null;
  }
  // If first is a pure number, assume Highway N
  if (/^\d+$/.test(uniq[0])) return `Highway ${uniq[0]}`;
  return uniq[0];
}

// Optional: prefer Highway ref for motorways/trunks if present
function formatStreetName(name, props = {}){
  if ((props.highway === "motorway" || props.highway === "trunk") && props.ref) {
    // "Highway 401" or "401 Express"/"Collector" if present
    const base = /^Highway\s+/i.test(name) ? name : `Highway ${props.ref}`;
    return base;
  }
  return name;
}

// ---------- Movements builder (main) ----------
/**
 * Build movements like "WB Queen St W, NB Bathurst St" from a route LineString.
 * @param {Array<[lng,lat]>} routeCoords
 * @param {string} orsKey  - ORS key (from your key ring)
 * @param {object} opts    - { sampleMeters, minMeters, headingWindow }
 * @returns {Promise<Array<{bound:string, street:string, distance_m:number}>>}
 */
export async function buildMovementsFromPolyline(routeCoords, orsKey, opts = {}){
  const sampleMeters = opts.sampleMeters ?? 50;
  const minMeters    = opts.minMeters ?? 40;        // drop micro-jitter rows
  const headingWin   = opts.headingWindow ?? 1;     // 1 → use [i, i+1]; 2 → small smoothing

  // 1) Sample
  const sampled = sampleLine(routeCoords, sampleMeters);
  if (sampled.length < 2) return [];

  // 2) Snap all samples (1–2 requests per ~10 km route)
  const snapped = await snapPointsBatch(sampled, { key: orsKey });

  // 3) Pre-compute per-sample name (with small window smoothing)
  const names = sampled.map((_, i) => {
    const propsHere = (snapped[i] && snapped[i].properties) || {};
    let name = pickStreetName(propsHere);
    if (!name && i+1 < snapped.length) {
      const propsNext = (snapped[i+1] && snapped[i+1].properties) || {};
      name = pickStreetName(propsNext);
    }
    return formatStreetName(name || "(unnamed)", (snapped[i] && snapped[i].properties) || {});
  });

  // 4) Walk consecutive sample pairs to compute distances + headings
  const rows = [];
  let cur = null;

  const getHeading = (k) => {
    // Average small window to reduce noise
    const i1 = Math.max(0, k - headingWin);
    const i2 = Math.min(sampled.length - 1, k + 1 + headingWin);
    const start = sampled[i1], end = sampled[i2];
    return cardinal4(bearingDeg(start, end));
  };

  for (let i = 0; i < sampled.length - 1; i++){
    const segDist = haversineMeters(sampled[i], sampled[i+1]);
    if (segDist <= 0) continue;
    const street = names[i];
    const bound  = getHeading(i);

    if (!cur){
      cur = { street, bound, distance_m: 0 };
    }
    if (street === cur.street && bound === cur.bound){
      cur.distance_m += segDist;
    } else {
      // flush previous
      if (cur.distance_m >= minMeters) rows.push({ ...cur, distance_m: Math.round(cur.distance_m) });
      cur = { street, bound, distance_m: segDist };
    }
  }
  if (cur && cur.distance_m >= minMeters) rows.push({ ...cur, distance_m: Math.round(cur.distance_m) });

  // 5) Second pass merge (in case small jitter split same street+bound)
  const merged = [];
  for (const r of rows){
    const last = merged[merged.length - 1];
    if (last && last.street === r.street && last.bound === r.bound){
      last.distance_m += r.distance_m;
    } else {
      merged.push({ ...r });
    }
  }

  // 6) Round distances at the end
  merged.forEach(r => r.distance_m = Math.round(r.distance_m));
  return merged;
}
