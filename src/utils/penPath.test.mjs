import assert from "node:assert/strict";
import test from "node:test";
import { constrainAngle, penPressureAt, samplePenPath } from "./penPath.js";

const corner = (x, y) => ({ x, y, ox: 0, oy: 0 });

test("a straight path keeps its end points and even spacing", () => {
  const points = samplePenPath([corner(10, 10), corner(110, 10)], { taper: false });
  assert.deepEqual(points[0], { x: 10, y: 10, pressure: 0.7 });
  assert.equal(points.at(-1).x, 110);
  assert.ok(points.length > 25 && points.length < 60);
  assert.ok(points.every((p) => p.y === 10));
});

test("corners survive sampling exactly", () => {
  const points = samplePenPath([corner(0, 0), corner(50, 37), corner(100, 0)], { taper: false });
  assert.ok(points.some((p) => p.x === 50 && p.y === 37));
});

test("a dragged handle bends the segment", () => {
  const points = samplePenPath([{ x: 0, y: 0, ox: 0, oy: -60 }, corner(100, 0)], { taper: false });
  assert.ok(Math.min(...points.map((p) => p.y)) < -15);
});

test("a closed path returns to its first point", () => {
  const points = samplePenPath([corner(0, 0), corner(60, 0), corner(60, 60)], { closed: true });
  assert.equal(points.at(-1).x, 0);
  assert.equal(points.at(-1).y, 0);
  assert.ok(points.every((p) => p.pressure === 0.7));
});

test("taper thins both ends and stays within pressure range", () => {
  const points = samplePenPath([corner(0, 0), corner(400, 0)], { taper: true });
  const mid = points[Math.floor(points.length / 2)].pressure;
  assert.ok(points[0].pressure < 0.2 && points.at(-1).pressure < 0.2);
  assert.ok(mid > 0.8 && mid <= 1);
  assert.equal(penPressureAt(50, 100, { taper: false }), 0.7);
});

test("fewer than two nodes samples nothing", () => {
  assert.deepEqual(samplePenPath([corner(1, 1)]), []);
});

test("shift snaps to 45 degree steps", () => {
  const snapped = constrainAngle({ x: 0, y: 0 }, { x: 100, y: 8 });
  assert.ok(Math.abs(snapped.y) < 1e-9 && Math.abs(snapped.x - Math.hypot(100, 8)) < 1e-9);
});
