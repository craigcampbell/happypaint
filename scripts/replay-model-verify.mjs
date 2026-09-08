// Regression checks for document-sized layer helpers and ordered image replay.
// Uses the public modules in a real canvas renderer; never connects to rooms.
/* global document */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({ server: { host: "127.0.0.1", port: 5297, strictPort: true } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:5297/scripts/lab/index.html");
  const checks = await page.evaluate(async () => {
    const { createLayer, cloneLayerCanvas, compositeLayers, snapshotLayers, restoreLayersFromSnapshot } = await import("/src/utils/layers.js");
    const { createFrame, cloneFrame, compositeFrameToCanvas } = await import("/src/utils/frames.js");
    const { replayFrameOnto } = await import("/src/utils/opReplay.js");
    const { getAuthoringDab } = await import("/src/utils/brushes.js");
    const { normalizeSymmetry } = await import("/src/utils/symmetry.js");
    const results = [];
    const check = (name, pass) => results.push({ name, pass: !!pass });
    const pixel = (canvas, x, y) => [...canvas.getContext("2d").getImageData(x, y, 1, 1).data];
    const equals = (actual, expected) => actual.join(",") === expected.join(",");
    const layer = createLayer({ width: 192, height: 120, name: "Small document", locked: true, opacity: 0.75 });
    const ctx = layer.canvas.getContext("2d");
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 192, 120);
    ctx.fillStyle = "#0000ff";
    ctx.fillRect(150, 90, 42, 30);
    const frame = createFrame({ layers: [layer], activeLayerId: layer.id, durationMs: 240 });
    const allocations = [];
    const createElement = document.createElement.bind(document);
    document.createElement = (...args) => {
      const element = createElement(...args);
      if (args[0] === "canvas") allocations.push(element);
      return element;
    };
    let copy;
    try { copy = cloneFrame(frame); } finally { document.createElement = createElement; }
    check("duplicate allocates one canvas per layer", allocations.length === 1);
    check("duplicate preserves dimensions", copy.layers[0].canvas.width === 192 && copy.layers[0].canvas.height === 120);
    check("duplicate has fresh frame/layer ids", copy.id !== frame.id && copy.layers[0].id !== layer.id);
    check("duplicate preserves selected layer and metadata", copy.activeLayerId === copy.layers[0].id && copy.layers[0].locked && copy.layers[0].opacity === 0.75 && copy.durationMs === 240);
    check("duplicate preserves far-corner pixels", equals(pixel(copy.layers[0].canvas, 180, 110), [0, 0, 255, 255]));
    copy.layers[0].canvas.getContext("2d").clearRect(0, 0, 192, 120);
    check("duplicate does not share source pixels", equals(pixel(layer.canvas, 180, 110), [0, 0, 255, 255]));
    const clone = cloneLayerCanvas(layer.canvas);
    check("layer clone preserves own dimensions", clone.width === 192 && clone.height === 120);
    const restored = restoreLayersFromSnapshot(snapshotLayers([layer], layer.id));
    check("undo snapshot preserves dimensions and pixels", restored[0].canvas.width === 192 && equals(pixel(restored[0].canvas, 180, 110), [0, 0, 255, 255]));
    layer.opacity = 1;
    const full = compositeFrameToCanvas(frame);
    check("default composite uses document dimensions", full.width === 192 && full.height === 120);
    check("default composite reaches document edge", equals(pixel(full, 180, 110), [0, 0, 255, 255]));
    const thumbnail = compositeFrameToCanvas(frame, { width: 96, height: 60 });
    check("thumbnail scales complete source", equals(pixel(thumbnail, 90, 55), [0, 0, 255, 255]));
    const hidden = createLayer({ width: 192, height: 120, visible: false });
    const composited = cloneLayerCanvas(layer.canvas);
    compositeLayers(composited.getContext("2d"), [hidden]);
    check("hidden layer does not cover artwork", equals(pixel(composited, 180, 110), [0, 0, 255, 255]));
    const blank = createFrame({ width: 192, height: 120 });
    check("new frame honors supplied dimensions", blank.layers[0].canvas.width === 192 && blank.layers[0].canvas.height === 120);

    const world = createLayer({ width: 192, height: 120 }).canvas;
    const image = { kind: "image", dataUrl: layer.canvas.toDataURL(), x: 0, y: 0, w: 192, h: 120 };
    const rect = { kind: "shape", tool: "rect", start: { x: 20, y: 20 }, end: { x: 80, y: 80 }, opts: { color: "#00ff00", opacity: 1, fillShape: true, size: 1 } };
    await replayFrameOnto(world, [image, rect]);
    check("checkpoint image stays below later paint", equals(pixel(world, 40, 40), [0, 255, 0, 255]));
    check("checkpoint uncovered pixels survive", equals(pixel(world, 180, 110), [0, 0, 255, 255]));
    await replayFrameOnto(world, [rect, image]);
    check("later image remains above earlier paint", equals(pixel(world, 40, 40), [255, 0, 0, 255]));
    const green = createLayer({ width: 192, height: 120 }).canvas;
    green.getContext("2d").fillStyle = "#00ff00";
    green.getContext("2d").fillRect(0, 0, 192, 120);
    await replayFrameOnto(world, [image, { ...image, dataUrl: green.toDataURL() }, image]);
    check("repeated image URLs preserve op order", equals(pixel(world, 40, 40), [255, 0, 0, 255]));
    await replayFrameOnto(world, [{ ...image, dataUrl: "data:image/png;base64,broken" }, rect]);
    check("invalid image does not block later paint", equals(pixel(world, 40, 40), [0, 255, 0, 255]));
    const dab = getAuthoringDab("marker").dab;
    const stroke = { kind: "draw", strokeId: "small-world-mirror", points: [{ x: 20, y: 30, pressure: 1 }, { x: 40, y: 30, pressure: 1 }], settings: { brush: "marker", color: "#000000", size: 8, opacity: 1, seed: 42, v: 3, dab, symmetry: normalizeSymmetry("mirror") }, end: true };
    await replayFrameOnto(world, [stroke]);
    check("replay clears the previous frame", pixel(world, 100, 100)[3] === 0);
    check("replay preserves source stroke", pixel(world, 30, 30)[3] > 0);
    check("symmetry uses actual document width", pixel(world, 162, 30)[3] > 0);
    return results;
  });
  checks.forEach(({ name, pass }) => console.log(`${pass ? "PASS" : "FAIL"} ${name}`));
  assert.ok(checks.every(({ pass }) => pass), "canvas model/replay regression");
  console.log(`All ${checks.length} canvas model/replay checks passed.`);
} finally {
  await browser?.close();
  await server.close();
}
