// Brush sprites (Brush Engine revamp, spec section 3): fixed-seed texture
// atlases for the sprite dab shapes (wash / graphite / wax / softOval / matte /
// loaded / halo) plus the smudge feather mask, the granulation paper tile, the
// per-colour tint cache and the two 256^2 scratch canvases.
//
// Why a sprite atlas at all: the old per-dab shapes are arcs and flecks, which
// is why a watercolor stroke read as "circles in a line". A dab is now ONE
// drawImage of a 128^2 alpha texture (setTransform for rotation/aspect), so a
// blotch can have an irregular rim, tooth and lanes at zero per-dab cost.
//
// Determinism rules (3-way parity: local / remote / replay / spectator must
// render byte-identical pixels, so every client has to build byte-identical
// atlases):
// - every atlas is built from a FIXED seed through mulberry32 lattices, a
//   coordinate hash, bilinear 2D value noise, smoothstep and sqrt ONLY. No
//   Math.pow / exp / sin / cos / atan2, no canvas arcs or gradients: those go
//   through libm / the rasteriser and differ across engines. IEEE-754 + - * /
//   sqrt are correctly rounded everywhere.
// - the pixels land through createImageData + ONE putImageData per atlas.
// - a family's formula is IMMUTABLE once shipped. Persisted ops name the
//   family; a new look is a new family id, never an edit to an existing one.
//
// Memory (iOS canvas ceiling): atlases are one 128-px-tall row per family
// (variants x 128 wide, <= 1024 x 128), the tint ring is 32 x 128^2 (2 MB, the
// cap), the paper tile and the two scratches are 256^2 each. Everything is
// built lazily, and releaseBrushSprites() sets width = 0 on all of it so the
// backing stores go away immediately (rebuilt on next use).
//
// This module must stay import-free from brushes.js (brushes.js imports THIS
// module in Stage 2, so a back-edge would be a cycle) — mulberry32 is copied
// below instead. It is also safe to import in Node: nothing touches the DOM
// until a canvas is actually requested.

const HAS_DOM = typeof document !== "undefined";

// A sprite cell is SPRITE_PX square; the dab's UNIT radius is SPRITE_UNIT px
// of that cell, not half the cell. The 10 px margin is what lets the wash rim
// swell to ~1.17 radii (see the wash formula) without touching the cell edge,
// which would draw as a hard clipped line when the sprite is stamped scaled.
// Stage 2 therefore draws drawImage(slot, -64, -64, 128, 128) with
//   sx = radius * aspect / SPRITE_UNIT,  sy = radius / SPRITE_UNIT
// and a dab's extent is radius * SPRITE_PX / 2 / SPRITE_UNIT (~1.19 radii).
export const SPRITE_PX = 128;
export const SPRITE_UNIT = 54;
const SPRITE_CENTER = (SPRITE_PX - 1) / 2; // pixel centres, so the sprite is symmetric
const CELL = SPRITE_PX * SPRITE_PX;
const PAPER_PX = 256;
const SCRATCH_PX = 256;
const TINT_SLOTS = 32;

// Families in atlas order (the index is part of the tint-cache key, so this
// order is frozen too). `aspect` is the BAKED x:y ratio of the body: the body
// spans SPRITE_UNIT px along x and SPRITE_UNIT / aspect px along y.
export const FAMILIES = Object.freeze([
  Object.freeze({ id: "wash", variants: 8, seed: 0x57a7e12c, aspect: 1 }),
  Object.freeze({ id: "graphite", variants: 6, seed: 0x1d2b8e01, aspect: 1 }),
  Object.freeze({ id: "wax", variants: 8, seed: 0x7f4a7c15, aspect: 1 }),
  Object.freeze({ id: "softOval", variants: 6, seed: 0x2c1e9f33, aspect: 1 }),
  Object.freeze({ id: "matte", variants: 6, seed: 0x66e0b2a7, aspect: 1 }),
  Object.freeze({ id: "loaded", variants: 6, seed: 0x3a9c51d7, aspect: 2 }),
  Object.freeze({ id: "halo", variants: 2, seed: 0x0b5d3c9e, aspect: 1 }),
  Object.freeze({ id: "softMask", variants: 1, seed: 0x5f3759df, aspect: 1 }),
]);

const FAMILY_INDEX = Object.create(null);
FAMILIES.forEach((family, index) => {
  FAMILY_INDEX[family.id] = index;
});

// Family id -> atlas index, or -1 for an unknown id (hostile / future ops
// normalize to a known family before reaching the dab path).
export function spriteFamilyIndex(family) {
  const index = FAMILY_INDEX[family];
  return index === undefined ? -1 : index;
}

// Granulation paper: separate from brushes.js GRAIN_SEED (0x9e3779b9) so the
// two tiles never line up and read as one pattern.
const PAPER_SEED = (0x9e3779b9 ^ 0x5bd1e995) >>> 0;

// ---------------------------------------------------------------------------
// Math primitives. All integer / polynomial / sqrt — see the header.

// Standard mulberry32, copied from brushes.js (no import: cycle avoidance).
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Per-pixel "white" noise as a coordinate HASH rather than a running stream,
// so a formula's white term does not depend on raster order.
function white(x, y, salt) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + salt) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// smoothstep S(a, b, t) = u^2 (3 - 2u), u = clamp((t - a) / (b - a)).
function smooth(a, b, t) {
  if (t <= a) {
    return 0;
  }
  if (t >= b) {
    return 1;
  }
  const u = (t - a) / (b - a);
  return u * u * (3 - 2 * u);
}

// Lattice seed for (family seed, variant, octave k). k = 0 is reserved for
// the variant's parameter roll (phase offsets, lane tables, fleck positions).
function latticeSeed(seed, variant, k) {
  return (seed ^ Math.imul(variant + 1, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca6b)) >>> 0;
}

// Bilinear 2D value noise: a `cells`-wide lattice of mulberry32 values over a
// px x px area, smoothstep-weighted between lattice points, written for every
// pixel into `dst` (row-major, px*px). `ox`/`oy` (lattice units, 0..1) shift
// the lattice phase so variants don't share bump positions. `wrap` makes the
// lattice periodic (the paper tile must tile seamlessly).
//
// Cost model: the y-interpolated lattice row is formed once per pixel row
// (<= 34 values) and each pixel then costs one lerp. The tables are
// module-level scratch (sized for the 256-px paper tile, the largest use):
// ~100 fields are sampled per prebuild and per-call allocation was 15% of it
// in GC.
const NOISE_MAX_PX = 256;
const NOISE_MAX_STRIDE = 34; // 32 wrapped cells (paper) or <= 32 + 2
const lattice = new Float64Array(NOISE_MAX_STRIDE * NOISE_MAX_STRIDE);
const ix0 = new Int32Array(NOISE_MAX_PX);
const ix1 = new Int32Array(NOISE_MAX_PX);
const wx = new Float64Array(NOISE_MAX_PX);
const iy0 = new Int32Array(NOISE_MAX_PX);
const iy1 = new Int32Array(NOISE_MAX_PX);
const wy = new Float64Array(NOISE_MAX_PX);
const row = new Float64Array(NOISE_MAX_STRIDE);

function noiseField(dst, px, cells, seed, ox, oy, wrap) {
  const stride = wrap ? cells : cells + 2;
  const rand = mulberry32(seed);
  for (let i = 0; i < stride * stride; i += 1) {
    lattice[i] = rand();
  }
  // Per-axis tables: lattice index + smoothstep weight per pixel.
  const scale = cells / px;
  for (let p = 0; p < px; p += 1) {
    const u = p * scale + ox;
    const iu = Math.floor(u);
    const fu = u - iu;
    ix0[p] = wrap ? iu % cells : iu;
    ix1[p] = wrap ? (iu + 1) % cells : iu + 1;
    wx[p] = fu * fu * (3 - 2 * fu);
    const v = p * scale + oy;
    const iv = Math.floor(v);
    const fv = v - iv;
    iy0[p] = wrap ? iv % cells : iv;
    iy1[p] = wrap ? (iv + 1) % cells : iv + 1;
    wy[p] = fv * fv * (3 - 2 * fv);
  }
  for (let y = 0; y < px; y += 1) {
    const r0 = iy0[y] * stride;
    const r1 = iy1[y] * stride;
    const w = wy[y];
    for (let i = 0; i < stride; i += 1) {
      row[i] = lattice[r0 + i] + (lattice[r1 + i] - lattice[r0 + i]) * w;
    }
    const base = y * px;
    for (let x = 0; x < px; x += 1) {
      const a = row[ix0[x]];
      dst[base + x] = a + (row[ix1[x]] - a) * wx[x];
    }
  }
}

// ---------------------------------------------------------------------------
// Shared per-pixel geometry for a 128^2 cell: unit-radius rho and the cell
// edge guard. Built once (module lifetime, 256 KB) — build-time only.

let RHO = null; // distance from the cell centre in unit radii
let GUARD = null; // 1 inside, fading to 0 on the outermost pixel ring

function geometry() {
  if (!RHO) {
    RHO = new Float64Array(CELL);
    GUARD = new Float64Array(CELL);
    // Guard: alpha must hit exactly 0 ON the outermost pixel ring (whose
    // centres sit 63.5 px out), otherwise a scaled stamp shows the cell as a
    // faint square. Starts at 61 px; circular, so a clipped fleck stays round.
    const guardStart = 61 / SPRITE_UNIT;
    const guardEnd = SPRITE_CENTER / SPRITE_UNIT;
    for (let y = 0; y < SPRITE_PX; y += 1) {
      const dy = y - SPRITE_CENTER;
      for (let x = 0; x < SPRITE_PX; x += 1) {
        const dx = x - SPRITE_CENTER;
        const rho = Math.sqrt(dx * dx + dy * dy) / SPRITE_UNIT;
        const i = y * SPRITE_PX + x;
        RHO[i] = rho;
        GUARD[i] = 1 - smooth(guardStart, guardEnd, rho);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Build-time scratch. Each family's setup fills noise octaves (fieldA..E) and
// the small per-variant tables below, then ONE shared kernel (runKernel)
// evaluates the family's per-pixel formula into ALPHA and blitVariant writes
// the bytes. One kernel on purpose: V8 tiers a loop up once, so the first
// variant of every family runs optimized instead of interpreted — that alone
// halves the cold prebuild (separate per-family loops cost ~40 ms cold).

const fieldA = new Float64Array(CELL);
const fieldB = new Float64Array(CELL);
const fieldC = new Float64Array(CELL);
const fieldD = new Float64Array(CELL);
const fieldE = new Float64Array(CELL);
const ALPHA = new Float64Array(CELL);
// The family's variant-independent radial profile (disc / edge / feather),
// computed ONCE per family rather than once per pixel per variant.
const PROFILE = new Float64Array(CELL);

const KIND_WASH = 0;
const KIND_GRAPHITE = 1;
const KIND_WAX = 2;
const KIND_SOFT_OVAL = 3;
const KIND_MATTE = 4;
const KIND_LOADED = 5;
const KIND_HALO = 6;
const KIND_HALO_CORE = 7;
const KIND_SOFT_MASK = 8;

// Per-variant kernel inputs (set by the family setup right before runKernel).
let pSalt = 0; // white-noise salt
let pTooth = false; // wash: drybrush variant
let pMean = 0.5; // wash: this variant's mean n3 (keeps every blotch's average radius at 1 unit)
let pHalfY = SPRITE_UNIT; // loaded: baked body half-height in px
const laneRow = new Float64Array(SPRITE_PX); // softOval: lane modulation per pixel row
const LANE_LUT_RES = 4; // loaded: lane field sampled every 1/4 px
const LANE_LUT_N = SPRITE_PX * LANE_LUT_RES + 8;
const laneLut = new Float64Array(LANE_LUT_N); // loaded: L(yy), yy = k / 4 - 63.5
const wobble = new Float64Array(SPRITE_PX); // loaded: per-column lane wobble in px

// PROFILE for the families whose disc / edge term has no variant input.
// `rows` < SPRITE_PX is only used by warmUp().
function fillProfile(kind, rows = SPRITE_PX) {
  for (let y = 0; y < rows; y += 1) {
    const ey = (y - SPRITE_CENTER) / pHalfY;
    for (let x = 0; x < SPRITE_PX; x += 1) {
      const i = y * SPRITE_PX + x;
      const rho = RHO[i];
      let p = 1;
      switch (kind) {
        case KIND_GRAPHITE:
          p = 1 - smooth(0.45, 1, rho);
          break;
        case KIND_WAX:
          p = 1 - smooth(0.94, 1.0, rho);
          break;
        case KIND_SOFT_OVAL:
          p = 1 - smooth(0.7, 1, rho);
          break;
        case KIND_LOADED: {
          const ex = (x - SPRITE_CENTER) / SPRITE_UNIT;
          p = 1 - smooth(0.9, 1.0, Math.sqrt(ex * ex + ey * ey));
          break;
        }
        default:
          p = 1;
      }
      PROFILE[i] = p;
    }
  }
}

function runKernel(kind, rows = SPRITE_PX) {
  for (let y = 0; y < rows; y += 1) {
    const dy = y - SPRITE_CENTER;
    const lane = laneRow[y];
    for (let x = 0; x < SPRITE_PX; x += 1) {
      const i = y * SPRITE_PX + x;
      const rho = RHO[i];
      let a = 0;
      switch (kind) {
        case KIND_WASH: {
          const r = rho / (1 + 0.28 * (fieldA[i] - pMean) + 0.1 * (fieldB[i] - 0.5));
          const ring = 0.45 + 0.55 * smooth(0.45, 0.74, r);
          const mask = 0.3 + 0.7 * smooth(0.25, 0.7, fieldD[i]);
          a = (0.45 + (ring - 0.45) * mask) * (1 - smooth(0.86, 1.0, r)) * (1 + 0.22 * (fieldC[i] - 0.5));
          if (pTooth) {
            const t = 0.45 + 0.55 * smooth(0.35, 0.75, fieldE[i]);
            a *= t + (1 - t) * smooth(0.6, 0.85, r);
          }
          break;
        }
        case KIND_GRAPHITE: {
          const tooth = smooth(0.3, 0.8, 0.55 * fieldA[i] + 0.45 * fieldB[i] + 0.3 * white(x, y, pSalt));
          a = PROFILE[i] * (0.4 + 0.6 * tooth);
          break;
        }
        case KIND_WAX: {
          const tex = 0.5 * fieldA[i] + 0.35 * fieldB[i] + 0.15 * white(x, y, pSalt);
          a = 0.9 * (0.3 + 0.7 * smooth(0.4, 0.6, tex)) * PROFILE[i];
          break;
        }
        case KIND_SOFT_OVAL:
          a = PROFILE[i] * (1 + 0.08 * lane * (0.6 + 0.4 * fieldA[i]));
          break;
        case KIND_MATTE: {
          const r = rho / (1 + 0.05 * (2 * fieldA[i] - 1));
          a = (0.97 + 0.03 * (2 * fieldB[i] - 1)) * (1 - smooth(0.92, 1.0, r));
          break;
        }
        case KIND_LOADED: {
          let k = ((dy - wobble[x] + SPRITE_CENTER) * LANE_LUT_RES + 0.5) | 0;
          k = k < 0 ? 0 : k >= LANE_LUT_N ? LANE_LUT_N - 1 : k;
          a = PROFILE[i] * (0.6 + 0.4 * laneLut[k]) * (0.94 + 0.06 * fieldA[i]);
          break;
        }
        case KIND_HALO: {
          const t = 1 - rho;
          a = t > 0 ? t * t : 0;
          break;
        }
        case KIND_HALO_CORE:
          a = 1 - smooth(0.6, 1, rho);
          break;
        default:
          a = 1 - smooth(0.55, 1.0, rho); // KIND_SOFT_MASK
      }
      ALPHA[i] = a;
    }
  }
}

// One-time JIT warm-up before the first build: every kernel / profile case
// runs on two rows so the optimizer sees all switch arms at once. Without
// this each family's first variant deoptimizes the kernel on its unseen arm
// and re-tiers (~3 ms per family — most of the difference between a 43 ms
// cold and a 17 ms warm build). Pure scratch: everything it writes is
// overwritten by the real build. Pixel output is unaffected.
let warmed = false;
function warmUp() {
  if (warmed) {
    return;
  }
  warmed = true;
  for (let kind = KIND_WASH; kind <= KIND_SOFT_MASK; kind += 1) {
    pTooth = kind === KIND_WASH;
    fillProfile(kind, 2);
    runKernel(kind, 2);
  }
  pTooth = false;
  noiseField(fieldA, SPRITE_PX, 3, 1, 0.5, 0.5, false);
  noiseField(fieldA, SPRITE_PX, 16, 1, 0, 0, true);
}

// Screen a soft round fleck into ALPHA: a' = a + f (1 - a) with
// f = alpha (1 - S(0.4, 1, dist / radius)). Only the fleck's bounding box is
// touched — outside it f is exactly 0, so the result equals a full-cell pass.
function screenFleck(fx, fy, radius, alpha) {
  const x0 = Math.max(0, Math.floor(fx - radius));
  const x1 = Math.min(SPRITE_PX - 1, Math.ceil(fx + radius));
  const y0 = Math.max(0, Math.floor(fy - radius));
  const y1 = Math.min(SPRITE_PX - 1, Math.ceil(fy + radius));
  for (let y = y0; y <= y1; y += 1) {
    const dy = y - fy;
    for (let x = x0; x <= x1; x += 1) {
      const dx = x - fx;
      const f = alpha * (1 - smooth(0.4, 1, Math.sqrt(dx * dx + dy * dy) / radius));
      const i = y * SPRITE_PX + x;
      ALPHA[i] += f * (1 - ALPHA[i]);
    }
  }
}

// Write ALPHA (guarded) as white RGBA into the atlas row at `variant`.
function blitVariant(data, rowWidth, variant) {
  const x0 = variant * SPRITE_PX;
  for (let y = 0; y < SPRITE_PX; y += 1) {
    let o = (y * rowWidth + x0) * 4;
    const base = y * SPRITE_PX;
    for (let x = 0; x < SPRITE_PX; x += 1) {
      const i = base + x;
      let a = ALPHA[i] * GUARD[i];
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = (a * 255 + 0.5) | 0;
      o += 4;
    }
  }
}

// ---------------------------------------------------------------------------
// Family formulas. IMMUTABLE once shipped — see the header. Notation: rho =
// distance / SPRITE_UNIT; n_k = value noise with k lattice cells across the
// cell (each octave has its own lattice, phase-shifted per variant); S =
// smoothstep; x/y are the pixel's offset from the cell centre in px (x = the
// stroke tangent after Stage 2's rotation); white = hash(x, y, salt). The
// per-pixel code lives in runKernel above; the setup below rolls the
// variant's parameters and octaves in the documented order.

// wash (seed 0x57a7e12c, 8 variants): an irregular watercolor blotch — a
// pale core, a pigment ring that is present only in ARCS around the rim (a
// continuous ring made every dab read as a circle inside a stroke), a long
// feather, and a two-octave wobbling outline.
//   phase (ox, oy) = roll k0 (2 rolls); m3 = mean of n3 over the cell
//   r     = rho / (1 + 0.28 * (n3 - m3) + 0.10 * (n7 - 0.5))  outline: ~0.81..1.19 radii,
//                                                             average radius exactly 1 unit
//   ring  = 0.45 + 0.55 * S(0.45, 0.74, r)                  core 0.45 rising to a broad ring of 1
//   mask  = 0.3 + 0.7 * S(0.25, 0.7, n6)                     where the ring shows
//   a     = (0.45 + (ring - 0.45) * mask) * (1 - S(0.86, 1.0, r))   14% feather
//         * (1 + 0.22 * (n9 - 0.5))                           interior mottle
//   variants 4-7 (drybrush): t = 0.45 + 0.55 * S(0.35, 0.75, n4);
//         a *= t + (1 - t) * S(0.6, 0.85, r)                   tooth in the body, rim keeps pooling
// Octaves: n3 = 1, n7 = 2, n9 = 3, n6 = 4, n4 = 5.
function buildWash(data, rowWidth, family) {
  for (let v = 0; v < family.variants; v += 1) {
    const roll = mulberry32(latticeSeed(family.seed, v, 0));
    const ox = roll();
    const oy = roll();
    noiseField(fieldA, SPRITE_PX, 3, latticeSeed(family.seed, v, 1), ox, oy, false);
    noiseField(fieldB, SPRITE_PX, 7, latticeSeed(family.seed, v, 2), oy, ox, false);
    noiseField(fieldC, SPRITE_PX, 9, latticeSeed(family.seed, v, 3), ox, oy, false);
    noiseField(fieldD, SPRITE_PX, 6, latticeSeed(family.seed, v, 4), oy, ox, false);
    let sum = 0;
    for (let i = 0; i < CELL; i += 1) {
      sum += fieldA[i];
    }
    pMean = sum / CELL;
    pTooth = v >= 4;
    if (pTooth) {
      noiseField(fieldE, SPRITE_PX, 4, latticeSeed(family.seed, v, 5), ox, oy, false);
    }
    runKernel(KIND_WASH);
    blitVariant(data, rowWidth, v);
  }
}

// graphite (seed 0x1d2b8e01, 6 variants): pencil tooth — a soft disc whose
// coverage is broken by paper grain at two scales plus per-pixel speckle.
//   phase = roll k0 (2 rolls); salt = latticeSeed(seed, v, 3)
//   tooth = S(0.3, 0.8, 0.55 * n3 + 0.45 * n12 + 0.3 * white)
//   a     = (1 - S(0.45, 1, rho)) * (0.4 + 0.6 * tooth)
// The spec's n3 alone reads as three soft blobs; the n12 octave is what makes
// it read as paper tooth at stamp scale, and the 0.4 floor (spec 0.55) keeps
// the stroke's edges grainy after the flow accumulates.
function buildGraphite(data, rowWidth, family) {
  fillProfile(KIND_GRAPHITE);
  for (let v = 0; v < family.variants; v += 1) {
    const roll = mulberry32(latticeSeed(family.seed, v, 0));
    const ox = roll();
    const oy = roll();
    noiseField(fieldA, SPRITE_PX, 3, latticeSeed(family.seed, v, 1), ox, oy, false);
    noiseField(fieldB, SPRITE_PX, 12, latticeSeed(family.seed, v, 2), oy, ox, false);
    pSalt = latticeSeed(family.seed, v, 3) | 0;
    runKernel(KIND_GRAPHITE);
    blitVariant(data, rowWidth, v);
  }
}

// wax (seed 0x7f4a7c15, 8 variants): crayon — a hard-rimmed disc whose
// coverage breaks into crisp waxy islands with paper specks, plus two crumbs
// baked outside the rim.
//   phase = roll k0 (2 rolls), then per fleck: (u, v) rolls until
//           0.84 <= sqrt(u^2 + v^2) <= 1.02 (u, v in -1.05..1.05, <= 64 tries,
//           fallback (0.95, 0)), then radius roll (5..9 px), alpha roll (0.5..0.8);
//           salt = latticeSeed(seed, v, 3)
//   tex   = 0.5 * n6 + 0.35 * n14 + 0.15 * white
//   edge  = 1 - S(0.94, 1.0, rho)                     6% rim
//   body  = 0.9 * (0.3 + 0.7 * S(0.4, 0.6, tex)) * edge
//   fleck = alphaF * (1 - S(0.4, 1, dist / radiusF))
//   a     = body screened with fleck 0, then fleck 1  (a' = a + f (1 - a))
function buildWax(data, rowWidth, family) {
  fillProfile(KIND_WAX);
  for (let v = 0; v < family.variants; v += 1) {
    const roll = mulberry32(latticeSeed(family.seed, v, 0));
    const ox = roll();
    const oy = roll();
    const flecks = [];
    for (let f = 0; f < 2; f += 1) {
      let fx = 0.95;
      let fy = 0;
      for (let attempt = 0; attempt < 64; attempt += 1) {
        const u = (roll() * 2 - 1) * 1.05;
        const w = (roll() * 2 - 1) * 1.05;
        const d = Math.sqrt(u * u + w * w);
        if (d >= 0.84 && d <= 1.02) {
          fx = u;
          fy = w;
          break;
        }
      }
      flecks.push({
        x: SPRITE_CENTER + fx * SPRITE_UNIT,
        y: SPRITE_CENTER + fy * SPRITE_UNIT,
        radius: 5 + roll() * 4,
        alpha: 0.5 + roll() * 0.3,
      });
    }
    noiseField(fieldA, SPRITE_PX, 6, latticeSeed(family.seed, v, 1), ox, oy, false);
    noiseField(fieldB, SPRITE_PX, 14, latticeSeed(family.seed, v, 2), oy, ox, false);
    pSalt = latticeSeed(family.seed, v, 3) | 0;
    runKernel(KIND_WAX);
    for (let f = 0; f < 2; f += 1) {
      screenFleck(flecks[f].x, flecks[f].y, flecks[f].radius, flecks[f].alpha);
    }
    blitVariant(data, rowWidth, v);
  }
}

// Lane table shared by softOval and loaded: `count` horizontal lanes (along
// x) at jittered-stratified y positions across +-spread px, each with a
// half-width, a level and a sign. Rolled in order: for each lane, y -> width
// -> level -> sign.
function rollLanes(roll, count, spread, widthMin, widthMax) {
  const lanes = [];
  for (let i = 0; i < count; i += 1) {
    const slot = (i + 0.1 + roll() * 0.8) / count; // stratified: no two lanes pile up
    lanes.push({
      y: -spread + slot * spread * 2,
      width: widthMin + roll() * (widthMax - widthMin),
      level: 0.3 + roll() * 0.7,
      sign: roll() < 0.5 ? -1 : 1,
    });
  }
  return lanes;
}

// Sum of lane bumps at row offset `dy` (px from the centre), each bump
// = 1 - S(0, 1, |dy - lane.y| / lane.width), weighted by sign (softOval) or
// level (loaded).
function laneField(lanes, dy, signed) {
  let sum = 0;
  for (let i = 0; i < lanes.length; i += 1) {
    const lane = lanes[i];
    const d = dy - lane.y;
    const bump = 1 - smooth(0, 1, (d < 0 ? -d : d) / lane.width);
    sum += signed ? lane.sign * bump : lane.level * bump;
  }
  return sum;
}

// softOval (seed 0x2c1e9f33, 6 variants): soft loaded paint with faint
// bristle lanes.
//   phase = roll k0 (2 rolls); laneCount = 3 + floor(roll * 3); lanes =
//           rollLanes(count, spread 40 px, width 3..7 px)
//   lanes(y) = clamp(sum_i sign_i * bump_i(y), -1, 1)
//   a  = (1 - S(0.7, 1, rho)) * (1 + 0.08 * lanes(y) * (0.6 + 0.4 * n5))
// n5 fades the lanes in and out along the stroke (bristles lifting).
function buildSoftOval(data, rowWidth, family) {
  fillProfile(KIND_SOFT_OVAL);
  for (let v = 0; v < family.variants; v += 1) {
    const roll = mulberry32(latticeSeed(family.seed, v, 0));
    const ox = roll();
    const oy = roll();
    const lanes = rollLanes(roll, 3 + Math.floor(roll() * 3), 40, 3, 7);
    noiseField(fieldA, SPRITE_PX, 5, latticeSeed(family.seed, v, 1), ox, oy, false);
    for (let y = 0; y < SPRITE_PX; y += 1) {
      const lane = laneField(lanes, y - SPRITE_CENTER, true);
      laneRow[y] = lane < -1 ? -1 : lane > 1 ? 1 : lane;
    }
    runKernel(KIND_SOFT_OVAL);
    blitVariant(data, rowWidth, v);
  }
}

// matte (seed 0x66e0b2a7, 6 variants): flat opaque gouache with a slightly
// irregular hard-ish rim.
//   phase = roll k0 (2 rolls)
//   r  = rho / (1 + 0.05 * (2 * n5 - 1))              rim wobble +-5%
//   a  = (0.97 + 0.03 * (2 * n10 - 1)) * (1 - S(0.92, 1.0, r))   8% edge
function buildMatte(data, rowWidth, family) {
  for (let v = 0; v < family.variants; v += 1) {
    const roll = mulberry32(latticeSeed(family.seed, v, 0));
    const ox = roll();
    const oy = roll();
    noiseField(fieldA, SPRITE_PX, 5, latticeSeed(family.seed, v, 1), ox, oy, false);
    noiseField(fieldB, SPRITE_PX, 10, latticeSeed(family.seed, v, 2), oy, ox, false);
    runKernel(KIND_MATTE);
    blitVariant(data, rowWidth, v);
  }
}

// loaded (seed 0x3a9c51d7, 6 variants): the oil/acrylic base — an elongated
// body (2:1 baked: SPRITE_UNIT px along x, SPRITE_UNIT / 2 along y) streaked
// with bristle lanes along x. Solid coverage: the lane floor is 0.6.
//   phase = roll k0 (2 rolls); laneCount = 6 + floor(roll * 4); lanes =
//           rollLanes(count, spread 24 px, width 2.5..5 px)
//   wob(x) = 4 * (n6row(x) - 0.5)   px, one shared 1-D lattice (octave 2, row 0)
//   L(yy)  = min(1, sum_i level_i * bump_i(yy)), tabulated every 1/4 px and
//            read at yy = y - wob(x) rounded to the nearest 1/4 px
//   e      = sqrt((x / 54)^2 + (y / 27)^2)             elliptical rho
//   a      = (1 - S(0.9, 1.0, e)) * (0.6 + 0.4 * L) * (0.94 + 0.06 * n8)
// Note for Stage 2: lanes are per VARIANT, so coherent streaks along a stroke
// need the variant rolled per stroke (seed), not per dab.
function buildLoaded(data, rowWidth, family) {
  pHalfY = SPRITE_UNIT / family.aspect;
  fillProfile(KIND_LOADED);
  for (let v = 0; v < family.variants; v += 1) {
    const roll = mulberry32(latticeSeed(family.seed, v, 0));
    const ox = roll();
    const oy = roll();
    const lanes = rollLanes(roll, 6 + Math.floor(roll() * 4), 24, 2.5, 5);
    noiseField(fieldA, SPRITE_PX, 8, latticeSeed(family.seed, v, 1), ox, oy, false);
    noiseField(fieldB, SPRITE_PX, 6, latticeSeed(family.seed, v, 2), oy, ox, false);
    for (let x = 0; x < SPRITE_PX; x += 1) {
      wobble[x] = 4 * (fieldB[x] - 0.5); // row 0 of the 6-cell field = a 1-D lattice
    }
    for (let k = 0; k < LANE_LUT_N; k += 1) {
      const lane = laneField(lanes, k / LANE_LUT_RES - SPRITE_CENTER, false);
      laneLut[k] = lane > 1 ? 1 : lane;
    }
    runKernel(KIND_LOADED);
    blitVariant(data, rowWidth, v);
  }
  pHalfY = SPRITE_UNIT;
}

// halo (seed 0x0b5d3c9e, 2 variants, no noise): the glow pair.
//   variant 0 (halo): a = (1 - rho)^2 for rho < 1, else 0
//   variant 1 (core): a = 1 - S(0.6, 1, rho)
function buildHalo(data, rowWidth) {
  runKernel(KIND_HALO);
  blitVariant(data, rowWidth, 0);
  runKernel(KIND_HALO_CORE);
  blitVariant(data, rowWidth, 1);
}

// softMask (1 variant, no noise): the smudge feather.
//   a = 1 - S(0.55, 1.0, rho)
function buildSoftMask(data, rowWidth) {
  runKernel(KIND_SOFT_MASK);
  blitVariant(data, rowWidth, 0);
}

const BUILDERS = {
  wash: buildWash,
  graphite: buildGraphite,
  wax: buildWax,
  softOval: buildSoftOval,
  matte: buildMatte,
  loaded: buildLoaded,
  halo: buildHalo,
  softMask: buildSoftMask,
};

// Pure pixel build for one family: { width, height, data } RGBA (white RGB,
// alpha = the sprite). DOM-free, so Node tests can hash it directly. `data`
// may be supplied (an ImageData's buffer) to skip a copy.
export function buildFamilyImage(family, data) {
  const index = spriteFamilyIndex(family);
  if (index < 0) {
    return null;
  }
  const entry = FAMILIES[index];
  const width = entry.variants * SPRITE_PX;
  const height = SPRITE_PX;
  const out = data || new Uint8ClampedArray(width * height * 4);
  geometry();
  warmUp();
  BUILDERS[entry.id](out, width, entry);
  return { width, height, data: out };
}

// Pure pixel build for the paper tile (black RGB, alpha = 2-octave value
// noise: 16-px + 8-px lattices, periodic so it tiles, + 15% white hash).
//   v = 0.55 * n16px + 0.30 * n8px + 0.15 * white(x, y, PAPER_SEED)
export function buildPaperImage(data) {
  const out = data || new Uint8ClampedArray(PAPER_PX * PAPER_PX * 4);
  const coarse = new Float64Array(PAPER_PX * PAPER_PX);
  const fine = new Float64Array(PAPER_PX * PAPER_PX);
  noiseField(coarse, PAPER_PX, PAPER_PX / 16, latticeSeed(PAPER_SEED, 0, 1), 0, 0, true);
  noiseField(fine, PAPER_PX, PAPER_PX / 8, latticeSeed(PAPER_SEED, 0, 2), 0, 0, true);
  const salt = PAPER_SEED | 0;
  let o = 0;
  for (let y = 0; y < PAPER_PX; y += 1) {
    for (let x = 0; x < PAPER_PX; x += 1) {
      const i = y * PAPER_PX + x;
      let v = 0.55 * coarse[i] + 0.3 * fine[i] + 0.15 * white(x, y, salt);
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
      out[o + 3] = (v * 255 + 0.5) | 0;
      o += 4;
    }
  }
  return { width: PAPER_PX, height: PAPER_PX, data: out };
}

// ---------------------------------------------------------------------------
// Canvas side: atlases, tint ring, paper tile, scratches.

const atlases = new Array(FAMILIES.length).fill(null);
let paperTile = null;
let smudgeScratch = null;
let carryScratch = null;

function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// The family's atlas row: variant v occupies x in [v * 128, v * 128 + 128).
// White RGB + alpha; tint through getTintedSprite, never by hand.
export function getAtlas(family) {
  const index = spriteFamilyIndex(family);
  if (index < 0 || !HAS_DOM) {
    return null;
  }
  let canvas = atlases[index];
  if (!canvas) {
    const entry = FAMILIES[index];
    canvas = makeCanvas(entry.variants * SPRITE_PX, SPRITE_PX);
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(canvas.width, canvas.height);
    buildFamilyImage(entry.id, image.data);
    ctx.putImageData(image, 0, 0); // the ONE putImageData per atlas
    atlases[index] = canvas;
  }
  return canvas;
}

// The granulation tile: black, alpha = paper noise, world-aligned by the
// caller like applyGrain (same phase rule), 256^2 and seamless.
export function getPaperTile() {
  if (!HAS_DOM) {
    return null;
  }
  if (!paperTile) {
    const canvas = makeCanvas(PAPER_PX, PAPER_PX);
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(PAPER_PX, PAPER_PX);
    buildPaperImage(image.data);
    ctx.putImageData(image, 0, 0);
    paperTile = canvas;
  }
  return paperTile;
}

// The smudge feather (softMask atlas, 1 variant = the whole 128^2 canvas).
export function getSoftMask() {
  return getAtlas("softMask");
}

// Module-singleton 256^2 scratches for the Stage-4 blend brush: the sampled
// patch (smudgeScratch) and the colour the finger carries (carryScratch).
// Cleared by the caller at stroke start — never allocated per stroke.
export function getSmudgeScratch() {
  if (!HAS_DOM) {
    return null;
  }
  if (!smudgeScratch) {
    smudgeScratch = makeCanvas(SCRATCH_PX, SCRATCH_PX);
  }
  return smudgeScratch;
}

export function getCarryScratch() {
  if (!HAS_DOM) {
    return null;
  }
  if (!carryScratch) {
    carryScratch = makeCanvas(SCRATCH_PX, SCRATCH_PX);
  }
  return carryScratch;
}

// --- Tint ring ---------------------------------------------------------------
// 32 pre-allocated 128^2 canvases (2 MB, allocated together on first use or
// by prebuild). A lookup is keyed by ONE Number:
//   ((familyIdx << 4) | variant) << 15 | rgb5key
// with the colour quantized to 5 bits per channel (rounded), so a rainbow of
// wet-pickup colours maps onto <= 32K keys and stays in the ring instead of
// re-tinting per dab. On a miss the round-robin next slot is re-tinted IN
// PLACE: 'copy' drawImage of the white variant, then 'source-in' fillRect —
// no canvas allocation ever happens on the dab path.
//
// PARITY: the tint colour is the key's canonical colour (expand5(q5(c))),
// NEVER the caller's raw rgb — two callers whose colours share a bucket must
// get byte-identical pixels regardless of who tinted the slot first, or cache
// order would leak into strokes. Cost: up to 4/255 per channel of colour
// error on sprite brushes, invisible next to flow accumulation.

let slots = null; // canvas[TINT_SLOTS]
let slotCtxs = null;
let slotKeys = null; // Int32Array(TINT_SLOTS), -1 = empty
const slotByKey = new Map(); // key -> slot index
let ringNext = 0;

function allocateSlots() {
  slots = new Array(TINT_SLOTS);
  slotCtxs = new Array(TINT_SLOTS);
  slotKeys = new Int32Array(TINT_SLOTS).fill(-1);
  for (let i = 0; i < TINT_SLOTS; i += 1) {
    slots[i] = makeCanvas(SPRITE_PX, SPRITE_PX);
    slotCtxs[i] = slots[i].getContext("2d");
  }
  slotByKey.clear();
  ringNext = 0;
}

function q5(c) {
  const v = c < 0 ? 0 : c > 255 ? 255 : c | 0;
  return ((v * 31 + 127) / 255) | 0;
}

function expand5(q) {
  return ((q * 255 + 15) / 31) | 0;
}

// The 15-bit colour part of a tint key. Exported so a wet/mix renderer can
// detect "colour bucket changed" with one integer compare per dab.
export function packRgb5(r, g, b) {
  return (q5(r) << 10) | (q5(g) << 5) | q5(b);
}

// A 128^2 canvas holding `variant` of `family` tinted (r, g, b) — draw it
// IMMEDIATELY: the returned canvas is a ring slot that a later call may
// re-tint for another colour. Returns null for an unknown family / no DOM.
export function getTintedSprite(family, variant, r, g, b) {
  const index = FAMILY_INDEX[family];
  if (index === undefined || !HAS_DOM) {
    return null;
  }
  const count = FAMILIES[index].variants;
  const v = variant >= 0 && variant < count ? variant | 0 : 0;
  const rgb5 = packRgb5(r, g, b);
  const key = (((index << 4) | v) << 15) | rgb5;
  const hit = slotByKey.get(key);
  if (hit !== undefined) {
    return slots[hit];
  }
  if (!slots) {
    allocateSlots();
  }
  const atlas = getAtlas(family);
  const slot = ringNext;
  ringNext = (ringNext + 1) % TINT_SLOTS;
  const evicted = slotKeys[slot];
  if (evicted !== -1) {
    slotByKey.delete(evicted);
  }
  slotKeys[slot] = key;
  slotByKey.set(key, slot);
  const ctx = slotCtxs[slot];
  ctx.globalCompositeOperation = "copy";
  ctx.drawImage(atlas, v * SPRITE_PX, 0, SPRITE_PX, SPRITE_PX, 0, 0, SPRITE_PX, SPRITE_PX);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = `rgb(${expand5(rgb5 >> 10)},${expand5((rgb5 >> 5) & 31)},${expand5(rgb5 & 31)})`;
  ctx.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
  return slots[slot];
}

// --- Lifecycle -----------------------------------------------------------------

// Build every atlas + the paper tile and allocate the tint ring, so the first
// sprite stroke pays nothing. Called bare it builds everything synchronously
// (~25 ms cold on a desktop). Handed an IdleDeadline — i.e. used directly as
// the requestIdleCallback callback — it builds one piece per step while at
// least IDLE_STEP_MS remain and re-schedules itself for the rest, so a phone
// never spends a whole idle slot in here (a busy page that never offers a
// slot gets the rest built in one go when the re-schedule's timeout fires).
// Either way every piece is lazy, so a stroke that arrives mid-way just
// builds what it needs on the spot.
const IDLE_STEP_MS = 12; // the biggest single piece (wash, 8 variants) cold
const IDLE_TIMEOUT_MS = 2000;
export function prebuildBrushSprites(deadline) {
  if (!HAS_DOM) {
    return;
  }
  const incremental = deadline && typeof deadline.timeRemaining === "function" && typeof requestIdleCallback === "function";
  const pieces = FAMILIES.length + 2; // atlases, paper tile, tint ring
  for (let i = 0; i < pieces; i += 1) {
    if (incremental && deadline.timeRemaining() < IDLE_STEP_MS && !deadline.didTimeout) {
      requestIdleCallback(prebuildBrushSprites, { timeout: IDLE_TIMEOUT_MS });
      return;
    }
    if (i < FAMILIES.length) {
      getAtlas(FAMILIES[i].id);
    } else if (i === FAMILIES.length) {
      getPaperTile();
    } else if (!slots) {
      allocateSlots();
    }
  }
}

// Free every backing store NOW (width = 0 is what makes iOS WebKit release
// canvas memory immediately, not at GC time). Everything rebuilds lazily on
// next use, so this is safe on studio unmount and visibilitychange hidden.
export function releaseBrushSprites() {
  for (let i = 0; i < atlases.length; i += 1) {
    if (atlases[i]) {
      atlases[i].width = 0;
      atlases[i] = null;
    }
  }
  if (slots) {
    for (let i = 0; i < TINT_SLOTS; i += 1) {
      slots[i].width = 0;
    }
    slots = null;
    slotCtxs = null;
    slotKeys = null;
    slotByKey.clear();
    ringNext = 0;
  }
  if (paperTile) {
    paperTile.width = 0;
    paperTile = null;
  }
  if (smudgeScratch) {
    smudgeScratch.width = 0;
    smudgeScratch = null;
  }
  if (carryScratch) {
    carryScratch.width = 0;
    carryScratch = null;
  }
}
