import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RADIAL_COPIES,
  MAX_RADIAL_COPIES,
  getSymmetryCopyCount,
  mirrorCoordinate,
  normalizeSymmetry,
  rotatePointAroundCenter,
  transformPointBySymmetry,
  transformPointsBySymmetry,
  transformSymmetryPoint,
} from "../src/utils/symmetry.js";

const approximatelyEqual = (actual, expected, epsilon = 1e-10) => {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
};

const assertPointApproximately = (actual, expected) => {
  approximatelyEqual(actual.x, expected.x);
  approximatelyEqual(actual.y, expected.y);
};

test("normalizeSymmetry returns a canonical fixed copy count for every fixed mode", () => {
  assert.deepEqual(normalizeSymmetry(), { mode: "none", copies: 1 });
  assert.deepEqual(normalizeSymmetry(null), { mode: "none", copies: 1 });
  assert.deepEqual(normalizeSymmetry(" mirror "), { mode: "mirror", copies: 2 });
  assert.deepEqual(normalizeSymmetry({ mode: "QUAD", copies: 7 }), { mode: "quad", copies: 4 });
  assert.deepEqual(normalizeSymmetry({ mode: "none", copies: 8 }), { mode: "none", copies: 1 });
});

test("normalizeSymmetry fails closed for unknown or malformed modes", () => {
  assert.deepEqual(normalizeSymmetry("diagonal"), { mode: "none", copies: 1 });
  assert.deepEqual(normalizeSymmetry({ mode: 42, copies: 8 }), { mode: "none", copies: 1 });
  assert.deepEqual(normalizeSymmetry({ copies: 8 }), { mode: "none", copies: 1 });
  assert.deepEqual(normalizeSymmetry(["radial"]), { mode: "none", copies: 1 });
});

test("normalizeSymmetry clamps radial copies to the deterministic 2..8 range", () => {
  assert.deepEqual(normalizeSymmetry("radial"), {
    mode: "radial",
    copies: DEFAULT_RADIAL_COPIES,
  });
  assert.deepEqual(normalizeSymmetry({ mode: "radial", copies: 1 }), {
    mode: "radial",
    copies: 2,
  });
  assert.deepEqual(normalizeSymmetry({ mode: "radial", copies: 5.9 }), {
    mode: "radial",
    copies: 5,
  });
  assert.deepEqual(normalizeSymmetry({ mode: "radial", copies: 99 }), {
    mode: "radial",
    copies: MAX_RADIAL_COPIES,
  });
  assert.deepEqual(normalizeSymmetry({ mode: "radial", copies: "6" }), {
    mode: "radial",
    copies: DEFAULT_RADIAL_COPIES,
  });
  assert.deepEqual(normalizeSymmetry({ mode: "radial", copies: "not-a-number" }), {
    mode: "radial",
    copies: DEFAULT_RADIAL_COPIES,
  });
});

test("coordinate and rotation helpers transform without mutating their inputs", () => {
  assert.equal(mirrorCoordinate(25, 100), 175);

  const point = { x: 75, y: 50, pressure: 0.4 };
  const center = { x: 50, y: 50 };
  const rotated = rotatePointAroundCenter(point, center, Math.PI / 2);

  assertPointApproximately(rotated, { x: 50, y: 75 });
  assert.equal(rotated.pressure, 0.4);
  assert.deepEqual(point, { x: 75, y: 50, pressure: 0.4 });
  assert.deepEqual(center, { x: 50, y: 50 });
});

test("none returns one cloned point and preserves metadata", () => {
  const point = { x: 10, y: 20, pressure: 0.75, time: 123 };
  const result = transformPointBySymmetry(point, "none", 400, 200);

  assert.deepEqual(result, [{ x: 10, y: 20, pressure: 0.75, time: 123 }]);
  assert.notEqual(result[0], point);
  assert.equal(getSymmetryCopyCount("none"), 1);
});

test("mirror reflects across the canvas vertical center", () => {
  const result = transformPointBySymmetry(
    { x: 25, y: 40, pressure: 0.5 },
    "mirror",
    200,
    100,
  );

  assert.deepEqual(result, [
    { x: 25, y: 40, pressure: 0.5 },
    { x: 175, y: 40, pressure: 0.5 },
  ]);
});

test("quad reflects across both center axes in stable copy order", () => {
  const result = transformPointBySymmetry({ x: 25, y: 10 }, "quad", 200, 100);

  assert.deepEqual(result, [
    { x: 25, y: 10 },
    { x: 175, y: 10 },
    { x: 25, y: 90 },
    { x: 175, y: 90 },
  ]);
});

test("radial creates evenly rotated copies around canvas center up to eight", () => {
  const result = transformPointBySymmetry(
    { x: 125, y: 50, pressure: 1 },
    { mode: "radial", copies: 4 },
    200,
    100,
  );

  const expected = [
    { x: 125, y: 50 },
    { x: 100, y: 75 },
    { x: 75, y: 50 },
    { x: 100, y: 25 },
  ];
  assert.equal(result.length, 4);
  result.forEach((point, index) => {
    assertPointApproximately(point, expected[index]);
    assert.equal(point.pressure, 1);
  });

  assert.equal(
    transformPointBySymmetry({ x: 1, y: 1 }, { mode: "radial", copies: 20 }, 10, 10).length,
    MAX_RADIAL_COPIES,
  );
});

test("stroke expansion returns separate paths and preserves point order", () => {
  const points = [
    { x: 10, y: 20, pressure: 0.2 },
    { x: 30, y: 40, pressure: 0.8 },
  ];
  const paths = transformPointsBySymmetry(points, "mirror", 100, 80);

  assert.deepEqual(paths, [
    [
      { x: 10, y: 20, pressure: 0.2 },
      { x: 30, y: 40, pressure: 0.8 },
    ],
    [
      { x: 90, y: 20, pressure: 0.2 },
      { x: 70, y: 40, pressure: 0.8 },
    ],
  ]);
  assert.notEqual(paths[0][0], points[0]);
  assert.deepEqual(points, [
    { x: 10, y: 20, pressure: 0.2 },
    { x: 30, y: 40, pressure: 0.8 },
  ]);
});

test("center points remain fixed under every symmetry copy", () => {
  const center = { x: 100, y: 50 };

  for (const symmetry of ["none", "mirror", "quad", { mode: "radial", copies: 8 }]) {
    const result = transformPointBySymmetry(center, symmetry, 200, 100);
    for (const point of result) {
      assertPointApproximately(point, center);
    }
  }
});

test("invalid points, dimensions, and copy indexes throw actionable errors", () => {
  assert.throws(
    () => transformPointBySymmetry({ x: Number.NaN, y: 0 }, "mirror", 100, 100),
    /point\.x must be a finite number/,
  );
  assert.throws(
    () => transformPointsBySymmetry([{ x: 1 }], "mirror", 100, 100),
    /points\[0\] is invalid: point\.y must be a finite number/,
  );
  assert.throws(
    () => transformPointsBySymmetry({}, "none", 100, 100),
    /points must be an array/,
  );
  assert.throws(
    () => transformPointsBySymmetry([], "none", Number.NaN, 100),
    /canvasWidth must be a finite number/,
  );
  assert.throws(
    () => transformPointBySymmetry({ x: 0, y: 0 }, "none", 0, 100),
    /canvas dimensions must be greater than zero/,
  );
  assert.throws(
    () => transformSymmetryPoint({ x: 0, y: 0 }, "mirror", 2, 100, 100),
    /copyIndex must be an integer from 0 to 1/,
  );
});
