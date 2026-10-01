// Deterministic helpers for the Painted Planet's painterly rendering.
//
// Everything here is decorative and deterministic (seeded, no Math.random) so
// the picture is identical on every render and every device. Nothing in it
// encodes data — the data lives in the country fills and splashes in
// PlanetPage.jsx — and every element is aria-hidden / pointer-events:none.

// ---- deterministic randomness ----------------------------------------------
export function hashCode(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- color helpers ----------------------------------------------------------
const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;

// Mix `hex` toward `toward` by t (0..1).
export function mix(hex, toward, t) {
  const a = toRgb(hex);
  const b = toRgb(toward);
  return toHex(a.map((v, i) => v + (b[i] - v) * t));
}

// A paint pot is never perfectly even: nudge each country a little around its
// ramp color, deterministically per country.
export function jitter(hex, seed, amount = 0.1) {
  const r = rng(seed)();
  return r < 0.5 ? mix(hex, "#ffffff", (0.5 - r) * 2 * amount) : mix(hex, "#5a2a1a", (r - 0.5) * 2 * amount * 0.7);
}
