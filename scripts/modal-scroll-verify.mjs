// Modal scrolling on phones.
//
// Reported bug: in a room on mobile, opening the 🌐 rooms dialog shows a list
// you can TAP but cannot SCROLL — the rooms below the fold are unreachable.
// Cause: .modal-backdrop is position:fixed and .studio-modal had no
// max-height/overflow, so a list taller than the viewport simply spilled off
// screen with no scroll container anywhere.
//
// This checks every studio modal that can grow past a phone screen: the
// content must be reachable (scrollable), and the modal must not exceed the
// viewport. Runs at iPhone-SE size, where the failure is worst.
import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, rmSync } from "fs";
import path from "path";

const ROOT = "C:/Users/Craig Campbell/Projects/happypaint";
const SCRATCH = path.join(process.env.TEMP || "/tmp", "modal-scroll-data");
const PORT = 8928;
const BASE = `http://localhost:${PORT}`;
const VIEWPORT = { width: 375, height: 667 }; // iPhone SE

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

// The scrollable box is whichever of the modal / its backdrop actually
// overflows — mirrors how a real finger-drag finds a scroller.
async function probeModal(page, selector) {
  return page.evaluate((sel) => {
    const modal = document.querySelector(sel);
    if (!modal) return null;
    const backdrop = modal.closest(".modal-backdrop") || modal.parentElement;
    const boxes = [modal, backdrop].filter(Boolean);
    const scroller = boxes.find((el) => el.scrollHeight > el.clientHeight + 4) || null;
    const r = modal.getBoundingClientRect();
    return {
      modalHeight: Math.round(r.height),
      modalBottom: Math.round(r.bottom),
      modalTop: Math.round(r.top),
      viewport: window.innerHeight,
      overflows: modal.scrollHeight > modal.clientHeight + 4,
      scrollerClass: scroller ? scroller.className : null,
      scrollerMax: scroller ? scroller.scrollHeight - scroller.clientHeight : 0,
    };
  }, selector);
}

// Actually move the scroller and confirm the position changes — CSS alone
// can look right while the box still refuses to move.
async function canScroll(page, selector) {
  return page.evaluate((sel) => {
    const modal = document.querySelector(sel);
    if (!modal) return false;
    const backdrop = modal.closest(".modal-backdrop") || modal.parentElement;
    const scroller = [modal, backdrop].find((el) => el && el.scrollHeight > el.clientHeight + 4);
    if (!scroller) return false;
    const before = scroller.scrollTop;
    scroller.scrollTop = 400;
    const moved = scroller.scrollTop > before;
    scroller.scrollTop = before;
    return moved;
  }, selector);
}

const run = async () => {
  for (let i = 0; i < 40; i += 1) {
    try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch { /* boot */ }
    await sleep(250);
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: VIEWPORT, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${BASE}/join/ZZMODAL`, { waitUntil: "domcontentloaded" });
  await sleep(2600);

  // ---- The reported bug: the rooms dialog, opened from inside a room -------
  // The quickbar "Rooms" FAB is the mobile entry point.
  const fab = page.locator(".studio-rooms-fab");
  if (await fab.isVisible().catch(() => false)) {
    await fab.click();
  } else {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => /🌐/.test(x.textContent || ""));
      if (b) b.click();
    });
  }
  await sleep(1200);

  const lobby = await probeModal(page, ".lobby-modal");
  check("the rooms dialog opens on mobile", !!lobby, lobby ? `${lobby.modalHeight}px tall` : "not found");

  if (lobby) {
    // The whole modal must sit inside the screen — a modal taller than the
    // viewport puts its top/bottom permanently out of reach.
    check("rooms dialog fits within the phone viewport",
      lobby.modalHeight <= lobby.viewport && lobby.modalTop >= -1 && lobby.modalBottom <= lobby.viewport + 1,
      `top=${lobby.modalTop} bottom=${lobby.modalBottom} viewport=${lobby.viewport}`);

    // …and the overflowing list must actually scroll.
    const scrolled = await canScroll(page, ".lobby-modal");
    check("the room list scrolls on mobile (the reported bug)",
      scrolled, `scroller=${lobby.scrollerClass || "NONE"} range=${lobby.scrollerMax}px`);

    // The last room in the list has to be reachable by scrolling.
    const lastReachable = await page.evaluate(() => {
      const items = [...document.querySelectorAll(".lobby-room")];
      if (!items.length) return null;
      const last = items[items.length - 1];
      last.scrollIntoView({ block: "center" });
      const r = last.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    });
    check("the last room in the list can be scrolled into view", lastReachable === true);
  }

  const fatal = errors.filter((e) => !/favicon|manifest/i.test(e));
  check("zero page errors", fatal.length === 0, fatal.slice(0, 2).join(" | "));

  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
};

run().catch((e) => { console.error("harness error:", e); server.kill(); process.exit(1); });
