// Undo takes back MY last stroke — and nobody else's.
//
// Since layers became shared room state, a friend's op paints into the same
// layer stack we do, so the snapshot an undo entry holds ("my layer before my
// stroke") also freezes the room at that instant. Restoring it verbatim rubbed
// every stroke a friend had added since off OUR screen. App.jsx now stamps each
// entry with a mark into utils/sharedOpLog and replays the friends' ops back
// over the restore. This harness drives two real browsers in one room and
// proves it, stroke by stroke.
//
// What it checks, with two Chromium clients (A = us, B = a friend) in one room:
//   A. Placement: undo is the floating pill over the canvas top-right on
//      desktop and its own button at the end of the quick bar on a phone —
//      and it is GONE from the tool rail's Actions list in both.
//   B. Interleaved strokes: A·B·A·B, then two undos and a redo. Only A's own
//      strokes move; B's stay exactly where they were, every step.
//   C. Crossing strokes: B's stroke drawn ACROSS A's survives A's undo — the
//      case the old snapshot restore always destroyed.
//   D. The known edge: a local undo does not retract the op from the room, so
//      B still sees A's undone stroke. Asserted so the limit stays visible.
//
// Screenshots land in the scratchpad `undo/` folder (or $UNDO_SHOTS).
import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, rmSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

// Derive the checkout from this file, so a worktree runs ITS OWN server.js
// rather than the main checkout's (the trap most of the older harnesses fell
// into by hard-coding an absolute ROOT).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = process.env.TEMP || "/tmp";
const SCRATCH = path.join(TMP, "undo-verify-data");
const SHOTS = process.env.UNDO_SHOTS || path.join(TMP, "undo");
const PORT = 8944;
const BASE = `http://localhost:${PORT}`;
const ROOM = "/join/ZZUN";

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  // PB_URL blanked: these clients join as guests and must not wait on a
  // PocketBase that this harness never starts.
  env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH, PB_URL: "" },
  stdio: "pipe",
});
server.stderr.on("data", (d) => { if (process.env.SRV_LOG) process.stderr.write("[srv] " + d); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
const guard = async (name, fn) => {
  try { await fn(); } catch (e) { check(name, false, "harness threw: " + String(e).slice(0, 220)); }
};

// ---- page helpers -----------------------------------------------------------
async function openRoom(context) {
  const page = await context.newPage();
  page.on("pageerror", (e) => { if (process.env.SRV_LOG) console.log("[page] " + e.message); });
  await page.goto(BASE + ROOM, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".overlay-canvas", { timeout: 20000 });
  await sleep(3000); // join curtain
  return page;
}

const rect = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const st = getComputedStyle(el);
  return {
    x: r.left, y: r.top, w: r.width, h: r.height,
    cx: r.left + r.width / 2, cy: r.top + r.height / 2,
    visible: st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0,
  };
}, sel);

// Everything below is in DISPLAY-CANVAS PIXELS, not screen coordinates. The two
// clients put their canvas at different screen offsets (the room bar differs
// between the artist who opened the room and the one who joined it), so a
// "40% across the element" probe is a different piece of art on each page.
// Canvas pixels are the one frame both pages share.
const geom = (page) => page.evaluate(() => {
  const c = document.querySelector(".display-canvas");
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, cw: c.width, ch: c.height };
});
const toScreen = (g, p) => ({
  x: Math.round(g.x + p.x * g.w / g.cw),
  y: Math.round(g.y + p.y * g.h / g.ch),
});

// Ink inside a canvas-pixel rectangle (dark, opaque samples).
const inkIn = (page, box) => page.evaluate((b) => {
  const c = document.querySelector(".display-canvas");
  if (!c) return -1;
  try {
    const x0 = Math.max(0, Math.round(b.x));
    const y0 = Math.max(0, Math.round(b.y));
    const w = Math.min(c.width - x0, Math.round(b.w));
    const h = Math.min(c.height - y0, Math.round(b.h));
    if (w <= 0 || h <= 0) return 0;
    const d = c.getContext("2d", { willReadFrequently: true }).getImageData(x0, y0, w, h).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4 * 5) {
      if (d[i + 3] > 8 && (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235)) ink += 1;
    }
    return ink;
  } catch { return -1; }
}, box);

// Wait for a region to gain ink (a friend's stroke arriving over the wire).
async function waitForInk(page, box, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    if ((await inkIn(page, box)) > 4) return true;
    await sleep(150);
  }
  return false;
}

// `from`/`to` are canvas pixels; the page's own geometry turns them into the
// screen points its mouse needs.
async function drawStroke(page, g, from, to, steps = 14) {
  const a = toScreen(g, from);
  const b = toScreen(g, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(
      Math.round(a.x + (b.x - a.x) * i / steps),
      Math.round(a.y + (b.y - a.y) * i / steps),
    );
    await sleep(16);
  }
  await page.mouse.up();
  await sleep(300); // the stroke's end op + its wire flush
}

// Four columns that never touch, plus the probe box over each — in canvas
// pixels, sized to the SHORTER of the two clients so every point exists on both.
function lanes(gA, gB) {
  const w = Math.min(gA.cw, gB.cw);
  const h = Math.min(gA.ch, gB.ch);
  const col = (f) => ({
    from: { x: Math.round(w * f), y: Math.round(h * 0.3) },
    to: { x: Math.round(w * f), y: Math.round(h * 0.68) },
    probe: { x: w * f - 16, y: h * 0.36, w: 32, h: h * 0.26 },
  });
  return { w, h, a1: col(0.16), b1: col(0.38), a2: col(0.6), b2: col(0.82) };
}

// ---- run --------------------------------------------------------------------
const browser = await chromium.launch();
// A desktop-tier client (wide, fine pointer) for us and for the friend.
const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });

let A = null;
let B = null;
try {
  await sleep(1400); // let the server bind
  A = await openRoom(ctxA);
  B = await openRoom(ctxB);

  // ---- A. placement --------------------------------------------------------
  await guard("A placement", async () => {
    console.log("\n  -- A. where the button lives --");
    const fab = await rect(A, ".undo-fab");
    const paper = await rect(A, ".canvas-paper");
    check("A1 desktop shows the floating undo", !!fab?.visible,
      fab ? `${Math.round(fab.w)}x${Math.round(fab.h)}` : "no .undo-fab");
    check("A2 it floats in the canvas top-right",
      !!(fab && paper && fab.cx > paper.x + paper.w * 0.6 && fab.cy < paper.y + paper.h * 0.25),
      fab && paper ? `centre ${Math.round(fab.cx)},${Math.round(fab.cy)} of paper ${Math.round(paper.x)},${Math.round(paper.y)} ${Math.round(paper.w)}x${Math.round(paper.h)}` : "");
    check("A3 it does not overlap the other top-right chrome", await A.evaluate(() => {
      const fabEl = document.querySelector(".undo-fab");
      if (!fabEl) return false;
      const f = fabEl.getBoundingClientRect();
      const others = [".wipe-chip", ".room-prompt-chip", ".zoom-controls"];
      return others.every((sel) => {
        const el = document.querySelector(sel);
        if (!el) return true;
        const r = el.getBoundingClientRect();
        if (!r.width) return true;
        return r.right <= f.left || r.left >= f.right || r.bottom <= f.top || r.top >= f.bottom;
      });
    }));
    // Taken out of the rail's Actions list and the desktop studio menu.
    const railUndo = await A.$$eval(".mobile-actions-grid button", (els) => els.filter((e) => /undo/i.test(e.textContent)).length);
    const menuUndo = await A.$$eval(".topbar-actions button", (els) => els.filter((e) => /^undo$/i.test(e.textContent.trim())).length);
    check("A4 undo is gone from the tool rail's Actions", railUndo === 0, `${railUndo} found`);
    check("A5 undo is gone from the desktop studio menu", menuUndo === 0, `${menuUndo} found`);
    // Redo stayed where it was — only undo was promoted.
    const railRedo = await A.$$eval(".mobile-actions-grid button", (els) => els.filter((e) => /redo/i.test(e.textContent)).length);
    check("A6 redo is still in the rail", railRedo === 1, `${railRedo} found`);
    await A.screenshot({ path: path.join(SHOTS, "desktop-fab.png") });
  });

  await guard("A phone placement", async () => {
    const ctxP = await browser.newContext({
      viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6,
    });
    const P = await openRoom(ctxP);
    const btn = await rect(P, ".mobile-quickbar .qb-undo");
    const bar = await rect(P, ".mobile-quickbar");
    const vw = await P.evaluate(() => window.innerWidth);
    check("A7 the phone quick bar carries undo", !!btn?.visible,
      btn ? `${Math.round(btn.w)}x${Math.round(btn.h)}` : "no .qb-undo");
    check("A8 it is the last item, behind a hairline", await P.evaluate(() => {
      const kids = [...document.querySelector(".mobile-quickbar").children].filter((e) => e.tagName === "BUTTON" || e.classList.contains("qb-sep"));
      const last = kids[kids.length - 1];
      return Boolean(last?.classList.contains("qb-undo") && kids[kids.length - 2]?.classList.contains("qb-sep"));
    }));
    check("A9 the eight-item bar still fits the phone", !!bar && bar.x >= 0 && bar.x + bar.w <= vw + 0.5,
      bar ? `bar ${Math.round(bar.x)}..${Math.round(bar.x + bar.w)} of ${vw}` : "no bar");
    check("A10 no floating pill on a phone (zoom owns that corner)", !(await rect(P, ".undo-fab")));
    await P.screenshot({ path: path.join(SHOTS, "phone-quickbar.png") });
    await ctxP.close();
  });

  // ---- B. interleaved strokes ---------------------------------------------
  const gA = await geom(A);
  const gB = await geom(B);
  check("B0 both clients share one canvas-pixel frame",
    !!(gA && gB) && Math.abs(gA.cw - gB.cw) < 2,
    gA && gB ? `A ${gA.cw}x${gA.ch} @${Math.round(gA.x)},${Math.round(gA.y)} · B ${gB.cw}x${gB.ch} @${Math.round(gB.x)},${Math.round(gB.y)}` : "no canvas");

  await guard("B interleaved", async () => {
    console.log("\n  -- B. A · B · A · B, then undo undo redo --");
    const L = lanes(gA, gB);

    await drawStroke(A, gA, L.a1.from, L.a1.to);          // mine #1
    check("B0b my first stroke reaches my friend", await waitForInk(B, L.a1.probe));
    await drawStroke(B, gB, L.b1.from, L.b1.to);          // friend #1
    await waitForInk(A, L.b1.probe);
    await drawStroke(A, gA, L.a2.from, L.a2.to);          // mine #2
    await waitForInk(B, L.a2.probe);
    await drawStroke(B, gB, L.b2.from, L.b2.to);          // friend #2
    await waitForInk(A, L.b2.probe);

    const read = async () => ({
      a1: await inkIn(A, L.a1.probe), b1: await inkIn(A, L.b1.probe),
      a2: await inkIn(A, L.a2.probe), b2: await inkIn(A, L.b2.probe),
    });
    const before = await read();
    check("B1 all four strokes are on my canvas",
      before.a1 > 4 && before.b1 > 4 && before.a2 > 4 && before.b2 > 4, JSON.stringify(before));
    await A.screenshot({ path: path.join(SHOTS, "b-before-undo.png") });

    await A.click(".undo-fab");
    await sleep(500);
    const one = await read();
    check("B2 one undo takes back MY newest stroke", one.a2 <= 4, `a2 ${before.a2} -> ${one.a2}`);
    check("B3 …and leaves my friend's newer stroke alone", one.b2 > 4, `b2 ${before.b2} -> ${one.b2}`);
    check("B4 …and their older one", one.b1 > 4, `b1 ${before.b1} -> ${one.b1}`);
    check("B5 …and my own older one", one.a1 > 4, `a1 ${before.a1} -> ${one.a1}`);
    await A.screenshot({ path: path.join(SHOTS, "b-after-undo-1.png") });

    await A.click(".undo-fab");
    await sleep(500);
    const two = await read();
    check("B6 a second undo reaches my previous stroke, not theirs",
      two.a1 <= 4 && two.b1 > 4 && two.b2 > 4, JSON.stringify(two));
    await A.screenshot({ path: path.join(SHOTS, "b-after-undo-2.png") });

    const redo = A.locator(".mobile-actions-grid button", { hasText: "Redo" });
    await A.click(".mobile-actions-grid").catch(() => {});
    await redo.click({ force: true });
    await sleep(500);
    const back = await read();
    check("B7 redo brings my stroke back and still leaves theirs be",
      back.a1 > 4 && back.b1 > 4 && back.b2 > 4, JSON.stringify(back));
  });

  // ---- C. crossing strokes -------------------------------------------------
  await guard("C crossing", async () => {
    console.log("\n  -- C. a friend draws ACROSS my stroke --");
    const L = lanes(gA, gB);
    // Mine: a long horizontal near the bottom. Theirs: a vertical through it.
    const hFrom = { x: Math.round(L.w * 0.2), y: Math.round(L.h * 0.85) };
    const hTo = { x: Math.round(L.w * 0.8), y: Math.round(L.h * 0.85) };
    const vFrom = { x: Math.round(L.w * 0.5), y: Math.round(L.h * 0.76) };
    const vTo = { x: Math.round(L.w * 0.5), y: Math.round(L.h * 0.94) };
    // Probes: a slice only MY line covers, and a slice only THEIRS covers.
    const mineOnly = { x: L.w * 0.24, y: L.h * 0.85 - 12, w: 48, h: 24 };
    const theirsOnly = { x: L.w * 0.5 - 12, y: L.h * 0.78, w: 24, h: 30 };

    await drawStroke(A, gA, hFrom, hTo, 18);
    check("C0 my stroke landed on my canvas", (await inkIn(A, mineOnly)) > 4, `mine-only ${await inkIn(A, mineOnly)}`);
    const reached = await waitForInk(B, mineOnly);
    check("C0b it reached my friend", reached, `friend sees ${await inkIn(B, mineOnly)}`);
    await drawStroke(B, gB, vFrom, vTo, 12);
    const crossed = await waitForInk(A, theirsOnly);
    check("C1 their crossing stroke reached me", crossed);

    await A.click(".undo-fab");
    await sleep(500);
    const mine = await inkIn(A, mineOnly);
    const theirs = await inkIn(A, theirsOnly);
    check("C2 my crossed-over stroke is gone", mine <= 4, `mine-only ${mine}`);
    check("C3 their stroke ACROSS it survives the undo", theirs > 4, `theirs-only ${theirs}`);
    await A.screenshot({ path: path.join(SHOTS, "c-crossing.png") });

    // ---- D. the documented edge -------------------------------------------
    // Undo is local: the op stays in the room's history, so the friend still
    // sees it. If this ever flips, undo grew a retraction and the note in
    // App.jsx#replaySharedOpsSince needs revisiting.
    const onTheirs = await inkIn(B, mineOnly);
    check("D1 my undo does not retract the stroke from the room (known limit)", onTheirs > 4,
      `friend still sees ${onTheirs}`);
  });
} finally {
  if (A) await A.close().catch(() => {});
  if (B) await B.close().catch(() => {});
  await browser.close().catch(() => {});
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log(`shots: ${SHOTS}`);
if (failed.length) {
  failed.forEach((r) => console.log("  FAIL " + r.name));
  process.exit(1);
}
