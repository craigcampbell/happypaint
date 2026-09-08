import assert from "node:assert/strict";
import test from "node:test";

import {
  hexToHsv,
  hexToRgb,
  hsvToHex,
  hsvToRgb,
  isHexColor,
  luma,
  normalizeHex,
  rgbToHex,
  rgbToHsv,
  withAlpha,
} from "../src/utils/color.js";

test("normalizeHex accepts 3/6 digit forms, with or without '#', and rejects junk", () => {
  assert.equal(normalizeHex("#ABC"), "#aabbcc");
  assert.equal(normalizeHex("abc"), "#aabbcc");
  assert.equal(normalizeHex(" #112233 "), "#112233");
  assert.equal(normalizeHex("#12345"), "#000000");
  assert.equal(normalizeHex("red", "#ff0000"), "#ff0000");
  assert.equal(normalizeHex(null, "#010203"), "#010203");
  assert.equal(isHexColor("#fff"), true);
  assert.equal(isHexColor("#ffff"), false);
  assert.equal(isHexColor(42), false);
});

test("hex ⇄ rgb round-trips and clamps", () => {
  assert.deepEqual(hexToRgb("#ff8000"), [255, 128, 0]);
  assert.equal(rgbToHex(255, 128, 0), "#ff8000");
  assert.equal(rgbToHex(300, -5, 12.6), "#ff000d");
  for (const hex of ["#000000", "#ffffff", "#123456", "#0878d1", "#ff4d91"]) {
    assert.equal(rgbToHex(...hexToRgb(hex)), hex);
  }
});

test("primary hues land on the expected angles", () => {
  assert.deepEqual(rgbToHsv(255, 0, 0), { h: 0, s: 1, v: 1 });
  assert.deepEqual(rgbToHsv(0, 255, 0), { h: 120, s: 1, v: 1 });
  assert.deepEqual(rgbToHsv(0, 0, 255), { h: 240, s: 1, v: 1 });
  assert.deepEqual(rgbToHsv(255, 255, 0), { h: 60, s: 1, v: 1 });
  assert.deepEqual(rgbToHsv(0, 0, 0), { h: 0, s: 0, v: 0 });
  assert.deepEqual(rgbToHsv(255, 255, 255), { h: 0, s: 0, v: 1 });
  const grey = rgbToHsv(128, 128, 128);
  assert.equal(grey.s, 0);
  assert.ok(Math.abs(grey.v - 128 / 255) < 1e-9);
});

test("hsv → rgb hits the corners and wraps hue", () => {
  assert.deepEqual(hsvToRgb(0, 1, 1), [255, 0, 0]);
  assert.deepEqual(hsvToRgb(360, 1, 1), [255, 0, 0]);
  assert.deepEqual(hsvToRgb(-120, 1, 1), [0, 0, 255]);
  assert.deepEqual(hsvToRgb(120, 1, 1), [0, 255, 0]);
  assert.deepEqual(hsvToRgb(240, 1, 1), [0, 0, 255]);
  assert.deepEqual(hsvToRgb(0, 0, 1), [255, 255, 255]);
  assert.deepEqual(hsvToRgb(200, 0, 0), [0, 0, 0]);
  assert.deepEqual(hsvToRgb(30, 2, 5), [255, 128, 0]); // s/v clamp to 1
});

test("hex → hsv → hex round-trips every channel within rounding", () => {
  for (let i = 0; i < 500; i += 1) {
    const r = (i * 53) % 256;
    const g = (i * 97 + 11) % 256;
    const b = (i * 193 + 7) % 256;
    const hex = rgbToHex(r, g, b);
    const { h, s, v } = hexToHsv(hex);
    const [r2, g2, b2] = hsvToRgb(h, s, v);
    assert.ok(Math.abs(r - r2) <= 1 && Math.abs(g - g2) <= 1 && Math.abs(b - b2) <= 1, `${hex} → ${rgbToHex(r2, g2, b2)}`);
  }
  assert.equal(hsvToHex(210, 0.5, 0.8), "#6699cc");
});

test("withAlpha / luma", () => {
  assert.equal(withAlpha("#ff8000", 0.5), "rgba(255, 128, 0, 0.5)");
  assert.equal(withAlpha("#ff8000", 7), "rgba(255, 128, 0, 1)");
  assert.equal(withAlpha("#ff8000", NaN), "rgba(255, 128, 0, 1)");
  assert.equal(luma("#ffffff"), 1);
  assert.equal(luma("#000000"), 0);
  assert.ok(luma("#ffff00") > luma("#0000ff"));
});
