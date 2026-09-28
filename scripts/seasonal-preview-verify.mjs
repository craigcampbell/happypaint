// Seasonal preview (snapshot mode) verification for LiveRoomCanvas.
//
// The story: the homepage wants a periodic MAIN thumbnail — a visitor-rendered
// preview that replays the authoritative spectator stream but only repaints the
// visible canvas every snapshotIntervalMs, instead of on every op like the live
// view. This suite boots the REAL server (port 8954, throwaway DATA_DIR), serves
// a scratch test page through a scratch Vite dev server (port 8955, proxies
// /ws + /api to the backend — no repo file touched, no build needed), and drives
// two LiveRoomCanvas instances side by side in a real browser:
//
//   #snap — <LiveRoomCanvas roomCode="MAIN" snapshotIntervalMs={8000} />
//   #live — <LiveRoomCanvas roomCode="MAIN" />            (unchanged default)
//
// A raw-WS painter draws into MAIN; a modwatch admin wipes it. Asserts, on the
// canvases' actual pixels:
//   1. snapshot mode renders the settled initial history promptly,
//   2. new draw ops leave the snapshot pixels FROZEN until the interval tick,
//      then the thumbnail changes,
//   3. a clear invalidates the snapshot immediately (no stale art waiting a
//      whole interval),
//   4. an idle empty room keeps rendering the white placeholder through ticks,
//   5. the plain live mode is unchanged (ops show promptly), and
//   6. a window resize retains the displayed pixels in both modes.
// Screenshots land in output/seasonal-preview/ (git-ignored).
/* global window, document */ // page.evaluate callbacks run in the browser
import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocket } from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "output", "seasonal-preview");
const BASE_SCRATCH = process.env.TMPDIR || os.tmpdir();
const SCRATCH = path.join(BASE_SCRATCH, "seasonal-preview-verify-data");
const VITE_DIR = path.join(BASE_SCRATCH, "seasonal-preview-verify-vite");
const PORT = 8954; // realtime backend (never 8787)
const VPORT = 8955; // scratch Vite dev server, proxies /ws + /api → backend
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_URL = `http://127.0.0.1:${VPORT}/seasonal-preview-test`;
const ROOM = "MAIN";
// Short test interval: long enough to prove "frozen between ticks" with
// deterministic headroom, short enough the whole suite stays quick.
const SNAP_MS = 8000;

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
try { rmSync(VITE_DIR, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(VITE_DIR, { recursive: true });
mkdirSync(OUT, { recursive: true });

// The scratch test page. Mounted once per mode; window.__mountAt anchors the
// interval cadence so the frozen-pixel assertion can run with known headroom.
const TEST_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>seasonal preview test</title>
<style>
  body { margin: 0; font-family: sans-serif; }
  /* Viewport-relative so setViewportSize really resizes the canvas backing
     store (which clears it) — the resize checks below prove the blit repaints. */
  .wrap { width: 80vw; height: 220px; border: 1px solid #ccc; }
  .live-room-canvas { width: 100%; height: 100%; display: block; }
</style></head>
<body>
<div id="snap" class="wrap"></div>
<div id="live" class="wrap"></div>
<script type="module">
import React from "react";
import { createRoot } from "react-dom/client";
import LiveRoomCanvas from "/src/components/LiveRoomCanvas.jsx";
window.__activity = { snap: 0, live: 0 };
window.__ops = { snap: 0, live: 0 };
createRoot(document.getElementById("snap")).render(
  React.createElement(LiveRoomCanvas, {
    roomCode: "${ROOM}",
    snapshotIntervalMs: ${SNAP_MS},
    onActivity: () => { window.__activity.snap += 1; },
    onOps: () => { window.__ops.snap += 1; },
  }),
);
createRoot(document.getElementById("live")).render(
  React.createElement(LiveRoomCanvas, {
    roomCode: "${ROOM}",
    onActivity: () => { window.__activity.live += 1; },
    onOps: () => { window.__ops.live += 1; },
  }),
);
window.__mountAt = Date.now();
window.__ready = true;
</script>
</body></html>`;

// Scratch Vite config: root is the repo (so /src/... resolves and the real
// plugin-react transforms JSX), but the config file itself lives outside the
// repo. A tiny middleware serves the test page through transformIndexHtml so
// its inline module imports get rewritten like any dev-served page.
writeFileSync(path.join(VITE_DIR, "vite.config.mjs"), `
import react from ${JSON.stringify(path.join(ROOT, "node_modules", "@vitejs", "plugin-react", "dist", "index.js"))};
const HTML = ${JSON.stringify(TEST_HTML)};
const testPage = {
  name: "seasonal-preview-test-page",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url || !req.url.startsWith("/seasonal-preview-test")) return next();
      server.transformIndexHtml(req.url, HTML).then((html) => {
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(html);
      }).catch(next);
    });
  },
};
export default {
  root: ${JSON.stringify(ROOT)},
  logLevel: "warn",
  plugins: [react(), testPage],
  server: {
    host: "127.0.0.1",
    port: ${VPORT},
    strictPort: true,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:${PORT}", ws: true },
      "/api": { target: "http://127.0.0.1:${PORT}" },
    },
  },
};
`);

// PB_URL/POCKETBASE_URL blanked: the repo-root .env configures accounts, which
// would refuse this harness's guest joins (same pattern as modwatch-verify).
const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH, PB_URL: "", POCKETBASE_URL: "" },
  stdio: "pipe",
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const vite = spawn(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "--config", path.join(VITE_DIR, "vite.config.mjs")], {
  cwd: ROOT, env: { ...process.env }, stdio: "pipe",
});
vite.stderr.on("data", (d) => process.stderr.write("[vite] " + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

function connectMember(room) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${room}`);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", token: null }));
      setTimeout(() => resolve({ ws, send: (o) => ws.send(JSON.stringify(o)) }), 350);
    });
    ws.on("error", () => resolve({ ws, send: () => {} }));
  });
}
function connectWatcher(room, key) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${room}&modwatch=1`);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "mod_auth", key }));
      setTimeout(() => resolve({ ws, send: (o) => ws.send(JSON.stringify(o)) }), 400);
    });
    ws.on("error", () => resolve({ ws, send: () => {} }));
  });
}

const drawStroke = (send, strokeId, x0, y0, x1, y1, color) => send({
  type: "op",
  op: { kind: "draw", strokeId, points: [{ x: x0, y: y0 }, { x: x1, y: y1 }], settings: { brush: "marker", color, size: 40 }, end: true },
});

// Pixel probe run in the page: non-white count + a cheap full-canvas hash.
const pix = (page, sel) => page.evaluate((s) => {
  const c = document.querySelector(`${s} canvas`);
  if (!c || !c.width || !c.height) return null;
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let nonWhite = 0;
  let hash = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]; const g = d[i + 1]; const b = d[i + 2];
    if (r < 245 || g < 245 || b < 245) nonWhite += 1;
    hash = ((hash * 31 + r * 3 + g * 5 + b * 7) >>> 0);
  }
  return { nonWhite, hash, w: c.width, h: c.height };
}, sel);

const run = async () => {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(BASE + "/healthz"); if (r.ok) break; } catch { /* booting */ }
    await sleep(250);
  }
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(TEST_URL); if (r.ok) break; } catch { /* booting */ }
    await sleep(250);
  }
  const adminKey = readFileSync(path.join(SCRATCH, ".admin-key"), "utf8").trim();
  check("backend + scratch vite booted", adminKey.length > 8);

  // Seed MAIN with one stroke BEFORE the page opens: snapshot mode must render
  // the settled initial history promptly, not wait for the first interval.
  const painter = await connectMember(ROOM);
  drawStroke(painter.send, "seed-1", 400, 400, 1200, 900, "#111827");
  await sleep(400);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 420, height: 820 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(TEST_URL, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 10000 });

  // ---- 1. Initial history renders promptly in BOTH modes ------------------
  let snap0 = null;
  let live0 = null;
  try {
    await page.waitForFunction(() => window.__activity.snap > 0 && window.__activity.live > 0, null, { timeout: 8000 });
  } catch { /* assert below */ }
  for (let i = 0; i < 40; i += 1) {
    snap0 = await pix(page, "#snap");
    live0 = await pix(page, "#live");
    if (snap0 && live0 && snap0.nonWhite > 0 && live0.nonWhite > 0) break;
    await sleep(250);
  }
  check("snapshot mode renders settled initial history promptly", !!snap0 && snap0.nonWhite > 0,
    snap0 ? `nonWhite=${snap0.nonWhite}` : "no canvas");
  check("live mode renders the same initial art", !!live0 && live0.nonWhite > 0,
    live0 ? `nonWhite=${live0.nonWhite}` : "no canvas");
  const activity = await page.evaluate(() => window.__activity);
  check("onActivity contract preserved in both modes", activity.snap > 0 && activity.live > 0,
    JSON.stringify(activity));

  // ---- 2. Frozen between ticks, then refreshed ----------------------------
  // Anchor inside the interval cadence: wait until we are >= 2.5s away from the
  // next tick so the frozen assertion below cannot straddle a flush.
  await page.evaluate(() => { window.__mountAt = window.__mountAt || Date.now(); });
  await page.waitForFunction((ms) => {
    const into = (Date.now() - window.__mountAt) % ms;
    return Date.now() - window.__mountAt > 500 && into < ms - 2500;
  }, SNAP_MS, { timeout: SNAP_MS * 2 });
  snap0 = await pix(page, "#snap");
  live0 = await pix(page, "#live");

  // Inside the initial framing crop (the seed stroke bounds it to roughly
  // x 288-1312 / y 330-970): a live op outside the crop is legitimately
  // invisible because live ops don't reframe.
  drawStroke(painter.send, "live-2", 500, 500, 1100, 850, "#dc2626");
  // Live mode must show the new op promptly (its default behavior unchanged).
  let live1 = live0;
  for (let i = 0; i < 24; i += 1) {
    live1 = await pix(page, "#live");
    if (live1 && live1.hash !== live0.hash) break;
    await sleep(150);
  }
  check("live mode shows a new draw op promptly (default unchanged)", !!live1 && live1.hash !== live0.hash);
  // …while the snapshot pixels stay byte-frozen well before the next tick.
  await sleep(500);
  const snapFrozen = await pix(page, "#snap");
  check("snapshot pixels stay frozen on a new op until the interval", !!snapFrozen && snapFrozen.hash === snap0.hash,
    snapFrozen ? `hash ${snap0.hash} -> ${snapFrozen.hash}` : "no canvas");
  // The replay internals still received the op (onOps fires; no display work).
  const opsSeen = await page.evaluate(() => window.__ops);
  check("snapshot mode still receives spectator ops (onOps fires)", opsSeen.snap > 0, JSON.stringify(opsSeen));

  // After the interval passes the thumbnail must pick the stroke up.
  let snap1 = snapFrozen;
  try {
    await page.waitForFunction(
      (h) => {
        const c = document.querySelector("#snap canvas");
        if (!c || !c.width) return false;
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let hash = 0;
        for (let i = 0; i < d.length; i += 4) hash = ((hash * 31 + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7) >>> 0);
        return hash !== h;
      },
      snap0.hash, { timeout: SNAP_MS + 6000, polling: 500 },
    );
    snap1 = await pix(page, "#snap");
  } catch { /* asserted below */ }
  check("snapshot thumbnail refreshes at the interval", !!snap1 && snap1.hash !== snap0.hash && snap1.nonWhite > snap0.nonWhite,
    snap1 ? `nonWhite ${snap0.nonWhite} -> ${snap1.nonWhite}` : "no change");
  await page.screenshot({ path: path.join(OUT, "1-after-interval.png") });

  // ---- 3. Resize retains the displayed pixels in both modes ---------------
  await page.setViewportSize({ width: 760, height: 900 });
  await sleep(600);
  const snapResized = await pix(page, "#snap");
  const liveResized = await pix(page, "#live");
  check("resize retains the snapshot's displayed pixels", !!snapResized && snapResized.nonWhite > 0 && snapResized.w !== snap1.w,
    snapResized ? `${snap1.w}px -> ${snapResized.w}px, nonWhite=${snapResized.nonWhite}` : "no canvas");
  check("resize retains live pixels", !!liveResized && liveResized.nonWhite > 0);

  // ---- 4. Clear invalidates the snapshot immediately ----------------------
  // A wipe lands long before the next tick; the thumbnail must not keep showing
  // removed art for a whole interval.
  const watcher = await connectWatcher(ROOM, adminKey);
  watcher.send({ type: "clear" });
  await sleep(600);
  const snapCleared = await pix(page, "#snap");
  const liveCleared = await pix(page, "#live");
  check("clear invalidates the snapshot immediately (before any tick)", !!snapCleared && snapCleared.nonWhite === 0,
    snapCleared ? `nonWhite=${snapCleared.nonWhite}` : "no canvas");
  check("live mode clears too", !!liveCleared && liveCleared.nonWhite === 0);
  await page.screenshot({ path: path.join(OUT, "2-after-clear.png") });

  // ---- 5. Idle empty room: white placeholder survives a tick --------------
  // No crash, no stale pixels, still alive after a full interval with no ops.
  try {
    await page.waitForFunction((ms) => (Date.now() - window.__mountAt) % ms < 1200, SNAP_MS, { timeout: SNAP_MS + 3000, polling: 300 });
  } catch { /* a tick boundary is what we waited for */ }
  await sleep(400);
  const snapIdle = await pix(page, "#snap");
  check("idle empty room keeps rendering the placeholder through ticks", !!snapIdle && snapIdle.nonWhite === 0);
  check("no page errors across the whole run", pageErrors.length === 0, pageErrors[0] || "");

  await browser.close();
  try { painter.ws.close(); } catch { /* gone */ }
  try { watcher.ws.close(); } catch { /* gone */ }
};

run()
  .catch((e) => { console.error(e); check("suite completed without a harness exception", false, String(e)); })
  .finally(() => {
    try { server.kill(); } catch { /* gone */ }
    try { vite.kill(); } catch { /* gone */ }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
  });
