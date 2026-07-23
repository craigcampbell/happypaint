// Timelapse share verification: draw a few strokes, open the 🎬 Timelapse
// player, confirm it captured snapshots, that "Save GIF" produces a real GIF,
// and that the "Share my timelapse" button is present + works (headless has no
// file share sheet, so it falls back to a download we can capture).
import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, rmSync, statSync, readFileSync } from "fs";
import path from "path";

const ROOT = "C:/Users/Craig Campbell/Projects/happypaint";
const SCRATCH = path.join(process.env.TEMP || "/tmp", "timelapse-verify-data");
const PORT = 8924;
const BASE = `http://localhost:${PORT}`;

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH }, stdio: "pipe",
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function drawStroke(page, fx, fy) {
  const overlay = page.locator(".overlay-canvas");
  const box = await overlay.boundingBox();
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) {
    await page.mouse.move(box.x + box.width * (fx + i * 0.02), box.y + box.height * (fy + i * 0.015));
    await sleep(25);
  }
  await page.mouse.up();
  await sleep(400);
}
const isGif = (file) => { try { return readFileSync(file).slice(0, 4).toString("latin1") === "GIF8"; } catch { return false; } };

const run = async () => {
  for (let i = 0; i < 40; i += 1) {
    try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch { /* boot */ }
    await sleep(250);
  }
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto(`${BASE}/join/ZZLAPSE`, { waitUntil: "domcontentloaded" });
  await sleep(2500);

  // Draw several strokes over time so the recorder accumulates snapshots.
  await drawStroke(page, 0.35, 0.35);
  await drawStroke(page, 0.45, 0.45);
  await drawStroke(page, 0.55, 0.4);
  await drawStroke(page, 0.4, 0.55);
  await sleep(600);

  // Open the timelapse player from the topbar (open the Studio dropdown first).
  const toggle = page.locator(".desktop-studio-toggle");
  if (await toggle.isVisible().catch(() => false)) {
    const open = await page.evaluate(() => document.querySelector(".topbar")?.className.includes("is-open"));
    if (!open) { await toggle.click(); await sleep(320); }
  }
  await page.locator(".topbar-actions button", { hasText: "🎬 Timelapse" }).click();
  await sleep(900);
  check("🎬 Timelapse opens the replay player", await page.locator(".replay-actions").isVisible().catch(() => false));
  check("the timelapse captured snapshots to play", await page.locator(".replay-share").isVisible().catch(() => false));

  // Save GIF (reliable download) → verify it's a real GIF.
  const gifDl = page.waitForEvent("download", { timeout: 60000 }).catch(() => null);
  await page.locator(".replay-actions button", { hasText: "Save GIF" }).click();
  const gif = await gifDl;
  let gifOk = false, gifDetail = "no download";
  if (gif) {
    const f = path.join(SCRATCH, gif.suggestedFilename());
    await gif.saveAs(f);
    gifOk = isGif(f) && statSync(f).size > 100;
    gifDetail = `${gif.suggestedFilename()} (${statSync(f).size}B, gif=${isGif(f)})`;
  }
  check("Save GIF produces a real timelapse GIF", gifOk, gifDetail);

  // Share my timelapse → headless has no file share sheet, so it downloads.
  const shareDl = page.waitForEvent("download", { timeout: 60000 }).catch(() => null);
  await page.locator(".replay-share").click();
  const shared = await shareDl;
  let shareOk = false, shareDetail = "no download (share sheet?)";
  if (shared) {
    const f = path.join(SCRATCH, shared.suggestedFilename());
    await shared.saveAs(f);
    shareOk = isGif(f) && statSync(f).size > 100;
    shareDetail = `${shared.suggestedFilename()} (${statSync(f).size}B)`;
  }
  check("Share my timelapse yields a shareable GIF (download fallback)", shareOk, shareDetail);

  const fatal = errors.filter((e) => !/favicon|manifest/i.test(e));
  check("zero page errors", fatal.length === 0, fatal.slice(0, 2).join(" | "));

  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
};

run().catch((e) => { console.error("harness error:", e); server.kill(); process.exit(1); });
