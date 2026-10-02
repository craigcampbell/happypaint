import assert from "node:assert/strict";
import test from "node:test";

import {
  PEN_PRESSURE_DEFAULT_CEILING,
  PEN_PRESSURE_FLOOR,
  createPenCalibration,
  createVelocityPressure,
  loadPenCalibration,
  mapPenPressure,
  resetVelocityPressure,
  resolvePointPressure,
  savePenCalibration,
} from "../src/utils/penInput.js";

// The getPoint seam: which pressure does ONE pointer sample produce? A pen
// sample must ALWAYS resolve through the adaptive pen band — even pressure 0
// (the lightest real contact, which iPads report for feather Pencil touches).
// Only mouse/touch may use the velocity synthesizer. Regression coverage for
// the "light stylus touch paints a full-size blob" bug, where a pen sample
// with pressure 0 fell into the velocity path and came out 0.65.

const penEvent = (pressure, timeStamp = 1000) => ({ pointerType: "pen", pressure, timeStamp });
const mouseEvent = (pressure, timeStamp) => ({ pointerType: "mouse", pressure, timeStamp });
const touchEvent = (pressure, timeStamp) => ({ pointerType: "touch", pressure, timeStamp });

function ctx(overrides = {}) {
  return {
    worldX: 0,
    worldY: 0,
    penCal: createPenCalibration(),
    velocity: createVelocityPressure(),
    now: 1000,
    ...overrides,
  };
}

test("pen with pressure 0 maps to the band floor (0.02), never the 0.65 velocity baseline", () => {
  const c = ctx();
  const p = resolvePointPressure(penEvent(0), c);
  assert.equal(p, 0.02);
});

test("pen with pressure 0 does NOT touch the velocity synthesizer state", () => {
  const c = ctx();
  resolvePointPressure(penEvent(0, 1000), c);
  resolvePointPressure(penEvent(0, 1016), c);
  // A pen hover/touch stream must leave the synthesizer pristine so the next
  // mouse or finger stroke still opens on the neutral 0.65 baseline.
  assert.equal(c.velocity.lastT, null);
  assert.equal(c.velocity.ema, null);
  const after = resolvePointPressure(mouseEvent(0.5, 2000), c);
  assert.equal(after, 0.65);
});

test("pen low-positive pressure maps through the adaptive band", () => {
  const c = ctx();
  assert.equal(resolvePointPressure(penEvent(PEN_PRESSURE_FLOOR), c), 0.02); // floor contact
  const light = resolvePointPressure(penEvent(0.1), c);
  assert.ok(light > 0.02 && light < 0.15, `0.1 raw should map near 0.1, got ${light}`);
  const mid = resolvePointPressure(penEvent(0.4), c);
  assert.ok(Math.abs(mid - 0.51) < 0.02, `0.4 raw should map ≈0.51, got ${mid}`);
});

test("pen lift (hover at pressure 0) then a real stroke maps the stroke, not hover", () => {
  const c = ctx();
  resolvePointPressure(penEvent(0, 1000), c); // hovering, lifted tip
  resolvePointPressure(penEvent(0, 1010), c);
  const p = resolvePointPressure(penEvent(0.5, 2000), c); // tip lands mid-pressure
  assert.ok(Math.abs(p - 0.65) < 0.02, `0.5 raw should map ≈0.65, got ${p}`);
});

test("mouse first sample is the 0.65 baseline; fast flicks lighten, slow drags stay heavy", () => {
  const fast = ctx();
  assert.equal(resolvePointPressure(mouseEvent(0.5, 1000), fast), 0.65);
  // A fast flick: 500 world px in 16ms → EMA speed high → pressure falls.
  const flick = resolvePointPressure(mouseEvent(0.5, 1016), { ...fast, worldX: 500, worldY: 0 });
  assert.ok(flick <= 0.31, `fast flick should lighten toward 0.3, got ${flick}`);

  const slow = ctx();
  resolvePointPressure(mouseEvent(0.5, 1000), slow);
  // A slow, deliberate drag: 1 px in 100ms → pressure stays near 0.9.
  const drag = resolvePointPressure(mouseEvent(0.5, 1100), { ...slow, worldX: 1, worldY: 0 });
  assert.ok(drag >= 0.85, `slow drag should stay heavy toward 0.9, got ${drag}`);

  // The EMA smooths: a slow sample right after a fast flick recovers only
  // gradually (width breathes instead of flickering).
  const rec = ctx();
  resolvePointPressure(mouseEvent(0.5, 1000), rec);
  resolvePointPressure(mouseEvent(0.5, 1016), { ...rec, worldX: 500, worldY: 0 });
  const recovering = resolvePointPressure(mouseEvent(0.5, 1116), { ...rec, worldX: 501, worldY: 0 });
  assert.ok(recovering < 0.85, `one slow sample after a flick must not snap back to heavy, got ${recovering}`);
});

test("touch uses the velocity synthesizer like the mouse", () => {
  const c = ctx();
  assert.equal(resolvePointPressure(touchEvent(0.5, 1000), c), 0.65);
});

test("coalesced identity: a repeated/older timestamp reuses the last synthesis without poisoning the EMA", () => {
  const c = ctx();
  resolvePointPressure(mouseEvent(0.5, 1000), c);
  const moved = resolvePointPressure(mouseEvent(0.5, 1016), { ...c, worldX: 100, worldY: 0 });
  const emaAfterMove = c.velocity.ema;
  // The SAME event seen again (cursor relay + coalesced draw replay)…
  const again = resolvePointPressure(mouseEvent(0.5, 1016), { ...c, worldX: 100, worldY: 0 });
  assert.equal(again, moved);
  assert.equal(c.velocity.ema, emaAfterMove);
  // …and an OLDER coalesced sibling must not inject a zero/negative dt sample.
  const older = resolvePointPressure(mouseEvent(0.5, 1000), { ...c, worldX: 50, worldY: 0 });
  assert.equal(older, moved);
  assert.equal(c.velocity.ema, emaAfterMove);
});

test("velocity synthesizer resets between strokes", () => {
  const velocity = createVelocityPressure();
  const c = ctx({ velocity });
  resolvePointPressure(mouseEvent(0.5, 1000), c);
  resolvePointPressure(mouseEvent(0.5, 1016), { ...c, worldX: 400, worldY: 0 });
  resetVelocityPressure(velocity);
  assert.equal(velocity.lastT, null);
  assert.equal(velocity.ema, null);
  const fresh = resolvePointPressure(mouseEvent(0.5, 5000), { ...c, worldX: 999, worldY: 999 });
  assert.equal(fresh, 0.65);
});

test("Wacom-heavy calibration: sustained pressure above the ceiling raises it and persists", () => {
  const storage = new Map();
  const fakeStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, v),
  };
  const c = ctx();
  // A Wacom filling the band to ~0.95: 16 sustained samples past the Pencil
  // ceiling + margin lift the ceiling.
  for (let i = 0; i < 20; i += 1) {
    resolvePointPressure(penEvent(0.95, 1000 + i * 8), c);
  }
  assert.ok(c.penCal.ceiling > PEN_PRESSURE_DEFAULT_CEILING, `ceiling should have risen, got ${c.penCal.ceiling}`);
  assert.equal(c.penCal.dirty, true);
  assert.equal(mapPenPressure(c.penCal, 0.95), 1); // heavy press now reaches full size
  savePenCalibration(c.penCal, fakeStorage);
  const restored = loadPenCalibration(fakeStorage);
  assert.equal(restored.ceiling, c.penCal.ceiling);
  // The restored ceiling still maps a feather touch to the floor.
  assert.equal(resolvePointPressure(penEvent(0), ctx({ penCal: restored })), 0.02);
});

test("a single heavy spike does NOT recalibrate the session", () => {
  const c = ctx();
  resolvePointPressure(penEvent(0.99, 1000), c);
  assert.equal(c.penCal.ceiling, PEN_PRESSURE_DEFAULT_CEILING);
  assert.equal(c.penCal.dirty, false);
});
