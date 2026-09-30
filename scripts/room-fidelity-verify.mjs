/* eslint-env node */
// Room-loading fidelity — Phase 1 regression suite (PERMANENT).
//
// Asserts the FIXED behavior for the three divergences reproduced in
// happypaint-evidence/room-loading-evaluation-2026-09-29 (REPORT.md §2):
//
//   A. Seeded eraser determinism — local / remote / offline replay must roll
//      the same per-point dice (pointRand(seed, x, y)). Legacy ops WITHOUT a
//      seed keep Math.random: reseeding them would repaint saved history, so
//      seedless erasers stay a DOCUMENTED divergence (tested functionally,
//      never gated on determinism).
//   B. Never-hydrated cold-frame rasters must honour the frame's ordered
//      layer stack (routing, visibility, opacity) — same structure coolFrame
//      encodes from live layers. Cold frames with NO layer metadata (legacy
//      rooms) keep the flat replay: locked here as the explicit policy.
//   C. Offline image replay must route through the supplied targetFor layer
//      router like every other op kind.
//
// Part 1 is a source guard on the owned callsites (cheap, always runs).
// Part 2 drives the REAL browser modules (opReplay / frameRasters) in
// headless Chrome off a tiny static server on 127.0.0.1:19102.
//
//   node scripts/room-fidelity-verify.mjs [--out <dir>] [--port 19102]
//
// Exit 0 = every assertion passed. Exit 1 = at least one REGRESSION.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argValue = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
};
const PORT = Number(argValue("--port") || 19102);
const OUT = argValue("--out") || "/home/craig/Projects/happypaint-evidence/room-loading-implementation-2026-09-29/phase1";
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${ok ? "" : ` — ${detail}`}`);
}

// ---- Part 1: source guards on the owned callsites ---------------------------
console.log("Part 1: source guards");
{
  const app = fs.readFileSync(path.join(ROOT, "src/App.jsx"), "utf8");
  const opReplay = fs.readFileSync(path.join(ROOT, "src/utils/opReplay.js"), "utf8");
  const frameRasters = fs.readFileSync(path.join(ROOT, "src/utils/frameRasters.js"), "utf8");

  check(
    "guard: opReplay eraser branch rolls the seeded per-point dice",
    /settings\.brush === "eraser"[\s\S]{0,600}?drawBrushSegment\(dest, last \|\| point, point, settings, eraserRand\(settings, point\)\)/.test(opReplay),
    "opReplay eraser branch must pass eraserRand(settings, point)",
  );
  check(
    "guard: opReplay image fast path routes through targetFor",
    /op\.kind === "image"\) \{[\s\S]{0,400}?targetFor \? \(targetFor\(op\) \|\| ctx\) : ctx/.test(opReplay),
    "replayFrameOnto's pre-decoded image branch must honour targetFor",
  );
  check(
    "guard: shared eraserRand helper is exported from opReplay",
    /export function eraserRand\(/.test(opReplay),
    "eraserRand must live in opReplay.js so every consumer shares one policy",
  );
  check(
    "guard: studio remote eraser branch rolls the seeded dice",
    /settings\.brush === "eraser"[\s\S]{0,900}?drawBrushSegment\(ctx, last \|\| point, point, settings, eraserRand\(settings, point\)\)/.test(app),
    "applyRemoteOp eraser branch must pass eraserRand(settings, point)",
  );
  check(
    "guard: studio local eraser paints the WIRE point sequence with the stroke seed",
    /wiredEraser/.test(app) && /prevWirePoint/.test(app),
    "drawBrushFromEvent must feed the seeded eraser wire points + prevWirePoint",
  );
  check(
    "guard: cold-frame raster call passes the frame's layer metadata",
    /rasterizeOps\(ops, frame\.layerMeta\)/.test(app),
    "runRasterQueue must call rasterizeOps(ops, frame.layerMeta)",
  );
  check(
    "guard: rasterizeOps accepts layer metadata and composites layered stacks",
    /export async function rasterizeOps\(ops, layersMeta/.test(frameRasters) && /replayFrameComposite/.test(frameRasters),
    "frameRasters must route multi-layer cold frames through replayFrameComposite",
  );
}

// ---- Part 2: browser module suite -------------------------------------------
console.log("Part 2: browser module suite (headless Chrome)");
const server = http.createServer((req, res) => {
  const name = new URL(req.url, "http://localhost").pathname;
  if (name === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><title>room-fidelity-phase1</title>");
    return;
  }
  if (!/^\/src\/utils\/[a-zA-Z0-9]+(?:\.js)?$/.test(name)) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.setHeader("Content-Type", "text/javascript");
    res.end(fs.readFileSync(ROOT + name + (name.endsWith(".js") ? "" : ".js")));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

let browser;
try {
  browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-accelerated-2d-canvas"],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}`);
  const r = await page.evaluate(async () => {
    const { applyOp, replayFrameOnto, replayFrameComposite } = await import("/src/utils/opReplay.js");
    const { rasterizeOps, decodeRaster } = await import("/src/utils/frameRasters.js");
    const { createLayerCanvas } = await import("/src/utils/layers.js");
    const { createMixMap } = await import("/src/utils/mixMap.js");
    const { prepareStrokeCommit } = await import("/src/utils/brushes.js");

    const hash = async (c) => Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", c.getContext("2d").getImageData(0, 0, c.width, c.height).data)),
    ).map((x) => x.toString(16).padStart(2, "0")).join("");
    const probe = (c, x, y) => Array.from(c.getContext("2d").getImageData(x, y, 1, 1).data);
    const alphaCount = (c) => {
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n += 1;
      return n;
    };

    const rect = (x0, y0, x1, y1, color, layerId) => ({
      kind: "shape", tool: "rect", start: { x: x0, y: y0 }, end: { x: x1, y: y1 },
      opts: { fillShape: true, color, opacity: 1 }, layerId,
    });
    const eraserPoints = [];
    for (let i = 0; i <= 24; i += 1) {
      eraserPoints.push({ x: 20 + i * 8, y: 128 + Math.sin(i / 3) * 40, pressure: 0.8 });
    }
    const eraserOp = (seed, variation, layerId = "L0") => ({
      kind: "draw", strokeId: `eraser-${seed}-${variation}`, layerId, points: eraserPoints, end: true,
      settings: { brush: "eraser", size: 22, opacity: 1, variation, ...(seed == null ? {} : { seed }), color: "#000000" },
    });
    const splitEraserOps = (seed, variation) => [0, 1, 2].map((chunk) => ({
      kind: "draw", strokeId: `eraser-${seed}-${variation}`, layerId: "L0",
      points: eraserPoints.slice(chunk * 8, chunk === 2 ? 25 : (chunk + 1) * 8 + 1),
      end: chunk === 2,
      settings: { brush: "eraser", size: 22, opacity: 1, variation, seed, color: "#000000" },
    }));

    // Drive applyOp op-by-op (what the studio's remote path mirrors).
    const driveApplyOp = (canvas, ops) => {
      const ctx = canvas.getContext("2d");
      const mix = createMixMap(() => canvas, canvas.width, canvas.height);
      const lastMap = new Map();
      const strokes = new Map();
      const deferred = new Map();
      for (const op of ops) applyOp(ctx, op, lastMap, strokes, null, mix, deferred, canvas.width, canvas.height);
      for (const [id, entry] of strokes) {
        if (entry.buf) {
          prepareStrokeCommit(entry.buf, entry.renderer, entry.fx);
          entry.buf.commit(ctx, entry.opacity);
          entry.buf.dispose();
        }
        strokes.delete(id);
      }
      return canvas;
    };

    const out = {};

    // A1: seeded eraser replay is deterministic (variation 0.08 AND 0.3).
    for (const variation of [0.08, 0.3]) {
      const hashes = [];
      for (let i = 0; i < 3; i += 1) {
        const c = createLayerCanvas(256, 256);
        await replayFrameOnto(c, [rect(0, 0, 256, 256, "#c04030", "L0"), eraserOp(4242, variation)]);
        hashes.push(await hash(c));
      }
      out[`eraserDeterminism:${variation}`] = { identical: new Set(hashes).size === 1, hashes };
    }

    // A2: wire batching boundaries cannot move the dice (1 op vs 3 ops).
    {
      const a = createLayerCanvas(256, 256);
      await replayFrameOnto(a, [rect(0, 0, 256, 256, "#c04030", "L0"), eraserOp(4242, 0.3)]);
      const b = createLayerCanvas(256, 256);
      await replayFrameOnto(b, [rect(0, 0, 256, 256, "#c04030", "L0"), ...splitEraserOps(4242, 0.3)]);
      out.batchSplit = { identical: (await hash(a)) === (await hash(b)) };
    }

    // A3: offline replayFrameOnto == applyOp driven op-by-op (remote path).
    {
      const ops = [rect(0, 0, 256, 256, "#c04030", "L0"), eraserOp(4242, 0.3)];
      const a = createLayerCanvas(256, 256);
      await replayFrameOnto(a, ops);
      const b = driveApplyOp(createLayerCanvas(256, 256), ops);
      out.applyOpParity = { identical: (await hash(a)) === (await hash(b)) };
    }

    // A4: an eraser tagged L1 cuts ONLY L1 in a layered composite.
    {
      const layers = [{ id: "L0", visible: true, opacity: 1 }, { id: "L1", visible: true, opacity: 1 }];
      const withErase = createLayerCanvas(256, 256);
      await replayFrameComposite(withErase, layers, [rect(0, 0, 256, 256, "#c04030", "L0"), eraserOp(4242, 0.3, "L1")]);
      const withoutL1 = createLayerCanvas(256, 256);
      await replayFrameComposite(withoutL1, layers, [rect(0, 0, 256, 256, "#c04030", "L0")]);
      out.layeredEraserIsolation = { identical: (await hash(withErase)) === (await hash(withoutL1)) };
    }

    // A5: legacy SEEDLESS eraser still erases (functional; determinism NOT
    // gated — the documented legacy divergence).
    {
      const c = createLayerCanvas(256, 256);
      await replayFrameOnto(c, [rect(0, 0, 256, 256, "#c04030", "L0"), eraserOp(null, 0.3)]);
      const hashes = [];
      for (let i = 0; i < 2; i += 1) {
        const r = createLayerCanvas(256, 256);
        await replayFrameOnto(r, [rect(0, 0, 256, 256, "#c04030", "L0"), eraserOp(null, 0.3)]);
        hashes.push(await hash(r));
      }
      out.legacySeedless = {
        erased: alphaCount(c) < 256 * 256, // the eraser removed some of the rect
        informationalIdentical: new Set(hashes).size === 1,
      };
    }

    // B: cold-frame rasters honour the layer stack. World 4000x2500 → raster
    // 1600x1000 (scale 0.4); rects at (1000,600)-(1800,1100) probe (560,340).
    const decodeToCanvas = async (blob) => {
      const bitmap = await decodeRaster(blob);
      const c = createLayerCanvas(bitmap.width, bitmap.height);
      c.getContext("2d").drawImage(bitmap, 0, 0);
      bitmap.close();
      return c;
    };
    const bigRect = (color, layerId) => rect(1000, 600, 1800, 1100, color, layerId);
    {
      // B1: hidden layer stays hidden in the cold raster.
      const meta = [{ id: "L0", visible: true, opacity: 1 }, { id: "L1", visible: false, opacity: 1 }];
      const c = await decodeToCanvas(await rasterizeOps([bigRect("#ff0000", "L1")], meta));
      out.coldHiddenLayer = { pixel: probe(c, 560, 340) };
    }
    {
      // B2: layer opacity is honoured (white @ 0.5 over black → mid grey).
      const meta = [{ id: "L0", visible: true, opacity: 1 }, { id: "L1", visible: true, opacity: 0.5 }];
      const ops = [rect(0, 0, 4000, 2500, "#000000", "L0"), bigRect("#ffffff", "L1")];
      const c = await decodeToCanvas(await rasterizeOps(ops, meta));
      out.coldLayerOpacity = { pixel: probe(c, 560, 340) };
    }
    {
      // B3: STACK ORDER beats op order — L1 (upper) blue op FIRST, L0 red op
      // SECOND: layered composite shows blue; the flat replay showed red.
      const meta = [{ id: "L0", visible: true, opacity: 1 }, { id: "L1", visible: true, opacity: 1 }];
      const ops = [bigRect("#0000ff", "L1"), bigRect("#ff0000", "L0")];
      const c = await decodeToCanvas(await rasterizeOps(ops, meta));
      out.coldLayerOrder = { pixel: probe(c, 560, 340) };
      // B4: no metadata (legacy room) stays flat — explicit policy lock.
      const flat = await decodeToCanvas(await rasterizeOps(ops));
      out.coldNoMetaFlat = { pixel: probe(flat, 560, 340) };
    }
    {
      // B5: single-layer metadata renders identically to the flat path.
      const ops = [bigRect("#224466", "L0"), eraserOp(7, 0.3, "L0")];
      const scaledEraser = {
        ...ops[1],
        points: eraserPoints.map((p) => ({ ...p, x: p.x * 4 + 1000, y: p.y * 2 + 500 })),
        settings: { ...ops[1].settings, size: 60 },
      };
      const fullOps = [ops[0], scaledEraser];
      const flat = await decodeToCanvas(await rasterizeOps(fullOps));
      const single = await decodeToCanvas(await rasterizeOps(fullOps, [{ id: "L0", visible: true, opacity: 1 }]));
      out.coldSingleLayerMeta = { identical: (await hash(flat)) === (await hash(single)) };
    }
    {
      // B6: an op naming a layer the metadata no longer has lands on layer 0.
      const meta = [{ id: "L0", visible: true, opacity: 1 }, { id: "L1", visible: true, opacity: 1 }];
      const c = await decodeToCanvas(await rasterizeOps([bigRect("#00ff00", "L_GONE")], meta));
      out.coldUnknownLayerFallsToL0 = { pixel: probe(c, 560, 340) };
    }

    {
      // A single canonical layer still has visibility/opacity; only the
      // default visible, opaque stack may use the flat shortcut.
      const ops = [bigRect("#ff0000", "L0")];
      const hidden = await decodeToCanvas(await rasterizeOps(ops, [{ id: "L0", visible: false, opacity: 1 }]));
      const faded = await decodeToCanvas(await rasterizeOps(ops, [{ id: "L0", visible: true, opacity: 0.5 }]));
      out.coldSingleLayerProperties = { hidden: probe(hidden, 560, 340), faded: probe(faded, 560, 340) };
    }

    // C: offline image replay honours targetFor.
    const redPng = (() => {
      const c = createLayerCanvas(8, 8);
      const g = c.getContext("2d");
      g.fillStyle = "#ff0000";
      g.fillRect(0, 0, 8, 8);
      return c.toDataURL("image/png");
    })();
    const imageOp = (layerId) => ({ kind: "image", layerId, dataUrl: redPng, x: 0, y: 0, w: 8, h: 8 });
    {
      // C1: replayFrameOnto with a layer router puts the image on ITS layer.
      const l0 = createLayerCanvas(128, 128);
      const l1 = createLayerCanvas(128, 128);
      await replayFrameOnto(l0, [imageOp("L1")], 128, 128, (op) => (op.layerId === "L1" ? l1 : l0).getContext("2d"));
      out.imageRouting = { basePixel: probe(l0, 4, 4), upperPixel: probe(l1, 4, 4) };
    }
    {
      // C2: layered composite — image on L1 shows when visible, not when hidden.
      const meta = [{ id: "L0", visible: true, opacity: 1 }, { id: "L1", visible: true, opacity: 1 }];
      const shown = createLayerCanvas(128, 128);
      await replayFrameComposite(shown, meta, [imageOp("L1")]);
      const hiddenMeta = [{ id: "L0", visible: true, opacity: 1 }, { id: "L1", visible: false, opacity: 1 }];
      const hidden = createLayerCanvas(128, 128);
      await replayFrameComposite(hidden, hiddenMeta, [imageOp("L1")]);
      out.imageComposite = { shownPixel: probe(shown, 4, 4), hiddenPixel: probe(hidden, 4, 4) };
    }
    {
      // C3: no router (flat consumer) — the image lands on the base canvas.
      const c = createLayerCanvas(128, 128);
      await replayFrameOnto(c, [imageOp("L1")], 128, 128);
      out.imageFlatLegacy = { pixel: probe(c, 4, 4) };
    }

    return out;
  });

  // ---- assertions over the browser results ----
  for (const variation of ["0.08", "0.3"]) {
    const e = r[`eraserDeterminism:${variation}`];
    check(`A1 seeded eraser replay deterministic (variation ${variation})`, e.identical, `hashes ${e.hashes.join(" / ")}`);
  }
  check("A2 seeded eraser identical across wire batch splits", r.batchSplit.identical);
  check("A3 offline replay == applyOp remote-path parity", r.applyOpParity.identical);
  check("A4 layered eraser cuts only its own layer", r.layeredEraserIsolation.identical);
  check(
    "A5 legacy seedless eraser still erases (determinism intentionally not gated)",
    r.legacySeedless.erased,
    "seedless eraser must keep functioning",
  );
  check(
    "B1 cold raster honours a hidden layer",
    r.coldHiddenLayer.pixel[3] === 0,
    `expected transparent, got ${r.coldHiddenLayer.pixel}`,
  );
  {
    const p = r.coldLayerOpacity.pixel;
    const grey = p[0];
    check(
      "B2 cold raster honours layer opacity (mid grey ±24, lossy WebP)",
      p[3] === 255 && Math.abs(grey - 128) <= 24 && Math.abs(p[1] - grey) <= 8 && Math.abs(p[2] - grey) <= 8,
      `expected ~128 grey, got ${p}`,
    );
  }
  {
    const p = r.coldLayerOrder.pixel;
    check(
      "B3 cold raster honours stack ORDER over op order (upper layer wins)",
      p[2] > 150 && p[0] < 105,
      `expected blue, got ${p}`,
    );
  }
  {
    const p = r.coldNoMetaFlat.pixel;
    check(
      "B4 no-metadata cold raster stays flat (explicit legacy policy)",
      p[0] > 150 && p[2] < 105,
      `expected red (flat op order), got ${p}`,
    );
  }
  check("B5 single-layer metadata == flat raster", r.coldSingleLayerMeta.identical);
  {
    const p = r.coldUnknownLayerFallsToL0.pixel;
    check(
      "B6 op for a deleted layer falls to layer 0",
      p[1] > 150 && p[3] === 255,
      `expected green, got ${p}`,
    );
  }
  check("B7 single-layer hidden state is respected", r.coldSingleLayerProperties.hidden[3] === 0);
  check("B8 single-layer opacity is respected", r.coldSingleLayerProperties.faded[3] === 128);
  check(
    "C1 offline image replay routes through targetFor",
    r.imageRouting.basePixel[3] === 0 && r.imageRouting.upperPixel[3] === 255,
    `base ${r.imageRouting.basePixel} upper ${r.imageRouting.upperPixel}`,
  );
  check(
    "C2 layered composite shows/hides routed images with the layer",
    r.imageComposite.shownPixel[3] === 255 && r.imageComposite.hiddenPixel[3] === 0,
    `shown ${r.imageComposite.shownPixel} hidden ${r.imageComposite.hiddenPixel}`,
  );
  check(
    "C3 flat consumer (no router) still draws images to the base canvas",
    r.imageFlatLegacy.pixel[3] === 255,
    `got ${r.imageFlatLegacy}`,
  );

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "room-fidelity-verify-results.json"), JSON.stringify({ when: new Date().toISOString(), results, raw: r }, null, 2));
} finally {
  await browser?.close();
  server.close();
}

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`);
if (failed.length) {
  console.log(`FAILED: ${failed.map((x) => x.name).join("; ")}`);
  process.exit(1);
}
console.log("room-fidelity phase-1 suite: all assertions hold.");
