// Bbox-capped offscreen stroke buffer (Brush Engine Stage 1, bug #62).
//
// A live stroke is painted into this small offscreen canvas at FULL opacity,
// then composited over the document each frame — and committed into its layer
// exactly once at stroke end — at the stroke's opacity. That makes a
// 50%-opacity stroke read as 50% instead of accumulating per segment where the
// round caps overlap.
//
// Memory rules (iOS WebKit has a hard canvas-memory ceiling — NEVER allocate a
// full-size 4000x2500 scratch canvas per stroke):
// - lazily allocated, starting at 512x512 around the first point;
// - grows by power-of-2 re-allocation only when the stroke leaves the box;
// - hard-capped at 2048x2048. When a grow would exceed the cap, ensure()
//   reports { overflow: true } and the CALLER commits the current buffer to
//   the layer and reset()s to restart a fresh buffer at the new point (a rare,
//   visually-minor opacity seam on giant strokes — intended).
//
// Origin-offset model: the buffer covers the world rect {x0, y0, w, h} and its
// context carries a translate(-x0, -y0) transform, so callers draw in WORLD
// coordinates. Display compositing reads `canvas` + `x0/y0/w/h` (or bounds())
// directly. base() hands the same transform to the dab renderer as ONE stable
// object ({ s, tx, ty }, mutated in place — never reallocated), so a sprite
// dab can compose world x local with a single setTransform and addPoints can
// put the origin transform back with one call instead of save/restore.
//
// `composite` is the stroke's commit blend mode (getStrokeComposite in
// brushes.js — stored here once at creation by makeStrokeEntryCore) so every
// commit site inherits it by default and none can drift.

const MIN_SIZE = 512;
const MAX_SIZE = 2048;

// Shared result objects so the per-point ensure() call allocates nothing on
// the hot path.
const ENSURE_OK = { overflow: false };
const ENSURE_OVERFLOW = { overflow: true };

function pow2AtLeast(n) {
  let size = MIN_SIZE;
  while (size < n) size *= 2;
  return size;
}

export function createStrokeBuffer() {
  return {
    canvas: null,
    ctx: null,
    x0: 0,
    y0: 0,
    w: 0,
    h: 0,
    composite: "source-over",
    // The world->buffer transform as one reused object (see base()).
    _base: { s: 1, tx: 0, ty: 0 },

    // Make sure the buffer covers (x ± pad, y ± pad). Cheap bounds check in
    // the common case. Consecutive stroke points are each ensured, and the
    // buffer rect is convex, so every SEGMENT between them is covered too.
    ensure(x, y, pad) {
      const margin = Math.min(pad, MAX_SIZE / 2 - 4); // a giant pad can never dead-lock the cap
      if (this.canvas) {
        if (
          x - margin >= this.x0 &&
          y - margin >= this.y0 &&
          x + margin <= this.x0 + this.w &&
          y + margin <= this.y0 + this.h
        ) {
          return ENSURE_OK;
        }
        // Union of the current rect and the needed rect, snapped out to ints.
        const ux0 = Math.min(this.x0, Math.floor(x - margin));
        const uy0 = Math.min(this.y0, Math.floor(y - margin));
        const ux1 = Math.max(this.x0 + this.w, Math.ceil(x + margin));
        const uy1 = Math.max(this.y0 + this.h, Math.ceil(y + margin));
        const w = pow2AtLeast(ux1 - ux0);
        const h = pow2AtLeast(uy1 - uy0);
        if (w > MAX_SIZE || h > MAX_SIZE) {
          return ENSURE_OVERFLOW; // caller commits + reset()s, then re-ensures
        }
        // Centre the union inside the grown rect and copy the old content
        // across at its world position (the new transform does the mapping).
        const nx0 = Math.floor(ux0 - (w - (ux1 - ux0)) / 2);
        const ny0 = Math.floor(uy0 - (h - (uy1 - uy0)) / 2);
        const next = document.createElement("canvas");
        next.width = w;
        next.height = h;
        const nextCtx = next.getContext("2d");
        nextCtx.setTransform(1, 0, 0, 1, -nx0, -ny0);
        nextCtx.drawImage(this.canvas, this.x0, this.y0);
        this.canvas.width = 0; // release the old backing store eagerly (iOS)
        this.canvas = next;
        this.ctx = nextCtx;
        this.x0 = nx0;
        this.y0 = ny0;
        this.w = w;
        this.h = h;
        this._base.tx = -nx0;
        this._base.ty = -ny0;
        return ENSURE_OK;
      }
      // First allocation: a power-of-2 square centred on the point.
      const size = Math.min(MAX_SIZE, pow2AtLeast(Math.ceil(margin * 2 + 2)));
      this.x0 = Math.floor(x - size / 2);
      this.y0 = Math.floor(y - size / 2);
      this.w = size;
      this.h = size;
      this.canvas = document.createElement("canvas");
      this.canvas.width = size;
      this.canvas.height = size;
      this.ctx = this.canvas.getContext("2d");
      this.ctx.setTransform(1, 0, 0, 1, -this.x0, -this.y0);
      this._base.tx = -this.x0;
      this._base.ty = -this.y0;
      return ENSURE_OK;
    },

    // World-coordinate drawing context (thanks to the origin transform).
    getCtx() {
      return this.ctx;
    },

    has() {
      return this.canvas !== null;
    },

    bounds() {
      return { x0: this.x0, y0: this.y0, w: this.w, h: this.h };
    },

    // The buffer ctx's world-origin transform, { s: 1, tx: -x0, ty: -y0 }, as
    // ONE stable object: mutated by ensure()/reset(), never reallocated, so a
    // renderer can hold it for the whole stroke (across grows) with no
    // per-point allocation. Identity until the first ensure().
    base() {
      return this._base;
    },

    // Stamp the whole buffer onto a target context ONCE at the stroke's
    // opacity — the uniform-opacity commit — with the stroke's composite
    // (this.composite, set at creation; the parameter exists for probes).
    commit(targetCtx, opacity, composite = this.composite) {
      if (!this.canvas) {
        return;
      }
      targetCtx.save();
      targetCtx.globalAlpha = opacity;
      targetCtx.globalCompositeOperation = composite;
      targetCtx.drawImage(this.canvas, this.x0, this.y0);
      targetCtx.restore();
    },

    // Drop the pixels but keep the manager usable (overflow restart).
    reset() {
      if (this.canvas) {
        this.canvas.width = 0; // free the backing store now, not at GC time
      }
      this.canvas = null;
      this.ctx = null;
      this.w = 0;
      this.h = 0;
      this._base.tx = 0;
      this._base.ty = 0;
    },

    dispose() {
      this.reset();
    },
  };
}
