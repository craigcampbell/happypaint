// Multi-client verification of the SHARED animation rooms (Google-Docs model)
// + film-strip gating + video export. Drives a LOCAL isolated server.
//
// The story under test: the strip only exists in FLIPBOOK (and private rooms
// that opt in); frames are shared state — B sees A's frames/strokes live, and
// someone who leaves and rejoins sees everything done while they were gone.
import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, rmSync } from "fs";
import path from "path";

const ROOT = "C:/Users/Craig Campbell/Projects/happypaint";
const SCRATCH = path.join(process.env.TEMP || "/tmp", "anim-sync-verify-data");
const PORT = 8919;
const BASE = `http://localhost:${PORT}`;

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH },
  stdio: "pipe",
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

// Count "inky" (dark) pixels on the visible display canvas — strokes are drawn
// with the default near-black marker, paper is light, so this is a robust
// "is there art on the frame I'm looking at" probe.
async function darkPixels(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector(".display-canvas");
    if (!canvas) return -1;
    const ctx = canvas.getContext("2d");
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 16) { // sample every 4th pixel
      if (data[i + 3] > 100 && data[i] < 90 && data[i + 1] < 90 && data[i + 2] < 90) dark += 1;
    }
    return dark;
  });
}

async function drawStroke(page, fx = 0.45, fy = 0.45) {
  const overlay = page.locator(".overlay-canvas");
  const box = await overlay.boundingBox();
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) {
    await page.mouse.move(box.x + box.width * (fx + i * 0.015), box.y + box.height * (fy + i * 0.01));
    await sleep(25);
  }
  await page.mouse.up();
  await sleep(700); // stroke commit + relay
}

const selectCel = async (page, index) => {
  await page.locator(".fs-cel-thumb").nth(index).click();
  await sleep(500);
};

const run = async () => {
  for (let i = 0; i < 40; i += 1) {
    try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch { /* boot */ }
    await sleep(250);
  }

  const browser = await chromium.launch({ headless: true });
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const errors = [];
  for (const [tag, page] of [["A", pageA], ["B", pageB]]) {
    page.on("pageerror", (err) => errors.push(`${tag}: ${err}`));
    page.on("console", (msg) => { if (msg.type() === "error") errors.push(`${tag}: ${msg.text()}`); });
  }

  // 1) Gating: MAIN (public drawing room) has NO strip.
  await pageA.goto(`${BASE}/join/MAIN`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  check("no film strip in MAIN (public drawing room)", !(await pageA.locator(".film-strip").isVisible().catch(() => false)));

  // 2) FLIPBOOK has the strip.
  await pageA.goto(`${BASE}/join/FLIPBOOK`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  check("film strip present in FLIPBOOK", await pageA.locator(".film-strip").isVisible().catch(() => false));

  // 3) A adds a frame (server round-trip) and lands on it.
  await pageA.locator(".fs-add").click();
  await sleep(900);
  check("A: add frame via server echo -> 2 cels", (await pageA.locator(".fs-cel").count()) === 2);
  const aActive = await pageA.locator(".fs-cel.is-active small").innerText().catch(() => "?");
  check("A lands on the new frame", aActive === "2", `active=${aActive}`);

  // 4) A draws on frame 2; B joins and sees the same structure + art.
  await drawStroke(pageA);
  await pageB.goto(`${BASE}/join/FLIPBOOK`, { waitUntil: "domcontentloaded" });
  await sleep(2800);
  check("B: joins and sees 2 cels", (await pageB.locator(".fs-cel").count()) === 2);
  await selectCel(pageB, 1);
  const bSeesA = await darkPixels(pageB);
  check("B sees A's frame-2 art (join catch-up)", bSeesA > 50, `darkPixels=${bSeesA}`);

  // 5) Live sync: B draws on frame 2, A (also on frame 2) sees it appear.
  const aBefore = await darkPixels(pageA);
  await drawStroke(pageB, 0.55, 0.35);
  await sleep(800);
  const aAfter = await darkPixels(pageA);
  check("A sees B's stroke live on the same frame", aAfter > aBefore + 30, `${aBefore} -> ${aAfter}`);

  // 6) THE GOOGLE-DOCS TEST: A leaves; B keeps working (new frame + art);
  //    A comes back and sees everything B did.
  await pageA.goto("about:blank");
  await sleep(400);
  await pageB.locator(".fs-add").click();
  await sleep(900);
  await drawStroke(pageB, 0.4, 0.55); // B draws on the new frame 3
  await pageA.goto(`${BASE}/join/FLIPBOOK`, { waitUntil: "domcontentloaded" });
  await sleep(2800);
  check("A rejoins: sees B's new frame (3 cels)", (await pageA.locator(".fs-cel").count()) === 3);
  await selectCel(pageA, 2);
  const rejoinArt = await darkPixels(pageA);
  check("A rejoins: sees art B drew while A was away", rejoinArt > 50, `darkPixels=${rejoinArt}`);

  // 7) Per-frame clear: A clears frame 3 for everyone; frame 2 survives.
  await pageA.locator("button", { hasText: "Clear" }).first().click();
  await sleep(400);
  await pageA.getByRole("button", { name: /yes, clear it/i }).click();
  await sleep(900);
  const clearedA = await darkPixels(pageA);
  check("A: clear wipes the current frame", clearedA < 20, `darkPixels=${clearedA}`);
  await selectCel(pageB, 2);
  const clearedB = await darkPixels(pageB);
  check("B: sees frame 3 cleared too", clearedB < 20, `darkPixels=${clearedB}`);
  await selectCel(pageB, 1);
  const frame2Intact = await darkPixels(pageB);
  check("B: frame 2 art survived the frame-3 clear", frame2Intact > 50, `darkPixels=${frame2Intact}`);

  // 8) Video export downloads a real file.
  await pageA.locator(".fs-menu-toggle").click();
  await sleep(200);
  const downloadPromise = pageA.waitForEvent("download", { timeout: 60000 }).catch(() => null);
  await pageA.getByRole("button", { name: /export video/i }).click();
  const download = await downloadPromise;
  let videoOk = false;
  let videoDetail = "no download";
  if (download) {
    const file = path.join(SCRATCH, download.suggestedFilename());
    await download.saveAs(file);
    const { statSync } = await import("fs");
    const size = statSync(file).size;
    videoOk = size > 2000;
    videoDetail = `${download.suggestedFilename()} (${size} bytes)`;
  }
  check("video export produces a real file", videoOk, videoDetail);

  const fatal = errors.filter((e) => !/favicon|manifest/i.test(e));
  check("zero page errors across both clients", fatal.length === 0, fatal.slice(0, 2).join(" | "));

  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
};

run().catch((e) => { console.error("harness error:", e); server.kill(); process.exit(1); });
