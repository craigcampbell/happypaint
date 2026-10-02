// Homepage Inktober hero paper card verification.
//
// Boots the REAL server (port 8993, throwaway DATA_DIR under the Hermes
// scratch cache) plus a scratch Vite dev server (port 8994) serving the real
// homepage, then drives it in a real browser. The server's INKTOBER_CLOCK_FILE
// hook walks the calendar so every phase is exercised deterministically:
//
//   1. /api/inktober fixture: active/upcoming/ended payloads (phase, day,
//      prompt straight from the 2026 list, room, nextChangeAt ISO).
//   2. Active card: exact "Inktober is here!" ink heading in the bundled
//      cursive font, "Today's prompt" + the server prompt, the exact
//      "Draw yours today!" CTA, day chip, no nested interactive controls.
//   3. Anonymous CTA: clicking the card navigates to /join/INKTOBER.
//   4. UTC rollover: with the page open, midnight passes (Date shim) and the
//      card flips to the next day's prompt WITHOUT a reload.
//   5. Error fallback: a failed refresh past the announced rollover drops the
//      event state entirely, the generic "A shared canvas is waiting." card
//      returns instead of a stale or invented "today".
//   6. Upcoming/ended phases render their readable alternatives.
//   7. Screenshots at 375px and 1280px land in output/home-inktober/.
/* global window, document */ // page.evaluate callbacks run in the browser
import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "output", "home-inktober");
const SCRATCH = path.join(tmpdir(), "ink-globe-home");
const VITE_DIR = path.join(SCRATCH, "vite");
const CLOCK_FILE = path.join(SCRATCH, "inktober-clock.txt");
const PORT = 8993; // realtime backend (never 8787)
const VPORT = 8994; // scratch Vite dev server, proxies /ws + /api → backend
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = `http://127.0.0.1:${VPORT}/`;

const PROMPTS = JSON.parse(readFileSync(path.join(ROOT, "src", "data", "inktober2026.json"), "utf8")).prompts;
const promptFor = (day) => (PROMPTS.find((p) => p.day === day) || {}).prompt;

const setClock = (iso) => writeFileSync(CLOCK_FILE, iso);

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(VITE_DIR, { recursive: true });
mkdirSync(OUT, { recursive: true });
setClock("2026-10-15T23:59:50Z"); // active, day 15, midnight imminent

// Scratch Vite config: the repo root serves the REAL index.html/homepage; the
// config lives outside the repo and only adds the API/WS proxy.
writeFileSync(path.join(VITE_DIR, "vite.config.mjs"), `
import react from ${JSON.stringify(path.join(ROOT, "node_modules", "@vitejs", "plugin-react", "dist", "index.js"))};
export default {
  root: ${JSON.stringify(ROOT)},
  logLevel: "warn",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: ${VPORT},
    strictPort: true,
    fs: { allow: ${JSON.stringify([ROOT, realpathSync(path.join(ROOT, "node_modules"))])} },
    proxy: {
      "/ws": { target: "ws://127.0.0.1:${PORT}", ws: true },
      "/api": { target: "http://127.0.0.1:${PORT}" },
    },
  },
};
`);

// PB_URL/POCKETBASE_URL blanked: anonymous-first path, no account gating.
const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: SCRATCH,
    PB_URL: "",
    POCKETBASE_URL: "",
    INKTOBER_CLOCK_FILE: CLOCK_FILE,
  },
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
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
};

const inktoberApi = async () => {
  const r = await fetch(`${BASE}/api/inktober`, { cache: "no-store" });
  return r.ok ? r.json() : null;
};

// A page clock pinned near the (fake) server clock so the component's
// nextChangeAt scheduling computes a short, testable delay. window.__advanceTo
// lets the suite jump the page's idea of "now" across the rollover.
const TIME_SHIM = `
(() => {
  const RealDate = Date;
  let offset = RealDate.parse("2026-10-15T23:59:50Z") - RealDate.now();
  function FakeDate(...args) {
    return args.length ? new RealDate(...args) : new RealDate(RealDate.now() + offset);
  }
  FakeDate.now = () => RealDate.now() + offset;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;
  window.__advanceTo = (iso) => { offset = RealDate.parse(iso) - RealDate.now(); };
  window.Date = FakeDate;
})();
`;

const run = async () => {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(BASE + "/healthz"); if (r.ok) break; } catch { /* booting */ }
    await sleep(250);
  }
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(HOME); if (r.ok) break; } catch { /* booting */ }
    await sleep(250);
  }
  check("backend + scratch vite booted", true);

  // ---- 1. API fixture: all three phases, authoritative prompts ------------
  setClock("2026-10-15T12:00:00Z");
  const active = await inktoberApi();
  check("API active phase: day 15 from the clock", !!active && active.phase === "active" && active.day === 15,
    active ? `phase=${active.phase} day=${active.day}` : "no payload");
  check("API active prompt is the server list, not a constant", active?.prompt === promptFor(15),
    `prompt=${JSON.stringify(active?.prompt)}`);
  check("API carries room + ISO nextChangeAt", active?.room === "INKTOBER" && /^\d{4}-\d{2}-\d{2}T/.test(active?.nextChangeAt || ""),
    `room=${active?.room} nextChangeAt=${active?.nextChangeAt}`);

  setClock("2026-09-15T12:00:00Z");
  const upcoming = await inktoberApi();
  check("API upcoming phase: no day stamping, rollover is the Oct 1 start",
    !!upcoming && upcoming.phase === "upcoming" && upcoming.day === null && /^\d{4}-10-01T/.test(upcoming.nextChangeAt || ""),
    upcoming ? `phase=${upcoming.phase} next=${upcoming.nextChangeAt}` : "no payload");

  setClock("2026-11-05T12:00:00Z");
  const ended = await inktoberApi();
  check("API ended phase: no day, no nextChangeAt",
    !!ended && ended.phase === "ended" && ended.day === null && ended.nextChangeAt === null,
    ended ? `phase=${ended.phase}` : "no payload");

  // ---- 2. Active card content + typography --------------------------------
  setClock("2026-10-15T23:59:50Z"); // midnight imminent for the rollover test
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(TIME_SHIM);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(HOME, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".home-paper-ink", { timeout: 15000 });
  const card = page.locator(".home-paper-ink");

  const cardText = (await card.innerText()).replace(/\s+/g, " ");
  const cardLower = cardText.toLowerCase(); // label is CSS-uppercased
  check("active card shows the exact ink title", cardText.includes("Inktober is here!"), cardText.slice(0, 90));
  check("active card shows 'Today’s prompt' + the server prompt",
    cardLower.includes("today’s prompt") && cardText.includes(promptFor(15)), cardText.slice(0, 140));
  check("active card CTA is exactly 'Draw yours today!'", cardText.includes("Draw yours today!"));
  check("day chip stamped from the server payload", cardText.includes("Day 15 of 31"));
  check("no nested interactive controls inside the card button",
    (await card.locator("button, a").count()) === 0);

  const typo = await card.evaluate((el) => {
    const line = el.querySelector(".ink-line-1");
    const cs = getComputedStyle(line);
    return { family: cs.fontFamily, weight: cs.fontWeight };
  });
  check("heading uses the bundled cursive ink font", typo.family.includes("Inktober Ink"), typo.family);
  check("bundled font actually loaded (not system fallback)",
    await page.evaluate(() => document.fonts.check('700 40px "Inktober Ink"')));

  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, "active-1280.png") });

  // ---- 3. Anonymous CTA → /join/INKTOBER -----------------------------------
  await card.click();
  await page.waitForURL("**/join/INKTOBER", { timeout: 10000 });
  check("card click opens /join/INKTOBER anonymously", page.url().includes("/join/INKTOBER"), page.url());
  await page.goto(HOME, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".home-paper-ink", { timeout: 15000 });

  // ---- 4. UTC rollover without a reload ------------------------------------
  // The mount fetch scheduled a refresh at nextChangeAt (+1.5s), ~11.5s of
  // real time from load. Move the server clock across midnight first; the
  // card must flip to day 16 on its own.
  setClock("2026-10-16T00:00:20Z");
  let rolled = false;
  try {
    await page.waitForFunction(
      (expected) => (document.querySelector(".home-paper-ink")?.innerText || "").includes(expected),
      promptFor(16), { timeout: 25000 },
    );
    rolled = true;
  } catch { /* asserted below */ }
  check("card rolls over to the next day's prompt at UTC midnight (no reload)", rolled,
    `expected ${JSON.stringify(promptFor(16))}`);
  const rolledText = (await page.locator(".home-paper-ink").innerText()).replace(/\s+/g, " ");
  check("day chip follows the rollover", rolledText.includes("Day 16 of 31"), rolledText.slice(0, 120));

  // ---- 5. Error fallback: no stale/fake "today" ----------------------------
  // Now the API starts failing AND the announced rollover passes: the event
  // state must be dropped rather than left stale, returning the generic card.
  await context.route("**/api/inktober", (route) => route.fulfill({ status: 500, body: "down" }));
  await page.evaluate(() => {
    window.__advanceTo("2026-10-17T00:00:30Z"); // past the last known nextChangeAt
    document.dispatchEvent(new Event("visibilitychange")); // visible tab → refetch
  });
  let fellBack = false;
  try {
    await page.waitForSelector(".home-paper:not(.home-paper-ink) .home-paper-note", { timeout: 10000 });
    fellBack = true;
  } catch { /* asserted below */ }
  check("failed refresh past rollover drops the event card (no stale 'today')", fellBack);
  const fallbackText = await page.locator(".home-paper").first().innerText();
  check("fallback is the generic shared-canvas invitation",
    fallbackText.includes("A shared canvas is waiting."), fallbackText.slice(0, 80));
  await page.screenshot({ path: path.join(OUT, "fallback-1280.png") });
  await context.unroute("**/api/inktober");

  // ---- 6. Upcoming / ended alternatives ------------------------------------
  setClock("2026-09-15T12:00:00Z");
  await page.goto(HOME, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".home-paper-ink", { timeout: 15000 });
  const upText = (await page.locator(".home-paper-ink").innerText()).replace(/\s+/g, " ");
  const upLower = upText.toLowerCase();
  check("upcoming card reads as a warm-up (no 'today' claim)",
    upText.includes("Inktober is coming!") && upLower.includes("warm-up prompt") && !upLower.includes("today’s prompt"),
    upText.slice(0, 140));
  await page.screenshot({ path: path.join(OUT, "upcoming-1280.png") });

  setClock("2026-11-05T12:00:00Z");
  await page.goto(HOME, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".home-paper-ink", { timeout: 15000 });
  const endText = (await page.locator(".home-paper-ink").innerText()).replace(/\s+/g, " ");
  check("ended card points at the event gallery",
    endText.includes("Inktober has wrapped!") && endText.includes("See the gallery"), endText.slice(0, 140));
  await page.screenshot({ path: path.join(OUT, "ended-1280.png") });

  // ---- 7. Active card at phone width ---------------------------------------
  setClock("2026-10-15T12:00:00Z");
  await page.setViewportSize({ width: 375, height: 760 });
  await page.goto(HOME, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".home-paper-ink", { timeout: 15000 });
  const phoneText = (await page.locator(".home-paper-ink").innerText()).replace(/\s+/g, " ");
  check("375px card keeps title, prompt and CTA",
    phoneText.includes("Inktober is here!") && phoneText.includes(promptFor(15)) && phoneText.includes("Draw yours today!"),
    phoneText.slice(0, 140));
  const phoneCard = await page.locator(".home-paper-ink").boundingBox();
  check("375px card fits the viewport", !!phoneCard && phoneCard.width <= 375, phoneCard ? `w=${Math.round(phoneCard.width)}` : "no box");
  await page.locator(".home-paper-ink").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, "active-375.png") });

  // HTTP failures must recover on the retry timer without navigation or a
  // visibility event. Clock control only replaces waiting, not API behavior.
  setClock("2026-10-15T12:00:00Z");
  const retryContext = await browser.newContext({ viewport: { width: 375, height: 760 } });
  const retryPage = await retryContext.newPage();
  await retryPage.clock.install({ time: new Date("2026-10-15T12:00:00Z") });
  let refuse = true;
  let requests = 0;
  await retryContext.route("**/api/inktober", (route) => {
    requests += 1;
    return refuse ? route.fulfill({ status: 503, body: "unavailable" }) : route.continue();
  });
  await retryPage.goto(HOME);
  await retryPage.waitForFunction(() => !!document.querySelector(".home-paper-note"));
  await retryPage.waitForTimeout(300);
  check("initial HTTP failure leaves the anonymous generic card", await retryPage.locator(".home-paper-ink").count() === 0);
  refuse = false;
  await retryPage.clock.fastForward(61_000);
  await retryPage.locator(".home-paper-ink").waitFor();
  check("HTTP failure automatically recovers without reload", requests >= 2 && (await retryPage.locator(".home-paper-ink").innerText()).includes(promptFor(15)));
  // An event weeks away must not overflow setTimeout into a tight request loop.
  setClock("2026-08-01T12:00:00Z");
  await retryPage.clock.setSystemTime(new Date("2026-08-01T12:00:00Z"));
  await retryPage.reload();
  await retryPage.locator('.home-paper-ink[data-phase="upcoming"]').waitFor();
  const before = requests;
  await retryPage.clock.fastForward(5_000);
  await retryPage.waitForTimeout(100);
  check("distant October boundary does not create a timer-overflow request loop", requests === before);
  await retryContext.close();

  check("no page errors across the whole run", pageErrors.length === 0, pageErrors[0] || "");

  await browser.close();
};

run()
  .catch((e) => { console.error(e); check("suite completed without a harness exception", false, String(e)); })
  .finally(() => {
    try { server.kill(); } catch { /* gone */ }
    try { vite.kill(); } catch { /* gone */ }
    try { rmSync(VITE_DIR, { recursive: true, force: true }); } catch { /* scratch */ }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
  });
