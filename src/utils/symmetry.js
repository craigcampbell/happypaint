// Pure symmetry helpers for Kaleido Jam.
//
// Persist the result of normalizeSymmetry() on a draw op. Replaying that
// canonical value ensures every client expands the stroke in the same way,
// even if UI labels or defaults change later.

export const SYMMETRY_MODES = Object.freeze(["none", "mirror", "quad", "radial"]);
export const MAX_RADIAL_COPIES = 8;
export const DEFAULT_RADIAL_COPIES = 8;
export const DEFAULT_SYMMETRY = Object.freeze({ mode: "none", copies: 1 });

const MODE_COPY_COUNTS = Object.freeze({
  none: 1,
  mirror: 2,
  quad: 4,
});

function normalizeMode(value) {
  if (typeof value !== "string") {
    return "none";
  }

  const mode = value.trim().toLowerCase();
  return SYMMETRY_MODES.includes(mode) ? mode : "none";
}

/**
 * Convert user, room, or replay data to the one canonical symmetry shape.
 *
 * Unknown modes fail closed to no symmetry. Fixed modes ignore a supplied copy
 * count. Radial counts are rounded down and clamped to 2..8.
 */
export function normalizeSymmetry(value) {
  const source = typeof value === "string" ? { mode: value } : value;
  const mode = normalizeMode(source?.mode);

  if (mode !== "radial") {
    return { mode, copies: MODE_COPY_COUNTS[mode] };
  }

  const requestedCopies = source?.copies;
  const copies = Number.isFinite(requestedCopies)
    ? Math.min(MAX_RADIAL_COPIES, Math.max(2, Math.floor(requestedCopies)))
    : DEFAULT_RADIAL_COPIES;

  return { mode, copies };
}

function assertFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
}

function assertPoint(point, label = "point") {
  if (!point || typeof point !== "object" || Array.isArray(point)) {
    throw new TypeError(`${label} must be an object with finite x and y coordinates`);
  }
  assertFiniteNumber(point.x, `${label}.x`);
  assertFiniteNumber(point.y, `${label}.y`);
}

function assertCanvasDimensions(canvasWidth, canvasHeight) {
  assertFiniteNumber(canvasWidth, "canvasWidth");
  assertFiniteNumber(canvasHeight, "canvasHeight");
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    throw new RangeError("canvas dimensions must be greater than zero");
  }
}

/**
 * Reflect one coordinate across a center coordinate.
 */
export function mirrorCoordinate(coordinate, centerCoordinate) {
  assertFiniteNumber(coordinate, "coordinate");
  assertFiniteNumber(centerCoordinate, "centerCoordinate");
  return centerCoordinate * 2 - coordinate;
}

/**
 * Rotate a point around a supplied center. Extra point fields are retained.
 */
export function rotatePointAroundCenter(point, center, radians) {
  assertPoint(point);
  assertPoint(center, "center");
  assertFiniteNumber(radians, "radians");

  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);

  return {
    ...point,
    x: center.x + dx * cosine - dy * sine,
    y: center.y + dx * sine + dy * cosine,
  };
}

/**
 * Return how many paths a canonical or untrusted symmetry value produces.
 */
export function getSymmetryCopyCount(symmetry) {
  return normalizeSymmetry(symmetry).copies;
}

/**
 * Transform one point for one symmetry copy.
 *
 * Copy zero is always the original point. For mirror, reflection is across the
 * canvas's vertical center line. Quad reflects across the vertical axis, the
 * horizontal axis, then both. Radial copies rotate evenly around canvas center.
 */
export function transformSymmetryPoint(
  point,
  symmetry,
  copyIndex,
  canvasWidth,
  canvasHeight,
) {
  assertPoint(point);
  assertCanvasDimensions(canvasWidth, canvasHeight);

  const normalized = normalizeSymmetry(symmetry);
  if (!Number.isInteger(copyIndex) || copyIndex < 0 || copyIndex >= normalized.copies) {
    throw new RangeError(`copyIndex must be an integer from 0 to ${normalized.copies - 1}`);
  }

  if (copyIndex === 0 || normalized.mode === "none") {
    return { ...point };
  }

  const center = {
    x: canvasWidth / 2,
    y: canvasHeight / 2,
  };

  if (normalized.mode === "mirror") {
    return { ...point, x: mirrorCoordinate(point.x, center.x) };
  }

  if (normalized.mode === "quad") {
    if (copyIndex === 1) {
      return { ...point, x: mirrorCoordinate(point.x, center.x) };
    }
    if (copyIndex === 2) {
      return { ...point, y: mirrorCoordinate(point.y, center.y) };
    }
    return {
      ...point,
      x: mirrorCoordinate(point.x, center.x),
      y: mirrorCoordinate(point.y, center.y),
    };
  }

  const radians = (Math.PI * 2 * copyIndex) / normalized.copies;
  return rotatePointAroundCenter(point, center, radians);
}

/**
 * Expand a point into one point per symmetry copy.
 */
export function transformPointBySymmetry(point, symmetry, canvasWidth, canvasHeight) {
  const copies = getSymmetryCopyCount(symmetry);
  return Array.from(
    { length: copies },
    (_, copyIndex) => transformSymmetryPoint(
      point,
      symmetry,
      copyIndex,
      canvasWidth,
      canvasHeight,
    ),
  );
}

/**
 * Expand a stroke into parallel paths, one path per symmetry copy.
 *
 * Keeping copies as separate paths prevents callers from drawing connecting
 * lines between the mirrored/rotated versions of a stroke.
 */
export function transformPointsBySymmetry(points, symmetry, canvasWidth, canvasHeight) {
  if (!Array.isArray(points)) {
    throw new TypeError("points must be an array");
  }
  assertCanvasDimensions(canvasWidth, canvasHeight);

  const copies = getSymmetryCopyCount(symmetry);
  return Array.from(
    { length: copies },
    (_, copyIndex) => points.map(
      (point, pointIndex) => {
        try {
          return transformSymmetryPoint(
            point,
            symmetry,
            copyIndex,
            canvasWidth,
            canvasHeight,
          );
        } catch (error) {
          if (error instanceof TypeError) {
            throw new TypeError(`points[${pointIndex}] is invalid: ${error.message}`);
          }
          throw error;
        }
      },
    ),
  );
}
