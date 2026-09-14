/* eslint-env browser, node */
// Run: node scripts/pressure-verify.mjs  (Chromium via CDP — the one way to dispatch a PEN with force)
// Pressure mode check: for each Hand & pen "Pressure" mode, draw one pen
// stroke whose force ramps 0.08 -> 1.0 left to right, then compare the light
// end and the heavy end of the stroke on the display canvas:
//   width    = rows that carry ink in a vertical slice  (size follows pressure?)
//   darkness = mean (255 - min channel) over inked samples (opacity follows?)
import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, rmSync } from "fs";
import path from "path";

const ROOT = "C:/Users/Craig Campbell/Projects/happypaint";
const SCRATCH = path.join(process.env.TEMP || "/tmp", "pressure-verify-data");
const PORT = 8941;
const BASE = `http://localhost:${PORT}`;
const ROOM = "/join/ZZPR";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
const server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH }, stdio: "pipe" });

const pen = async (cdp, type, p, force, buttons) =>
  cdp.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1, pointerType: "pen", force });

// Sample a vertical slice (CSS px column band) of the display canvas.
const slice = (page, x, y0, y1, band = 6) => page.evaluate(([x, y0, y1, band]) => {
  const c = document.querySelector(".display-canvas");
  const r = c.getBoundingClientRect();
  const sx = c.width / r.width;
  const sy = c.height / r.height;
  const px = Math.floor((x - r.left) * sx);
  const py0 = Math.floor((y0 - r.top) * sy);
  const h = Math.ceil((y1 - y0) * sy);
  const w = Math.ceil(band * sx);
  const d = c.getContext("2d", { willReadFrequently: true }).getImageData(px, py0, w, h).data;
  const rows = new Set();
  let dark = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const m = Math.min(d[i], d[i + 1], d[i + 2]);
    if (d[i + 3] > 8 && m < 235) {
      rows.add(Math.floor(i / 4 / w));
      dark += 255 - m;
      n += 1;
    }
  }
  return { width: Math.round(rows.size / sy), darkness: n ? Math.round(dark / n) : 0 };
}, [x, y0, y1, band]);

const results = [];
const run = async () => {
  for (let i = 0; i < 60; i += 1) { try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch { /* boot */ } await sleep(250); }
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await page.goto(BASE + ROOM, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".overlay-canvas", { timeout: 15000 });
  await sleep(2800);
  // Big round marker so width differences are unmistakable.
  await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((el) => /Marker/.test(el.textContent)); b && b.click(); });
  let y = 150;
  for (const mode of ["size", "opacity", "both", "off"]) {
    await page.evaluate((m) => {
      const raw = JSON.parse(localStorage.getItem("happypaint:input-prefs:v1") || "{}");
      localStorage.setItem("happypaint:input-prefs:v1", JSON.stringify({ ...raw, pressure: m }));
    }, mode);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".overlay-canvas", { timeout: 15000 });
    await sleep(2800);
    const seen = await page.evaluate(() => [...document.querySelectorAll(".pref-pressure .seg-toggle button")].find((b) => b.classList.contains("is-on"))?.textContent.trim());
    // Set a fat brush via the Size slider so both ends are measurable.
    await page.evaluate(() => {
      const input = document.querySelector('input[aria-label="Brush size"]');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, "60");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await sleep(200);
    const from = { x: 200, y };
    const to = { x: 800, y };
    await pen(cdp, "mouseMoved", from, 0, 0);
    await pen(cdp, "mousePressed", from, 0.08, 1);
    const steps = 40;
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      await pen(cdp, "mouseMoved", { x: Math.round(from.x + (to.x - from.x) * t), y }, 0.08 + 0.92 * t, 1);
      await sleep(12);
    }
    await pen(cdp, "mouseReleased", to, 0, 0);
    await sleep(900);
    const light = await slice(page, 270, y - 80, y + 80);
    const heavy = await slice(page, 730, y - 80, y + 80);
    results.push({ mode, seen, light, heavy });
    console.log(`${mode.padEnd(8)} toggle=${seen}  light: width ${light.width}px darkness ${light.darkness}   heavy: width ${heavy.width}px darkness ${heavy.darkness}`);
    y += 160;
  }
  await page.screenshot({ path: path.join(process.env.TEMP || "/tmp", "pressure-modes.png") });
  await browser.close();
  server.kill();
  const by = Object.fromEntries(results.map((r) => [r.mode, r]));
  const checks = [
    ["size: heavy end wider than light end", by.size.heavy.width > by.size.light.width * 1.6],
    ["opacity: heavy end darker than light end", by.opacity.heavy.darkness > by.opacity.light.darkness * 1.35],
    ["opacity: width roughly constant", Math.abs(by.opacity.heavy.width - by.opacity.light.width) <= 6],
    ["both: wider AND darker at the heavy end", by.both.heavy.width > by.both.light.width * 1.6 && by.both.heavy.darkness > by.both.light.darkness * 1.35],
    ["off: width and darkness roughly constant", Math.abs(by.off.heavy.width - by.off.light.width) <= 6 && by.off.heavy.darkness < by.off.light.darkness * 1.25],
    ["the rail toggle reflects each mode", results.every((r) => r.seen && r.seen.toLowerCase() === r.mode)],
  ];
  let failed = 0;
  for (const [name, ok] of checks) { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failed += 1; }
  process.exit(failed ? 1 : 0);
};
run().catch((e) => { console.error(e); server.kill(); process.exit(2); });
