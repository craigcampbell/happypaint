/* eslint-env node */
// Room-loading fidelity — Phase 1 INTEGRATION: seeded-eraser 3-way parity in
// the real app (local painter vs live remote vs remote after history reload).
//
// Spawns the REAL server.js on 127.0.0.1:19101 against a throwaway DATA_DIR
// (under the Hermes scratch dir; accounts unset → anonymous path), opens two
// headless-Chrome pages in one random private room, then:
//   1. p1 draws a marker X and erases a band through it at 30% size variation.
//   2. The display-canvas rect is SHA-256 hashed on p1 (local render), p2
//      (live remote render) and p2 after a full reload (history replay).
//   3. All three hashes must be identical — the seeded eraser rolls the same
//      per-point dice on every path (pointRand(seed, x, y) over the WIRE
//      points). Before the phase-1 fix all three eraser paths rolled
//      Math.random and this test fails.
//
// Requires a built client: `npm run build` first (server.js serves dist/).
//
//   node test/room-fidelity-phase1.integration.mjs
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.FIDELITY_API_PORT || 19101);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = "/home/craig/.hermes/cache/scratch/fidelity-phase1/data";
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const ROOM = `ZZF1${Math.floor(Math.random() * 900 + 100)}`;

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

let browser;
try {
  await waitForHealth();
  browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-accelerated-2d-canvas"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 850 } });
  const p2 = await ctx.newPage();
  await p2.goto(`${BASE}/join/${ROOM}`, { waitUntil: "networkidle" });
  await p2.waitForTimeout(2000);
  const p1 = await ctx.newPage();
  await p1.goto(`${BASE}/join/${ROOM}`, { waitUntil: "networkidle" });
  await p1.waitForSelector(".overlay-canvas");
  await p1.waitForTimeout(2000);

  // Identical geometry is a precondition for byte-comparing the display
  // canvas (same technique as scripts/brush-parity-test.mjs).
  const geometry = (page) => page.evaluate(() => {
    const d = document.querySelector(".display-canvas");
    const rr = d.getBoundingClientRect();
    return [Math.round(rr.x), Math.round(rr.y), Math.round(rr.width), Math.round(rr.height), d.width, d.height, window.devicePixelRatio];
  });
  const layout = { local: await geometry(p1), live: await geometry(p2) };
  layout.identical = layout.local.join(",") === layout.live.join(",");
  check("precondition: identical display-canvas geometry on both clients", layout.identical, JSON.stringify(layout));

  // 30% size variation so the eraser's jitter is unmistakable (default 8%).
  await p1.evaluate(() => {
    const slider = document.querySelector('input[aria-label="Brush variation"]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    set.call(slider, "30");
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });

  const pickBrush = (name) => p1.evaluate((n) => {
    const chip = [...document.querySelectorAll(".brush-chip")].find((c) => new RegExp(n, "i").test(c.textContent));
    if (chip) chip.click();
    return !!chip;
  }, name);

  const r = await p1.evaluate(() => {
    const e = document.querySelector(".overlay-canvas").getBoundingClientRect();
    return { x: e.x, y: e.y, w: e.width, h: e.height };
  });
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const stroke = async (x0, y0, x1, y1) => {
    await p1.mouse.move(x0, y0);
    await p1.mouse.down();
    for (let t = 0; t <= 1.001; t += 0.05) {
      await p1.mouse.move(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, { steps: 2 });
      await p1.waitForTimeout(9);
    }
    await p1.mouse.up();
    await p1.waitForTimeout(1200);
  };

  check("precondition: marker chip found", await pickBrush("Marker"));
  await stroke(cx - 300, cy - 150, cx + 100, cy + 150);
  await stroke(cx + 100, cy - 150, cx - 300, cy + 150);
  check("precondition: eraser chip found", await pickBrush("Eraser"));
  await stroke(cx - 320, cy, cx + 120, cy + 40);

  const hashRect = (page) => page.evaluate(() => {
    const el = document.querySelector(".display-canvas");
    const g = el.getContext("2d");
    const rr = el.getBoundingClientRect();
    const sx = el.width / rr.width;
    const sy = el.height / rr.height;
    const data = g.getImageData(0, 0, el.width, el.height).data;
    let painted = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) painted += 1;
    }
    return { bytes: Array.from(data), painted, sx, sy };
  });
  const sha = (bytes) => createHash("sha256").update(Buffer.from(bytes)).digest("hex");

  const local = await hashRect(p1);
  const live = await hashRect(p2);
  const hashes = { local: sha(local.bytes), live: sha(live.bytes) };
  check("marker+eraser actually painted", local.painted > 5000, `painted ${local.painted}`);
  check("eraser parity: local render == live remote render", hashes.local === hashes.live, `local ${hashes.local} live ${hashes.live}`);

  await p2.reload({ waitUntil: "networkidle" });
  await p2.waitForTimeout(3500);
  const history = await hashRect(p2);
  hashes.history = sha(history.bytes);
  check("eraser parity: local render == history replay after reload", hashes.local === hashes.history, `local ${hashes.local} history ${hashes.history}`);

  console.log(JSON.stringify({ ROOM, layout, painted: local.painted, hashes }, null, 2));
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
console.log("room-fidelity phase-1 integration: eraser parity holds on all three paths.");
