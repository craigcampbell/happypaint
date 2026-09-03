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
//
// Prefetch (App.jsx, idle after a commit): flush() is public so the refresh
// can run while the pen is up instead of on the first wet dab of the next
// stroke. A prefetch reads layer 0 EARLIER than the lazy path would, so it is
// only op-order-equivalent if nothing lands on layer 0 between the prefetch
// and the sample that would have flushed — and layer 0 has writers that never
// markDirty (eraser, smudge, shapes, text: direct, unbuffered). The map keeps
// a ledger of what its prefetches have read since the last sample-flush point
// (`prefetched`), and invalidatePrefetch() — called by App.jsx at every such
// unmarked write — puts exactly that rect back on the dirty list, so the next
// sample re-reads it where the lazy path would have read it for the first
// time. It never dirties more than the lazy path still had dirty (the ledger
// is cleared at every sample, the lazy flush point), so a prefetching map and
// a lazy one — history replay, spectators, the other clients — read the same
// bytes at the same op-order points. Over-calling invalidatePrefetch() is
// always safe; forgetting a write site is the only way to diverge.

export const MIX_SCALE = 8;
const MIX_ALPHA_FLOOR = 32; // below this the paper shows through — nothing to pick up

// sample() hands back THIS array every time (a dab reads r/g/b and moves on):
// no allocation per dab. Callers that keep a sample across calls must copy it.
const SAMPLE = [0, 0, 0];

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
  // World rects a PREFETCH flush has read since the last sample (see the
  // header): what invalidatePrefetch() hands back to `dirty`.
  let prefetched = null;

  const union = (a, b) => {
    if (!a) {
      return { x0: b.x0, y0: b.y0, w: b.w, h: b.h };
    }
    const x0 = Math.min(a.x0, b.x0);
    const y0 = Math.min(a.y0, b.y0);
    const x1 = Math.max(a.x0 + a.w, b.x0 + b.w);
    const y1 = Math.max(a.y0 + a.h, b.y0 + b.h);
    return { x0, y0, w: x1 - x0, h: y1 - y0 };
  };

  // Union a world-space bbox ({x0, y0, w, h}) into the pending dirty rect.
  const markDirty = (bounds) => {
    if (!bounds || !(bounds.w > 0) || !(bounds.h > 0)) {
      return;
    }
    dirty = union(dirty, bounds);
  };

  const markAllDirty = () => {
    dirty = { x0: 0, y0: 0, w: worldWidth, h: worldHeight };
    prefetched = null; // everything is dirty — nothing left to hand back
  };

  // Layer 0 was wiped: cheaper than re-reading a blank canvas.
  const clear = () => {
    ctx.clearRect(0, 0, w, h);
    data.fill(0);
    dirty = null;
    prefetched = null;
  };

  // Re-mirror the dirty bbox: one downscaled drawImage + one SMALL getImageData
  // of the affected map cells, spliced into the cached CPU array.
  const refresh = () => {
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

  // PREFETCH entry point (idle, pen up): refresh now, and remember what was
  // read so an unmarked write before the next sample can hand it back.
  const flush = () => {
    if (!dirty) {
      return;
    }
    prefetched = union(prefetched, dirty);
    refresh();
  };

  // An unmarked write landed on layer 0 (eraser / smudge / shape / text —
  // paths that draw the layer directly and never markDirty): anything a
  // prefetch read since the last sample may be stale now. Re-dirty exactly
  // that, so the next sample reads it where the lazy path would have.
  const invalidatePrefetch = () => {
    if (prefetched) {
      dirty = union(dirty, prefetched);
      prefetched = null;
    }
  };

  // World coords in, [r, g, b] out — or null over (near-)transparent paper.
  // The returned array is the shared SAMPLE (see above): read it before the
  // next sample() call, copy it if you need to keep it.
  const sample = (x, y) => {
    if (dirty) {
      refresh();
    }
    // This is the lazy flush point: from here on a prefetch has nothing the
    // lazy path would not also have read.
    if (prefetched) {
      prefetched = null;
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
    SAMPLE[0] = data[i];
    SAMPLE[1] = data[i + 1];
    SAMPLE[2] = data[i + 2];
    return SAMPLE;
  };

  return { markDirty, markAllDirty, clear, sample, flush, invalidatePrefetch };
}
