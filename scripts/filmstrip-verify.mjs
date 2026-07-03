// Playwright verification for the film-strip + onion-skin MVP.
// Drives a LOCAL isolated server (scratch DATA_DIR) — never production.
import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, rmSync } from "fs";
import path from "path";

const ROOT = "C:/Users/Craig Campbell/Projects/happypaint";
const SCRATCH = path.join(process.env.TEMP || "/tmp", "filmstrip-verify-data");
const PORT = 8917;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.argv[2] || ".";

// Frames persist server-side now — start every run from a clean room store.
try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH },
  stdio: "pipe",
});
server.stdout.on("data", () => {});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const run = async () => {
  // Wait for the server.
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch {}
    await sleep(250);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await page.goto(`${BASE}/join/FLIPBOOK`, { waitUntil: "domcontentloaded" });
  await sleep(2500);

  // Click through any greeter/guest modal generically.
  for (const label of [/keep drawing as a guest/i, /start painting/i, /let's paint/i, /jump in/i, /continue/i]) {
    const btn = page.getByRole("button", { name: label }).first();
    if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); await sleep(600); }
  }

  // 1) The strip is mounted at the bottom of the canvas stage.
  const strip = page.locator(".film-strip");
  check("film strip visible", await strip.isVisible().catch(() => false));
  const stripBox = await strip.boundingBox();
  const paperBox = await page.locator(".canvas-paper").boundingBox();
  check("strip sits BELOW the canvas (no overlap)", !!stripBox && !!paperBox && stripBox.y >= paperBox.y + paperBox.height - 2,
    `paperBottom=${paperBox && Math.round(paperBox.y + paperBox.height)} stripTop=${stripBox && Math.round(stripBox.y)}`);

  // 2) One starting cel; add two frames.
  const cels = page.locator(".fs-cel");
  check("starts with 1 cel", (await cels.count()) === 1, `count=${await cels.count()}`);
  await page.locator(".fs-add").click();
  await sleep(300);
  await page.locator(".fs-add").click();
  await sleep(300);
  check("add frame -> 3 cels", (await cels.count()) === 3, `count=${await cels.count()}`);

  // 3) Draw a stroke on frame 3 (currently active after adds).
  const overlay = page.locator(".overlay-canvas");
  const ob = await overlay.boundingBox();
  await page.mouse.move(ob.x + ob.width * 0.4, ob.y + ob.height * 0.4);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(ob.x + ob.width * (0.4 + i * 0.02), ob.y + ob.height * (0.4 + i * 0.015));
    await sleep(30);
  }
  await page.mouse.up();
  await sleep(800);
  check("drew a stroke without errors", consoleErrors.length === 0, consoleErrors[0] || "");

  // 4) Onion toggle.
  const onion = page.locator(".fs-onion");
  await onion.click();
  await sleep(400);
  check("onion toggle aria-pressed", (await onion.getAttribute("aria-pressed")) === "true");

  // 5) Eyeball hides frame 2 locally.
  const cel2 = page.locator(".fs-cel").nth(1);
  await cel2.locator(".fs-eye").click();
  await sleep(300);
  check("eyeball marks cel hidden", ((await cel2.getAttribute("class")) || "").includes("is-hidden"));

  // 6) Scrub rail: drag from left to right lands on the last frame.
  const rail = page.locator(".fs-rail");
  const rb = await rail.boundingBox();
  await page.mouse.move(rb.x + 4, rb.y + rb.height / 2);
  await page.mouse.down();
  await page.mouse.move(rb.x + rb.width * 0.5, rb.y + rb.height / 2, { steps: 6 });
  await sleep(120);
  await page.mouse.move(rb.x + rb.width - 4, rb.y + rb.height / 2, { steps: 6 });
  await sleep(120);
  await page.mouse.up();
  await sleep(500);
  const activeIdx = await page.locator(".fs-cel.is-active small").innerText().catch(() => "?");
  check("scrub to end selects last frame", activeIdx === "3", `active=${activeIdx}`);

  // 7) Play/pause runs.
  const play = page.locator(".fs-transport button").nth(1);
  await play.click();
  await sleep(700);
  const paused = await play.getAttribute("aria-pressed");
  check("playback started", paused === "true");
  await play.click();
  await sleep(300);

  // 8) Reel menu opens with export actions.
  await page.locator(".fs-menu-toggle").click();
  await sleep(200);
  check("reel menu shows Export GIF", await page.getByRole("button", { name: /export gif/i }).isVisible().catch(() => false));
  await page.locator(".fs-menu-toggle").click();

  // 9) Desktop screenshot.
  await page.screenshot({ path: path.join(SHOTS, "filmstrip-desktop.png") });

  // 10) Mobile viewport — a FRESH phone load (chat starts closed on phones),
  // not a resized desktop session dragging its open chat window along.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/join/FLIPBOOK`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  await page.locator(".fs-add").click().catch(() => {});
  await sleep(400);
  check("strip visible on mobile", await strip.isVisible().catch(() => false));
  const mStrip = await strip.boundingBox();
  check("mobile strip is compact (<=120px tall)", !!mStrip && mStrip.height <= 120, `h=${mStrip && Math.round(mStrip.height)}`);
  await page.screenshot({ path: path.join(SHOTS, "filmstrip-mobile.png") });

  check("zero console errors end-to-end", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
};

run().catch((e) => { console.error("harness error:", e); server.kill(); process.exit(1); });
