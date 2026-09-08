// Quick stroke controls + Hand & pen preferences + palm rejection.
//
// What it drives, on real engines (Chromium with CDP touch/pen, WebKit):
//   A. The Size pill / Colour dot on the compact quick bar and the desktop
//      zoom cluster: present, the bar fits the viewport, tap opens the brush
//      menu / the colour wheel, a chip switches the brush, a ring tap changes
//      the colour, a drag on the pill resizes the brush.
//   B. Palm rejection (Chromium only — CDP is the one way to dispatch a PEN):
//      fingers still draw with no pen around; a pen draws; in a pen session a
//      finger stroke is held then replayed (300ms drag + 90ms flick both
//      draw, a stationary tap is dropped); a pen landing during the hold
//      cancels it; a pen landing on a LIVE finger stroke discards it; Pen
//      only mode never paints with a finger but still pinch-zooms.
//   C. Left-hand mode: the desktop rail docks on the left; the iPad side
//      sheet slides in from the left and the quick bar re-centres right of it.
//
// Screenshots land in the scratchpad `quick-stroke/` folder (or $QS_SHOTS).
import { chromium, webkit, devices } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, rmSync } from "fs";
import path from "path";

const ROOT = "C:/Users/Craig Campbell/Projects/happypaint";
const SCRATCH = path.join(process.env.TEMP || "/tmp", "quick-stroke-data");
const SHOTS = process.env.QS_SHOTS || path.join(process.env.TEMP || "/tmp", "quick-stroke");
const PORT = 8940;
const BASE = `http://localhost:${PORT}`;
const ROOM = "/join/ZZQS";

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH }, stdio: "pipe",
});
server.stderr.on("data", (d) => { if (process.env.SRV_LOG) process.stderr.write("[srv] " + d); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let device = "";
const check = (name, ok, detail = "") => {
  results.push({ device, name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
const skip = (name, detail = "") => {
  results.push({ device, name, ok: true, skipped: true });
  console.log(`SKIP  ${name}${detail ? " — " + detail : ""}`);
};
const guard = async (name, fn) => {
  try { await fn(); } catch (e) { check(name, false, "harness threw: " + String(e).slice(0, 200)); }
};

// ---- page helpers ------------------------------------------------------------
async function openRoom(page) {
  await page.goto(BASE + ROOM, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".overlay-canvas", { timeout: 15000 });
  await sleep(2800); // join curtain
}

const rect = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const st = getComputedStyle(el);
  return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2,
    visible: st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0 };
}, sel);

const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, sel);

// Ink inside a CSS-px rectangle of the display canvas (dark, opaque samples).
const inkIn = (page, box) => page.evaluate((b) => {
  const c = document.querySelector(".display-canvas");
  if (!c) return { err: "no display canvas" };
  try {
    const r = c.getBoundingClientRect();
    const sx = c.width / r.width;
    const sy = c.height / r.height;
    const x0 = Math.max(0, Math.floor((b.x - r.left) * sx));
    const y0 = Math.max(0, Math.floor((b.y - r.top) * sy));
    const w = Math.min(c.width - x0, Math.ceil(b.w * sx));
    const h = Math.min(c.height - y0, Math.ceil(b.h * sy));
    if (w <= 0 || h <= 0) return { ink: 0, w, h };
    const d = c.getContext("2d", { willReadFrequently: true }).getImageData(x0, y0, w, h).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4 * 7) {
      if (d[i + 3] > 8 && (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235)) ink += 1;
    }
    return { ink, w, h };
  } catch (e) { return { err: String(e).slice(0, 80) }; }
}, box);

async function settledInk(page, box, prev, wantMore, tries = 16) {
  let cur = await inkIn(page, box);
  for (let i = 0; i < tries; i += 1) {
    if (cur.err) return cur;
    if (wantMore ? cur.ink > prev + 2 : cur.ink <= prev + 2) return cur;
    await sleep(120);
    cur = await inkIn(page, box);
  }
  return cur;
}

// Canvas regions (CSS px) that never overlap: a finger works the LEFT third,
// the pen the RIGHT third, well inside the paper.
async function regions(page) {
  const box = await rect(page, ".overlay-canvas");
  if (!box) return null;
  const L = { x: box.x + box.w * 0.12, y: box.y + box.h * 0.35, w: box.w * 0.26, h: box.h * 0.3 };
  const R = { x: box.x + box.w * 0.62, y: box.y + box.h * 0.35, w: box.w * 0.26, h: box.h * 0.3 };
  return { box, L, R };
}
const mid = (b) => ({ x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) });

// ---- CDP input ----------------------------------------------------------------
const tp = (x, y, id = 1) => [{ x, y, radiusX: 6, radiusY: 6, force: 0.8, id }];

async function touchDrag(cdp, from, to, { steps = 10, gapMs = 18, holdEndMs = 0 } = {}) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: tp(from.x, from.y) });
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: tp(Math.round(from.x + (to.x - from.x) * i / steps), Math.round(from.y + (to.y - from.y) * i / steps)),
    });
    await sleep(gapMs);
  }
  if (holdEndMs) await sleep(holdEndMs);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function penDown(cdp, p) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, pointerType: "pen", force: 0 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1, pointerType: "pen", force: 0.6 });
}
async function penMove(cdp, p) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "left", buttons: 1, pointerType: "pen", force: 0.6 });
}
async function penUp(cdp, p) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 1, pointerType: "pen", force: 0 });
}
async function penDrag(cdp, from, to, steps = 10, gapMs = 18) {
  await penDown(cdp, from);
  for (let i = 1; i <= steps; i += 1) {
    await penMove(cdp, { x: Math.round(from.x + (to.x - from.x) * i / steps), y: Math.round(from.y + (to.y - from.y) * i / steps) });
    await sleep(gapMs);
  }
  await penUp(cdp, to);
}

// ---- A. quick controls ----------------------------------------------------------
async function runControls(page, tier, tap, drag, shot) {
  await guard("A controls", async () => {
    console.log(`\n  -- quick controls (${tier}) --`);
    const barSel = tier === "desktop" ? ".zoom-controls" : ".mobile-quickbar";
    const bar = await rect(page, barSel);
    const size = await rect(page, `${barSel} .qs-size`);
    const color = await rect(page, `${barSel} .qs-color`);
    const vw = await page.evaluate(() => window.innerWidth);
    check("A1 size pill + colour dot on the bar", !!(size?.visible && color?.visible),
      `size=${size ? Math.round(size.w) + "x" + Math.round(size.h) : "none"} colour=${color ? Math.round(color.w) + "x" + Math.round(color.h) : "none"}`);
    check("A2 the bar fits the viewport", !!bar && bar.x >= 0 && bar.x + bar.w <= vw + 0.5,
      bar ? `bar ${Math.round(bar.x)}..${Math.round(bar.x + bar.w)} of ${vw}` : "no bar");
    if (tier !== "desktop") {
      const items = await page.$$eval(`${barSel} > button`, (els) => els.map((e) => e.textContent.trim()));
      check("A2b seven quick bar items", items.length === 7, items.join(" · "));
      await shot("bar");
    }
    if (!size || !color) return;

    await tap(mid(size));
    await sleep(350);
    const menu = await rect(page, ".qs-pop .bqm");
    check("A3 tap on the size pill opens the brush menu", !!menu?.visible, menu ? `${Math.round(menu.w)}x${Math.round(menu.h)} at y=${Math.round(menu.y)}` : "no .bqm");
    check("A3b brush menu stays on screen", !!menu && menu.y >= 0 && menu.x >= 0 && menu.x + menu.w <= vw + 0.5,
      menu ? `x ${Math.round(menu.x)}..${Math.round(menu.x + menu.w)}, top ${Math.round(menu.y)}` : "");
    await shot("brush-menu");
    const chip = await page.evaluateHandle(() => [...document.querySelectorAll(".bqm-chip")].find((c) => c.textContent.includes("Crayon")) || null);
    const chipBox = await chip.evaluate((el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    if (chipBox) {
      await tap({ x: Math.round(chipBox.x), y: Math.round(chipBox.y) });
      await sleep(350);
      const active = await text(page, ".rail-top-1 .brush-chip.is-active .chip-name");
      const gone = !(await rect(page, ".qs-pop"));
      check("A4 picking Crayon switches the brush and closes the menu", active === "Crayon" && gone, `rail active=${active} menu closed=${gone}`);
    } else {
      check("A4 picking Crayon switches the brush and closes the menu", false, "no Crayon chip");
    }

    const hexBefore = await page.evaluate(() => document.querySelector(".qs-color .qs-color-fill")?.style.background || "");
    await tap(mid(color));
    await sleep(350);
    const cw = await rect(page, ".qs-pop .cw");
    check("A5 tap on the colour dot opens the wheel", !!cw?.visible, cw ? `${Math.round(cw.w)}x${Math.round(cw.h)} at y=${Math.round(cw.y)}` : "no .cw");
    check("A5b colour picker stays on screen", !!cw && cw.y >= 0 && cw.x >= 0 && cw.x + cw.w <= vw + 0.5,
      cw ? `x ${Math.round(cw.x)}..${Math.round(cw.x + cw.w)}, top ${Math.round(cw.y)}` : "");
    const wheel = await rect(page, ".cw-wheel");
    const hexShown = await text(page, ".cw-preview-hex");
    if (wheel) {
      // 3 o'clock on the ring = hue 90 (yellow-green): unmistakably not the default navy.
      await tap({ x: Math.round(wheel.x + wheel.w - 13), y: Math.round(wheel.cy) });
      await sleep(400);
      const hexAfter = await text(page, ".cw-preview-hex");
      const dotAfter = await page.evaluate(() => document.querySelector(".qs-color .qs-color-fill")?.style.background || "");
      check("A6 tapping the hue ring changes the colour (preview + bar dot)", hexAfter !== hexShown && dotAfter !== hexBefore,
        `${hexShown} → ${hexAfter}; dot ${hexBefore} → ${dotAfter}`);
    }
    await shot("colour-wheel");
    // Done closes it.
    const done = await rect(page, ".cw-done");
    if (done) { await tap(mid(done)); await sleep(300); }
    check("A7 Done closes the picker", !(await rect(page, ".qs-pop")));

    // Drag the size pill: right + up = bigger.
    const numBefore = Number(await text(page, `${barSel} .qs-size-num`));
    const s2 = await rect(page, `${barSel} .qs-size`);
    await drag(mid(s2), { x: mid(s2).x + 60, y: mid(s2).y - 40 });
    await sleep(300);
    const numAfter = Number(await text(page, `${barSel} .qs-size-num`));
    check("A8 dragging the size pill up-right grows the brush", numAfter > numBefore && !(await rect(page, ".qs-pop")),
      `${numBefore} → ${numAfter}, no menu opened`);
    await drag(mid(s2), { x: mid(s2).x - 60, y: mid(s2).y + 40 });
    await sleep(300);
    const numBack = Number(await text(page, `${barSel} .qs-size-num`));
    check("A9 dragging it down-left shrinks the brush", numBack < numAfter, `${numAfter} → ${numBack}`);
  });
}

// ---- B. palm rejection (Chromium + CDP only) -----------------------------------
async function runPalm(page, cdp, shot) {
  await guard("B palm", async () => {
    console.log("\n  -- palm rejection --");
    const rg = await regions(page);
    if (!rg) { skip("B palm rejection", "no canvas"); return; }
    const { L, R } = rg;
    const lFrom = { x: Math.round(L.x + L.w * 0.2), y: Math.round(L.y + L.h * 0.3) };
    const lTo = { x: Math.round(L.x + L.w * 0.8), y: Math.round(L.y + L.h * 0.7) };
    const rFrom = { x: Math.round(R.x + R.w * 0.2), y: Math.round(R.y + R.h * 0.3) };
    const rTo = { x: Math.round(R.x + R.w * 0.8), y: Math.round(R.y + R.h * 0.7) };

    // B1: no pen has been near — a finger draws at once.
    let l0 = (await inkIn(page, L)).ink;
    await touchDrag(cdp, lFrom, lTo);
    let l1 = await settledInk(page, L, l0, true);
    check("B1 a finger draws when no pen is in play", l1.ink > l0 + 2, `ink ${l0} → ${l1.ink}`);

    // B2: the pen draws (and opens the pen session).
    let r0 = (await inkIn(page, R)).ink;
    await penDrag(cdp, rFrom, rTo);
    let r1 = await settledInk(page, R, r0, true);
    check("B2 the pen draws", r1.ink > r0 + 2, `ink ${r0} → ${r1.ink}`);

    // The pen-priority window (1.5s) must lapse; the pen SESSION (60s) stays.
    await sleep(1700);

    // B3: a 300ms finger drag in a pen session is held, then replayed: it draws.
    l0 = (await inkIn(page, L)).ink;
    await touchDrag(cdp, { x: lFrom.x, y: lTo.y }, { x: lTo.x, y: lFrom.y }, { steps: 12, gapMs: 25 });
    l1 = await settledInk(page, L, l0, true);
    check("B3 a held finger stroke still draws (replayed after the hold)", l1.ink > l0 + 2, `ink ${l0} → ${l1.ink}`);

    // B4: a 90ms flick that lifts inside the hold window draws too.
    l0 = l1.ink;
    await touchDrag(cdp, lFrom, { x: lFrom.x + 60, y: lFrom.y + 30 }, { steps: 4, gapMs: 18 });
    l1 = await settledInk(page, L, l0, true);
    check("B4 a quick flick inside the hold window draws", l1.ink > l0 + 2, `ink ${l0} → ${l1.ink}`);

    // B5: a stationary tap inside the hold window is a stray palm tap: dropped.
    l0 = l1.ink;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: tp(lFrom.x, lFrom.y) });
    await sleep(60);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(500);
    l1 = await inkIn(page, L);
    check("B5 a stationary tap in a pen session is dropped", l1.ink <= l0 + 2, `ink ${l0} → ${l1.ink}`);

    await sleep(1700);
    // B6: finger lands, pen lands 60ms later — the finger stroke never starts.
    l0 = (await inkIn(page, L)).ink;
    r0 = (await inkIn(page, R)).ink;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: tp(lFrom.x, lFrom.y) });
    await sleep(20);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: tp(lFrom.x + 20, lFrom.y + 10) });
    await sleep(20);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: tp(lFrom.x + 40, lFrom.y + 20) });
    await sleep(20);
    await penDrag(cdp, rFrom, rTo);
    // The hand keeps sliding while the pen writes — none of it may paint.
    for (let i = 3; i <= 8; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: tp(lFrom.x + i * 15, lFrom.y + i * 8) });
      await sleep(30);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(500);
    l1 = await inkIn(page, L);
    r1 = await inkIn(page, R);
    check("B6 pen landing during the hold cancels the finger stroke", l1.ink <= l0 + 2 && r1.ink > r0 + 2,
      `finger region ${l0} → ${l1.ink} (must not grow); pen region ${r0} → ${r1.ink}`);
    const toast = await text(page, ".toast, .studio-toast, [class*='toast']");
    check("B6b the palm tip toast appears once", !!toast && /palm/i.test(toast), toast ? toast.slice(0, 80) : "no toast");

    await sleep(1700);
    // B7: the finger stroke is LIVE (past the hold, ink on the canvas) when the pen lands: discarded.
    l0 = (await inkIn(page, L)).ink;
    r0 = (await inkIn(page, R)).ink;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: tp(lFrom.x, lTo.y) });
    for (let i = 1; i <= 12; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: tp(Math.round(lFrom.x + (lTo.x - lFrom.x) * i / 12), Math.round(lTo.y - (lTo.y - lFrom.y) * i / 12)) });
      await sleep(30);
    }
    await sleep(120);
    const lLive = await inkIn(page, L);
    check("B7a the finger stroke went live after the hold", lLive.ink > l0 + 2, `ink ${l0} → ${lLive.ink}`);
    await penDrag(cdp, rTo, rFrom);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    l1 = await settledInk(page, L, l0, false);
    r1 = await inkIn(page, R);
    check("B7b pen landing on a live finger stroke discards it", l1.ink <= l0 + 2 && r1.ink > r0 + 2,
      `finger region ${l0} → ${lLive.ink} (live) → ${l1.ink} (after pen); pen region ${r0} → ${r1.ink}`);
    await shot("palm-after");

    // B8: Pen only mode — a finger never paints, two fingers still zoom.
    await page.evaluate(() => localStorage.setItem("happypaint:input-prefs:v1", JSON.stringify({ hand: "right", touch: "pen", palmTipShown: true })));
    await openRoom(page);
    const rg2 = await regions(page);
    const L2 = rg2.L;
    const f2 = { x: Math.round(L2.x + L2.w * 0.2), y: Math.round(L2.y + L2.h * 0.3) };
    const t2 = { x: Math.round(L2.x + L2.w * 0.8), y: Math.round(L2.y + L2.h * 0.7) };
    l0 = (await inkIn(page, L2)).ink;
    await touchDrag(cdp, f2, t2, { steps: 12, gapMs: 25 });
    await sleep(600);
    l1 = await inkIn(page, L2);
    check("B8 Pen only: a finger drag paints nothing", l1.ink <= l0 + 2, `ink ${l0} → ${l1.ink}`);
    const penOnlyLabel = await page.evaluate(() => [...document.querySelectorAll(".input-prefs .seg-toggle button")].filter((b) => b.classList.contains("is-on")).map((b) => b.textContent.trim()).join(","));
    check("B8b the rail shows Pen only selected", /Pen only/.test(penOnlyLabel), penOnlyLabel);
    const zoomBefore = await text(page, ".zoom-pct");
    const c = mid(rg2.box);
    const two = (d) => [
      { x: c.x - d, y: c.y, radiusX: 6, radiusY: 6, force: 0.8, id: 1 },
      { x: c.x + d, y: c.y, radiusX: 6, radiusY: 6, force: 0.8, id: 2 },
    ];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: two(40) });
    for (let d = 46; d <= 130; d += 12) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: two(d) });
      await sleep(20);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    let zoomAfter = zoomBefore;
    for (let i = 0; i < 10 && zoomAfter === zoomBefore; i += 1) {
      await sleep(100);
      await page.evaluate(() => window.dispatchEvent(new Event("resize")));
      zoomAfter = await text(page, ".zoom-pct");
    }
    check("B8c Pen only: two fingers still pinch-zoom", zoomAfter !== zoomBefore, `${zoomBefore} → ${zoomAfter}`);
    const penOnlyInk0 = (await inkIn(page, rg2.R)).ink;
    await penDrag(cdp, { x: Math.round(rg2.R.x + 10), y: Math.round(rg2.R.y + 10) }, { x: Math.round(rg2.R.x + rg2.R.w - 10), y: Math.round(rg2.R.y + rg2.R.h - 10) });
    const penOnlyInk1 = await settledInk(page, rg2.R, penOnlyInk0, true);
    check("B8d Pen only: the pen still draws", penOnlyInk1.ink > penOnlyInk0 + 2, `ink ${penOnlyInk0} → ${penOnlyInk1.ink}`);
    await page.evaluate(() => localStorage.removeItem("happypaint:input-prefs:v1"));
  });
}

// ---- C. left-hand mode -----------------------------------------------------------
async function runHand(page, tier, tap, shot) {
  await guard("C hand", async () => {
    console.log(`\n  -- left-hand mode (${tier}) --`);
    await page.evaluate(() => localStorage.setItem("happypaint:input-prefs:v1", JSON.stringify({ hand: "left", touch: "auto", palmTipShown: true })));
    await openRoom(page);
    const hand = await page.evaluate(() => document.querySelector(".studio-shell")?.dataset.hand);
    check("C1 the shell carries data-hand=left", hand === "left", `data-hand=${hand}`);
    if (tier === "desktop") {
      const rail = await rect(page, ".tool-rail");
      const ws = await rect(page, ".studio-workspace");
      check("C2 desktop: the rail docks on the LEFT of the canvas", !!rail && !!ws && rail.x < ws.x && rail.x <= 1,
        `rail x=${rail ? Math.round(rail.x) : "?"} workspace x=${ws ? Math.round(ws.x) : "?"}`);
      await shot("left-hand-desktop");
      await page.keyboard.press("t");
      await sleep(400);
      const reopen = await rect(page, ".rail-reopen");
      check("C3 desktop: collapsed, the reopen tab sits on the LEFT edge", !!reopen && reopen.x <= 1, reopen ? `x=${Math.round(reopen.x)}` : "no tab");
      await page.keyboard.press("t");
    } else if (tier === "tablet") {
      const tools = await page.evaluateHandle(() => [...document.querySelectorAll(".mobile-quickbar .qb-btn")].find((b) => b.textContent.includes("Tools")) || null);
      const tb = await tools.evaluate((el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      if (!tb) { check("C4 tablet: Tools button", false, "not found"); return; }
      await tap({ x: Math.round(tb.x), y: Math.round(tb.y) });
      await sleep(600);
      const rail = await rect(page, ".tool-rail.is-open");
      const vw = await page.evaluate(() => window.innerWidth);
      const bar = await rect(page, ".mobile-quickbar");
      check("C4 tablet: the side sheet slides in from the LEFT", !!rail && rail.x <= 1 && rail.w < vw / 2, rail ? `x=${Math.round(rail.x)} w=${Math.round(rail.w)}` : "no open rail");
      check("C5 tablet: the quick bar re-centres right of the sheet", !!bar && !!rail && bar.x > rail.x + rail.w && bar.x + bar.w <= vw + 0.5,
        bar && rail ? `bar ${Math.round(bar.x)}..${Math.round(bar.x + bar.w)}, sheet ends ${Math.round(rail.x + rail.w)}` : "");
      const fab = await rect(page, ".studio-rooms-fab");
      check("C6 tablet: the rooms FAB is not under the sheet", !!fab && !!rail && fab.x >= rail.x + rail.w - 1, fab && rail ? `fab x=${Math.round(fab.x)}` : "");
      await shot("left-hand-tablet");
    }
    await page.evaluate(() => localStorage.removeItem("happypaint:input-prefs:v1"));
  });
}

// ---- devices ----------------------------------------------------------------------
async function runDevice(label, engineName, launcher, descriptor, tier, { palm = false, hand = false } = {}) {
  device = label;
  console.log(`\n${"=".repeat(72)}\n${label}  [${engineName} / ${tier}]\n${"=".repeat(72)}`);
  let browser = null;
  try {
    browser = await launcher.launch({ headless: true });
    const ctx = await browser.newContext({ ...descriptor });
    const page = await ctx.newPage();
    let cdp = null;
    if (engineName === "chromium") {
      try { cdp = await ctx.newCDPSession(page); } catch { cdp = null; }
    }
    const touch = tier !== "desktop";
    const tap = async (p) => (touch ? page.touchscreen.tap(p.x, p.y) : page.mouse.click(p.x, p.y));
    const drag = async (from, to) => {
      if (touch && cdp) return touchDrag(cdp, from, to, { steps: 8, gapMs: 16 });
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i += 1) {
        await page.mouse.move(Math.round(from.x + (to.x - from.x) * i / 8), Math.round(from.y + (to.y - from.y) * i / 8));
        await sleep(16);
      }
      await page.mouse.up();
    };
    const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${name}.png`) }).catch(() => {});

    await openRoom(page);
    const tierSeen = await page.evaluate(() => document.querySelector(".studio-shell")?.dataset.layout);
    check("tier", tierSeen === tier, `data-layout=${tierSeen}`);
    await runControls(page, tier, tap, drag, shot);
    if (palm) {
      if (cdp) await runPalm(page, cdp, shot);
      else skip("B palm rejection", "needs Chromium CDP");
    }
    if (hand) await runHand(page, tier, tap, shot);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

const run = async () => {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch { /* boot */ }
    await sleep(250);
  }
  await runDevice("Pixel 7", "chromium", chromium, { ...devices["Pixel 7"] }, "phone", { palm: true });
  await runDevice("Desktop 1280x800", "chromium", chromium, { viewport: { width: 1280, height: 800 } }, "desktop", { hand: true });
  await runDevice("iPad Pro 11 landscape", "webkit", webkit, { ...devices["iPad Pro 11 landscape"] }, "tablet", { hand: true });
  await runDevice("iPhone 14", "webkit", webkit, { ...devices["iPhone 14"] }, "phone");

  const failed = results.filter((r) => !r.ok);
  const passed = results.filter((r) => r.ok && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  console.log(`\n${"=".repeat(72)}\n${passed} passed, ${failed.length} failed, ${skipped} skipped\n`);
  for (const f of failed) console.log(`  FAIL [${f.device}] ${f.name}`);
  console.log(`screenshots: ${SHOTS}`);
  server.kill();
  process.exit(failed.length ? 1 : 0);
};

run().catch((e) => { console.error(e); server.kill(); process.exit(2); });
