// Tiny Animation Loops frame model. A project is a list of frames; each frame
// owns its OWN layer stack (reusing the layers.js model) plus a duration in ms.
// Switching frames swaps that frame's layer stack onto the live canvas.
//
// A frame is intentionally shaped like a mini-project so the existing layer
// helpers (snapshot/restore/composite) apply unchanged:
//   { id, durationMs, layers: Layer[], activeLayerId }

import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  compositeLayers,
  createDefaultLayers,
  createLayer,
} from "./layers";

export const DEFAULT_FRAME_DURATION = 120;
export const FRAME_COUNT_PRESETS = [1, 2, 4, 8];
export const MAX_FRAMES = 8;

let frameIdSeed = 0;

function nextFrameId() {
  frameIdSeed += 1;
  return `frame-${Date.now().toString(36)}-${frameIdSeed}`;
}

// Build a frame from an explicit layer stack (used when capturing the live
// stack into the frame model). Layers are referenced as-is, not cloned. `width`
// / `height` can size a NEW frame's default layer stack. Existing documents
// retain their own dimensions when they are duplicated or composited.
export function createFrame({ layers, activeLayerId, durationMs = DEFAULT_FRAME_DURATION, width, height } = {}) {
  const stack = layers && layers.length > 0 ? layers : createDefaultLayers(width, height);
  return {
    id: nextFrameId(),
    durationMs,
    layers: stack,
    activeLayerId: activeLayerId || stack[stack.length - 1].id,
  };
}

// Deep-clone a frame's layer canvases so duplicate/copy never share pixels.
export function cloneFrame(frame, { durationMs } = {}) {
  const layers = frame.layers.map((layer) => {
    // Allocate only the clone: creating a throwaway mural canvas for its id
    // would briefly consume another 40 MB for every animation layer.
    const copy = createLayer({ width: layer.canvas.width, height: layer.canvas.height });
    copy.canvas.getContext("2d").drawImage(layer.canvas, 0, 0);
    return { ...layer, id: copy.id, canvas: copy.canvas };
  });
  // Preserve relative active-layer selection by index.
  const activeIndex = frame.layers.findIndex((layer) => layer.id === frame.activeLayerId);
  return {
    id: nextFrameId(),
    durationMs: typeof durationMs === "number" ? durationMs : frame.durationMs,
    layers,
    activeLayerId: layers[Math.max(0, activeIndex)]?.id || layers[layers.length - 1].id,
  };
}

// Composite a single frame (its visible layers) onto a fresh canvas of the
// given size. Used for thumbnails, onion-skin, GIF export, loop assets.
// A COLD frame (layers === null — see utils/frameRasters.js) composites to a
// blank canvas here; callers that can wait use the frame's raster instead.
export function compositeFrameToCanvas(frame, {
  width = frame.layers?.[0]?.canvas.width || CANVAS_WIDTH,
  height = frame.layers?.[0]?.canvas.height || CANVAS_HEIGHT,
} = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  compositeLayers(canvas.getContext("2d"), frame.layers || [], { width, height });
  return canvas;
}

// A frame shell for a server-synced animation room: no canvases until it is
// hydrated, just its identity, timing and (soon) its ops + raster.
export function createColdFrame(id, durationMs = DEFAULT_FRAME_DURATION) {
  return { id, durationMs, layers: null, activeLayerId: null, ops: [], raster: null, rasterCount: -1, hydrating: null };
}

// Give a cold frame blank live canvases (its ops replay into them next).
export function allocateFrameLayers(frame) {
  if (!frame || frame.layers) return frame;
  const layers = createDefaultLayers(CANVAS_WIDTH, CANVAS_HEIGHT);
  frame.layers = layers;
  frame.activeLayerId = layers[layers.length - 1].id;
  return frame;
}
