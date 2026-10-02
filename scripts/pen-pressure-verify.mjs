// Pen pressure seam verification: a feather-light stylus touch must produce a
// THIN dab, not a full-size blob.
//
// Reported bug: on iPad + Apple Pencil the lightest touches paint big round
// blobs (a Wacom does not). Root cause under test: getPoint (src/App.jsx)
// only routes pen samples through the adaptive pen band when `pressure > 0`;
// a pen sample with pressure 0 (the lightest real contact) falls into the
// mouse/finger velocity synthesizer, which returns 0.65 for the first sample
// of a stroke — so with the default "size" pressure mode the initial dab is
// ~65% of brush width instead of the 2% floor mapPenPressure(0) yields.
//
// This harness boots the REAL stack on isolated ports (vite dev :8993 +
// server.js :8994, scratch DATA_DIR), drives synthetic PointerEvents through
// the studio's actual pointer handlers in Chromium, and captures the draw ops
// the browser authors via a second WS client in the same room.
//
//   node scripts/pen-pressure-verify.mjs
//
// Exit 0 = every check passed; 1 = at least one FAILED.
/* global document, PointerEvent */ // page.evaluate callbacks run in the browser
import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SCRATCH_BASE = process.env.HERMES_SCRATCH || path.join(os.homedir(), ".hermes", "cache", "scratch");
const SCRATCH = mkdtempSync(path.join(SCRATCH_BASE, "pen-pressure-"));
const DATA_DIR = path.join(SCRATCH, "data");
const VITE_PORT = 8993;
const SERVER_PORT = 8994;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const ROOM = "PENTST";

const children = [];
function spawnProc(args, env, tag) {
  const child = spawn(args[0], args.slice(1), { cwd: ROOT, env: { ...process.env, ...env }, stdio: "pipe" });
  child.stderr.on("data", (d) => { if (process.env.SRV_LOG) process.stderr.write(`[${tag}] ${d}`); });
  child.stdout.on("data", (d) => { if (process.env.SRV_LOG) process.stderr.write(`[${tag}] ${d}`); });
  children.push(child);
  return child;
}
function cleanup() {
  for (const c of children) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best-effort */ }
}
process.on("exit", cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${url}`);
}

// --- tiny WS observer -------------------------------------------------------
function observeRoom() {
  const ops = [];
  const ws = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws?room=${ROOM}`);
  const connected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("observer connect timeout")), 8000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: null })));
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "connected") { clearTimeout(timer); resolve(); }
      if (msg.type === "op") ops.push(msg.op);
    });
    ws.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
  return { ops, connected, close: () => { try { ws.close(); } catch { /* gone */ } } };
}

// --- checks -----------------------------------------------------------------
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

async function main() {
  // Server: isolated port + scratch DATA_DIR, anonymous path (no PocketBase).
  spawnProc([process.execPath, "server.js"], { PORT: String(SERVER_PORT), DATA_DIR, NODE_ENV: "test" }, "srv");
  await waitForHttp(`http://127.0.0.1:${SERVER_PORT}/healthz`);

  // Vite dev on 8993 with an isolated cache (node_modules is a shared symlink)
  // and the WS override pointed at the isolated server.
  const viteConfig = path.join(SCRATCH, "vite.config.mjs");
  writeFileSync(viteConfig, [
    `import base from ${JSON.stringify(path.join(ROOT, "vite.config.js"))};`,
    `export default {`,
    `  ...base,`,
    `  cacheDir: ${JSON.stringify(path.join(SCRATCH, "vite-cache"))},`,
    `  server: { ...base.server, port: ${VITE_PORT}, strictPort: true },`,
    `};`,
    ``,
  ].join("\n"));
  const viteBin = path.join(ROOT, "node_modules", ".bin", "vite");
  spawnProc([viteBin, "--config", viteConfig], { VITE_WS_URL: `ws://127.0.0.1:${SERVER_PORT}/ws` }, "vite");
  await waitForHttp(`${BASE}/`);

  const observer = observeRoom();
  await observer.connected;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 200)));
  await page.goto(`${BASE}/join/${ROOM}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".overlay-canvas", { timeout: 20000 });
  await sleep(1500); // let the studio settle + WS join

  // Drive REAL pointer events through the studio's own handlers. Everything
  // goes through element.dispatchEvent so React's root listener runs the same
  // handleCanvasPointer* pipeline a physical stylus would.
  async function stroke({ pointerType, pressure, from, to, steps = 4, tap = false, hoverFirst = false }) {
    return page.evaluate(({ pointerType, pressure, from, to, steps, tap, hoverFirst }) => {
      const el = document.querySelector(".overlay-canvas");
      const rect = el.getBoundingClientRect();
      const at = (fx, fy) => ({ clientX: rect.left + rect.width * fx, clientY: rect.top + rect.height * fy });
      const fire = (type, pt, pr, buttons) => {
        el.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true,
          pointerId: 7, isPrimary: true, pointerType,
          button: type === "pointerup" ? 0 : 0, buttons,
          pressure: pr, tiltX: 0, tiltY: 0, width: 1, height: 1,
          ...pt,
        }));
      };
      if (hoverFirst) {
        // Pen hovering (lifted, no contact): pressure 0, buttons 0.
        fire("pointermove", at(from[0] - 0.02, from[1] - 0.02), 0, 0);
        fire("pointermove", at(from[0] - 0.01, from[1] - 0.01), 0, 0);
      }
      fire("pointerdown", at(from[0], from[1]), pressure, 1);
      if (!tap) {
        for (let i = 1; i <= steps; i += 1) {
          const fx = from[0] + (to[0] - from[0]) * (i / steps);
          const fy = from[1] + (to[1] - from[1]) * (i / steps);
          fire("pointermove", at(fx, fy), pressure, 1);
        }
      }
      fire("pointerup", at(tap ? from[0] : to[0], tap ? from[1] : to[1]), 0, 0);
      return true;
    }, { pointerType, pressure, from, to, steps, tap, hoverFirst });
  }

  // Wait for a NEW draw op (with points) authored after `mark`.
  async function nextDrawOp(mark, label, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const fresh = observer.ops.slice(mark).filter((op) => op && op.kind === "draw" && Array.isArray(op.points) && op.points.length > 0);
      if (fresh.length > 0) return fresh[0];
      await sleep(120);
    }
    throw new Error(`no draw op observed for ${label}`);
  }

  const paintedPixels = (fx, fy) => page.evaluate(({ fx, fy }) => {
    const canvas = document.querySelector(".display-canvas");
    const ctx2d = canvas.getContext("2d");
    // The canvas is pre-filled with an opaque paper color, so alpha alone
    // can't find ink — count pixels that DIFFER from the paper background
    // (sampled from an untouched corner).
    const bg = ctx2d.getImageData(4, 4, 1, 1).data;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const cx = Math.round(rect.width * fx * scaleX);
    const cy = Math.round(rect.height * fy * scaleY);
    const box = 90;
    const x0 = Math.max(0, cx - box / 2);
    const y0 = Math.max(0, cy - box / 2);
    const data = ctx2d.getImageData(x0, y0, box, box).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const diff = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
      if (diff > 40) n += 1;
    }
    return n;
  }, { fx, fy });

  // 1. Feather pen TAP (pressure 0 the whole contact) — the reported blob.
  let mark = observer.ops.length;
  await stroke({ pointerType: "pen", pressure: 0, from: [0.3, 0.3], to: [0.3, 0.3], tap: true });
  const tapOp = await nextDrawOp(mark, "pen tap pressure 0");
  const tapP = tapOp.points[0].pressure;
  check("pen tap, pressure 0 → dab pressure at the 0.02 floor, not velocity 0.65", tapP <= 0.05, `first point pressure=${tapP}`);
  await sleep(300);
  const tapPixels = await paintedPixels(0.3, 0.3);

  // 2. Light pen DRAG held at pressure 0 — every sample stays at the floor.
  mark = observer.ops.length;
  await stroke({ pointerType: "pen", pressure: 0, from: [0.3, 0.45], to: [0.5, 0.45] });
  const dragOp = await nextDrawOp(mark, "pen drag pressure 0");
  const dragPressures = dragOp.points.map((p) => p.pressure);
  check("pen drag, pressure 0 → all samples at the floor", dragPressures.every((p) => p <= 0.05), `pressures=${JSON.stringify(dragPressures)}`);

  // 3. Mid pen pressure still maps through the adaptive band.
  mark = observer.ops.length;
  await stroke({ pointerType: "pen", pressure: 0.4, from: [0.3, 0.6], to: [0.5, 0.6] });
  const midOp = await nextDrawOp(mark, "pen drag pressure 0.4");
  const midP = midOp.points[0].pressure;
  // (0.4 - 0.03) / (0.75 - 0.03) ≈ 0.51 on the default Pencil band.
  check("pen drag, pressure 0.4 → band-mapped ≈0.51", midP >= 0.45 && midP <= 0.58, `first point pressure=${midP}`);

  // 4. Pen hover (lifted) must not disturb the next real stroke's mapping.
  mark = observer.ops.length;
  await stroke({ pointerType: "pen", pressure: 0.5, from: [0.55, 0.6], to: [0.7, 0.6], hoverFirst: true });
  const liftOp = await nextDrawOp(mark, "pen after hover");
  const liftP = liftOp.points[0].pressure;
  // (0.5 - 0.03) / 0.72 ≈ 0.65.
  check("pen lift/hover then pressure 0.5 → band-mapped ≈0.65", liftP >= 0.58 && liftP <= 0.72, `first point pressure=${liftP}`);

  // 5. Mouse keeps the velocity-synthesized baseline (first sample 0.65).
  mark = observer.ops.length;
  await stroke({ pointerType: "mouse", pressure: 0.5, from: [0.3, 0.75], to: [0.5, 0.75] });
  const mouseOp = await nextDrawOp(mark, "mouse drag");
  const mouseP = mouseOp.points[0].pressure;
  check("mouse drag → velocity baseline 0.65 preserved", mouseP === 0.65, `first point pressure=${mouseP}`);

  // 6. Finger keeps the velocity path too. (Wait out the pen-priority window
  // — PEN_PRIORITY_MS = 1500 — or the app correctly ignores the finger as a
  // resting hand right after pen activity.)
  await sleep(1700);
  mark = observer.ops.length;
  await stroke({ pointerType: "touch", pressure: 0.5, from: [0.55, 0.75], to: [0.7, 0.75] });
  const touchOp = await nextDrawOp(mark, "touch drag");
  const touchP = touchOp.points[0].pressure;
  check("touch drag → velocity baseline 0.65 preserved", touchP === 0.65, `first point pressure=${touchP}`);

  // 7. The pixel-level symptom: feather pen dab vs mouse dab on the display.
  mark = observer.ops.length;
  await stroke({ pointerType: "mouse", pressure: 0.5, from: [0.6, 0.3], to: [0.6, 0.3], tap: true });
  await nextDrawOp(mark, "mouse tap");
  await sleep(300);
  const mousePixels = await paintedPixels(0.6, 0.3);
  check(
    "feather pen tap paints a visibly smaller dab than a mouse tap",
    tapPixels > 0 && mousePixels > 0 && tapPixels < mousePixels * 0.5,
    `pen-zero dab=${tapPixels}px vs mouse dab=${mousePixels}px`,
  );

  await browser.close();
  observer.close();
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error("harness crashed:", err && err.stack ? err.stack : err);
    process.exit(2);
  });
