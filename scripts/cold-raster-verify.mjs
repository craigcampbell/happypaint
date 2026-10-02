// Cold-raster invalidation: MODULE regression checks (real browser, no room).
// Covers the phase-1 review blocker: a render-affecting layer-metadata change
// on a COLD frame must invalidate its raster even though the op count never
// moved, and an async raster build must never install a blob built from
// superseded inputs.
//
//   layerRenderSig, fingerprints ordered ids/visibility/opacity ONLY
//   coldRasterStale, the one staleness contract (count OR sig)
//   rasterTicket, async generation guard (meta/clear/op mid-build)
//   bitmap cache keys, blob identity, not `id:rasterCount`: a regenerated
//                         same-opcount raster decodes to NEW pixels
//   composite scratch, rasterizeOps reuses one pooled layer stack, not N
//                         full-size canvases per cel; releaseWorldCanvas frees
//
// Serves the repo with the vite dev server and drives the public modules in
// headless Chrome (same pattern as scripts/replay-model-verify.mjs).
//
//   node scripts/cold-raster-verify.mjs
/* global document, createImageBitmap */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const PORT = Number(process.env.COLD_RASTER_PORT || 19102);
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";

const server = await createServer({ server: { host: "127.0.0.1", port: PORT, strictPort: true } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-accelerated-2d-canvas"],
  });
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error("PAGE ERROR:", error.message));
  await page.goto(`http://127.0.0.1:${PORT}/scripts/lab/index.html`);
  const checks = await page.evaluate(async () => {
    const {
      layerRenderSig,
      coldRasterStale,
      rasterTicket,
      rasterTicketCurrent,
      rasterizeOps,
      getFrameBitmap,
      peekFrameBitmap,
      dropFrameBitmap,
      dropFrameBitmaps,
      releaseWorldCanvas,
      createBitmapCache,
    } = await import("/src/utils/frameRasters.js");
    const { CANVAS_WIDTH, CANVAS_HEIGHT } = await import("/src/utils/layers.js");

    const results = [];
    const check = (name, pass, detail = "") => results.push({ name, pass: !!pass, detail });

    // ---- layerRenderSig: render-affecting fields only ----------------------
    const meta = [
      { id: "L1", name: "Canvas", visible: true, opacity: 1, locked: false },
      { id: "L2", name: "Inks", visible: true, opacity: 0.8, locked: false },
    ];
    const sig = layerRenderSig(meta);
    check("sig ignores name changes", layerRenderSig(meta.map((m, i) => (i === 1 ? { ...m, name: "Renamed" } : m))) === sig);
    check("sig ignores lock changes", layerRenderSig(meta.map((m, i) => (i === 0 ? { ...m, locked: true } : m))) === sig);
    check("sig catches visibility", layerRenderSig(meta.map((m, i) => (i === 1 ? { ...m, visible: false } : m))) !== sig);
    check("sig catches opacity", layerRenderSig(meta.map((m, i) => (i === 1 ? { ...m, opacity: 0.5 } : m))) !== sig);
    check("sig catches stack order", layerRenderSig([meta[1], meta[0]]) !== sig);
    check("sig catches layer id change", layerRenderSig(meta.map((m, i) => (i === 1 ? { ...m, id: "L9" } : m))) !== sig);
    check("sig of missing/empty meta is empty", layerRenderSig(null) === "" && layerRenderSig([]) === "");
    check("sig normalizes out-of-range opacity like the compositor", layerRenderSig([{ id: "L1", opacity: 2 }]) === layerRenderSig([{ id: "L1", opacity: 1 }]));

    // ---- coldRasterStale: the shared contract -------------------------------
    const coldFrame = (over = {}) => ({
      id: "f",
      layers: null,
      ops: [{}, {}],
      raster: {},
      rasterCount: 2,
      rasterSig: sig,
      layerMeta: meta,
      ...over,
    });
    check("fresh cold raster is not stale", !coldRasterStale(coldFrame()));
    check("op-count drift is stale", coldRasterStale(coldFrame({ rasterCount: 1 })));
    check("never-rasterized cold frame is stale", coldRasterStale(coldFrame({ raster: null, rasterCount: -1 })));
    check("hidden-layer sync is stale at the SAME op count", coldRasterStale(coldFrame({ layerMeta: meta.map((m, i) => (i === 1 ? { ...m, visible: false } : m)) })));
    check("name-only sync is NOT stale", !coldRasterStale(coldFrame({ layerMeta: meta.map((m, i) => (i === 1 ? { ...m, name: "Renamed" } : m)) })));
    check("blank cold frame (no ops) is never stale", !coldRasterStale(coldFrame({ ops: [], raster: null, rasterCount: -1 })));
    check("hydrated frame is never stale", !coldRasterStale(coldFrame({ layers: [{}], rasterCount: -1 })));
    check("flat legacy frame (no meta) follows the count only", !coldRasterStale(coldFrame({ layerMeta: null, rasterSig: "" })));

    // ---- rasterTicket: async build guard ------------------------------------
    // One frame, one ticket; mutate ONE input dimension at a time so each
    // kill is attributable to it.
    const frame = coldFrame();
    const ticket = rasterTicket(frame);
    check("untouched ticket stays current", rasterTicketCurrent(frame, ticket));
    frame.layerMeta = meta.map((m, i) => (i === 0 ? { ...m, name: "Paper" } : m));
    check("name-only edit mid-build keeps the ticket", rasterTicketCurrent(frame, ticket));
    frame.layerMeta = meta.map((m, i) => (i === 0 ? { ...m, locked: true } : m));
    check("lock-only edit mid-build keeps the ticket", rasterTicketCurrent(frame, ticket));
    frame.layerMeta = meta.map((m, i) => (i === 1 ? { ...m, visible: false } : m));
    check("visibility edit mid-build kills the ticket (same op count)", !rasterTicketCurrent(frame, ticket));
    frame.layerMeta = meta; // restore
    check("restored meta revives the ticket", rasterTicketCurrent(frame, ticket));
    frame.ops.push({}); // an op arrived mid-build (same array, in place)
    check("op arrival mid-build kills the ticket", !rasterTicketCurrent(frame, ticket));
    frame.ops.pop(); // revoked, identity and count match again
    check("revoked op revives the ticket", rasterTicketCurrent(frame, ticket));
    frame.ops = []; // a clear replaced the list
    check("clear mid-build kills the ticket", !rasterTicketCurrent(frame, ticket));
    frame.rasterGen = (frame.rasterGen || 0) + 1; // an invalidation landed
    check("invalidation gen-bump mid-build kills the ticket", !rasterTicketCurrent(frame, ticket));

    // ---- Same-opcount regeneration must decode NEW pixels -------------------
    // Two layers, one block of color each: L1 red on the left, L2 blue on
    // the right. Hiding L2 keeps the op count at 2, the exact case the old
    // `id:rasterCount` bitmap key served stale pixels for.
    const ops = [
      { kind: "shape", tool: "rect", layerId: "L1", start: { x: 0, y: 0 }, end: { x: 2000, y: 2500 }, opts: { color: "#ff0000", opacity: 1, fillShape: true, size: 1 } },
      { kind: "shape", tool: "rect", layerId: "L2", start: { x: 2000, y: 0 }, end: { x: 4000, y: 2500 }, opts: { color: "#0000ff", opacity: 1, fillShape: true, size: 1 } },
    ];
    const drawFrame = coldFrame({ id: "regen", ops });
    const pixelOf = async (bitmap, x, y) => {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      return [...ctx.getImageData(x, y, 1, 1).data];
    };
    releaseWorldCanvas();
    dropFrameBitmaps();
    drawFrame.raster = await rasterizeOps(ops, meta);
    drawFrame.rasterCount = ops.length;
    drawFrame.rasterSig = layerRenderSig(meta);
    check("rasterizeOps produced a raster blob", !!drawFrame.raster && drawFrame.raster.size > 0);
    const bmp1 = await getFrameBitmap(drawFrame);
    const rightVisible = await pixelOf(bmp1, Math.floor(bmp1.width * 0.9), Math.floor(bmp1.height / 2));
    check("both layers composite into the raster (blue right half)", rightVisible[2] > 150 && rightVisible[3] > 200, rightVisible.join(","));
    check("peek serves the decoded bitmap", peekFrameBitmap(drawFrame) === bmp1);

    // Regenerate with L2 hidden: SAME ops, SAME count, new blob.
    const hiddenMeta = meta.map((m, i) => (i === 1 ? { ...m, visible: false } : m));
    drawFrame.raster = await rasterizeOps(ops, hiddenMeta);
    drawFrame.rasterSig = layerRenderSig(hiddenMeta);
    const bmp2 = await getFrameBitmap(drawFrame);
    const rightHidden = await pixelOf(bmp2, Math.floor(bmp2.width * 0.9), Math.floor(bmp2.height / 2));
    check("regenerated same-opcount raster decodes to a NEW bitmap", bmp2 !== bmp1);
    check("new bitmap has the hidden layer's pixels GONE", rightHidden[3] === 0 || rightHidden[2] < 60, rightHidden.join(","));
    check("peek after regeneration serves the NEW bitmap", peekFrameBitmap(drawFrame) === bmp2);

    // Opacity + order changes produce different composites (the sig's teeth).
    const faint = await rasterizeOps(ops, meta.map((m, i) => (i === 1 ? { ...m, opacity: 0.25 } : m)));
    const bmpFaint = await createImageBitmap(faint);
    const rightFaint = await pixelOf(bmpFaint, Math.floor(bmpFaint.width * 0.9), Math.floor(bmpFaint.height / 2));
    check("opacity change moves the composite alpha", rightFaint[3] > 20 && rightFaint[3] < 120, rightFaint.join(","));
    const reordered = await rasterizeOps(ops, [meta[1], meta[0]]);
    const bmpOrder = await createImageBitmap(reordered);
    const leftOrdered = await pixelOf(bmpOrder, Math.floor(bmpOrder.width * 0.1), Math.floor(bmpOrder.height / 2));
    check("reorder changes what lands on top (blue under red on the left)", leftOrdered[0] > 150 && leftOrdered[2] < 60, leftOrdered.join(","));
    bmpFaint.close();
    bmpOrder.close();

    // ---- dropFrameBitmap: per-frame invalidation ----------------------------
    const other = coldFrame({ id: "other", ops });
    other.raster = await rasterizeOps(ops, meta);
    const otherBmp = await getFrameBitmap(other);
    dropFrameBitmap(drawFrame);
    check("dropFrameBitmap evicts the frame's decode (peek misses)", peekFrameBitmap(drawFrame) === null);
    check("dropFrameBitmap leaves other frames cached", peekFrameBitmap(other) === otherBmp);
    const bmp3 = await getFrameBitmap(drawFrame); // the peek above kicked a re-decode
    check("frame re-decodes after a drop", !!bmp3);

    // ---- Pooled composite scratch: bounded allocation -----------------------
    // createElement("canvas") returns a 300x150 element, the caller sizes it
    // afterwards, so collect the created elements and count the ones that
    // END UP full-size after each call.
    releaseWorldCanvas();
    const realCreate = document.createElement.bind(document);
    let made = [];
    document.createElement = (...args) => {
      const el = realCreate(...args);
      if (args[0] === "canvas") made.push(el);
      return el;
    };
    const fullSizeMade = () => made.filter((c) => c.width === CANVAS_WIDTH && c.height === CANVAS_HEIGHT).length;
    try {
      made = [];
      await rasterizeOps(ops, meta); // world + 2 layer surfaces
      const first = fullSizeMade();
      check("first composite rasterize allocates world + one surface per layer", first === 3, String(first));
      made = [];
      await rasterizeOps(ops, hiddenMeta); // pool hit: zero new full-size canvases
      check("second composite rasterize allocates ZERO full-size canvases", fullSizeMade() === 0, String(fullSizeMade()));
      made = [];
      await rasterizeOps(ops, [...meta, { id: "L3", name: "FX", visible: true, opacity: 1 }]);
      check("deeper stack grows the pool by the DELTA only", fullSizeMade() === 1, String(fullSizeMade()));
      made = [];
      await rasterizeOps(ops, meta); // back to 2 layers: still pooled
      check("shallower stack reuses the pool", fullSizeMade() === 0, String(fullSizeMade()));
      releaseWorldCanvas();
      made = [];
      await rasterizeOps(ops, meta);
      check("releaseWorldCanvas frees the pool (bounded re-allocation)", fullSizeMade() === 3, String(fullSizeMade()));
      releaseWorldCanvas();
      made = [];
      await rasterizeOps(ops, null); // legacy flat path: world only, no layer surfaces
      check("flat path allocates only the world canvas", fullSizeMade() === 1, String(fullSizeMade()));
    } finally {
      document.createElement = realCreate;
      releaseWorldCanvas();
    }

    // ---- createBitmapCache: prefix delete + pending sharing ------------------
    const cache = createBitmapCache(4);
    const blob = await rasterizeOps(ops, meta);
    const [a, b] = await Promise.all([cache.load("f:1", blob), cache.load("f:1", blob)]);
    check("concurrent loads share one decode", a === b);
    cache.load("f:2", blob);
    cache.load("g:1", blob);
    await new Promise((r) => setTimeout(r, 50));
    cache.deletePrefix("f:");
    check("deletePrefix evicts only the matching frame", !cache.has("f:1") && !cache.has("f:2") && cache.has("g:1"));
    cache.clear();

    return results;
  });
  let failed = 0;
  for (const { name, pass, detail } of checks) {
    if (!pass) failed += 1;
    console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : `, ${detail}`}`);
  }
  assert.ok(failed === 0, `${failed} cold-raster module check(s) failed`);
  console.log(`All ${checks.length} cold-raster module checks passed.`);
} finally {
  await browser?.close();
  await server.close();
}
