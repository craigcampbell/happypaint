// Spherical math + deterministic painterly prep for the Painted Planet globe.
//
// The globe is a true sphere: countries are stored as lon/lat rings
// (src/data/world-geo.json, Natural Earth 110m) and rendered through an
// orthographic projection every frame. This module is pure — no DOM, no
// React — so the verify script can import and test it directly.

import { hashCode, mix, rng } from "../paintUtils.js";

export const DEG = Math.PI / 180;

// Longitude normalized to [-180, 180). Rotation accumulates unbounded degrees
// (spin + drag inertia), and shortest-path math via raw `%` goes wrong on
// negative values — always route lon deltas through this.
export function normalizeLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

// Orthographic projection of lon/lat (degrees) onto the unit sphere seen from
// center (rotLon, rotLat) (degrees). Returns {x, y, z} with z > 0 on the
// visible hemisphere; x right, y DOWN (screen convention: the north pole has
// y = -1, i.e. it renders at the TOP of the canvas at cy + y * R).
export function project(lon, lat, rotLon, rotLat) {
  const l = lon * DEG - rotLon * DEG;
  const p = lat * DEG;
  const p0 = rotLat * DEG;
  const sinP = Math.sin(p);
  const cosP = Math.cos(p);
  const cosL = Math.cos(l);
  return {
    x: cosP * Math.sin(l),
    y: Math.sin(p0) * cosP * cosL - Math.cos(p0) * sinP,
    z: Math.sin(p0) * sinP + Math.cos(p0) * cosP * cosL,
  };
}

// Inverse orthographic: screen offset (nx right, ny DOWN, in units of R) →
// lon/lat degrees, or null when the point is outside the disc.
export function unproject(nx, ny, rotLon, rotLat) {
  const upY = -ny; // the classic inverse formula below wants y-up (north = +)
  const rho = Math.hypot(nx, upY);
  if (rho > 1) return null;
  const c = Math.asin(Math.min(1, rho));
  const p0 = rotLat * DEG;
  const lat = Math.asin(Math.cos(c) * Math.sin(p0) + (rho ? (upY * Math.sin(c) * Math.cos(p0)) / rho : 0)) / DEG;
  const lon = rotLon + Math.atan2(nx * Math.sin(c), rho * Math.cos(c) * Math.cos(p0) - upY * Math.sin(c) * Math.sin(p0)) / DEG;
  return [lon, lat];
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  }
  return a / 2;
}

// Signed lon/lat area of a ring (dateline-normalized on its own centroid).
function ringArea(ring) {
  const c = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  return signedArea(ring.map(([x, y]) => [normalizeLon(x - c), y]));
}

// Unit-circle points closing a limb cut along the HORIZON, not a straight
// chord. The two crossings split the limb into a short and a long arc; the
// correct one keeps the closed path's orientation consistent with the ring
// itself. (Orthographic projection viewed from outside reverses orientation:
// for every fully-visible country ring, sign(screen area) = -sign(lonlat
// area). This is deterministic — a point-sample near the limb overshoots
// razor-thin coastal strips and picks the disc-filling wrong side.)
function horizonArc(a, b, seg, wantSign) {
  const aa = Math.atan2(a[1], a[0]);
  const bb = Math.atan2(b[1], b[0]);
  let sweep = bb - aa;
  while (sweep <= -Math.PI) sweep += Math.PI * 2;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  const build = (dir) => {
    const steps = Math.max(4, Math.ceil(Math.abs(dir) / 0.12));
    const pts = [];
    for (let i = 0; i <= steps; i += 1) {
      const ang = aa + (dir * i) / steps;
      pts.push([Math.cos(ang), Math.sin(ang)]);
    }
    return pts;
  };
  const short = build(sweep);
  const area = signedArea([...seg, ...short.slice(1, -1)]);
  // Degenerate micro-fragments (coast grazing the limb) have near-zero area
  // whose sign is numerical noise — but closing them the long way fills the
  // whole disc. Nearby crossings always mean a cap/dip: the short arc. A
  // genuinely long closure only ever comes from a large fragment, where the
  // orientation sign is reliable.
  if (Math.abs(area) < 1e-3 || Math.sign(area) === wantSign) return short;
  return build(sweep - Math.sign(sweep) * Math.PI * 2);
}

const onLimb = (pt) => Math.abs(Math.hypot(pt[0], pt[1]) - 1) < 1e-9;

// Clip one closed lon/lat ring to the front hemisphere. Returns visible
// polyline fragments ([[x,y],...] in unit-disc screen coords, y down). A
// fragment cut by the limb carries an `arc` array of unit-circle points
// closing it along the horizon — closing with a straight chord carves false
// cutouts into the fill. A ring whose initial vertex is visible splits one
// visible run into a first and last fragment around the wrap; those are
// stitched back together.
export function clipRing(ring, rotLon, rotLat) {
  const n = ring.length;
  const cross = (a, b) => {
    const t = a.z / (a.z - b.z);
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const m = Math.hypot(x, y) || 1;
    return [x / m, y / m];
  };
  const frags = [];
  let cur = null;
  let prev = null;
  for (let i = 0; i <= n; i += 1) {
    const pt = ring[i % n];
    const p = project(pt[0], pt[1], rotLon, rotLat);
    if (prev) {
      const a = prev.z > 0;
      const b = p.z > 0;
      if (a && b) {
        cur.push([p.x, p.y]);
      } else if (a && !b) {
        cur.push(cross(prev, p));
        frags.push(cur);
        cur = null;
      } else if (!a && b) {
        cur = [cross(prev, p), [p.x, p.y]];
      }
    } else if (p.z > 0) {
      cur = [[p.x, p.y]];
    }
    prev = p;
  }
  if (cur && cur.length > 1) frags.push(cur);
  let segs = frags.filter((s) => s.length > 1);
  // Stitch fragments that meet at the SAME limb point. A visible run splits
  // not only at the ring's index wrap but also where a vertex/edge grazes the
  // limb (z ≈ 0): the ring exits and re-enters at the same crossing, and the
  // two pieces must rejoin before the horizon-arc closure — closed apart, a
  // micro-fragment's orientation is meaningless and it fills the whole disc.
  const samePt = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 < 1e-12;
  const joined = [];
  for (const f of segs) {
    const prev = joined[joined.length - 1];
    if (prev && samePt(prev[prev.length - 1], f[0])) {
      joined[joined.length - 1] = [...prev, ...f.slice(1)];
    } else {
      joined.push(f);
    }
  }
  if (joined.length > 1) {
    const first = joined[0];
    const last = joined[joined.length - 1];
    if (samePt(last[last.length - 1], first[0])) {
      joined[0] = [...last, ...first.slice(1)];
      joined.pop();
    }
  }
  segs = joined;
  const wantSign = -Math.sign(ringArea(ring)) || 1; // projection flips orientation
  for (const seg of segs) {
    const a = seg[seg.length - 1];
    const b = seg[0];
    if (onLimb(a) && onLimb(b) && (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 > 1e-12) {
      seg.arc = horizonArc(a, b, seg, wantSign);
    }
  }
  return segs;
}

// Draw one clipped segment into a Path2D, following its horizon arc (if any)
// and closing. Unit-disc screen coords (x right, y down) scaled by R.
export function appendSegToPath2D(path, seg, cx, cy, R) {
  path.moveTo(cx + seg[0][0] * R, cy + seg[0][1] * R);
  for (let i = 1; i < seg.length; i += 1) path.lineTo(cx + seg[i][0] * R, cy + seg[i][1] * R);
  if (seg.arc && seg.arc.length > 1) {
    // screen angle of each arc point; the signed total sweep picks direction
    const scr = (pt) => Math.atan2(pt[1], pt[0]);
    let sweep = 0;
    for (let i = 1; i < seg.arc.length; i += 1) {
      let d = scr(seg.arc[i]) - scr(seg.arc[i - 1]);
      while (d > Math.PI) d -= Math.PI * 2;
      while (d <= -Math.PI) d += Math.PI * 2;
      sweep += d;
    }
    const a0 = scr(seg.arc[0]);
    path.arc(cx, cy, R, a0, a0 + sweep, sweep < 0);
  }
  path.closePath();
  return path;
}

// A ring is closed: segments plus their horizon arcs make one correct fill.
export function ringSegmentsToPath2D(segs, cx, cy, R) {
  const path = new Path2D();
  for (const s of segs) appendSegToPath2D(path, s, cx, cy, R);
  return path;
}

// ---- painterly prep (deterministic, seeded) ----------------------------------

// The shared paint ramp: marigold -> coral -> berry with activity, on a 4-step
// sqrt ramp so the long tail is still visibly "painted".
export const PAINT = ["#f4b71f", "#ee8a3c", "#dc4f63", "#a02f86"];
export const UNPAINTED = "#efe6d3"; // bare paper

export function rampFor(count, top) {
  if (!count || !top) return null;
  const t = Math.sqrt(count / top);
  return { color: PAINT[Math.min(PAINT.length - 1, Math.floor(t * PAINT.length))], t };
}

function jitter(hex, seed, amount = 0.1) {
  const r = rng(seed)();
  return r < 0.5 ? mix(hex, "#ffffff", (0.5 - r) * 2 * amount) : mix(hex, "#5a2a1a", (r - 0.5) * 2 * amount * 0.7);
}

export function paintFor(code, count, top) {
  const r = rampFor(count, top);
  return r ? jitter(r.color, hashCode(code), 0.12) : jitter(UNPAINTED, hashCode(code), 0.05);
}

function tint(fill, r) {
  const k = r();
  if (k < 0.3) return mix(fill, "#ffffff", 0.35 + r() * 0.2);
  if (k < 0.55) return mix(fill, "#4a1f2a", 0.2 + r() * 0.15);
  if (k < 0.8) return mix(fill, "#f7d16a", 0.35);
  return mix(fill, "#b03a86", 0.28);
}

// Dry-brush glazes inside a country, generated in lon/lat space so the brush
// marks rotate WITH the paint, not with the screen. Strokes are quadratic
// segments [sx,sy,mx,my,ex,ey] in degrees, grouped into a few tint buckets so
// a frame needs only a handful of canvas stroke calls per country.
function glazeStrokes(code, rings, fill, t) {
  const r = rng(hashCode(`coat-${code}`));
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const w = Math.max(1.5, x1 - x0);
  const h = Math.max(1.5, y1 - y0);
  const glazes = 1 + Math.round(t * 2);
  const buckets = new Map(); // color -> strokes[]
  for (let g = 0; g < glazes; g += 1) {
    const angle = ((r() - 0.5) * 70 + (g % 2 ? 62 : -14)) * DEG;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const diag = Math.hypot(w, h) + 3;
    const rows = Math.max(3, Math.min(16, Math.round((Math.abs(cosA) * h + Math.abs(sinA) * w) / 1.1)));
    const step = (Math.abs(cosA) * h + Math.abs(sinA) * w + 2.5) / rows;
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    for (let i = 0; i < rows; i += 1) {
      const off = -((rows - 1) / 2) * step + i * step + (r() - 0.5) * step * 0.5;
      const sx = mx - (diag / 2) * cosA - off * sinA + (r() - 0.5) * 1.6;
      const sy = my - (diag / 2) * sinA + off * cosA + (r() - 0.5) * 1.6;
      const len = diag * (0.55 + r() * 0.5);
      const wob = (r() - 0.5) * 0.16;
      const ex = sx + len * Math.cos(angle + wob);
      const ey = sy + len * Math.sin(angle + wob);
      const bend = (r() - 0.5) * Math.min(4, step * 3);
      const color = tint(fill, r);
      if (!buckets.has(color)) buckets.set(color, []);
      buckets.get(color).push([
        sx, sy,
        (sx + ex) / 2 - sinA * bend, (sy + ey) / 2 + cosA * bend,
        ex, ey,
        step * (1.1 + r() * 0.7), // stroke width in degrees
        0.3 + r() * 0.3 + t * 0.1,
      ]);
    }
  }
  return [...buckets.entries()].map(([color, strokes]) => ({ color, strokes }));
}

// Wet drips hanging off the busiest painted countries: 1-2 drips each for the
// top few, anchored at runtime to the country's lowest visible point.
function dripSpec(code, fill, rank) {
  const r = rng(hashCode(`drip-${code}`));
  const n = rank < 4 ? 2 : 1;
  const drips = [];
  for (let i = 0; i < n; i += 1) {
    drips.push({
      // where along the country's low edge the drip hangs (0..1), its width,
      // how far it can run (px at R=300), and a wobble phase
      along: 0.25 + r() * 0.5,
      width: 2.6 + r() * 2.4,
      len: 16 + r() * 34,
      phase: r() * Math.PI * 2,
      color: r() < 0.5 ? fill : mix(fill, "#4a1f2a", 0.25),
    });
  }
  return drips;
}

// Build everything the per-frame renderer needs, once per data payload.
// countries: API rows [{code, count}]; geo: world-geo.json.
export function buildGlobePrep(countries, geo) {
  const byCode = new Map(countries.map((c) => [c.code, c.count || 0]));
  const top = countries.reduce((m, c) => Math.max(m, c.count || 0), 0);
  const painted = countries.filter((c) => (c.count || 0) > 0).sort((a, b) => b.count - a.count);
  const dripRank = new Map(painted.slice(0, 14).map((c, i) => [c.code, i]));

  const items = new Map(); // code -> prep item
  for (const c of geo.countries) {
    const count = byCode.get(c.code) || 0;
    const ramp = rampFor(count, top);
    const fill = paintFor(c.code, count, top);
    const item = {
      code: c.code,
      count,
      t: ramp ? ramp.t : 0,
      fill,
      rings: c.rings,
      center: c.c,
      glazes: ramp ? glazeStrokes(c.code, c.rings, fill, ramp.t) : null,
      drips: dripRank.has(c.code) ? dripSpec(c.code, fill, dripRank.get(c.code)) : null,
    };
    items.set(c.code, item);
  }
  const dots = geo.dots.map((d) => ({
    code: d.code,
    count: byCode.get(d.code) || 0,
    fill: paintFor(d.code, byCode.get(d.code) || 0, top),
    center: d.c,
  }));
  return { byCode, top, items, dots };
}

// Short wave dashes scattered over the oceans (drawn before land, so land
// covers any that stray). Deterministic.
export function waveDashes() {
  const r = rng(90210);
  const out = [];
  const palette = ["#ffffff", "#ffffff", "#bfe8ef", "#eaf9fa"];
  for (let i = 0; i < 42; i += 1) {
    out.push({
      lon: -180 + r() * 360,
      lat: -58 + r() * 128,
      len: 2.2 + r() * 4.5, // degrees
      amp: 0.5 + r() * 1.1,
      color: palette[Math.floor(r() * palette.length)],
      opacity: 0.18 + r() * 0.3,
      drift: (r() - 0.5) * 30 * DEG,
    });
  }
  return out;
}

// Paint flecks flicked onto the paper below the globe, colored like the
// busiest paints. Paper-space (unit square), deterministic.
export function paperSplats(paintedCodes, fillOf) {
  const r = rng(777);
  const out = [];
  const colors = paintedCodes.slice(0, 4).map(fillOf);
  if (!colors.length) colors.push("#ee8a3c");
  for (let i = 0; i < 9; i += 1) {
    out.push({
      x: 0.18 + r() * 0.64,
      y: 0.86 + r() * 0.12,
      rx: 1.2 + Math.pow(r(), 2) * 4.2,
      ry: 0.8 + Math.pow(r(), 2) * 2.4,
      color: colors[Math.floor(r() * colors.length)],
      opacity: 0.28 + r() * 0.3,
    });
  }
  return out;
}
