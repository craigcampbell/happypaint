// Cold frames. A hydrated frame owns full-size layer canvases (~40MB each);
// that is why a scene used to cap at 8 frames. In a server-synced animation
// room only the ACTIVE frame and its neighbors stay hydrated now — every
// other frame keeps its op list (the shared source of truth) plus a compressed
// raster, and re-hydrates by replaying its ops through the parity-tested
// offline interpreter when the artist steps onto it.
//
// Rasters are 1600x1000 WebP blobs (≈50–150KB): the size both exporters
// encode at, small enough that a 60-frame scene costs a few MB, and decoded
// on demand into a tiny LRU of ImageBitmaps for playback, thumbnails, onion
// skin and export.

import { CANVAS_WIDTH, CANVAS_HEIGHT, compositeLayers } from "./layers";
import { replayFrameOnto, replayFrameComposite } from "./opReplay";
import {
  CheckpointError,
  checkpointClientSupport,
  decodeCheckpoint,
  installCheckpointLayers,
  releaseCheckpoint,
} from "./checkpointClient";

export const RASTER_WIDTH = 1600;
export const RASTER_HEIGHT = 1000;
// Frames either side of the active one kept as live canvases (onion skin
// reads ±1; ±2 makes flipping back and forth instant).
export const HYDRATED_RADIUS = 2;

let world = null; // one reusable full-size replay surface (lazy, ~40MB)
let scratch = null; // one reusable raster-size compositing surface
// Reusable per-layer replay surfaces for rasterizeOps (replayFrameComposite's
// optional scratch): without them EVERY cold cel's rasterization allocated N
// full-size canvases (~40MB each). Bounded by the deepest stack rasterized
// since the last releaseWorldCanvas; pixels are always cleared before use.
let compositeScratch = [];

export function getWorldCanvas() {
  if (!world) {
    world = document.createElement("canvas");
    world.width = CANVAS_WIDTH;
    world.height = CANVAS_HEIGHT;
  }
  return world;
}
export function releaseWorldCanvas() {
  if (world) {
    world.width = 1;
    world.height = 1;
    world = null;
  }
  for (const canvas of compositeScratch) {
    canvas.width = 1;
    canvas.height = 1;
  }
  compositeScratch = [];
}
function getScratch(width, height) {
  if (!scratch) scratch = document.createElement("canvas");
  if (scratch.width !== width || scratch.height !== height) {
    scratch.width = width;
    scratch.height = height;
  }
  return scratch;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality));
}

// Encode a raster from `draw(ctx, w, h)` (a callback so callers can composite a
// layer stack or draw a world canvas). WebP when the browser can encode it,
// PNG otherwise (Safari < 16 returns null for image/webp).
export async function encodeRaster(draw, width = RASTER_WIDTH, height = RASTER_HEIGHT) {
  const canvas = getScratch(width, height);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, width, height);
  draw(ctx, width, height);
  const webp = await canvasToBlob(canvas, "image/webp", 0.92);
  if (webp && webp.type === "image/webp") return webp;
  return canvasToBlob(canvas, "image/png");
}

// Raster for a frame this client never hydrated: replay its ops offline into
// the shared world canvas, then downscale + encode. `layersMeta` is the
// frame's server-canonical layer stack (frame.layerMeta): with more than one
// layer the ops route into per-layer surfaces and composite in stack order
// honoring visibility + opacity — the same structure coolFrame encodes from
// the live layers, so a frame's raster no longer depends on whether THIS
// client ever visited it. No metadata (legacy rooms) keeps flat replay;
// the composite helper also preserves the opaque, visible single-layer path.
// The per-layer surfaces come from the module pool (compositeScratch), NOT a
// per-call allocation — a 60-cel sweep reuses one stack's worth of canvases.
//
// Phase 4: a frame carrying `checkpoint` (a verified wire descriptor retained
// from the scene's history) restores its trusted baseline BEFORE the tail —
// the checkpoint is re-decoded/validated here (bounded, cancellable), its
// layers drawn 1:1 into the scratch stack, its mix-map continuation state
// restored, and only then do the retained tail ops replay. A checkpoint that
// fails validation rejects with CheckpointError: the caller must drop the
// poisoned descriptor and refetch the full scene — NEVER paint the bare tail.
//
// All rasterization serializes through one module chain: the world canvas and
// the scratch stack are singletons, so concurrent callers (idle rasterizer,
// playback snapshotter, exporter) would otherwise clobber each other mid-job.
let rasterChain = Promise.resolve();
export function rasterizeOps(ops, layersMeta = null, checkpoint = null, options = {}) {
  const job = rasterChain.then(() => rasterizeOpsNow(ops, layersMeta, checkpoint, options));
  rasterChain = job.catch(() => {});
  return job;
}

async function rasterizeOpsNow(ops, layersMeta, checkpoint, options) {
  const surface = getWorldCanvas();
  if (checkpoint) {
    await restoreCheckpointTail(surface, layersMeta, ops || [], checkpoint, options);
  } else if (Array.isArray(layersMeta) && layersMeta.length > 0) {
    await replayFrameComposite(surface, layersMeta, ops || [], CANVAS_WIDTH, CANVAS_HEIGHT, compositeScratch);
  } else {
    await replayFrameOnto(surface, ops || [], CANVAS_WIDTH, CANVAS_HEIGHT);
  }
  return encodeRaster((ctx, w, h) => ctx.drawImage(surface, 0, 0, w, h));
}

// Restore `descriptor`'s verified baseline into the pooled per-layer scratch
// canvases, replay the retained tail over it, then composite the stack onto
// `surface` exactly like replayFrameComposite (visibility + opacity in stack
// order, hidden layers' pixels intact underneath).
async function restoreCheckpointTail(surface, layersMeta, ops, descriptor, options) {
  const metas = Array.isArray(layersMeta) && layersMeta.length ? layersMeta : null;
  if (!metas) throw new CheckpointError("layers", "a frame checkpoint requires canonical layer metadata");
  const rendererVersion = options.rendererVersion ?? checkpointClientSupport();
  const decoded = await decodeCheckpoint(
    { schemaVersion: 1, rendererVersion, frames: [descriptor] },
    {
      rendererVersion,
      expectedFrames: [{ id: descriptor.frameId, layers: metas }],
      tailOps: ops,
      tailLocalOps: true, // the retained tail may hold locally-originated ops (no server id yet)
      isCancelled: options.isCancelled,
      limits: options.limits,
    },
  );
  const frame = decoded.frames[0];
  try {
    const indexOfLayer = new Map();
    const pseudoLayers = metas.map((meta, i) => {
      if (!compositeScratch[i] || compositeScratch[i].width !== CANVAS_WIDTH || compositeScratch[i].height !== CANVAS_HEIGHT) {
        compositeScratch[i] = document.createElement("canvas");
        compositeScratch[i].width = CANVAS_WIDTH;
        compositeScratch[i].height = CANVAS_HEIGHT;
      }
      const canvas = compositeScratch[i];
      const layerCtx = canvas.getContext("2d");
      layerCtx.setTransform(1, 0, 0, 1, 0, 0);
      layerCtx.globalCompositeOperation = "source-over";
      layerCtx.globalAlpha = 1;
      indexOfLayer.set(meta.id, i);
      return { id: meta.id, canvas };
    });
    // Validated against the same metadata at decode; install replaces each
    // scratch layer's pixels 1:1 (no visibility/opacity bake) and closes the
    // bitmaps as they land.
    installCheckpointLayers(frame, pseudoLayers);
    const targetFor = (op) => compositeScratch[indexOfLayer.has(op.layerId) ? indexOfLayer.get(op.layerId) : 0].getContext("2d");
    await replayFrameOnto(compositeScratch[0], ops, CANVAS_WIDTH, CANVAS_HEIGHT, targetFor, {
      preservePixels: true, // the checkpoint baseline IS the starting pixels
      mixState: frame.mixState,
    });
    const ctx = surface.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, surface.width, surface.height);
    for (let i = 0; i < metas.length; i += 1) {
      const meta = metas[i];
      if (meta.visible === false || !(Number(meta.opacity) > 0)) continue;
      ctx.globalAlpha = typeof meta.opacity === "number" ? Math.max(0, Math.min(1, meta.opacity)) : 1;
      ctx.drawImage(compositeScratch[i], 0, 0, surface.width, surface.height);
    }
    ctx.globalAlpha = 1;
  } finally {
    releaseCheckpoint(decoded); // anything not installed still gets closed
  }
}

export function decodeRaster(blob) {
  return createImageBitmap(blob);
}

// ---- The cold-raster contract ----------------------------------------------
// A cold frame's raster is a composite of its layer stack, so the stack's
// RENDER-AFFECTING fields — the ordered layer ids, each layer's visibility
// and its opacity — are part of the raster's identity, exactly like the op
// count. Names and locks don't move a pixel and must NOT trigger a rebuild.
// `layerRenderSig` fingerprints just the render-affecting fields so a layer
// sync can tell "the raster no longer matches" apart from "a label changed".
export function layerRenderSig(layersMeta) {
  if (!Array.isArray(layersMeta) || layersMeta.length === 0) return "";
  return layersMeta
    .map((meta) => `${meta?.id}:${meta?.visible === false ? 0 : 1}:${typeof meta?.opacity === "number" ? Math.max(0, Math.min(1, meta.opacity)) : 1}`)
    .join("|");
}

// The ONE staleness check every cold-raster consumer shares (the idle
// rasterizer, the diagnostics handle): a cold frame holding ops needs a
// (re)build when its raster was made from a different op count OR a different
// render-affecting layer stack. A hydrated frame never does — it paints its
// live canvases; a blank cold frame has nothing to build.
export function coldRasterStale(frame) {
  if (!frame || frame.layers) return false;
  const count = (frame.ops || []).length;
  if (count === 0) return false;
  return frame.rasterCount !== count || (frame.rasterSig || "") !== layerRenderSig(frame.layerMeta);
}

// A cold-raster build is async (offline replay + WebP encode). While it is in
// flight the inputs can change: an op lands, a clear replaces the op list, a
// layer sync hides a layer. Capture a ticket BEFORE the await and install the
// blob ONLY if it is still current — otherwise the frame would wear a raster
// built from inputs it no longer has, and with the op count UNCHANGED (a
// hidden layer, a reorder) the old count-based check could never tell.
// `frame.rasterGen` is bumped by every invalidation site; the ops identity
// catches a swapped list, the count an in-place push, the sig a metadata edit.
export function rasterTicket(frame) {
  return { gen: frame.rasterGen || 0, ops: frame.ops || null, count: (frame.ops || []).length, sig: layerRenderSig(frame.layerMeta) };
}
export function rasterTicketCurrent(frame, ticket) {
  return !!frame && !!ticket
    && (frame.rasterGen || 0) === ticket.gen
    && (frame.ops || null) === ticket.ops
    && (frame.ops || []).length === ticket.count
    && layerRenderSig(frame.layerMeta) === ticket.sig;
}

// Tiny LRU of decoded rasters, bounded by BOTH count and BYTES. Every entry
// accounts its real allocation (width × height × 4) — a cache of 1600x1000
// bitmaps is ~6.4MB apiece, and the Phase 4 contract budgets decoded bitmaps
// by bytes, not by an item count that silently scales with bitmap size.
// Evicted bitmaps are closed to free GPU memory.
export function createBitmapCache(limit = 16, maxBytes = Infinity) {
  const map = new Map(); // key -> { bitmap, bytes }
  const pending = new Map();
  let totalBytes = 0;
  const entryBytes = (bitmap) => {
    const w = Number(bitmap?.width);
    const h = Number(bitmap?.height);
    return w > 0 && h > 0 ? w * h * 4 : RASTER_WIDTH * RASTER_HEIGHT * 4;
  };
  const evictWhileOver = () => {
    while (map.size > limit || totalBytes > maxBytes) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      const entry = map.get(oldest);
      entry?.bitmap?.close?.();
      totalBytes -= entry?.bytes || 0;
      map.delete(oldest);
    }
  };
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      map.delete(key);
      map.set(key, hit); // bump to most-recent
      return hit.bitmap;
    },
    has(key) {
      return map.has(key);
    },
    get bytes() {
      return totalBytes;
    },
    // Decode (once) and cache; concurrent callers share the in-flight decode.
    load(key, blob) {
      const hit = this.get(key);
      if (hit) return Promise.resolve(hit);
      if (pending.has(key)) return pending.get(key);
      const job = decodeRaster(blob)
        .then((bitmap) => {
          this.set(key, bitmap);
          return bitmap;
        })
        .catch(() => null)
        .finally(() => pending.delete(key));
      pending.set(key, job);
      return job;
    },
    set(key, bitmap) {
      if (map.has(key)) {
        const old = map.get(key);
        old?.bitmap?.close?.();
        totalBytes -= old?.bytes || 0;
        map.delete(key);
      }
      map.set(key, { bitmap, bytes: entryBytes(bitmap) });
      totalBytes += entryBytes(bitmap);
      evictWhileOver();
    },
    delete(key) {
      const entry = map.get(key);
      entry?.bitmap?.close?.();
      totalBytes -= entry?.bytes || 0;
      map.delete(key);
    },
    // Drop every entry whose key starts with `prefix` (one frame's whole
    // generation line) — frees the GPU memory now instead of on LRU eviction.
    deletePrefix(prefix) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) this.delete(key);
      }
    },
    clear() {
      for (const entry of map.values()) entry?.bitmap?.close?.();
      map.clear();
      totalBytes = 0;
    },
  };
}

// ---- Painting frames that may be cold --------------------------------------
// One studio at a time, so the decoded-raster LRU is a module singleton.
// Count cap for tiny thumbnails, byte cap for the real budget: 24 full
// raster bitmaps ≈ 154MB of decoded GPU memory, never unbounded.
const bitmaps = createBitmapCache(48, 160 * 1024 * 1024);
// `id:rasterCount` used to key the LRU — but a REGENERATED raster can carry
// the same op count (a layer was hidden, the stack reordered), and the old
// ImageBitmap would then be served forever. Key on the raster BLOB's identity
// instead: a fresh blob is a fresh key, whatever the count. Superseded
// entries are orphaned but LRU-bounded (closed on eviction), and an explicit
// invalidation drops them via dropFrameBitmap.
let blobKeySeed = 0;
const blobKeys = new WeakMap();
const rasterKey = (frame) => {
  const blob = frame.raster;
  if (!blob || typeof blob !== "object") return `${frame.id}:raw`;
  let id = blobKeys.get(blob);
  if (!id) {
    blobKeySeed += 1;
    id = blobKeySeed;
    blobKeys.set(blob, id);
  }
  return `${frame.id}:${id}`;
};

// The decoded raster if it's already in the LRU, else null — and kick off the
// decode so the NEXT paint has it (playback / scrub / onion never await).
export function peekFrameBitmap(frame) {
  if (!frame?.raster) return null;
  const key = rasterKey(frame);
  const hit = bitmaps.get(key);
  if (hit) return hit;
  void bitmaps.load(key, frame.raster);
  return null;
}
export function getFrameBitmap(frame) {
  return frame?.raster ? bitmaps.load(rasterKey(frame), frame.raster) : Promise.resolve(null);
}
// Drop every decoded bitmap a frame has in the LRU (any generation). Called
// when its raster is invalidated so no stale decode can be served and the
// GPU memory comes back now, not on eviction.
export function dropFrameBitmap(frame) {
  if (!frame) return;
  bitmaps.deletePrefix(`${frame.id}:`);
}
export function dropFrameBitmaps() {
  bitmaps.clear();
}

// Synchronous paint: live layers, else whatever raster is already decoded.
// Returns false when the frame has pixels we can't show yet.
export function paintFrameSync(ctx, frame, width, height) {
  if (frame.layers) {
    compositeLayers(ctx, frame.layers, { width, height });
    return true;
  }
  const bitmap = peekFrameBitmap(frame);
  if (bitmap) {
    ctx.drawImage(bitmap, 0, 0, width, height);
    return true;
  }
  return !frame.raster && !(frame.ops || []).length; // a blank frame paints as blank
}

// Async paint (exports / wall / GIF / thumbnails): waits for the decode.
export async function paintFrameInto(ctx, frame, width, height) {
  if (frame.layers) {
    compositeLayers(ctx, frame.layers, { width, height });
    return;
  }
  const bitmap = await getFrameBitmap(frame);
  if (bitmap) ctx.drawImage(bitmap, 0, 0, width, height);
}

// Warm the LRU for the next few frames of a playback loop.
export function prefetchFrameBitmaps(list, from, count = 4) {
  for (let i = 0; i < count && i < list.length; i += 1) {
    const frame = list[(from + i) % list.length];
    if (frame && !frame.layers && frame.raster) peekFrameBitmap(frame);
  }
}
