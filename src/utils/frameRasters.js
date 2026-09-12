// Cold frames. A hydrated frame owns full-size layer canvases (~40MB each);
// that is why a scene used to cap at 8 frames. In a server-synced animation
// room only the ACTIVE frame and its neighbours stay hydrated now — every
// other frame keeps its op list (the shared source of truth) plus a compressed
// raster, and re-hydrates by replaying its ops through the parity-tested
// offline interpreter when the artist steps onto it.
//
// Rasters are 1600x1000 WebP blobs (≈50–150KB): the size both exporters
// encode at, small enough that a 60-frame scene costs a few MB, and decoded
// on demand into a tiny LRU of ImageBitmaps for playback, thumbnails, onion
// skin and export.

import { CANVAS_WIDTH, CANVAS_HEIGHT, compositeLayers } from "./layers";
import { replayFrameOnto } from "./opReplay";

export const RASTER_WIDTH = 1600;
export const RASTER_HEIGHT = 1000;
// Frames either side of the active one kept as live canvases (onion skin
// reads ±1; ±2 makes flipping back and forth instant).
export const HYDRATED_RADIUS = 2;

let world = null; // one reusable full-size replay surface (lazy, ~40MB)
let scratch = null; // one reusable raster-size compositing surface

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
// the shared world canvas, then downscale + encode.
export async function rasterizeOps(ops) {
  const surface = getWorldCanvas();
  await replayFrameOnto(surface, ops || [], CANVAS_WIDTH, CANVAS_HEIGHT);
  return encodeRaster((ctx, w, h) => ctx.drawImage(surface, 0, 0, w, h));
}

export function decodeRaster(blob) {
  return createImageBitmap(blob);
}

// Tiny LRU of decoded rasters. `limit` bitmaps × 6.4MB (1600x1000 RGBA) is the
// playback/export working set — evicted bitmaps are closed to free GPU memory.
export function createBitmapCache(limit = 16) {
  const map = new Map();
  const pending = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      map.delete(key);
      map.set(key, hit); // bump to most-recent
      return hit;
    },
    has(key) {
      return map.has(key);
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
      if (map.has(key)) map.get(key)?.close?.();
      map.delete(key);
      map.set(key, bitmap);
      while (map.size > limit) {
        const oldest = map.keys().next().value;
        map.get(oldest)?.close?.();
        map.delete(oldest);
      }
    },
    delete(key) {
      map.get(key)?.close?.();
      map.delete(key);
    },
    clear() {
      for (const bitmap of map.values()) bitmap?.close?.();
      map.clear();
    },
  };
}

// ---- Painting frames that may be cold --------------------------------------
// One studio at a time, so the decoded-raster LRU is a module singleton.
const bitmaps = createBitmapCache(16);
const rasterKey = (frame) => `${frame.id}:${frame.rasterCount}`;

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
