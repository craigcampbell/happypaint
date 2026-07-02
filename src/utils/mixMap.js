// Wet-canvas mix map: a 1/8-scale offscreen mirror of LAYER 0 plus a cached
// CPU pixel array, so wet strokes can sample "what colour is under this dab?"
// for a few array reads per dab — NEVER a getImageData against the full
// 4000x2500 layer on the draw hot path.
//
// Freshness model (dirty-region, flush-on-demand): producers call markDirty()
// with the bbox of whatever just landed on layer 0 (stroke-buffer commits,
// image stamps, fills) — that's O(1). The actual pixel refresh (drawImage of
// the dirty bbox into the 1/8 canvas + a small getImageData of just that rect)
// runs lazily inside sample(), the first time a wet dab actually looks. So:
//  - rooms that never touch the wet toggle pay nothing but bbox unions;
//  - a big history replay does at most one refresh per wet stroke, not one
//    per committed stroke;
//  - flush timing is a pure function of the op order (deterministic replay).
// The map starts fully dirty, so late creation self-heals on first sample.

export const MIX_SCALE = 8;
const MIX_ALPHA_FLOOR = 32; // below this the paper shows through — nothing to pick up

// `getSource` returns the CURRENT layer-0 canvas (layer objects can be swapped
// wholesale by undo/history restores, so we can't capture the canvas itself).
export function createMixMap(getSource, worldWidth, worldHeight) {
  const w = Math.ceil(worldWidth / MIX_SCALE);
  const h = Math.ceil(worldHeight / MIX_SCALE);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const data = new Uint8ClampedArray(w * h * 4);
  let dirty = { x0: 0, y0: 0, w: worldWidth, h: worldHeight }; // fully dirty at birth

  // Union a world-space bbox ({x0, y0, w, h}) into the pending dirty rect.
  const markDirty = (bounds) => {
    if (!bounds || !(bounds.w > 0) || !(bounds.h > 0)) {
      return;
    }
    if (!dirty) {
      dirty = { x0: bounds.x0, y0: bounds.y0, w: bounds.w, h: bounds.h };
      return;
    }
    const x0 = Math.min(dirty.x0, bounds.x0);
    const y0 = Math.min(dirty.y0, bounds.y0);
    const x1 = Math.max(dirty.x0 + dirty.w, bounds.x0 + bounds.w);
    const y1 = Math.max(dirty.y0 + dirty.h, bounds.y0 + bounds.h);
    dirty = { x0, y0, w: x1 - x0, h: y1 - y0 };
  };

  const markAllDirty = () => {
    dirty = { x0: 0, y0: 0, w: worldWidth, h: worldHeight };
  };

  // Layer 0 was wiped: cheaper than re-reading a blank canvas.
  const clear = () => {
    ctx.clearRect(0, 0, w, h);
    data.fill(0);
    dirty = null;
  };

  // Re-mirror the dirty bbox: one downscaled drawImage + one SMALL getImageData
  // of the affected map cells, spliced into the cached CPU array.
  const flush = () => {
    const source = getSource();
    if (!source || !dirty) {
      return;
    }
    const bounds = dirty;
    dirty = null;
    const mx0 = Math.max(0, Math.floor(bounds.x0 / MIX_SCALE));
    const my0 = Math.max(0, Math.floor(bounds.y0 / MIX_SCALE));
    const mx1 = Math.min(w, Math.ceil((bounds.x0 + bounds.w) / MIX_SCALE));
    const my1 = Math.min(h, Math.ceil((bounds.y0 + bounds.h) / MIX_SCALE));
    const mw = mx1 - mx0;
    const mh = my1 - my0;
    if (mw <= 0 || mh <= 0) {
      return;
    }
    ctx.clearRect(mx0, my0, mw, mh);
    ctx.drawImage(source, mx0 * MIX_SCALE, my0 * MIX_SCALE, mw * MIX_SCALE, mh * MIX_SCALE, mx0, my0, mw, mh);
    const patch = ctx.getImageData(mx0, my0, mw, mh).data;
    for (let row = 0; row < mh; row += 1) {
      data.set(patch.subarray(row * mw * 4, (row + 1) * mw * 4), ((my0 + row) * w + mx0) * 4);
    }
  };

  // World coords in, [r, g, b] out — or null over (near-)transparent paper.
  const sample = (x, y) => {
    if (dirty) {
      flush();
    }
    const cx = (x / MIX_SCALE) | 0;
    const cy = (y / MIX_SCALE) | 0;
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) {
      return null;
    }
    const i = (cy * w + cx) * 4;
    if (data[i + 3] < MIX_ALPHA_FLOOR) {
      return null;
    }
    return [data[i], data[i + 1], data[i + 2]];
  };

  return { markDirty, markAllDirty, clear, sample };
}
