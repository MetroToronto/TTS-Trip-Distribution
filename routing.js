// routing.js — Full Drop-in Replacement
(function (global) {
  // ===== Tunables ===========================================================
  const SWITCH_CONFIRM_M = 250;
  const REJOIN_WINDOW_M = 800;
  const MIN_FRAGMENT_M = 80;
  const SAMPLE_EVERY_M = 50;
  const SNAP_BATCH_SIZE = 180;
  const BOUND_LOCK_WINDOW_M = 300;
  const PROFILE = 'driving-car';
  const PREFERENCE = 'fastest';
  const ORS_BASE = 'https://api.openrouteservice.org';
  const COLOR_FIRST = '#0b3aa5';
  const COLOR_OTHERS = '#2166f3';

  // ===== State ==============================================================
  const S = { map: null, group: null, keys: [], keyIndex: 0, results: [], els: {} };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ===== Geometry / math helpers ===========================================
  const toRad = (d) => d * Math.PI / 180;
  function haversineMeters(a, b) {
    const R = 6371000;
    const [x1, y1] = a, [x2, y2] = b;
    const dLat = toRad(y2 - y1), dLng = toRad(x2 - x1);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(y1)) * Math.cos(toRad(y2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function bearingDeg(a, b) {
    const [lng1, lat1] = [toRad(a[0]), toRad(a[1])], [lng2, lat2] = [toRad(b[0]), toRad(b[1])];
    const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function cardinal4(deg) {
    if (deg >= 315 || deg < 45) return 'NB';
    if (deg < 135) return 'EB';
    if (deg < 225) return 'SB';
    return 'WB';
  }
  function sampleLine(coords, stepM) {
    if (!coords || coords.length < 2) return coords ?? [];
    const pts = [coords[0]];
    let acc = 0;
    for (let i = 1; i < coords.length; i++) {
      const seg = haversineMeters(coords[i - 1], coords[i]);
      acc += seg;
      if (acc >= stepM) {
        pts.push(coords[i]);
        acc = 0;
      }
    }
    if (pts[pts.length - 1] !== coords[coords.length - 1]) pts.push(coords[coords.length - 1]);
    return pts;
  }

  // ===== Naming helpers =====================================================
  function normalizeName(raw) {
    if (!raw) return '';
    let s = String(raw).trim();
    const canon = (n) => `Highway ${n}`;
    s = s.replace(/\b(?:ON|Ontario)?\s*[-–]?\s*(?:Hwy|HWY|Highway|RTE|Route)?\s*401\b.*/ig, canon(401));
    s = s.replace(/\b(?:ON|Ontario)?\s*[-–]?\s*(?:Hwy|HWY|Highway|RTE|Route)?\s*400\b.*/ig, canon(400));
    s = s.replace(/\b(?:ON|Ontario)?\s*[-–]?\s*(?:Hwy|HWY|Highway|RTE|Route)?\s*404\b.*/ig, canon(404));
    s = s.replace(/\b(?:ON|Ontario)?\s*[-–]?\s*(?:Hwy|HWY|Highway|RTE|Route)?\s*427\b.*/ig, canon(427));
    s = s.replace(/\b(?:ON|Ontario)?\s*[-–]?\s*(?:Hwy|HWY|Highway|RTE|Route)?\s*409\b.*/ig, canon(409));
    s = s.replace(/\b(st)\b\.?/ig, 'Street').replace(/\b(rd)\b\.?/ig, 'Road').replace(/\b(ave)\b\.?/ig, 'Avenue');
    s = s.replace(/\b(?:Onramp|Offramp|Ramp)\b.*/i, '');
    return s.replace(/\s+/g, ' ').trim();
  }
  function pickFromSnapProps(props = {}) {
    const flat = ['name', 'street', 'road', 'way_name', 'label', 'display_name', 'name:en'];
    for (const k of flat) if (props[k]) return normalizeName(props[k]);
    if (props.ref) return normalizeName(`Highway ${props.ref}`);
    const tags = props.tags ?? props.properties ?? {};
    for (const k of flat) if (tags[k]) return normalizeName(tags[k]);
    if (tags.ref) return normalizeName(`Highway ${tags.ref}`);
    return '';
  }
  function isHighwayName(s = '') {
    return /\b(Highway\s?\d{2,3}|Expressway|Express\b|Collector\b|Gardiner|Don Valley Parkway|DVP|QEW)\b/i.test(s);
  }
  function snapRef(props = {}) {
    const p = props ?? {};
    return p.ref ?? p?.tags?.ref ?? p?.properties?.ref ?? '';
  }
  function isHighwayByProps(props = {}) {
    const p = { ...props, ...(props.tags ?? {}), ...(props.properties ?? {}) };
    const vals = [p.highway, p.class, p.road_class, p.category, p.fclass, p.type, p.kind]
      .map((v) => String(v ?? '').toLowerCase()).join('\n');
    if (/motorway|trunk|freeway|express|expressway|motorway_link|trunk_link/.test(vals)) return true;
    const maxs = Number(p.maxspeed ?? p.max_speed ?? 0);
    if (maxs >= 80) return true;
    if (/^\d{2,3}$/.test(String(snapRef(p)))) return true;
    return false;
  }

  // ===== Movement builder ===================================================
  async function buildMovements(coords, seg) {
    const sampled = sampleLine(coords, SAMPLE_EVERY_M);
    if (sampled.length < 2) return [];

    const steps = seg?.steps ?? [];
    const stepNameAt = (i) => {
      if (!steps.length) return '';
      const idx = Math.floor((i / (sampled.length - 1)) * steps.length);
      const st = steps[Math.max(0, Math.min(steps.length - 1, idx))];
      const raw = (st?.name ?? String(st?.instruction ?? '')).replace(/<[^>]*>/g, '').trim();
      return normalizeName(raw);
    };

    let snapFeats = [];
    try {
      for (let i = 0; i < sampled.length; i += SNAP_BATCH_SIZE) {
        const chunk = sampled.slice(i, i + SNAP_BATCH_SIZE);
        const got = await snapRoad(chunk);
        if (got.length < chunk.length) {
          for (let k = got.length; k < chunk.length; k++) got.push({});
        } else if (got.length > chunk.length) {
          got.length = chunk.length;
        }
        snapFeats.push(...got);
      }
    } catch {
      snapFeats = [];
    }

    const snapNameAt = (i) => pickFromSnapProps(snapFeats[i]?.properties ?? {});
    const snapIsHwy = (i) => isHighwayByProps(snapFeats[i]?.properties ?? {});
    const snapRefAt = (i) => snapRef(snapFeats[i]?.properties ?? {});

    const names = [], isHwy = [];
    for (let i = 0; i < sampled.length - 1; i++) {
      const stepNm = stepNameAt(i);
      if (stepNm) {
        names[i] = stepNm;
        isHwy[i] = isHighwayName(stepNm) || snapIsHwy(i);
        continue;
      }
      const nm = snapNameAt(i);
      if (nm) {
        names[i] = nm;
      } else if (snapIsHwy(i)) {
        const r = snapRefAt(i);
        names[i] = r ? `Highway ${r}` : 'Highway';
      } else {
        names[i] = '';
      }
      isHwy[i] = snapIsHwy(i) || isHighwayName(names[i]);
    }

    names[names.length - 1] = names[names.length - 2] ?? '';
    isHwy[isHwy.length - 1] = isHwy[isHwy.length - 2] ?? false;

    const distBetween = (i) => haversineMeters(sampled[i], sampled[i + 1]);
    const firstHwyIdx = isHwy.findIndex(Boolean);
    const lastIdx = (firstHwyIdx > -1 ? firstHwyIdx : sampled.length - 1);

    const rowsIdx = [];
    let curName = names[0] ?? '(unnamed)';
    let startIdx = 0, pendName = null, pendDist = 0, holdPrev = null, distOnNew = 0;

    for (let i = 0; i < lastIdx; i++) {
      const d = distBetween(i);
      const observed = names[i] ?? curName;

      if (holdPrev) {
        distOnNew += d;
        if (observed === holdPrev.name && distOnNew < REJOIN_WINDOW_M) {
          curName = holdPrev.name;
          startIdx = holdPrev.i0;
          holdPrev = null; pendName = null; pendDist = 0;
          continue;
        }
        if (distOnNew >= REJOIN_WINDOW_M) {
          rowsIdx.push({ name: holdPrev.name, i0: holdPrev.i0, i1: i });
          holdPrev = null;
        }
      }

      if (observed === curName || !observed) continue;

      if (pendName === observed) {
        pendDist += d;
        if (pendDist >= SWITCH_CONFIRM_M) {
          rowsIdx.push({ name: curName, i0: startIdx, i1: i });
          holdPrev = { name: curName, i0: startIdx };
          distOnNew = 0;
          curName = pendName;
          startIdx = Math.max(0, i - Math.ceil(pendDist / SAMPLE_EVERY_M));
          pendName = null; pendDist = 0;
        }
      } else {
        pendName = observed; pendDist = d;
      }
    }

    rowsIdx.push({ name: curName, i0: startIdx, i1: lastIdx });
    if (firstHwyIdx > -1) {
      const r = snapRefAt(firstHwyIdx);
      const hwyName = isHighwayName(names[firstHwyIdx]) ? names[firstHwyIdx] : (r ? `Highway ${r}` : 'Highway');
      rowsIdx.push({ name: hwyName, i0: firstHwyIdx, i1: sampled.length - 1, isHighway: true });
    }

    const rows = [];
    for (const r of rowsIdx) {
      let meters = 0;
      for (let i = r.i0; i < r.i1; i++) meters += distBetween(i);
      if (meters < MIN_FRAGMENT_M) continue;

      const dir = cardinal4(bearingDeg(sampled[r.i0], sampled[r.i0 + 1]));
      const nm = normalizeName(r.name);
      if (!nm || nm === '(unnamed)') continue;

      rows.push({ dir, name: nm, km: +(meters / 1000).toFixed(2) });
      if (r.isHighway) break;
    }

    return rows;
  }

  // Export
  global.Routing = global.Routing ?? {};
  global.Routing.buildMovements = buildMovements;
})(window);
