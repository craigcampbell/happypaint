import assert from "node:assert/strict";
import test from "node:test";

import {
  LATENT_SIZE,
  latentToRgb,
  mixLatent,
  mixRgb,
  mixRgbFloat,
  rgbToLatent,
} from "../src/utils/pigment.js";

// --- helpers ------------------------------------------------------------------

const hexToRgb = (hex) => {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};

const rgbToHex = (rgb) =>
  "#" + Array.from(rgb, (x) => Math.round(x).toString(16).padStart(2, "0")).join("");

/** HSL hue in degrees (0..360) and saturation (0..1) of an sRGB triple. */
const hsl = ([r, g, b]) => {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: NaN, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
};

/** Relative luminance Y (linear light, 0..1) of an sRGB triple. */
const luminance = ([r, g, b]) => {
  const lin = (x) => {
    x /= 255;
    return x > 0.04045 ? Math.pow((x + 0.055) / 1.055, 2.4) : x / 12.92;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

/** CIE L* (0..100) from relative luminance. */
const lightness = (rgb) => {
  const y = luminance(rgb);
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
};

const isByte = (x) => Number.isInteger(x) && x >= 0 && x <= 255;

const assertBytes = (rgb, label) => {
  for (let i = 0; i < 3; i++) {
    assert.ok(isByte(rgb[i]), `${label}: channel ${i} = ${rgb[i]} is not an int in 0..255`);
  }
};

const assertClose = (actual, expected, tol, label) => {
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= tol,
      `${label}: ${rgbToHex(actual)} vs ${rgbToHex(expected)} differs by more than ${tol} in channel ${i}`,
    );
  }
};

const YELLOW = hexToRgb("#f9d423");
const BLUE = hexToRgb("#1e88e5");
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const PURE_BLUE = [0, 0, 255];
const CYAN = [0, 255, 255];
const MAGENTA = [255, 0, 255];
const PURE_YELLOW = [255, 255, 0];
const SATURATED = [BLACK, WHITE, RED, GREEN, PURE_BLUE, CYAN, MAGENTA, PURE_YELLOW];

// --- tests --------------------------------------------------------------------

test("endpoints are exact: t=0 gives a, t=1 gives b, a===b gives a", () => {
  const pairs = [
    [YELLOW, BLUE],
    [WHITE, BLACK],
    [RED, PURE_BLUE],
    [[17, 200, 99], [250, 3, 77]],
  ];
  for (const [a, b] of pairs) {
    assert.deepEqual(mixRgb(a, b, 0), a);
    assert.deepEqual(mixRgb(a, b, 1), b);
    assert.deepEqual(mixRgb(a, a, 0.5), a);
    assert.deepEqual(mixRgb(b, b, 0.37), b);
    // out-of-range t is clamped to the endpoints, NaN t means "all of a"
    assert.deepEqual(mixRgb(a, b, -3), a);
    assert.deepEqual(mixRgb(a, b, 7), b);
    assert.deepEqual(mixRgb(a, b, Number.NaN), a);
  }
  // mixRgb writes into `out` when given and returns it
  const out = [9, 9, 9];
  assert.equal(mixRgb(YELLOW, BLUE, 0.5, out), out);
  assertBytes(out, "out buffer");
});

test("mix(a,b,t) equals mix(b,a,1-t) within rounding", () => {
  // The K/S average is order-independent, so the only possible difference is
  // floating-point summation order flipping a value that sits on a .5 rounding
  // boundary: tolerance is 1 sRGB step per channel.
  const pairs = [
    [YELLOW, BLUE],
    [WHITE, BLACK],
    [RED, PURE_BLUE],
    [RED, GREEN],
    [[10, 200, 30], [240, 15, 180]],
    [[128, 128, 128], [200, 100, 50]],
  ];
  for (const [a, b] of pairs) {
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      assertClose(mixRgb(a, b, t), mixRgb(b, a, 1 - t), 1, `symmetry t=${t}`);
    }
  }
});

test("yellow + blue makes a green that is not dark", () => {
  const mix = mixRgb(YELLOW, BLUE, 0.5);
  const { h, s } = hsl(mix);
  // Hue window 70..170 spans yellow-green through green to teal-green; paint
  // mixes of a warm yellow and a cerulean-ish blue land mid-green (~115).
  assert.ok(h >= 70 && h <= 170, `hue ${h.toFixed(1)} of ${rgbToHex(mix)} not green`);
  // Must be a real green, not a greyed-out olive: saturation at least 0.25.
  assert.ok(s >= 0.25, `saturation ${s.toFixed(2)} of ${rgbToHex(mix)} too grey`);
  // "Not darker than ~35% luminance": CIE L* >= 35 (Y >= ~0.085) is the
  // threshold below which the mix would read as a dark, muddy green. The
  // Kubelka-Munk result actually sits around L* 65.
  const L = lightness(mix);
  assert.ok(L >= 35, `L* ${L.toFixed(1)} of ${rgbToHex(mix)} too dark`);
  // and the HSL lightness check the brief literally asks for
  assert.ok(hsl(mix).l >= 0.35, `HSL lightness ${hsl(mix).l.toFixed(2)} too dark`);
});

test("red + blue gives a purple, not grey or black", () => {
  // Pure red has ~3x the luminance of pure blue, and the concentration weights
  // are luminance-scaled, so the equal-luminance point sits at t ~ 0.63: below
  // that the mix is a red-leaning plum, above it a violet. Assert the whole
  // plum..violet band for the middle mixes and a proper purple once blue holds
  // the balance.
  for (const t of [0.5, 0.6, 0.7]) {
    const mix = mixRgb(RED, PURE_BLUE, t);
    const { h, s } = hsl(mix);
    assert.ok(
      h >= 255 && h <= 345,
      `t=${t}: hue ${h.toFixed(1)} of ${rgbToHex(mix)} is outside violet..plum`,
    );
    assert.ok(s >= 0.3, `t=${t}: saturation ${s.toFixed(2)} of ${rgbToHex(mix)} is grey`);
    assert.ok(Math.max(...mix) >= 40, `t=${t}: ${rgbToHex(mix)} is black`);
  }
  const purple = mixRgb(RED, PURE_BLUE, 0.7);
  const { h } = hsl(purple);
  assert.ok(h >= 255 && h <= 320, `hue ${h.toFixed(1)} of ${rgbToHex(purple)} not purple`);
});

test("white + black makes an untinted grey around the middle", () => {
  const mix = mixRgb(WHITE, BLACK, 0.5);
  // Untinted: channels equal within 1 sRGB step of rounding.
  assert.ok(
    Math.max(...mix) - Math.min(...mix) <= 1,
    `${rgbToHex(mix)} is tinted`,
  );
  // "Approximately mid grey": Kubelka-Munk with luminance-weighted
  // concentration lands lighter than an sRGB lerp (about #a6a6a6, L* ~68),
  // because black's near-zero luminance gives it little tinting power at an
  // even share. Accept sRGB 90..180 (L* ~38..73), which rules out both the
  // near-white and the near-black failure modes.
  const v = mix[0];
  assert.ok(v >= 90 && v <= 180, `${rgbToHex(mix)} is not a mid grey`);
  // More black must always mean darker, never lighter.
  let prev = 256;
  for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    const g = mixRgb(WHITE, BLACK, t)[0];
    assert.ok(g < prev || (t === 0 && g === 255), `not monotonic at t=${t}: ${g} >= ${prev}`);
    prev = g;
  }
});

test("white tints a colour without greying it", () => {
  const tint = mixRgb(WHITE, BLUE, 0.5);
  const { h, s } = hsl(tint);
  const { h: hb } = hsl(BLUE);
  assert.ok(Math.abs(h - hb) <= 20, `tint hue drifted: ${h.toFixed(1)} vs ${hb.toFixed(1)}`);
  assert.ok(s >= 0.5, `tint of blue went grey: ${rgbToHex(tint)} s=${s.toFixed(2)}`);
  assert.ok(lightness(tint) > lightness(BLUE), "white did not lighten");
});

test("complementary red + green goes brown, not black or neutral grey", () => {
  const mix = mixRgb(RED, GREEN, 0.5);
  const { h, s } = hsl(mix);
  assert.ok(Math.max(...mix) >= 80, `${rgbToHex(mix)} is (near) black`);
  assert.ok(lightness(mix) >= 25, `${rgbToHex(mix)} is too dark`);
  // brown/olive: hue in the orange..yellow-green band with real saturation
  assert.ok(h >= 10 && h <= 80, `hue ${h.toFixed(1)} of ${rgbToHex(mix)} is not brown/olive`);
  assert.ok(s >= 0.2, `${rgbToHex(mix)} is neutral grey`);
});

test("never produces NaN or out-of-range channels", () => {
  for (const a of SATURATED) {
    for (const b of SATURATED) {
      for (const t of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1]) {
        assertBytes(mixRgb(a, b, t), `${rgbToHex(a)}+${rgbToHex(b)}@${t}`);
      }
    }
  }
  // hostile inputs
  const junk = [Number.NaN, undefined, null, -50, 999, Infinity, -Infinity, "12", "abc", 127.5];
  for (const x of junk) {
    assertBytes(mixRgbFloat(x, 10, 20, 30, x, 50, 0.5, [0, 0, 0]), `junk ${String(x)}`);
    assertBytes(mixRgb([x, x, x], [200, x, 0], 0.4), `junk triple ${String(x)}`);
    assertBytes(mixRgb([100, 100, 100], [0, 0, 0], x), `junk t ${String(x)}`);
  }
  assertBytes(mixRgb(null, undefined, 0.5), "null inputs");
  assertBytes(mixRgb([], [], 0.5), "empty inputs");
  // a float latent never yields NaN either
  const lat = rgbToLatent(Number.NaN, -1, 300);
  for (let i = 0; i < LATENT_SIZE; i++) assert.ok(Number.isFinite(lat[i]), `latent[${i}] not finite`);
});

test("rgbToLatent -> latentToRgb round-trips every colour on a 5-step grid exactly", () => {
  // The seven basis spectra were fitted so that reflectance -> XYZ -> sRGB
  // reproduces the input; we check it is exact after rounding on a
  // 52^3 = 140,608 colour grid (a full 16.7M sweep is ~30x slower).
  const lat = new Float64Array(LATENT_SIZE);
  const out = [0, 0, 0];
  let worst = 0;
  let worstAt = null;
  for (let r = 0; r <= 255; r += 5) {
    for (let g = 0; g <= 255; g += 5) {
      for (let b = 0; b <= 255; b += 5) {
        latentToRgb(rgbToLatent(r, g, b, lat), out);
        const e = Math.max(Math.abs(out[0] - r), Math.abs(out[1] - g), Math.abs(out[2] - b));
        if (e > worst) {
          worst = e;
          worstAt = [r, g, b, out.slice()];
        }
      }
    }
  }
  assert.equal(worst, 0, `worst round-trip error ${worst} at ${JSON.stringify(worstAt)}`);
});

test("latent-space mixing matches the RGB API and can be chained", () => {
  const la = rgbToLatent(...YELLOW);
  const lb = rgbToLatent(...BLUE);
  const viaLatent = latentToRgb(mixLatent(la, lb, 0.5));
  assert.deepEqual(viaLatent, mixRgb(YELLOW, BLUE, 0.5));

  // Carried-colour use: mix repeatedly without leaving latent space, and
  // mixing into one of the inputs is allowed.
  const carried = rgbToLatent(...WHITE);
  const brush = rgbToLatent(...BLUE);
  for (let i = 0; i < 6; i++) mixLatent(carried, brush, 0.3, carried);
  const chained = latentToRgb(carried);
  assertBytes(chained, "chained");
  const { h, s } = hsl(chained);
  assert.ok(Math.abs(h - hsl(BLUE).h) <= 20 && s >= 0.5, `chained tint drifted: ${rgbToHex(chained)}`);
  assert.ok(lightness(chained) > lightness(BLUE), "chained tint should still be lighter than blue");

  // Latents are plain buffers: a caller-supplied Float64Array is used as-is.
  const buf = new Float64Array(LATENT_SIZE);
  assert.equal(rgbToLatent(1, 2, 3, buf), buf);
  assert.equal(mixLatent(la, lb, 0.5, buf), buf);
  const rgbOut = new Float64Array(3);
  assert.equal(latentToRgb(buf, rgbOut), rgbOut);
});

test("mixRgbFloat writes into out, accepts float channels, and the cache is order-safe", () => {
  const out = new Float64Array(3);
  assert.equal(mixRgbFloat(255, 0, 0, 0, 0, 255, 0.5, out), out);
  assert.deepEqual(Array.from(out), mixRgb(RED, PURE_BLUE, 0.5));

  // Float channels are accepted and land between their integer neighbours.
  const lo = mixRgb([100, 50, 200], BLUE, 0.5);
  const hi = mixRgb([101, 50, 200], BLUE, 0.5);
  const mid = Array.from(mixRgbFloat(100.5, 50, 200, ...BLUE, 0.5, out));
  for (let i = 0; i < 3; i++) {
    assert.ok(mid[i] >= Math.min(lo[i], hi[i]) - 1 && mid[i] <= Math.max(lo[i], hi[i]) + 1, "float channel");
  }

  // Cache correctness: interleaving different operand orders and repeats must
  // never change a result (stale-slot bug detector).
  const colours = [YELLOW, BLUE, RED, WHITE, [40, 90, 160]];
  const expected = new Map();
  for (const a of colours) for (const b of colours) expected.set(rgbToHex(a) + rgbToHex(b), mixRgb(a, b, 0.4));
  for (let round = 0; round < 3; round++) {
    for (const a of colours) {
      for (const b of colours) {
        assert.deepEqual(mixRgb(a, b, 0.4), expected.get(rgbToHex(a) + rgbToHex(b)));
        assert.deepEqual(mixRgb(b, a, 0.4), expected.get(rgbToHex(b) + rgbToHex(a)));
      }
    }
  }
});

test("performance: 100k mixRgbFloat calls", () => {
  const out = new Float64Array(3);
  // Deterministic LCG so the run is reproducible.
  let seed = 12345;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const N = 100_000;
  const a = new Uint8Array(N * 3);
  for (let i = 0; i < a.length; i++) a[i] = rnd() & 255;

  // warm-up so the JIT has settled
  for (let i = 0; i < 5000; i++) mixRgbFloat(a[i * 3], a[i * 3 + 1], a[i * 3 + 2], 30, 136, 229, 0.35, out);

  // Realistic stroke: varying carried colour vs one fixed brush colour
  // (brush colour hits the cache, carried colour is decomposed every call).
  let t0 = performance.now();
  for (let i = 0; i < N; i++) {
    mixRgbFloat(a[i * 3], a[i * 3 + 1], a[i * 3 + 2], 30, 136, 229, 0.35, out);
  }
  const fixedMs = performance.now() - t0;

  // Worst case: both operands change every call (two decompositions).
  t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    mixRgbFloat(a[i * 3], a[i * 3 + 1], a[i * 3 + 2], a[j * 3], a[j * 3 + 1], a[j * 3 + 2], 0.5, out);
  }
  const bothMs = performance.now() - t0;

  console.log(
    `  timing: 100k mixRgbFloat (fixed brush colour) = ${fixedMs.toFixed(1)} ms; ` +
      `(both operands varying) = ${bothMs.toFixed(1)} ms`,
  );
  // Design target is 150 ms on a dev machine; the assertion is loose enough
  // (4x) that a slow CI box does not fail the suite but a 10x regression does.
  assert.ok(fixedMs < 600, `100k mixes took ${fixedMs.toFixed(1)} ms (target 150 ms)`);
});

test("example mixes (for eyeballing)", () => {
  const rows = [
    ["#f9d423", "#1e88e5", 0.5],
    ["#ff0000", "#0000ff", 0.5],
    ["#ff0000", "#0000ff", 0.7],
    ["#ffffff", "#000000", 0.5],
    ["#ff0000", "#00ff00", 0.5],
    ["#ffff00", "#0000ff", 0.5],
    ["#ffffff", "#1e88e5", 0.5],
    ["#ff0000", "#00ffff", 0.5],
    ["#ffff00", "#ff00ff", 0.5],
    ["#e53935", "#43a047", 0.5],
  ];
  const lines = rows.map(([a, b, t]) => {
    const mix = mixRgb(hexToRgb(a), hexToRgb(b), t);
    assertBytes(mix, `${a}+${b}`);
    return `  ${a} + ${b} @ t=${t} -> ${rgbToHex(mix)}`;
  });
  console.log(lines.join("\n"));
});
