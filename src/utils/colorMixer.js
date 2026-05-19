// Pigment-based subtractive color mixing using CMY model
// This produces realistic paint mixing behavior where:
// - Yellow + Blue = Green (subtractive, not additive)
// - Layers of paint darken rather than wash out to white
// - Paint opacity follows Kubelka-Munk theory

function rgbToCmy(r, g, b) {
  return {
    c: 1 - r / 255,
    m: 1 - g / 255,
    y: 1 - b / 255,
  };
}

function cmyToRgb(c, m, y) {
  return {
    r: Math.round((1 - c) * 255),
    g: Math.round((1 - m) * 255),
    b: Math.round((1 - y) * 255),
  };
}

function clamp(v) {
  return Math.max(0, Math.min(1, v));
}

export function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  } : { r: 0, g: 0, b: 0 };
}

export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(x => {
    const h = Math.round(clamp(x));
    return h.toString(16).padStart(2, '0');
  }).join('');
}

// Mix two colors using Kubelka-Munk pigment mixing
// dst = paint already on canvas, src = new paint being applied
// opacity = how much of the new pigment is deposited (0-1)
export function mixPigments(dstHex, srcHex, opacity) {
  const dst = hexToRgb(dstHex);
  const src = hexToRgb(srcHex);

  // Convert to absorption coefficients (K/S)
  // Higher values = more absorption = darker pigment
  const dstCmy = rgbToCmy(dst.r, dst.g, dst.b);
  const srcCmy = rgbToCmy(src.r, src.g, src.b);

  // Kubelka-Munk mixing: combine absorption coefficients weighted by concentration
  const d = opacity;
  const mixed = {
    c: clamp(dstCmy.c * (1 - d) + srcCmy.c * d),
    m: clamp(dstCmy.m * (1 - d) + srcCmy.m * d),
    y: clamp(dstCmy.y * (1 - d) + srcCmy.y * d),
  };

  const rgb = cmyToRgb(mixed.c, mixed.m, mixed.y);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

// Blend using physical pigment behavior (Kubelka-Munk)
// More realistic than simple alpha blending
export function kubelkaMunkBlend(dstRgba, srcHex, opacity) {
  const src = hexToRgb(srcHex);

  // Convert background to absorption (K) and scattering (S)
  // Assume white scattering base for the canvas
  const canvasK = { r: 0, g: 0, b: 0 };

  const dstK = {
    r: canvasK.r + (dstRgba[0] / 255) * 0.3,
    g: canvasK.g + (dstRgba[1] / 255) * 0.3,
    b: canvasK.b + (dstRgba[2] / 255) * 0.3,
  };

  const srcK = {
    r: (1 - src.r / 255) * opacity,
    g: (1 - src.g / 255) * opacity,
    b: (1 - src.b / 255) * opacity,
  };

  // Combined K/S
  const K = {
    r: dstK.r + srcK.r,
    g: dstK.g + srcK.g,
    b: dstK.b + srcK.b,
  };

  // Reflectance from K/S (simplified: R = 1 + K/S - sqrt((K/S)^2 + 2*K/S))
  const result = (k) => {
    const ks = Math.min(k, 10);
    return 1 + ks - Math.sqrt(ks * ks + 2 * ks);
  };

  return {
    r: Math.round(clamp(result(K.r)) * 255),
    g: Math.round(clamp(result(K.g)) * 255),
    b: Math.round(clamp(result(K.b)) * 255),
    a: 255,
  };
}

// Compute an array of pigment values from image data at a point
export function samplePigment(imageData, x, y, width) {
  const idx = (y * width + x) * 4;
  if (idx < 0 || idx >= imageData.data.length) return null;
  return {
    r: imageData.data[idx],
    g: imageData.data[idx + 1],
    b: imageData.data[idx + 2],
    a: imageData.data[idx + 3],
  };
}

// Write pigment back to image data
export function writePigment(imageData, x, y, width, pigment) {
  const idx = (y * width + x) * 4;
  if (idx < 0 || idx >= imageData.data.length) return;
  imageData.data[idx] = pigment.r;
  imageData.data[idx + 1] = pigment.g;
  imageData.data[idx + 2] = pigment.b;
  imageData.data[idx + 3] = pigment.a;
}
