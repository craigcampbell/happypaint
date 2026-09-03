// Emits scripts/lab/golden-ops.json — the FROZEN op fixture behind the golden
// pixel hash (`node scripts/brush-lab.mjs --golden`). Deterministic from
// FIXTURE_SEED, so `node scripts/lab/make-golden-ops.mjs --check` proves the
// committed JSON is byte-for-byte what this script emits.
//
// The JSON is the contract, not this script. Each group is replayed through
// opReplay.replayFrameOnto (the film-export / spectator consumer) onto a
// transparent 4000x2500 world canvas, and the per-group SHA-256 of the pixels
// (scripts/lab/golden.json) must not move while the engine changes underneath
// — "history is forever". The v3 groups embed dabs via getAuthoringDab at
// GENERATION time on purpose: that is what the studio persists, so re-running
// this script after NATURAL_DABS changes would (correctly) emit a different
// fixture. Don't regenerate casually — the committed file is what old rooms
// actually replay.
//
// Ops mirror the wire exactly (App.jsx startStroke + flushStrokeNet):
//   - settings in startStroke's key order: brush, color, size, opacity,
//     variation, seed, [symmetry], [strength], [v], [dab], [wet];
//   - quarter-px points with 3-dp pressure, wire-level duplicate dedupe, a
//     stationary pressure-only update every 41 points (survives dedupe);
//   - ~7-point batches per op with the settings object on EVERY op (only
//     inline-stamp strokes send settings once), end:true on the last op — for
//     every 4th stroke as an empty end-only op, which a pen-up right after a
//     flush produces.
//
//   node scripts/lab/make-golden-ops.mjs            # (re)write golden-ops.json
//   node scripts/lab/make-golden-ops.mjs --check    # exit 1 if the file differs
import fs from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The engine's relative imports are extensionless (vite resolves them; Node
// doesn't) — register the resolve hook BEFORE importing it.
register("./node-esm-hooks.mjs", import.meta.url);
const { brushCatalog, getAuthoringDab } = await import("../../src/utils/brushes.js");
const { normalizeSymmetry } = await import("../../src/utils/symmetry.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(HERE, "golden-ops.json");

const FIXTURE_SEED = 0x5eed0001;
// The shared world canvas (layers.js CANVAS_WIDTH/HEIGHT). Hard-coded rather
// than imported: the fixture must not silently follow a future canvas resize.
const CANVAS = { width: 4000, height: 2500 };
const BATCH = 7; // points per draw op — the wire's ~40ms batches at pointer rate
const SIZES = [12, 40, 90];
const COLORS = { blue: "#2f6fd6", red: "#e04b2a", yellow: "#f9d423", mixBlue: "#1e88e5" };
// Legacy-path brushes: no `dab` (spray, eraser) plus the pre-Stage-2 history
// of the brushes that later grew one (no `v` → drawBrushSegment forever).
const LEGACY_BRUSHES = ["marker", "pencil", "crayon", "paint", "glow", "spray", "eraser"];

// Same mulberry32 as brushes.js, inlined so the fixture can never drift with
// the engine's copy.
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(FIXTURE_SEED);
// startStroke: Math.floor(Math.random() * 2 ** 31) — same range, fixed dice.
const nextSeed = () => Math.floor(rng() * 2 ** 31);

let strokeCounter = 0;
const nextStrokeId = (label) => `g${(strokeCounter += 1).toString(36).padStart(3, "0")}-${label}`;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const q4 = (v) => Math.round(v * 4) / 4;
// The lab's pressure profile: 0.15 → 1 (at 55%) → 0.3.
const pressureAt = (t) => (t < 0.55 ? 0.15 + 0.85 * (t / 0.55) : 1 - 0.7 * ((t - 0.55) / 0.45));

// ---- Geometry -----------------------------------------------------------------
// Cell grid over the world canvas: cols x rows, `margin` px inset per cell.
const grid = (cols, rows, margin = 40) => {
  const cw = CANVAS.width / cols;
  const ch = CANVAS.height / rows;
  return (index) => ({
    x0: (index % cols) * cw + margin,
    y0: Math.floor(index / cols) * ch + margin,
    w: cw - margin * 2,
    h: ch - margin * 2,
  });
};

// S-curve across a cell (the lab's makeStroke): amplitude `amp` x cell height,
// `flip` mirrors it vertically so a second stroke crosses the first.
const sCurve = (box, { flip = false, count = 110, amp = 0.22, pressure = null } = {}) => {
  const points = [];
  const left = box.x0 + box.w * 0.06;
  const right = box.x0 + box.w * 0.94;
  const midY = box.y0 + box.h / 2;
  const a = box.h * amp;
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    points.push({
      x: left + (right - left) * t,
      y: midY + (flip ? -1 : 1) * a * Math.sin(t * Math.PI * 2),
      pressure: pressure == null ? pressureAt(t) : pressure,
    });
  }
  return points;
};

// Straight horizontal line at `y` across the cell (under-fields).
const flatLine = (box, y, { count = 40, pressure = 0.9 } = {}) => {
  const points = [];
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    points.push({ x: box.x0 + box.w * (0.04 + 0.92 * t), y, pressure });
  }
  return points;
};

// The lab's mixPath: `along` = a gentle 3-lobe wave across the cell; otherwise
// a path that dives onto that wave, rides it for the middle 40%, then leaves —
// so wet pickup has a stretch of under-paint to drag.
const wavePath = (box, along, { count = 130, pressure = 0.75 } = {}) => {
  const points = [];
  const waveY = (t) => box.y0 + box.h * 0.5 + box.h * 0.08 * Math.sin(t * Math.PI * 3);
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    const x = box.x0 + box.w * (0.08 + 0.84 * t);
    let y;
    if (along) {
      y = waveY(t);
    } else if (t < 0.3) {
      const u = t / 0.3;
      y = box.y0 + box.h * 0.86 + (waveY(0.3) - (box.y0 + box.h * 0.86)) * (u * u);
    } else if (t < 0.7) {
      y = waveY(t);
    } else {
      const u = (t - 0.7) / 0.3;
      y = waveY(0.7) + (box.y0 + box.h * 0.12 - waveY(0.7)) * (u * u);
    }
    points.push({ x, y, pressure });
  }
  return points;
};

// Long wave between two world points (overflow strokes).
const longWave = (from, to, { count = 400, amp = 120, lobes = 3 } = {}) => {
  const points = [];
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    const off = amp * Math.sin(t * Math.PI * lobes);
    points.push({ x: from.x + dx * t + nx * off, y: from.y + dy * t + ny * off, pressure: pressureAt(t) });
  }
  return points;
};

// ---- Wire shaping ---------------------------------------------------------------
// What the studio actually puts on the wire (App.jsx drawBrushFromEvent):
// quarter-px coords, dedupe of a point that lands on the previous one with
// |Δpressure| < 0.01, plus a stationary pressure-only update every 41 points
// (Δp = 0.02 survives dedupe) — the renderer must skip those without moving
// its walk state.
const toWire = (raw) => {
  const out = [];
  let prev = null;
  raw.forEach((p, i) => {
    const nx = q4(p.x);
    const ny = q4(p.y);
    const pr = Math.round(clamp(p.pressure, 0, 1) * 1000) / 1000;
    if (!prev || prev.x !== nx || prev.y !== ny || Math.abs(prev.pressure - pr) >= 0.01) {
      prev = { x: nx, y: ny, pressure: pr };
      out.push(prev);
    }
    if (i > 0 && i % 41 === 0) {
      prev = { x: prev.x, y: prev.y, pressure: Math.min(1, Math.round((prev.pressure + 0.02) * 1000) / 1000) };
      out.push(prev);
    }
  });
  return out;
};

// One stroke → its wire ops. Every 4th stroke ends with an empty end-only op.
const strokeOps = (label, settings, rawPoints) => {
  const points = toWire(rawPoints);
  const strokeId = nextStrokeId(label);
  const ops = [];
  for (let i = 0; i < points.length; i += BATCH) {
    ops.push({ kind: "draw", strokeId, points: points.slice(i, i + BATCH), settings });
  }
  if (strokeCounter % 4 === 0) {
    ops.push({ kind: "draw", strokeId, points: [], settings, end: true });
  } else {
    ops[ops.length - 1].end = true;
  }
  return ops;
};

// ---- Settings (startStroke's netSettings, key order preserved) --------------------
const legacySettings = (brush, { color, size, opacity = 1, variation = 0, seeded = true }) => {
  const settings = { brush, color, size, opacity, variation };
  if (seeded) settings.seed = nextSeed();
  return settings;
};

const v2Settings = (brush, { color, size, opacity = 1, symmetry = null }) => {
  const authoring = getAuthoringDab(brush);
  if (!authoring) throw new Error(`${brush} has no dab — not a v2 brush`);
  const settings = { brush, color, size, opacity, variation: 0, seed: nextSeed() };
  if (symmetry && symmetry.copies > 1) settings.symmetry = symmetry;
  settings.v = 2; // persisted v2 history resolves through the static catalog
  return settings;
};

const v3Settings = (brush, { color, size, opacity = 1, wet = false, symmetry = null }) => {
  const authoring = getAuthoringDab(brush);
  if (!authoring || authoring.version !== 3) throw new Error(`${brush} is not a v3 (NATURAL_DABS) brush`);
  const settings = { brush, color, size, opacity, variation: 0, seed: nextSeed() };
  if (symmetry && symmetry.copies > 1) settings.symmetry = symmetry;
  settings.v = 3;
  settings.dab = authoring.dab; // the normalized inline dab, as persisted
  if (wet) settings.wet = true;
  return settings;
};

// The inline dabs the studio embedded for v3 oil / acrylic when this fixture
// was first recorded (Stage 0) — frozen LITERALS, byte-for-byte what those
// ops carry in golden-ops.json, NOT getAuthoringDab: Stage 2 replaced the
// oil / acrylic NATURAL_DABS entries (shape "loaded"), and the Stage-0 groups
// are exactly the persisted history that must keep replaying unchanged. Key
// order matters (the JSON is the contract).
const STAGE0_V3_DABS = {
  oil: { spacing: 0.065, minSize: 0.28, flow: 0.9, shape: "bristle", scatter: 0, rotJitter: 0, grain: 0, bristles: 12, stretch: 2.6, wetEdge: 0.12, impasto: 0.18, loaded: 1, load: 1.18, depletion: 0.018, reload: 0.004, tooth: 0.34, bristleMemory: 0.72, laneWobble: 0.14 },
  acrylic: { spacing: 0.075, minSize: 0.24, flow: 0.96, shape: "bristle", scatter: 0, rotJitter: 0, grain: 0, bristles: 9, stretch: 2, wetEdge: 0.04, impasto: 0.12, loaded: 1, load: 0.95, depletion: 0.03, reload: 0.002, tooth: 0.24, bristleMemory: 0.58, laneWobble: 0.09 },
};
const v3Stage0Settings = (brush, { color, size, opacity = 1, wet = false }) => {
  const dab = STAGE0_V3_DABS[brush];
  if (!dab) throw new Error(`${brush} has no frozen Stage-0 v3 dab`);
  const settings = { brush, color, size, opacity, variation: 0, seed: nextSeed() };
  settings.v = 3;
  settings.dab = dab;
  if (wet) settings.wet = true;
  return settings;
};

const smudgeSettings = ({ size, strength }) => ({
  brush: "smudge",
  color: "#000000",
  size,
  opacity: 1,
  variation: 0,
  seed: nextSeed(),
  strength,
});

// ---- Groups ------------------------------------------------------------------------
// (a) Legacy draw ops (no `v`): the pre-Stage-2 history of every brush that
// went through drawBrushSegment. Unseeded = Math.random (never gates);
// seeded = pointRand (deterministic). Eraser rows first lay a marker field to
// cut through. NOTE the eraser branch never receives pointRand (opReplay /
// applyRemoteOp pass no `rand`), so a seeded eraser with variation > 0 still
// rolls Math.random — the seeded group pins eraser variation at 0.
const legacyGroup = (seeded) => {
  const ops = [];
  const cell = grid(SIZES.length, LEGACY_BRUSHES.length);
  LEGACY_BRUSHES.forEach((brush, row) => {
    SIZES.forEach((size, col) => {
      const box = cell(row * SIZES.length + col);
      if (brush === "eraser") {
        // Deterministic field either way (variation 0 → the one rand() roll
        // is multiplied by zero).
        const field = legacySettings("marker", { color: COLORS.blue, size: 160, variation: 0, seeded });
        ops.push(...strokeOps("field", field, flatLine(box, box.y0 + box.h / 2 - 70)));
        ops.push(...strokeOps("field", field, flatLine(box, box.y0 + box.h / 2 + 70)));
      }
      const variation = brush === "eraser" && seeded ? 0 : 0.3;
      const a = legacySettings(brush, { color: COLORS.blue, size, variation, seeded });
      const b = legacySettings(brush, { color: COLORS.red, size, opacity: 0.7, variation, seeded });
      ops.push(...strokeOps(`${brush}${size}a`, a, sCurve(box)));
      ops.push(...strokeOps(`${brush}${size}b`, b, sCurve(box, { flip: true })));
    });
  });
  return ops;
};

// (b) v2 for every catalog brush with a dab (oil/acrylic included — their
// pre-NATURAL_DABS history is v2 and resolves through brushCatalog).
const v2Group = () => {
  const brushes = brushCatalog.filter((b) => b.dab).map((b) => b.id);
  const ops = [];
  const cell = grid(SIZES.length, brushes.length);
  brushes.forEach((brush, row) => {
    SIZES.forEach((size, col) => {
      const box = cell(row * SIZES.length + col);
      ops.push(...strokeOps(`${brush}${size}a`, v2Settings(brush, { color: COLORS.blue, size }), sCurve(box)));
      ops.push(...strokeOps(`${brush}${size}b`, v2Settings(brush, { color: COLORS.red, size, opacity: 0.7 }), sCurve(box, { flip: true })));
    });
  });
  return ops;
};

// (c) Stage-0 v3 oil / acrylic with the inline dab embedded — dry, then wet
// over a v2 gouache under-layer (so pickup has paint to sample and drag).
const V3_BRUSHES = ["oil", "acrylic"];
const v3DryGroup = () => {
  const ops = [];
  const cell = grid(SIZES.length, V3_BRUSHES.length);
  V3_BRUSHES.forEach((brush, row) => {
    SIZES.forEach((size, col) => {
      const box = cell(row * SIZES.length + col);
      ops.push(...strokeOps(`${brush}${size}a`, v3Stage0Settings(brush, { color: COLORS.blue, size }), sCurve(box)));
      ops.push(...strokeOps(`${brush}${size}b`, v3Stage0Settings(brush, { color: COLORS.red, size, opacity: 0.7 }), sCurve(box, { flip: true })));
    });
  });
  return ops;
};
const v3WetGroup = () => {
  const ops = [];
  const cell = grid(SIZES.length, V3_BRUSHES.length);
  V3_BRUSHES.forEach((brush, row) => {
    SIZES.forEach((size, col) => {
      const box = cell(row * SIZES.length + col);
      const under = v2Settings("gouache", { color: COLORS.yellow, size: Math.max(48, size) });
      ops.push(...strokeOps(`under${size}`, under, wavePath(box, true)));
      ops.push(...strokeOps(`${brush}${size}wet`, v3Stage0Settings(brush, { color: COLORS.mixBlue, size, wet: true }), wavePath(box, false)));
    });
  });
  return ops;
};

// (d) Smudge over a hard red|blue field laid by fill-rect shape ops: the
// lab's back-and-forth passes at size 40 / strength 0.6, one diagonal with
// varying pressure, then a soft size-90 / strength-0.3 pass.
const smudgeGroup = () => {
  const boundary = 2000;
  const ops = [
    { kind: "shape", tool: "rect", start: { x: 600, y: 400 }, end: { x: boundary, y: 2100 }, opts: { color: COLORS.red, size: 8, opacity: 1, fillShape: true } },
    { kind: "shape", tool: "rect", start: { x: boundary, y: 400 }, end: { x: 3400, y: 2100 }, opts: { color: COLORS.mixBlue, size: 8, opacity: 1, fillShape: true } },
  ];
  const pass = (y, from, to, count = 120) => {
    const points = [];
    for (let i = 0; i < count; i += 1) {
      const t = i / (count - 1);
      points.push({ x: from + (to - from) * t, y: y + 6 * Math.sin(t * Math.PI * 4), pressure: 0.7 });
    }
    return points;
  };
  const strong = smudgeSettings({ size: 40, strength: 0.6 });
  ops.push(...strokeOps("smudge1", strong, pass(700, boundary - 260, boundary + 260)));
  ops.push(...strokeOps("smudge2", strong, pass(900, boundary + 260, boundary - 260)));
  ops.push(...strokeOps("smudge3", strong, pass(1100, boundary - 260, boundary + 260)));
  ops.push(...strokeOps("smudge4", strong, pass(1300, boundary + 260, boundary - 260)));
  const diagonal = [];
  for (let i = 0; i < 200; i += 1) {
    const t = i / 199;
    diagonal.push({ x: boundary - 500 + 1000 * t, y: 1950 - 1400 * t, pressure: pressureAt(t) });
  }
  ops.push(...strokeOps("smudge5", strong, diagonal));
  ops.push(...strokeOps("smudge6", smudgeSettings({ size: 90, strength: 0.3 }), pass(1700, boundary - 400, boundary + 400, 200)));
  return ops;
};

// (e) Symmetry: quad (4 copies) marker + watercolor (commit passes per copy).
const symmetryQuadGroup = () => {
  const quad = normalizeSymmetry("quad");
  return [
    ...strokeOps("quadMarker", v2Settings("marker", { color: COLORS.blue, size: 40, symmetry: quad }), sCurve({ x0: 300, y0: 300, w: 1400, h: 700 })),
    ...strokeOps("quadWater", v2Settings("watercolor", { color: COLORS.red, size: 60, symmetry: quad }), sCurve({ x0: 500, y0: 900, w: 900, h: 260 }, { flip: true })),
  ];
};
// Radial 8 pins a consumer quirk: opReplay / applyRemoteOp cap concurrent
// buffers at 4 (MAX_STROKE_BUFFERS / REMOTE_BUFFER_CAP), and all 8 copies of
// one stroke are open at once — copies 5-8 fall to the legacy direct-segment
// path (no dabs, no commit passes) while the local studio buffers every copy.
const symmetryRadialGroup = () => {
  const radial = normalizeSymmetry({ mode: "radial", copies: 8 });
  return strokeOps("radialPaint", v2Settings("paint", { color: COLORS.blue, size: 32, symmetry: radial }), sCurve({ x0: 2200, y0: 400, w: 1000, h: 400 }));
};

// (f) Strokes spanning > 2200 px: the 2048² buffer cap overflows mid-stroke,
// banking a chunk (commit passes + opacity commit) and restarting the buffer
// with the renderer's walk state intact.
const overflowGroup = () => [
  ...strokeOps("overflowWater", v2Settings("watercolor", { color: COLORS.mixBlue, size: 40, opacity: 0.85 }), longWave({ x: 300, y: 400 }, { x: 3700, y: 1900 })),
  ...strokeOps("overflowOil", v3Stage0Settings("oil", { color: COLORS.red, size: 60 }), longWave({ x: 300, y: 2250 }, { x: 3700, y: 2250 }, { amp: 60, lobes: 5 })),
];

// (g) Shape ops (drawShape) and a text op (drawText) — App.jsx shapeOpts /
// textOp field-for-field.
const shapesGroup = () => [
  { kind: "shape", tool: "line", start: { x: 300, y: 300 }, end: { x: 1500, y: 900 }, opts: { color: COLORS.blue, size: 14, opacity: 1, fillShape: false } },
  { kind: "shape", tool: "rect", start: { x: 1700, y: 300 }, end: { x: 2600, y: 900 }, opts: { color: COLORS.red, size: 10, opacity: 0.8, fillShape: false } },
  { kind: "shape", tool: "rect", start: { x: 2800, y: 300 }, end: { x: 3700, y: 900 }, opts: { color: COLORS.yellow, size: 10, opacity: 0.6, fillShape: true } },
  { kind: "shape", tool: "ellipse", start: { x: 300, y: 1200 }, end: { x: 1500, y: 2100 }, opts: { color: COLORS.mixBlue, size: 18, opacity: 1, fillShape: false } },
  { kind: "shape", tool: "ellipse", start: { x: 1700, y: 1200 }, end: { x: 2600, y: 2100 }, opts: { color: COLORS.red, size: 8, opacity: 0.9, fillShape: true } },
  { kind: "shape", tool: "line", start: { x: 2800, y: 2100 }, end: { x: 3700, y: 1200 }, opts: { color: "#111827", size: 1, opacity: 0.5, fillShape: false } },
];
const textGroup = () => [
  { kind: "text", point: { x: 400, y: 900 }, text: "Golden 0\nhistory is forever", opts: { color: "#111827", opacity: 0.9, fontSize: 220 } },
];

// ---- Stage 2 groups (appended AFTER the Stage-0 groups so their seeds and
// stroke ids are untouched) ----------------------------------------------------------
// (h) One v3 stroke pair per Stage-2 shape — the marker's multiply disc and
// every sprite family — with the dab embedded via getAuthoringDab at
// generation time, exactly what the studio persists now.
const V3_STAGE2_BRUSHES = ["marker", "pencil", "crayon", "paint", "gouache", "watercolor", "oil", "acrylic", "glow"];
const v3SpritesGroup = () => {
  const ops = [];
  const cell = grid(SIZES.length, V3_STAGE2_BRUSHES.length);
  V3_STAGE2_BRUSHES.forEach((brush, row) => {
    SIZES.forEach((size, col) => {
      const box = cell(row * SIZES.length + col);
      ops.push(...strokeOps(`${brush}${size}a`, v3Settings(brush, { color: COLORS.blue, size }), sCurve(box)));
      ops.push(...strokeOps(`${brush}${size}b`, v3Settings(brush, { color: COLORS.red, size, opacity: 0.7 }), sCurve(box, { flip: true })));
    });
  });
  return ops;
};

// (i) Marker multiply: blue / yellow crossing (yellow over blue glazes dark
// green), a red one at 0.8 opacity through both, and a WHITE marker — the
// luma guard commits that one source-over (white multiplied would vanish).
const v3MarkerMultiplyGroup = () => {
  const box = { x0: 400, y0: 400, w: 3200, h: 1700 };
  return [
    ...strokeOps("mkBlue", v3Settings("marker", { color: COLORS.mixBlue, size: 70 }), sCurve(box)),
    ...strokeOps("mkYellow", v3Settings("marker", { color: COLORS.yellow, size: 70 }), sCurve(box, { flip: true })),
    ...strokeOps("mkRed", v3Settings("marker", { color: COLORS.red, size: 50, opacity: 0.8 }), flatLine(box, box.y0 + box.h / 2)),
    ...strokeOps("mkWhite", v3Settings("marker", { color: "#ffffff", size: 50 }), flatLine(box, box.y0 + box.h / 2 + 300)),
  ];
};

// (j) Watercolor glaze: dry yellow over blue (the multiply commit is the
// mixing), then wet blue over a v3 gouache under-layer (the legacy pickup
// lerp with the dab's own pickup 0.35).
const v3WaterGlazeGroup = () => {
  const cell = grid(2, 1, 80);
  const dry = cell(0);
  const wet = cell(1);
  return [
    ...strokeOps("glazeBlue", v3Settings("watercolor", { color: COLORS.mixBlue, size: 70 }), wavePath(dry, true)),
    ...strokeOps("glazeYellow", v3Settings("watercolor", { color: COLORS.yellow, size: 70 }), wavePath(dry, false)),
    ...strokeOps("glazeUnder", v3Settings("gouache", { color: COLORS.yellow, size: 70 }), wavePath(wet, true)),
    ...strokeOps("glazeWet", v3Settings("watercolor", { color: COLORS.mixBlue, size: 70, wet: true }), wavePath(wet, false)),
  ];
};

// (k) Symmetry quad copy of a wash stroke: four buffers, each with its own
// bleed / wet-edge / granulation passes and multiply commit.
const v3SymmetryWashGroup = () => {
  const quad = normalizeSymmetry("quad");
  return strokeOps("quadWash", v3Settings("watercolor", { color: COLORS.red, size: 60, symmetry: quad }), sCurve({ x0: 500, y0: 900, w: 900, h: 260 }, { flip: true }));
};

// (l) Overflow-sized wash stroke (> 2048 px span): the buffer cap banks
// mid-stroke chunks — the passes run per chunk and the renderer's walked
// distance (startFlow) survives the restarts.
const v3OverflowWashGroup = () =>
  strokeOps("overflowWash", v3Settings("watercolor", { color: COLORS.mixBlue, size: 60, opacity: 0.9 }), longWave({ x: 300, y: 400 }, { x: 3700, y: 1900 }));

// ---- Assemble ------------------------------------------------------------------------
const groups = [
  {
    name: "legacy-unseeded",
    deterministic: false,
    note: "no `v`, no seed → drawBrushSegment rolls Math.random; hashed for information only, never gates",
    ops: legacyGroup(false),
  },
  { name: "legacy-seeded", deterministic: true, note: "no `v`, seeded → pointRand; eraser variation 0 (its branch never gets a rand)", ops: legacyGroup(true) },
  { name: "v2-catalog", deterministic: true, note: "v:2 for every brush with a catalog dab, sizes 12/40/90, blue @1 + red @0.7 crossing", ops: v2Group() },
  { name: "v3-natural-dry", deterministic: true, note: "v:3 oil/acrylic with the inline dab embedded, dry", ops: v3DryGroup() },
  { name: "v3-natural-wet", deterministic: true, note: "v:3 oil/acrylic wet:true riding a v2 gouache under-layer (mix-map pickup)", ops: v3WetGroup() },
  { name: "smudge-legacy", deterministic: true, note: "brush smudge (no `v`, strength 0.6 / 0.3) over a fill-rect red|blue field", ops: smudgeGroup() },
  { name: "symmetry-quad", deterministic: true, note: "settings.symmetry quad (4 copies): marker + watercolor", ops: symmetryQuadGroup() },
  { name: "symmetry-radial8", deterministic: true, note: "radial 8 copies: pins the 4-buffer cap quirk (copies 5-8 replay on the legacy segment path)", ops: symmetryRadialGroup() },
  { name: "overflow", deterministic: true, note: "strokes spanning > 2200 px so the 2048² buffer cap banks mid-stroke chunks", ops: overflowGroup() },
  { name: "shapes", deterministic: true, note: "drawShape line / rect / ellipse, stroked and filled", ops: shapesGroup() },
  { name: "text", deterministic: true, machineBound: true, note: "drawText with system-ui — stable per machine, differs across OS font stacks", ops: textGroup() },
  // Stage 2 (appended; Stage-0 groups above are untouched).
  { name: "v3-sprites", deterministic: true, note: "Stage 2: v:3 marker/pencil/crayon/paint/gouache/watercolor/oil/acrylic/glow with the inline dab embedded, sizes 12/40/90, blue @1 + red @0.7 crossing", ops: v3SpritesGroup() },
  { name: "v3-marker-multiply", deterministic: true, note: "v:3 marker (blend multiply): blue x yellow crossing, red @0.8 through both, white (luma guard → source-over)", ops: v3MarkerMultiplyGroup() },
  { name: "v3-water-glaze", deterministic: true, note: "v:3 watercolor: dry yellow over blue (multiply glaze) + wet blue over a v3 gouache under-layer (pickup 0.35)", ops: v3WaterGlazeGroup() },
  { name: "v3-symmetry-wash", deterministic: true, note: "settings.symmetry quad (4 copies) of a v:3 watercolor stroke", ops: v3SymmetryWashGroup() },
  { name: "v3-overflow-wash", deterministic: true, note: "v:3 watercolor spanning > 2200 px so the 2048² buffer cap banks mid-stroke chunks", ops: v3OverflowWashGroup() },
];

const fixture = {
  schema: 1,
  generator: "scripts/lab/make-golden-ops.mjs",
  seed: `0x${FIXTURE_SEED.toString(16)}`,
  canvas: CANVAS,
  groups,
};

// Pretty at the top, one op per line: diffable without being 30k lines.
const serialize = (data) => {
  const lines = ["{"];
  lines.push(`  "schema": ${data.schema},`);
  lines.push(`  "generator": ${JSON.stringify(data.generator)},`);
  lines.push(`  "seed": ${JSON.stringify(data.seed)},`);
  lines.push(`  "canvas": ${JSON.stringify(data.canvas)},`);
  lines.push('  "groups": [');
  data.groups.forEach((group, gi) => {
    lines.push("    {");
    lines.push(`      "name": ${JSON.stringify(group.name)},`);
    lines.push(`      "deterministic": ${group.deterministic},`);
    if (group.machineBound) lines.push('      "machineBound": true,');
    lines.push(`      "note": ${JSON.stringify(group.note)},`);
    lines.push('      "ops": [');
    group.ops.forEach((op, oi) => lines.push(`        ${JSON.stringify(op)}${oi < group.ops.length - 1 ? "," : ""}`));
    lines.push("      ]");
    lines.push(`    }${gi < data.groups.length - 1 ? "," : ""}`);
  });
  lines.push("  ]", "}", "");
  return lines.join("\n");
};

const text = serialize(fixture);
const summary = groups.map((g) => `  ${g.name.padEnd(18)} ${String(g.ops.length).padStart(5)} ops${g.deterministic ? "" : "  (nondeterministic)"}`).join("\n");
if (process.argv.includes("--check")) {
  const existing = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, "utf8") : null;
  if (existing === text) {
    console.log(`make-golden-ops: ${path.relative(process.cwd(), OUT_FILE)} matches the generator\n${summary}`);
    process.exit(0);
  }
  console.error(`make-golden-ops: ${path.relative(process.cwd(), OUT_FILE)} ${existing == null ? "is missing" : "DIFFERS from the generator"} — regenerate deliberately (see the header comment)`);
  process.exit(1);
}
fs.writeFileSync(OUT_FILE, text);
console.log(`make-golden-ops: wrote ${path.relative(process.cwd(), OUT_FILE)} (${(text.length / 1024).toFixed(0)} KB)\n${summary}`);
