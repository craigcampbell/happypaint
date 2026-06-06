import { describe, it, expect } from 'vitest';
import {
  hexToRgb,
  rgbToHex,
  mixPigments,
  kubelkaMunkBlend,
  samplePigment,
  writePigment,
} from '../../src/utils/colorMixer';

describe('hexToRgb', () => {
  it('converts 6-digit hex with hash', () => {
    expect(hexToRgb('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('converts black', () => {
    expect(hexToRgb('#000000')).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('converts white', () => {
    expect(hexToRgb('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('converts mixed color', () => {
    expect(hexToRgb('#1a2b3c')).toEqual({ r: 26, g: 43, b: 60 });
  });

  it('converts hex without hash', () => {
    expect(hexToRgb('ff0000')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('handles uppercase hex', () => {
    expect(hexToRgb('#FF00AA')).toEqual({ r: 255, g: 0, b: 170 });
  });

  it('returns black for invalid input', () => {
    expect(hexToRgb('#xyz')).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('returns black for empty string', () => {
    expect(hexToRgb('')).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe('rgbToHex', () => {
  it('converts red', () => {
    expect(rgbToHex(255, 0, 0)).toBe('#ff0000');
  });

  it('converts white', () => {
    expect(rgbToHex(255, 255, 255)).toBe('#ffffff');
  });

  it('converts black', () => {
    expect(rgbToHex(0, 0, 0)).toBe('#000000');
  });

  it('pads single-digit hex values', () => {
    expect(rgbToHex(15, 15, 15)).toBe('#0f0f0f');
  });

  it('clamps negative values to 0', () => {
    expect(rgbToHex(-10, 0, 0)).toBe('#000000');
  });

  it('clamps values over 255', () => {
    expect(rgbToHex(300, 128, 128)).toBe('#ff8080');
  });

  it('handles fractional inputs by rounding', () => {
    expect(rgbToHex(127.6, 127.4, 128.5)).toBe('#807f81');
  });
});

describe('mixPigments', () => {
  it('mixing with white at 0 opacity returns original', () => {
    const result = mixPigments('#ffffff', '#ff0000', 0);
    expect(result).toBe('#ffffff');
  });

  it('mixing red onto white at full opacity returns red', () => {
    const result = mixPigments('#ffffff', '#ff0000', 1);
    expect(result).toBe('#ff0000');
  });

  it('mixing yellow onto blue at full opacity replaces with blue', () => {
    // At 100%, source completely replaces destination in CMY model
    const result = mixPigments('#ffff00', '#0000ff', 1);
    const rgb = hexToRgb(result);
    // Blue paint fully covers yellow — result is blue
    expect(rgb.b).toBeGreaterThan(200);
    expect(rgb.r).toBeLessThan(30);
    expect(rgb.g).toBeLessThan(30);
  });

  it('mixing yellow and blue at partial opacity darkens (subtractive)', () => {
    const result = mixPigments('#ffff00', '#0000ff', 0.5);
    const rgb = hexToRgb(result);
    // At 50% mix, both pigments contribute — should be dark/muddy
    expect(rgb.r).toBeLessThan(200);
    expect(rgb.g).toBeLessThan(200);
    expect(rgb.b).toBeLessThan(200);
  });

  it('mixing yellow and blue at 50% opacity', () => {
    const result = mixPigments('#ffff00', '#0000ff', 0.5);
    const rgb = hexToRgb(result);
    // Should have some green and red from partial yellow
    expect(rgb.r).toBeGreaterThan(0);
    expect(rgb.b).toBeGreaterThan(0);
  });

  it('mixing identical colors returns the same color', () => {
    const result = mixPigments('#aabbcc', '#aabbcc', 0.5);
    expect(result).toBe('#aabbcc');
  });

  it('mixing at 0 opacity returns destination unchanged', () => {
    const result = mixPigments('#123456', '#abcdef', 0);
    expect(result).toBe('#123456');
  });

  it('mixing dark onto dark produces dark', () => {
    const result = mixPigments('#111111', '#222222', 0.5);
    const rgb = hexToRgb(result);
    expect(rgb.r).toBeLessThan(50);
    expect(rgb.g).toBeLessThan(50);
    expect(rgb.b).toBeLessThan(50);
  });

  it('is deterministic', () => {
    const r1 = mixPigments('#ff8800', '#0088ff', 0.7);
    const r2 = mixPigments('#ff8800', '#0088ff', 0.7);
    expect(r1).toBe(r2);
  });

  it('all results are valid hex colors', () => {
    for (let opacity = 0; opacity <= 1; opacity += 0.2) {
      const result = mixPigments('#4a90d9', '#e74c3c', opacity);
      expect(result).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('kubelkaMunkBlend', () => {
  const whiteRgba = [255, 255, 255, 255];

  it('blending red onto white returns reddish with darkening', () => {
    const result = kubelkaMunkBlend(whiteRgba, '#ff0000', 1);
    expect(result.a).toBe(255);
    // KM model darkens colors realistically — red on white produces dark red
    expect(result.r).toBeGreaterThan(80);
    expect(result.r).toBeLessThan(200);
    expect(result.g).toBeLessThan(80);
    expect(result.b).toBeLessThan(80);
  });

  it('blending at 0 opacity returns white', () => {
    const result = kubelkaMunkBlend(whiteRgba, '#ff0000', 0);
    expect(result.a).toBe(255);
  });

  it('blending onto colored background', () => {
    const bg = [100, 150, 200, 255];
    const result = kubelkaMunkBlend(bg, '#ff0000', 1);
    expect(result.r).toBeGreaterThan(bg[0]);
  });

  it('blending black onto white darkens', () => {
    const result = kubelkaMunkBlend(whiteRgba, '#000000', 1);
    expect(result.r).toBeLessThan(100);
    expect(result.g).toBeLessThan(100);
    expect(result.b).toBeLessThan(100);
  });

  it('all channels output valid values', () => {
    const result = kubelkaMunkBlend(whiteRgba, '#4a90d9', 0.5);
    expect(result.r).toBeGreaterThanOrEqual(0);
    expect(result.r).toBeLessThanOrEqual(255);
    expect(result.g).toBeGreaterThanOrEqual(0);
    expect(result.g).toBeLessThanOrEqual(255);
    expect(result.b).toBeGreaterThanOrEqual(0);
    expect(result.b).toBeLessThanOrEqual(255);
  });
});

describe('samplePigment', () => {
  it('returns pigment object for valid coordinates', () => {
    const data = new Uint8ClampedArray([100, 150, 200, 255, 50, 60, 70, 128]);
    const imageData = { data, width: 2, height: 1 };
    const result = samplePigment(imageData, 0, 0, 2);
    expect(result).toEqual({ r: 100, g: 150, b: 200, a: 255 });
  });

  it('returns pigment from second pixel', () => {
    const data = new Uint8ClampedArray([100, 150, 200, 255, 50, 60, 70, 128]);
    const imageData = { data, width: 2, height: 1 };
    const result = samplePigment(imageData, 1, 0, 2);
    expect(result).toEqual({ r: 50, g: 60, b: 70, a: 128 });
  });

  it('returns null for out-of-bounds x', () => {
    const data = new Uint8ClampedArray([100, 150, 200, 255]);
    const imageData = { data, width: 1, height: 1 };
    const result = samplePigment(imageData, 5, 0, 1);
    expect(result).toBeNull();
  });

  it('returns null for negative coordinates', () => {
    const data = new Uint8ClampedArray([100, 150, 200, 255]);
    const imageData = { data, width: 1, height: 1 };
    const result = samplePigment(imageData, -1, 0, 1);
    expect(result).toBeNull();
  });
});

describe('writePigment', () => {
  it('writes pigment values to image data', () => {
    const data = new Uint8ClampedArray([0, 0, 0, 0]);
    const imageData = { data, width: 1, height: 1 };
    writePigment(imageData, 0, 0, 1, { r: 100, g: 150, b: 200, a: 255 });
    expect(data[0]).toBe(100);
    expect(data[1]).toBe(150);
    expect(data[2]).toBe(200);
    expect(data[3]).toBe(255);
  });

  it('does not write out of bounds', () => {
    const data = new Uint8ClampedArray([1, 2, 3, 4]);
    const imageData = { data, width: 1, height: 1 };
    writePigment(imageData, 10, 0, 1, { r: 100, g: 150, b: 200, a: 255 });
    // Data should remain unchanged
    expect(data[0]).toBe(1);
    expect(data[1]).toBe(2);
    expect(data[2]).toBe(3);
    expect(data[3]).toBe(4);
  });

  it('handles multi-pixel image data correctly', () => {
    const data = new Uint8ClampedArray([
      0, 0, 0, 0,  // pixel 0,0
      0, 0, 0, 0,  // pixel 1,0
      0, 0, 0, 0,  // pixel 0,1
      0, 0, 0, 0,  // pixel 1,1
    ]);
    const imageData = { data, width: 2, height: 2 };
    writePigment(imageData, 1, 1, 2, { r: 255, g: 128, b: 64, a: 200 });
    // Pixel at (1,1) should be updated: index = (1*2 + 1)*4 = 12
    expect(data[12]).toBe(255);
    expect(data[13]).toBe(128);
    expect(data[14]).toBe(64);
    expect(data[15]).toBe(200);
    // Other pixels unchanged
    expect(data[0]).toBe(0);
    expect(data[4]).toBe(0);
    expect(data[8]).toBe(0);
  });
});

describe('Pigment mixing real-world scenarios', () => {
  it('yellow + cyan at partial opacity produces greenish hue (subtractive)', () => {
    // At 100%, cyan fully replaces yellow. At 50%, they mix subtractively
    const result = mixPigments('#ffff00', '#00ffff', 0.5);
    const rgb = hexToRgb(result);
    // At 50% mix, should have significant green from partial mixing
    expect(rgb.g).toBeGreaterThan(140);
  });

  it('layering same color builds opacity', () => {
    const layer1 = mixPigments('#ffffff', '#4488cc', 0.3);
    const layer2 = mixPigments(layer1, '#4488cc', 0.3);
    const l1 = hexToRgb(layer1);
    const l2 = hexToRgb(layer2);
    // Second layer should be darker (more pigment)
    expect(l2.r).toBeLessThanOrEqual(l1.r);
    expect(l2.g).toBeLessThanOrEqual(l1.g);
    expect(l2.b).toBeLessThanOrEqual(l1.b);
  });

  it('mixing black with color darkens proportionally', () => {
    const original = mixPigments('#ffffff', '#ff0000', 1);
    const darkened = mixPigments(original, '#000000', 0.5);
    const orig = hexToRgb(original);
    const dark = hexToRgb(darkened);
    expect(dark.r).toBeLessThan(orig.r);
  });
});
