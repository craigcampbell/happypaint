// Colour math for the studio's own picker (HSB wheel + bars). Kept tiny and
// dependency-free: hex ⇄ RGB ⇄ HSV (HSB), plus an rgba() string helper for
// swatches that show the brush opacity over a checkerboard.
//
// HSV here: h in degrees 0..360 (0 = red, 120 = green, 240 = blue), s and v
// in 0..1. Hex is always the 6-digit lowercase form with a leading '#'.

const HEX3 = /^[0-9a-f]{3}$/i;
const HEX6 = /^[0-9a-f]{6}$/i;

export function normalizeHex(input, fallback = "#000000") {
  if (typeof input !== "string") {
    return fallback;
  }
  let h = input.trim().replace(/^#/, "");
  if (HEX3.test(h)) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!HEX6.test(h)) {
    return fallback;
  }
  return `#${h.toLowerCase()}`;
}

export function isHexColor(input) {
  if (typeof input !== "string") {
    return false;
  }
  const h = input.trim().replace(/^#/, "");
  return HEX3.test(h) || HEX6.test(h);
}

export function hexToRgb(hex) {
  const h = normalizeHex(hex).slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const clamp255 = (n) => Math.min(255, Math.max(0, Math.round(Number(n) || 0)));

export function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((c) => clamp255(c).toString(16).padStart(2, "0")).join("")}`;
}

export function rgbToHsv(r, g, b) {
  const rr = clamp255(r) / 255;
  const gg = clamp255(g) / 255;
  const bb = clamp255(b) / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rr) {
      h = ((gg - bb) / d) % 6;
    } else if (max === gg) {
      h = (bb - rr) / d + 2;
    } else {
      h = (rr - gg) / d + 4;
    }
    h *= 60;
    if (h < 0) {
      h += 360;
    }
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

export function hsvToRgb(h, s, v) {
  const hh = (((Number(h) || 0) % 360) + 360) % 360;
  const ss = Math.min(1, Math.max(0, Number(s) || 0));
  const vv = Math.min(1, Math.max(0, Number(v) || 0));
  const c = vv * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = vv - c;
  let rgb;
  if (hh < 60) rgb = [c, x, 0];
  else if (hh < 120) rgb = [x, c, 0];
  else if (hh < 180) rgb = [0, c, x];
  else if (hh < 240) rgb = [0, x, c];
  else if (hh < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((ch) => Math.round((ch + m) * 255));
}

export function hsvToHex(h, s, v) {
  const [r, g, b] = hsvToRgb(h, s, v);
  return rgbToHex(r, g, b);
}

export function hexToHsv(hex) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHsv(r, g, b);
}

// "rgba(r, g, b, a)" for a hex + 0..1 alpha — what a swatch paints over its
// checkerboard so the brush opacity is visible at a glance.
export function withAlpha(hex, alpha = 1) {
  const [r, g, b] = hexToRgb(hex);
  const a = Math.min(1, Math.max(0, Number(alpha)));
  return `rgba(${r}, ${g}, ${b}, ${Number.isFinite(a) ? a : 1})`;
}

// Perceived lightness 0..1 (Rec. 601 luma) — picks a readable ring/label
// colour over a swatch.
export function luma(hex) {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
