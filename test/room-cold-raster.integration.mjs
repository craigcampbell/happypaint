/* eslint-env node */
// Cold-raster invalidation — INTEGRATION: render-affecting layer metadata
// changes landing on a COLD frame in the real app (phase-1 review blocker).
//
// Spawns the REAL server.js on 127.0.0.1:19101 against a throwaway DATA_DIR
// (accounts unset → anonymous path) and opens two headless-Chrome clients in
// one random private animation room:
//   1. p1 (host) enables animation, draws on TWO layers of frame 1, then adds
//      five more frames and sits on the last one. p2 joins late and parks on
//      the last frame — frame 1 goes COLD for p2 with a fresh raster.
//   2. p1 steps back to frame 1 and HIDES layer 2. p2's frame 1 op count
//      never changes — before the fix its raster stayed fresh-looking
//      forever (stale check was rasterCount vs ops.length only, and the
//      bitmap cache key was `id:rasterCount`).
//   3. Assert on p2: rasterFresh flips false (invalidated), then true again
//      (regenerated at the SAME op count), the film-strip thumbnail changes,
//      and the raster generation moved.
//   4. A lock-only patch must NOT rebuild: rasterFresh stays true and the
//      generation never moves.
//   5. A visibility patch on a BLANK cold frame (no ops) invalidates (gen
//      bumps) but never spins up a raster build.
//
// Requires a built client: `npm run build` first (server.js serves dist/).
//
//   node test/room-cold-raster.integration.mjs
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.COLD_RASTER_API_PORT || 19101);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = "/home/craig/.hermes/cache/scratch/fidelity-revision/data-cold-raster";
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const ROOM = `ZZC1${Math.floor(Math.random() * 900 + 100)}`;

if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) {
  console.error("dist/index.html missing — run `npm run build` first (server.js serves dist/).");
  process.exit(2);
}

fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR, PB_URL: "", NODE_ENV: "test" },
  stdio: ["ignore", "pipe", "pipe"],
});
const serverLog = [];
server.stdout.on("data", (d) => serverLog.push(String(d)));
server.stderr.on("data", (d) => serverLog.push(String(d)));

async function waitForHealth() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`, { cache: "no-store" });
      if (res.ok) return;
    } catch { /* still booting */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not become healthy:\n${serverLog.join("")}`);
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${ok ? "" : ` — ${detail}`}`);
};
const sha = (text) => createHash("sha256").update(String(text)).digest("hex").slice(0, 16);

const framesOn = (page) => page.evaluate(() => window.__drawesomeFrames?.() || null);
const waitFrames = async (page, pred, label, timeout = 60000) => {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await framesOn(page);
    if (last && pred(last)) return last;
    await page.waitForTimeout(400);
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)}`);
};
const thumbSrc = (page, index) => page.evaluate((i) => {
  const cells = [...document.querySelectorAll(".fs-cel-thumb")];
  return cells[i]?.querySelector("img")?.src || null;
}, index);
const waitThumb = async (page, index, pred, label, timeout = 30000) => {
  const t0 = Date.now();
  let src = null;
  while (Date.now() - t0 < timeout) {
    src = await thumbSrc(page, index);
    if (src && pred(src)) return src;
    await page.waitForTimeout(400);
  }
  throw new Error(`timeout waiting for ${label} (src ${src ? "present" : "missing"})`);
};

let browser;
try {
  await waitForHealth();
  browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-accelerated-2d-canvas"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 850 } });

  // p1 first: the room host (only the host can flip animation on).
  const p1 = await ctx.newPage();
  await p1.goto(`${BASE}/join/${ROOM}`, { waitUntil: "networkidle" });
  await p1.waitForSelector(".overlay-canvas");
  await p1.waitForTimeout(2000);

  await p1.waitForSelector(".mp-anim-toggle", { timeout: 10000 });
  await p1.click(".mp-anim-toggle");
  await p1.waitForSelector(".film-strip", { timeout: 10000 });
  check("host enabled animation (film strip unlocked)", true);

  // Marker, like the phase-1 parity test.
  const pickBrush = (name) => p1.evaluate((n) => {
    const chip = [...document.querySelectorAll(".brush-chip")].find((c) => new RegExp(n, "i").test(c.textContent));
    if (chip) chip.click();
    return !!chip;
  }, name);
  check("precondition: marker chip found", await pickBrush("Marker"));

  const r = await p1.evaluate(() => {
    const e = document.querySelector(".overlay-canvas").getBoundingClientRect();
    return { x: e.x, y: e.y, w: e.width, h: e.height };
  });
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const stroke = async (x0, y0, x1, y1) => {
    await p1.mouse.move(x0, y0);
    await p1.mouse.down();
    for (let t = 0; t <= 1.001; t += 0.1) {
      await p1.mouse.move(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, { steps: 2 });
      await p1.waitForTimeout(9);
    }
    await p1.mouse.up();
    await p1.waitForTimeout(1200);
  };

  const layerRows = () => p1.evaluate(() => document.querySelectorAll(".layer-panel .layer-row").length);

  // Frame 1, layer 1 ("Canvas"): a stroke on the LEFT half.
  await stroke(cx - 320, cy - 140, cx - 120, cy + 140);
  // Add layer 2 (the actor lands on it) and stroke the RIGHT half.
  await p1.click('button[aria-label="Add layer"]');
  await p1.waitForFunction(() => document.querySelectorAll(".layer-panel .layer-row").length === 2, null, { timeout: 10000 });
  await stroke(cx + 120, cy - 140, cx + 320, cy + 140);
  check("precondition: drew on two layers of frame 1", (await layerRows()) === 2);

  // Five more frames; the actor lands on each new one, ending on frame 6.
  for (let n = 2; n <= 6; n += 1) {
    await p1.click(".fs-add");
    await p1.waitForFunction((count) => window.__drawesomeFrames?.().length === count, n, { timeout: 10000 });
    await p1.waitForTimeout(300);
  }
  check("precondition: six frames, host parked on the last", true);

  // p2 joins late (history catch-up) and parks on frame 6 — frames 1–3 go
  // cold for it (hydrated radius ±2).
  const p2 = await ctx.newPage();
  await p2.goto(`${BASE}/join/${ROOM}`, { waitUntil: "networkidle" });
  await p2.waitForSelector(".overlay-canvas");
  await p2.waitForSelector(".film-strip", { timeout: 15000 });
  await p2.waitForTimeout(2000);
  await p2.click('button[aria-label="Frame 6"]');

  const settled = await waitFrames(
    p2,
    (f) => f.length === 6 && f[0]?.cold && !f[0].hydrating && f[0].rasterFresh,
    "frame 1 cold with a fresh raster on p2",
  );
  check("frame 1 is cold on p2 with a fresh raster", true);
  const opsBefore = settled[0].ops;
  check("frame 1 holds its stroke ops on p2", opsBefore > 0, `ops=${opsBefore}`);
  const blank0 = settled[2];
  check("frame 3 is blank and cold on p2 (no ops, no raster)", blank0?.cold && blank0.ops === 0 && !blank0.raster, JSON.stringify(blank0));

  const thumbBefore = await waitThumb(p2, 0, (src) => src.startsWith("data:"), "frame 1 thumbnail on p2");
  const genBefore = settled[0].rasterGen;

  // ---- THE BUG: hide layer 2 on frame 1 — p2's op count never changes. ----
  await p1.click('button[aria-label="Frame 1"]');
  await p1.waitForFunction(() => document.querySelectorAll(".layer-panel .layer-row").length === 2, null, { timeout: 10000 });
  await p1.waitForTimeout(1500); // let the hydration replay land before the patch
  await p1.click(".layer-panel .layer-row:first-child .layer-visibility"); // top layer = layer 2

  const invalidated = await waitFrames(
    p2,
    (f) => f[0] && f[0].cold && !f[0].rasterFresh,
    "frame 1 raster invalidated on p2",
    20000,
  );
  check("hidden-layer sync invalidates the cold raster (same op count)", true);
  check("invalidation dropped the raster blob", !invalidated[0].raster, JSON.stringify(invalidated[0]));
  check("invalidation bumped the build generation", invalidated[0].rasterGen > genBefore, `${genBefore} -> ${invalidated[0].rasterGen}`);

  const regenerated = await waitFrames(
    p2,
    (f) => f[0]?.cold && f[0].rasterFresh,
    "frame 1 raster regenerated on p2",
    90000,
  );
  check("cold raster regenerated after the metadata change", true);
  check("regenerated at the SAME op count", regenerated[0].ops === opsBefore, `${opsBefore} -> ${regenerated[0].ops}`);
  const thumbAfter = await waitThumb(p2, 0, (src) => sha(src) !== sha(thumbBefore), "regenerated frame 1 thumbnail");
  check("film-strip thumbnail repainted with the layer hidden", sha(thumbAfter) !== sha(thumbBefore));
  const genAfterRegen = regenerated[0].rasterGen;

  // ---- Lock-only patch: NOT render-affecting, no rebuild. ------------------
  await p1.click(".layer-panel .layer-row:first-child .layer-lock"); // top layer
  await p1.waitForTimeout(4000);
  const lockA = await framesOn(p2);
  await p2.waitForTimeout(2000);
  const lockB = await framesOn(p2);
  check("lock-only sync keeps the raster fresh", lockA[0].rasterFresh && lockB[0].rasterFresh, JSON.stringify(lockB[0]));
  check("lock-only sync never bumps the generation", lockA[0].rasterGen === genAfterRegen && lockB[0].rasterGen === genAfterRegen, `${genAfterRegen} -> ${lockB[0].rasterGen}`);

  // ---- Visibility patch on a BLANK cold frame (no ops): invalidate, no spin.
  await p1.click('button[aria-label="Frame 3"]');
  await p1.waitForTimeout(1500);
  await p1.click(".layer-panel .layer-row:first-child .layer-visibility"); // hide its top layer
  await p1.waitForTimeout(4000);
  const blank1 = (await framesOn(p2))[2];
  await p2.waitForTimeout(2500);
  const blank2 = (await framesOn(p2))[2];
  check("blank cold frame still has no ops and no raster", blank1.ops === 0 && !blank1.raster && blank2.ops === 0 && !blank2.raster, JSON.stringify(blank2));
  check("blank cold frame's generation moved (the sync landed)", blank1.rasterGen > blank0.rasterGen, `${blank0.rasterGen} -> ${blank1.rasterGen}`);
  check("no raster build spun up for a frame with no ops", !blank2.rasterFresh && !blank2.hydrating);
  const end = await framesOn(p2);
  check("frame 1's regenerated raster survives the other frames' syncs", end[0].rasterFresh, JSON.stringify(end[0]));

  console.log(JSON.stringify({
    ROOM,
    frame1: { ops: end[0].ops, gen: `${genBefore} -> ${end[0].rasterGen}` },
    thumb: { before: sha(thumbBefore), after: sha(thumbAfter) },
  }, null, 2));
} finally {
  await browser?.close();
  if (server.exitCode == null) {
    server.kill("SIGTERM");
    await new Promise((resolve) => {
      server.once("exit", resolve);
      setTimeout(resolve, 2500);
    });
  }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`);
if (failed.length) {
  console.log(`server log tail:\n${serverLog.slice(-15).join("")}`);
  process.exit(1);
}
console.log("room cold-raster integration: cold metadata sync invalidates and regenerates rasters; lock-only and blank-frame syncs stay quiet.");
