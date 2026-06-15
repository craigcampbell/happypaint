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
  cloneLayerCanvas,
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
// stack into the frame model). Layers are referenced as-is, not cloned.
export function createFrame({ layers, activeLayerId, durationMs = DEFAULT_FRAME_DURATION } = {}) {
  const stack = layers && layers.length > 0 ? layers : createDefaultLayers();
  return {
    id: nextFrameId(),
    durationMs,
    layers: stack,
    activeLayerId: activeLayerId || stack[stack.length - 1].id,
  };
}

// Deep-clone a frame's layer canvases so duplicate/copy never share pixels.
export function cloneFrame(frame, { durationMs } = {}) {
  const layers = frame.layers.map((layer) => ({
    ...layer,
    id: createLayer().id, // fresh ids so layer selection stays unambiguous
    canvas: cloneLayerCanvas(layer.canvas),
  }));
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
export function compositeFrameToCanvas(frame, { width = CANVAS_WIDTH, height = CANVAS_HEIGHT } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  compositeLayers(canvas.getContext("2d"), frame.layers, { width, height });
  return canvas;
}
