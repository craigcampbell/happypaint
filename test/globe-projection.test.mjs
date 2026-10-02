/* eslint-env node */
// Globe projection correctness: cardinal directions (north renders UP on
// screen), unproject inverse in screen coords, clipRing wraparound merging and
// horizon-arc closure, longitude normalization.
//
//   node --test test/globe-projection.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEG,
  clipRing,
  normalizeLon,
  project,
  unproject,
} from "../src/components/globe/sphere.js";
import geo from "../src/data/world-geo.json" with { type: "json" };

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test("cardinal directions: north is screen-up, south down, east right", () => {
  // project() returns screen-convention unit coords: y DOWN. "Up" = y < 0.
  assert.ok(project(0, 90, 0, 0).y < -0.999, "north pole must be at the top (y < 0)");
  assert.ok(project(0, -90, 0, 0).y > 0.999, "south pole must be at the bottom (y > 0)");
  assert.ok(project(90, 0, 0, 0).x > 0.999, "east must be right (x > 0)");
  assert.ok(project(-90, 0, 0, 0).x < -0.999, "west must be left (x < 0)");
  // a point north of the view center sits above it, south below, with tilt
  for (const [rl, rp] of [[0, 0], [40, 25], [-120, -35], [210, 50]]) {
    const n = project(rl, Math.min(85, rp + 10), rl, rp);
    const s = project(rl, Math.max(-85, rp - 10), rl, rp);
    assert.ok(n.y < 0, `10° north of center must be up at rot ${rl},${rp}`);
    assert.ok(s.y > 0, `10° south of center must be down at rot ${rl},${rp}`);
    assert.ok(close(n.x, 0, 1e-9) && close(s.x, 0, 1e-9), "center meridian stays vertical");
  }
  // facing the antimeridian does not flip orientation
  assert.ok(project(0, 90, 180, 0).y < -0.999, "north still up when centered on 180°");
});

test("project/unproject are exact inverses in screen coords", () => {
  assert.equal(unproject(2, 0, 0, 0), null, "outside the disc is null");
  let tested = 0;
  for (let i = 0; i < 400; i += 1) {
    const rl = Math.random() * 720 - 360; // deliberately unnormalized rotations
    const rp = Math.random() * 124 - 62;
    const nx = Math.random() * 1.8 - 0.9;
    const ny = Math.random() * 1.8 - 0.9;
    const ll = unproject(nx, ny, rl, rp);
    if (!ll) continue;
    tested += 1;
    const p = project(ll[0], ll[1], rl, rp);
    assert.ok(close(p.x, nx, 1e-6) && close(p.y, ny, 1e-6), `roundtrip (${nx},${ny}) at rot ${rl},${rp}`);
  }
  assert.ok(tested > 250, "enough in-disc samples actually round-tripped");
  // a screen point ABOVE center unprojects north of the view center
  const up = unproject(0, -0.4, 10, 15);
  assert.ok(up[1] > 15, "screen-up must unproject to a HIGHER latitude");
  const down = unproject(0, 0.4, 10, 15);
  assert.ok(down[1] < 15, "screen-down must unproject to a LOWER latitude");
});

test("normalizeLon wraps to [-180, 180) and survives many revolutions", () => {
  assert.equal(normalizeLon(45), 45);
  assert.equal(normalizeLon(765), 45); // 2 revolutions + 45
  assert.equal(normalizeLon(-270), 90);
  assert.equal(normalizeLon(-180), -180);
  assert.ok(close(normalizeLon(-3600 - 95), -95), "negative revolutions");
  // shortest-path deltas stay in range no matter how raw lon accumulated
  for (const raw of [-3600 * 3 - 200, 3600 * 5 + 179, -12345.6]) {
    const d = normalizeLon(30 - normalizeLon(raw));
    assert.ok(d >= -180 && d <= 180, `delta in range for raw lon ${raw}`);
  }
  // project is invariant under full-revolution rotation offsets
  const a = project(15, 35, -3600 - 24, 20);
  const b = project(15, 35, -24, 20);
  assert.ok(close(a.x, b.x, 1e-9) && close(a.y, b.y, 1e-9) && close(a.z, b.z, 1e-9));
});

test("clipRing: front ring kept whole, back ring dropped, neither gets an arc", () => {
  const front = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
  const segs = clipRing(front, 0, 0);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].arc, undefined, "a fully visible ring closes on itself, no horizon arc");
  assert.equal(clipRing(front.map(([x]) => [x + 170, 0]), 0, 0).length, 0);
});

test("clipRing merges the wraparound split into ONE segment", () => {
  // First vertex visible, then hidden, then visible again: the visible run
  // wraps the ring's index boundary and must come back as one segment.
  const ring = [[-5, -5], [95, -5], [95, 5], [-5, 5]];
  const segs = clipRing(ring, 0, 0);
  assert.equal(segs.length, 1, `expected 1 merged segment, got ${segs.length}`);
  const s = segs[0];
  assert.ok(s.arc && s.arc.length > 1, "limb cut must close along a horizon arc");
  // arc starts where the segment ends, ends where the segment starts
  const end = s[s.length - 1];
  const start = s[0];
  assert.ok(close(end[0], s.arc[0][0], 1e-9) && close(end[1], s.arc[0][1], 1e-9));
  const arcEnd = s.arc[s.arc.length - 1];
  assert.ok(close(start[0], arcEnd[0], 1e-9) && close(start[1], arcEnd[1], 1e-9));
  // every arc point lies on the limb (unit circle)
  for (const p of s.arc) assert.ok(close(Math.hypot(p[0], p[1]), 1, 1e-6));
});

test("clipRing picks the SHORT horizon arc for a small dip AND a thin sliver", () => {
  const base = [[-5, -5], [95, -5], [95, 5], [-5, 5]];
  // mostly visible, one corner behind: closing the long way would erase land
  const dip = clipRing(base, 0, 0)[0];
  assert.ok(dip.arc.length <= 8, `dip arc should be short, got ${dip.arc.length} pts`);
  // mostly behind, only a thin sliver visible: closing the long way would
  // paint the whole disc
  const sliverRing = base.map(([x, y]) => [normalizeLon(x + 137), y + 11]);
  const sliver = clipRing(sliverRing, 40, 25)[0];
  assert.ok(sliver.arc && sliver.arc.length <= 8, `sliver arc should be short, got ${sliver.arc?.length} pts`);
});

test("clipRing holds up on rotated synthetic rings (no false chords/cutouts)", () => {
  const base = [[-5, -5], [95, -5], [95, 5], [-5, 5]];
  for (let deg = 0; deg < 360; deg += 30) {
    for (const lat of [-40, 0, 30]) {
      const ring = base.map(([x, y]) => [normalizeLon(x + deg), Math.max(-85, Math.min(85, y + lat))]);
      for (const [rl, rp] of [[0, 0], [40, 25], [120, -35], [300, 60]]) {
        const segs = clipRing(ring, rl, rp);
        for (const s of segs) {
          assert.ok(s.length > 1, "no degenerate segments");
          for (const [x, y] of s) assert.ok(Math.hypot(x, y) <= 1 + 1e-6, "segment inside the disc");
          if (!s.arc) continue;
          for (const p of s.arc) assert.ok(close(Math.hypot(p[0], p[1]), 1, 1e-6), "arc on the limb");
          const end = s[s.length - 1];
          const start = s[0];
          assert.ok(close(end[0], s.arc[0][0], 1e-9) && close(end[1], s.arc[0][1], 1e-9), "arc continues the segment");
          const arcEnd = s.arc[s.arc.length - 1];
          assert.ok(close(start[0], arcEnd[0], 1e-9) && close(start[1], arcEnd[1], 1e-9), "arc lands on the segment start");
        }
      }
    }
  }
});

test("clipRing on every real country ring: arcs valid, sweeps sane", () => {
  let arcs = 0;
  for (const c of geo.countries) {
    for (const ring of c.rings) {
      for (let rot = 0; rot < 360; rot += 45) {
        for (const rp of [-40, 0, 40]) {
          for (const s of clipRing(ring, rot, rp)) {
            if (!s.arc) continue;
            arcs += 1;
            for (const p of s.arc) assert.ok(close(Math.hypot(p[0], p[1]), 1, 1e-6), `${c.code} arc off the limb`);
            // ~0.12 rad per step; >55 points = sweeping most of the circle,
            // which for real country shapes means a wrong-side closure
            assert.ok(s.arc.length <= 55, `${c.code} arc sweeps the long way at rot ${rot},${rp}`);
          }
        }
      }
    }
  }
  assert.ok(arcs > 100, "the rotation sweep must actually exercise limb cuts");
});

// ---- ground-truth fill oracle -------------------------------------------------
// Spherical winding (works antipodally, unlike lon/lat ray casting) decides
// containment; the clipped fragment+arc polygons must agree point-for-point
// away from the 110m discretization skin.
const vec = (lon, lat) => [Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.cos(lat * DEG) * Math.sin(lon * DEG), Math.sin(lat * DEG)];
function inRingSphere(ring, lon, lat) {
  const t = vec(lon, lat);
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const vi = vec(ring[i][0], ring[i][1]);
    const vj = vec(ring[j][0], ring[j][1]);
    const a = [vi[0] - t[0], vi[1] - t[1], vi[2] - t[2]];
    const b = [vj[0] - t[0], vj[1] - t[1], vj[2] - t[2]];
    const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    sum += Math.atan2(t[0] * cross[0] + t[1] * cross[1] + t[2] * cross[2], a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
  }
  return Math.abs(sum) > Math.PI;
}
function edgeDist(ring, lon, lat) {
  let best = Infinity;
  const cl = Math.cos(lat * DEG);
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const ax = normalizeLon(ring[j][0] - lon) * cl;
    const ay = ring[j][1] - lat;
    const dx = normalizeLon(ring[i][0] - lon) * cl - ax;
    const dy = ring[i][1] - lat - ay;
    const len2 = dx * dx + dy * dy;
    const tt = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + dx * tt, ay + dy * tt));
  }
  return best;
}
function pip(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

test("clipRing fills match spherical containment (no false cutouts, no disc fills)", () => {
  let real = 0;
  let skin = 0;
  let sampled = 0;
  for (const c of geo.countries) {
    for (const ring of c.rings) {
      for (let rot = 0; rot < 360; rot += 72) {
        for (const rp of [-30, 15, 55]) {
          const segs = clipRing(ring, rot, rp);
          if (!segs.length) continue;
          const polys = segs.map((s) => (s.arc ? [...s, ...s.arc.slice(1, -1)] : s));
          for (let k = 0; k < 40; k += 1) {
            const ang = Math.random() * 2 * Math.PI;
            const r = Math.sqrt(Math.random()) * 0.999;
            const x = Math.cos(ang) * r;
            const y = Math.sin(ang) * r;
            const ll = unproject(x, y, rot, rp);
            const truth = inRingSphere(ring, ll[0], ll[1]);
            const got = polys.some((p) => pip(p, x, y));
            sampled += 1;
            if (got !== truth) {
              // near an edge the 110m segment skin legitimately disagrees
              if (edgeDist(ring, ll[0], ll[1]) > 0.8) real += 1;
              else skin += 1;
            }
          }
        }
      }
    }
  }
  assert.ok(sampled > 50000, "oracle must sample broadly");
  assert.equal(real, 0, `${real} fill decisions wrong far from any edge`);
  assert.ok(skin < sampled * 0.01, `boundary skin should be rare, got ${skin}/${sampled}`);
});

test("clipRing joins fragments split by a limb-grazing vertex", () => {
  // Armenia at rot (144,10): one vertex dips to z ≈ -0.004, splitting the
  // coastal run into an 11-pt and a 3-pt fragment at nearby crossings. Both
  // must close SHORT, before the fix the micro-fragment closed the long way
  // and painted the whole disc.
  const am = geo.countries.find((c) => c.code === "AM");
  const segs = clipRing(am.rings[0], 144, 10);
  assert.ok(segs.length >= 1);
  for (const s of segs) {
    if (!s.arc) continue;
    assert.ok(s.arc.length <= 8, `graze fragment must close short, got ${s.arc.length} arc pts`);
  }
});

test("normalized rotation keeps shortest-path selector math exact", () => {
  // Simulate a long session of spins/drags: rot.lon stays normalized, so the
  // select-country delta is always the short way round.
  let lon = -24;
  for (let i = 0; i < 100000; i += 1) lon = normalizeLon(lon - 3.7);
  const target = geo.countries.find((c) => c.code === "JP").c[0];
  const dLon = normalizeLon(target - lon);
  assert.ok(dLon >= -180 && dLon <= 180);
  const settled = normalizeLon(lon + dLon);
  assert.ok(close(normalizeLon(settled - target), 0, 1e-9), "tween lands exactly on the target");
});
