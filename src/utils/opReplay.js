// The standalone op interpreter — the third parity-tested consumer of the
// brush engine (after the studio's local + remote paths). Moved here from
// LiveRoomCanvas so BOTH the homepage spectator previews and the production
// film renderer replay ops through the exact same code.
//
// applyOp mirrors the studio's remote-op renderer byte-for-byte: non-eraser
// draw ops build in bbox-capped buffers at full alpha and land ONCE at the
// stroke's opacity on their end-op (#62); dab walks are per-stroke state so
// wire batching can't move dabs; smudge drags the paper directly; v3 stamp
// brushes defer until their tip pixels load.

import {
  drawBrushSegment,
  getStrokeDab,
  isBrushStampReady,
  makeSmudgeRenderer,
  makeStrokeEntryCore,
  pointRand,
  preloadBrushStamp,
  prepareStrokeCommit,
} from "./brushes";
import { createMixMap } from "./mixMap";
import { drawShape, drawText } from "./shapes";
import { CANVAS_WIDTH, CANVAS_HEIGHT } from "./layers";
import { normalizeSymmetry, transformPointsBySymmetry } from "./symmetry";

// Cap on concurrently BUFFERED in-progress strokes (each buffer ≤2048x2048);
// stroke #5 falls back to the legacy direct per-segment path.
export const MAX_STROKE_BUFFERS = 4;

// Apply one op to a full-res offscreen context. `lastMap` threads each
// stroke's previous point across op batches; `strokes` holds the per-strokeId
// in-progress buffers; `deferred` queues v3 stamp strokes until tips load.
export function applyOp(ctx, op, lastMap, strokes, onImage, mix, deferred) {
  if (!op) return;
  if (op.kind === "draw") {
    let entry = strokes.get(op.strokeId);
    const settings = op.settings || entry?.settings || {};
    const symmetry = normalizeSymmetry(settings.symmetry || "none");
    if (!op.symmetryExpanded && symmetry.copies > 1) {
      const paths = transformPointsBySymmetry(op.points || [], symmetry, CANVAS_WIDTH, CANVAS_HEIGHT);
      paths.forEach((points, copyIndex) => applyOp(
        ctx,
        {
          ...op,
          strokeId: `${op.strokeId}:sym${copyIndex}`,
          points,
          settings: { ...settings, symmetry: normalizeSymmetry("none") },
          symmetryExpanded: true,
        },
        lastMap,
        strokes,
        onImage,
        mix,
        deferred,
      ));
      return;
    }
    if (!op.settings && !entry) {
      const queued = deferred.get(op.strokeId);
      if (queued) queued.ops.push(op);
      return;
    }
    const pendingDab = settings.v >= 3 ? getStrokeDab(settings) : null;
    if (pendingDab?.shape === "stamp" && !isBrushStampReady(pendingDab)) {
      let queued = deferred.get(op.strokeId);
      if (!queued) {
        queued = { ops: [], loading: false };
        deferred.set(op.strokeId, queued);
      }
      queued.ops.push(op);
      if (!queued.loading) {
        queued.loading = true;
        preloadBrushStamp(pendingDab).then((ok) => {
          const readyQueue = deferred.get(op.strokeId);
          deferred.delete(op.strokeId);
          if (!ok || !readyQueue) return;
          for (const queuedOp of readyQueue.ops) applyOp(ctx, queuedOp, lastMap, strokes, onImage, mix, deferred);
          onImage?.();
        });
      }
      return;
    }
    let last = lastMap.get(op.strokeId);
    if (settings.brush === "eraser") {
      // Eraser keeps cutting the paper directly (destination-out can't buffer).
      for (const point of op.points || []) {
        drawBrushSegment(ctx, last || point, point, settings);
        last = point;
      }
      if (op.end) lastMap.delete(op.strokeId);
      else lastMap.set(op.strokeId, last);
      return;
    }
    if (settings.brush === "smudge") {
      // Smudge (private rooms) sample-and-drags the paper directly — the off
      // canvas IS this consumer's layer 0. No buffer; end just cleans up.
      let smudgeEntry = strokes.get(op.strokeId);
      if (!smudgeEntry) {
        smudgeEntry = { buf: null, lastTouch: 0, smudge: makeSmudgeRenderer(settings, ctx.canvas) };
        strokes.set(op.strokeId, smudgeEntry);
      }
      smudgeEntry.lastTouch = Date.now();
      for (const point of op.points || []) smudgeEntry.smudge.addPoints(ctx, [point]);
      if (op.end) {
        strokes.delete(op.strokeId);
        lastMap.delete(op.strokeId);
      }
      return;
    }
    if (!entry) {
      let buffered = 0;
      for (const open of strokes.values()) if (open.buf) buffered += 1;
      // The shared entry core (buffer / dab renderer / commit passes / pad /
      // opacity / commit composite) — the same builder the studio's local +
      // remote branches use, so nothing about a stroke is decided differently
      // here. Past the buffer cap (buffered: false) it is the legacy direct
      // per-segment fallback; null = a v3 op whose inline dab can't render.
      const core = makeStrokeEntryCore(settings, mix.sample, { buffered: buffered < MAX_STROKE_BUFFERS });
      if (!core) return;
      entry = { ...core, settings, lastTouch: 0 };
      strokes.set(op.strokeId, entry);
    }
    entry.lastTouch = Date.now();
    const seeded = settings.seed != null; // legacy ops carry no seed
    if (entry.buf) {
      for (const point of op.points || []) {
        if (entry.buf.ensure(point.x, point.y, entry.pad).overflow) {
          // Outgrew the 2048² cap: bank into the paper and restart (rare,
          // visually-minor opacity seam on giant strokes). Commit passes run
          // per chunk; renderer = null keeps the dab walk state across the
          // restart.
          prepareStrokeCommit(entry.buf, null, entry.fx);
          entry.buf.commit(ctx, entry.opacity);
          mix.markDirty(entry.buf.bounds());
          entry.buf.reset();
          entry.buf.ensure(point.x, point.y, entry.pad);
        }
        if (entry.renderer) {
          // One point at a time so batch boundaries can never matter.
          entry.renderer.addPoints(entry.buf.getCtx(), [point], entry.buf.base());
        } else {
          drawBrushSegment(entry.buf.getCtx(), last || point, point, entry.drawSettings, seeded ? pointRand(settings.seed, point.x, point.y) : Math.random);
        }
        last = point;
      }
    } else {
      for (const point of op.points || []) {
        drawBrushSegment(ctx, last || point, point, settings, seeded ? pointRand(settings.seed, point.x, point.y) : Math.random);
        last = point;
      }
    }
    if (op.end) {
      if (entry.buf) {
        // Flush the dab renderer + run the commit passes (wet edge / impasto
        // / grain), then the single opacity-stamped commit (legacy: no-op).
        prepareStrokeCommit(entry.buf, entry.renderer, entry.fx);
        entry.buf.commit(ctx, entry.opacity);
        mix.markDirty(entry.buf.bounds()); // paper changed under the wet-mix mirror
        entry.buf.dispose();
      }
      strokes.delete(op.strokeId);
      lastMap.delete(op.strokeId);
    } else {
      lastMap.set(op.strokeId, last);
    }
  } else if (op.kind === "shape") {
    drawShape(ctx, op.tool, op.start, op.end, op.opts || {});
  } else if (op.kind === "text") {
    drawText(ctx, op.point, op.text, op.opts || {});
  } else if (op.kind === "image" && op.dataUrl) {
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, op.x, op.y, op.w, op.h);
      mix.markDirty({ x0: op.x, y0: op.y, w: op.w, h: op.h });
      onImage?.();
    };
    img.src = op.dataUrl;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Offline frame renderer for film export: reset the given full-res world
// canvas, replay ONE frame's complete op list onto it, and settle async
// assets (embedded images, stamp-brush tips) before returning. The canvas is
// caller-owned and reusable so a 500-frame film never stacks allocations.
export async function replayFrameOnto(canvas, ops) {
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Pre-decode embedded images so applyOp's own Image() hits a warm cache and
  // lands within the settle window below.
  const imageOps = ops.filter((op) => op.kind === "image" && op.dataUrl);
  await Promise.all(
    imageOps.map(
      (op) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = resolve;
          img.onerror = resolve;
          img.src = op.dataUrl;
        }),
    ),
  );

  const mix = createMixMap(() => canvas, CANVAS_WIDTH, CANVAS_HEIGHT);
  const lastMap = new Map();
  const strokes = new Map();
  const deferred = new Map();
  for (const op of ops) {
    applyOp(ctx, op, lastMap, strokes, null, mix, deferred);
  }
  // Stamp-brush strokes may be parked until their tips load; wait them out.
  const deadline = Date.now() + 10000;
  while (deferred.size > 0 && Date.now() < deadline) {
    await sleep(50);
  }
  // Give warm-cache image onloads a beat to land.
  if (imageOps.length > 0) {
    await sleep(100);
  }
  // Commit anything still open (legacy strokes with no end marker).
  for (const [id, entry] of strokes) {
    if (entry.buf) {
      prepareStrokeCommit(entry.buf, entry.renderer, entry.fx);
      entry.buf.commit(ctx, entry.opacity);
      entry.buf.dispose();
    }
    strokes.delete(id);
  }
  return canvas;
}
