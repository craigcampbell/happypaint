// Layer Lite model. Each layer owns its own offscreen <canvas>. The visible
// display canvas is recomposited from the layer stack whenever something
// changes. Layers are ordered bottom-to-top: index 0 paints first (lowest),
// the last index paints last (on top).

export const CANVAS_WIDTH = 1600;
export const CANVAS_HEIGHT = 1200;

let layerIdSeed = 0;

function nextLayerId() {
  layerIdSeed += 1;
  return `layer-${Date.now().toString(36)}-${layerIdSeed}`;
}

export function createLayerCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const context = canvas.getContext("2d", { alpha: true });
  context.lineCap = "round";
  context.lineJoin = "round";
  context.imageSmoothingEnabled = true;
  return canvas;
}

export function createLayer({ name = "Layer", visible = true, opacity = 1, locked = false } = {}) {
  return {
    id: nextLayerId(),
    name,
    visible,
    opacity,
    locked,
    canvas: createLayerCanvas(),
  };
}

// The default Layer Lite stack from the product docs.
export function createDefaultLayers() {
  return [
    createLayer({ name: "Background" }),
    createLayer({ name: "Sketch" }),
    createLayer({ name: "Color" }),
    createLayer({ name: "Detail" }),
  ];
}

export function cloneLayerCanvas(source) {
  const canvas = createLayerCanvas();
  canvas.getContext("2d").drawImage(source, 0, 0);
  return canvas;
}

// Snapshot used for undo/redo: keep each layer's pixels plus the ordered meta
// so structural changes (reorder, add, delete, merge) are reversible too.
export function snapshotLayers(layers, activeLayerId) {
  return {
    activeLayerId,
    layers: layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      visible: layer.visible,
      opacity: layer.opacity,
      locked: layer.locked,
      canvas: cloneLayerCanvas(layer.canvas),
    })),
  };
}

// Rebuild live layer objects from a snapshot (fresh canvases so future edits
// never mutate the stored history entry).
export function restoreLayersFromSnapshot(snapshot) {
  return snapshot.layers.map((layer) => ({
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    opacity: layer.opacity,
    locked: layer.locked,
    canvas: cloneLayerCanvas(layer.canvas),
  }));
}

// Paint the visible layers (and optional paper background) onto a 2D context.
export function compositeLayers(context, layers, { width, height } = {}) {
  const targetWidth = width || CANVAS_WIDTH;
  const targetHeight = height || CANVAS_HEIGHT;

  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0) {
      continue;
    }
    context.globalAlpha = layer.opacity;
    context.drawImage(layer.canvas, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT, 0, 0, targetWidth, targetHeight);
  }

  context.globalAlpha = 1;
}
