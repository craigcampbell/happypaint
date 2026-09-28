// Seasonal marketing UI verification (Inktober page, Paint Jar page, homepage
// seasonal banner + fixed MAIN preview + room cards + prompt artwork strips,
// routes/nav, nav auth CTA).
//
// Harness: a REAL local server.js on :8953 (scratch DATA_DIR) serves the API;
// a Vite dev server on :8954 serves the UI. Playwright proxies every /api/*
// call from the UI to the real server.
//
// Two modes, auto-detected:
//  - REAL: the backend has landed /api/inktober + /api/paintjar. The script
//    seeds REAL wall posts through the real POST /api/wall (scratch DATA_DIR)
//    and asserts rendered UI against live API responses.
//  - SYNTHETIC fallback: endpoints not implemented yet → fixtures labeled
//    SYNTHETIC are fulfilled by Playwright instead. Final integration against
//    the actual API remains with the parent.
//
// Run: node scripts/seasonal-marketing-verify.mjs
/* global window, getComputedStyle */ // used inside page.evaluate callbacks (browser side)
import { chromium } from "playwright";
import { spawn, execSync } from "child_process";
import { mkdirSync, rmSync, readFileSync } from "fs";
import path from "path";
import os from "os";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SCRATCH = path.join(os.tmpdir(), "seasonal-marketing-verify-data");
const API_PORT = 8953;
const UI_PORT = 8954;
const API = `http://127.0.0.1:${API_PORT}`;
const UI = `http://127.0.0.1:${UI_PORT}`;

// ---------------------------------------------------------------- fixtures --
// SYNTHETIC fixtures: shaped exactly after docs/SEASONAL-CONTRACT.md. The
// prompt list itself is the parent's verified official list
// (src/data/inktober2026.json); only the API envelopes are synthetic.
const promptList = JSON.parse(readFileSync(path.join(ROOT, "src/data/inktober2026.json"), "utf8")).prompts;

const INKTOBER_UPCOMING = { // SYNTHETIC
  year: 2026,
  phase: "upcoming",
  date: "2026-09-27",
  day: null,
  prompt: "Warm-up: sharpen your favourite pen",
  nextChangeAt: "2026-10-01T00:00:00.000Z",
  source: "https://inktober.com/rules",
  prompts: promptList,
  room: "INKTOBER",
};
const INKTOBER_ACTIVE = { // SYNTHETIC
  ...INKTOBER_UPCOMING,
  phase: "active",
  date: "2026-10-03",
  day: 3,
  prompt: "Miniature",
  nextChangeAt: "2026-10-04T00:00:00.000Z",
};
const PAINTJAR = { // SYNTHETIC
  updatedAt: "2026-09-27T12:00:00.000Z",
  strokes: 48213,
  sessions: 1204,
  countries: [
    { code: "US", count: 87 },
    { code: "GB", count: 23 },
    { code: "DE", count: 9 },
  ],
  paperEquivalent: { sheets: 48, strokesPerSheet: 1000 },
  disclaimer:
    "Counts are aggregate recorded painting activity, not unique people. The sheet equivalent is illustrative, not a measured resource saving.",
};
const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SYNTH_INK_POSTS = [ // SYNTHETIC wall posts (event gallery)
  { id: "syn-ink-1", title: "Ink Apple", artist: "Sam", frames: 1, durationMs: 400, votes: 3, liked: false, tags: ["inktober"], event: "inktober-2026", eventDay: 1, eventPrompt: "Apple", allowRemix: false },
  { id: "syn-ink-3", title: "Tiny World", artist: "Jo", frames: 1, durationMs: 400, votes: 5, liked: false, tags: ["inktober"], event: "inktober-2026", eventDay: 3, eventPrompt: "Miniature", allowRemix: false },
];
const SYNTH_DAILY_POSTS = [ // SYNTHETIC wall posts (daily challenge strip)
  { id: "syn-daily-1", title: "Challenge Doodle", artist: "Rin", frames: 1, durationMs: 400, votes: 2, liked: false, tags: ["daily challenge"], challenge: "2026-09-27", allowRemix: false },
];
const INKTOBER_ROOM = { // SYNTHETIC lobby entry injected after MAIN
  code: "INKTOBER", title: "Ink & Pencil", users: 5, ops: 120, sheetId: null,
  lastActivity: Date.now(), hasHost: false, featured: true, emoji: "🖋️",
  prompt: "Miniature", wipeAt: 0,
};

// ------------------------------------------------------------------ harness --
try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
const procs = [];
const spawnProc = (args, opts, tag) => {
  // detached → own process group, so cleanup can kill the whole tree (vite
  // and server.js both spawn children that would otherwise leak the ports).
  const p = spawn(args[0], args.slice(1), { cwd: ROOT, stdio: "pipe", detached: true, ...opts });
  p.stderr.on("data", (d) => process.stderr.write(`[${tag}] ` + d));
  procs.push(p);
  return p;
};
spawnProc([process.execPath, "server.js"], {
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: SCRATCH, ADMIN_KEY: "seasonal-test-admin" },
}, "srv");
spawnProc([process.execPath, path.join(ROOT, "node_modules/vite/bin/vite.js"), "--port", String(UI_PORT), "--strictPort", "--host", "127.0.0.1"], {
  // VITE_PB_URL is set so the nav auth CTA (Sign in / My account) is exercised;
  // the dummy origin is never called — guests have no stored PocketBase record
  // and the signed-in check seeds a local-only synthetic auth record.
  env: { ...process.env, VITE_PB_URL: `http://127.0.0.1:${API_PORT}` },
}, "vite");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function waitUp(url, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* boot */ }
    await sleep(250);
  }
  return false;
}

let browser;
const cleanup = async () => {
  try { await browser?.close(); } catch { /* gone */ }
  for (const p of procs) {
    try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch { /* gone */ } }
  }
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* scratch */ }
};
process.on("SIGINT", async () => { await cleanup(); process.exit(130); });
process.on("SIGTERM", async () => { await cleanup(); process.exit(143); });
process.on("exit", () => { for (const p of procs) { try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ } } });

const run = async () => {
  if (!(await waitUp(API + "/healthz"))) throw new Error("server.js did not boot on " + API_PORT);
  if (!(await waitUp(UI + "/"))) throw new Error("vite dev did not boot on " + UI_PORT);

  // ---- mode detection -------------------------------------------------------
  // SEASONAL_VERIFY_SYNTHETIC=1 forces the fixture path even when the backend
  // has landed (proves the fallback + the synthetic-only phase checks).
  const forceSynthetic = process.env.SEASONAL_VERIFY_SYNTHETIC === "1";
  let realInktober = false;
  let realPaintjar = false;
  try { realInktober = (await fetch(API + "/api/inktober")).ok && !forceSynthetic; } catch { /* absent */ }
  try { realPaintjar = (await fetch(API + "/api/paintjar")).ok && !forceSynthetic; } catch { /* absent */ }
  const MODE = realInktober ? "REAL api" : "SYNTHETIC fixtures";
  console.log(`INFO  /api/inktober: ${realInktober ? "real" : "absent → SYNTHETIC"} · /api/paintjar: ${realPaintjar ? "real" : "absent → SYNTHETIC"} · mode: ${MODE}`);

  let realInkState = null;
  if (realInktober) {
    realInkState = await (await fetch(API + "/api/inktober")).json();
    check("real /api/inktober contract shape", ["year", "phase", "date", "day", "prompt", "source", "prompts", "room"].every((k) => k in realInkState)
      && ["upcoming", "active", "ended"].includes(realInkState.phase), `phase=${realInkState.phase}`);
  }
  let realJar = null;
  if (realPaintjar) {
    realJar = await (await fetch(API + "/api/paintjar")).json();
    check("real /api/paintjar contract shape", ["updatedAt", "strokes", "sessions", "countries", "paperEquivalent", "disclaimer"].every((k) => k in realJar));
  }

  // In REAL mode, seed wall posts through the REAL API (isolated scratch
  // DATA_DIR): one from the DAILY room (challenge-stamped) and one from the
  // INKTOBER room (server-assigned event metadata).
  if (realInktober) {
    const post = async (body) => {
      const res = await fetch(API + "/api/wall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { ok: res.ok, data: await res.json().catch(() => ({})) };
    };
    const daily = await post({ userKey: "u_seasonal_verify", title: "Verify Daily Post", artist: "Verifier", tags: [], frames: [PNG_1PX], durationMs: 400, room: "DAILY" });
    check("seed real DAILY wall post (challenge-stamped)", daily.ok && !!daily.data.id, JSON.stringify(daily.data).slice(0, 80));
    const ink = await post({ userKey: "u_seasonal_verify", title: "Verify Ink Post", artist: "Verifier", tags: [], frames: [PNG_1PX], durationMs: 400, room: "INKTOBER" });
    check("seed real INKTOBER wall post (event-stamped)", ink.ok && !!ink.data.id, JSON.stringify(ink.data).slice(0, 80));
  }

  // ---- static wiring checks --------------------------------------------------
  const homeSrc = readFileSync(path.join(ROOT, "src/components/HomePage.jsx"), "utf8");
  check('homepage MAIN preview is fixed with snapshotIntervalMs={120000}',
    /roomCode="MAIN"/.test(homeSrc) && /snapshotIntervalMs=\{120000\}/.test(homeSrc));
  const routerSrc = readFileSync(path.join(ROOT, "src/Router.jsx"), "utf8");
  check("router has /inktober route", routerSrc.includes("/inktober"));
  check("router has /paintjar route", routerSrc.includes("/paintjar"));
  const navSrc = readFileSync(path.join(ROOT, "src/components/SiteNav.jsx"), "utf8");
  check("site nav links Inktober + Planet", navSrc.includes("/inktober") && navSrc.includes("/planet"));
  // Informational only: App.jsx / server.js / LiveRoomCanvas.jsx are owned by
  // other agents working concurrently in this tree; this task did not edit them.
  const othersDirty = execSync("git diff --name-only HEAD -- src/App.jsx server.js src/components/LiveRoomCanvas.jsx src/App.css", { cwd: ROOT }).toString().trim().split("\n").filter(Boolean);
  console.log(`INFO  files owned by other agents with concurrent changes (not this task): ${othersDirty.join(", ") || "none"}`);

  // ---- browser ---------------------------------------------------------------
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 375, height: 760 } }); // phone-first
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

  // Mutable fixture/forcing state the route handlers read.
  const fx = {
    inktober: INKTOBER_UPCOMING,
    wallEvent: "posts", // synthetic-only: "posts" | "empty"
    wallDaily: "posts", // synthetic-only
    forceWallFail: false, // both modes: simulate a gallery outage
    forceJarFail: false, // both modes
    lastEventQuery: null,
    reportPosted: null,
  };

  const proxy = async (route) => {
    const url = new URL(route.request().url());
    try {
      const upstream = await fetch(API + url.pathname + url.search, {
        method: route.request().method(),
        headers: { "content-type": route.request().headers()["content-type"] || "application/json" },
        body: ["POST", "PUT", "PATCH", "DELETE"].includes(route.request().method()) ? route.request().postData() : undefined,
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      await route.fulfill({ status: upstream.status, body: buf, contentType: upstream.headers.get("content-type") || "application/json" });
    } catch {
      await route.fulfill({ status: 502, body: "harness proxy error", contentType: "text/plain" });
    }
  };

  // ONE catch-all handler with internal dispatch — Playwright routes are
  // matched last-registered-wins, so stacked specific + generic patterns let
  // the generic one swallow requests. A single handler is deterministic.
  const handleApi = async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p === "/api/inktober") {
      if (realInktober) return proxy(route);
      return route.fulfill({ json: fx.inktober }); // SYNTHETIC
    }
    if (p === "/api/paintjar" || p === "/api/planet") {
      if (fx.forceJarFail) return route.fulfill({ status: 500, body: "boom", contentType: "text/plain" });
      if (realPaintjar) return proxy(route);
      // SYNTHETIC: /api/planet carries the same aggregates plus the flag set.
      return route.fulfill({ json: p === "/api/planet" ? { ...PAINTJAR, flags: ["US", "MX", "BR"], live: {}, milestones: { strokesPerSheet: 1000, sheets: PAINTJAR.paperEquivalent.sheets } } : PAINTJAR });
    }
    if (p === "/api/wall" && route.request().method() === "GET") {
      if (url.searchParams.get("event") === "inktober-2026") {
        fx.lastEventQuery = url.search;
        if (fx.forceWallFail) return route.fulfill({ status: 500, body: "boom", contentType: "text/plain" });
        if (realInktober) return proxy(route); // REAL event filter
        const day = Number(url.searchParams.get("day") || 0); // SYNTHETIC below
        const posts = fx.wallEvent === "empty" ? [] : SYNTH_INK_POSTS.filter((x) => !day || x.eventDay === day);
        return route.fulfill({ json: { posts, total: posts.length, topTags: [] } });
      }
      if (url.searchParams.get("challenge")) {
        if (realInktober) return proxy(route); // REAL challenge filter
        const posts = fx.wallDaily === "empty" ? [] : SYNTH_DAILY_POSTS; // SYNTHETIC
        return route.fulfill({ json: { posts, total: posts.length, topTags: [] } });
      }
      return proxy(route);
    }
    if (/^\/api\/wall\/[^/]+\/report$/.test(p)) {
      fx.reportPosted = p;
      return proxy(route); // REAL moderation path on the scratch server
    }
    if (/^\/api\/wall\/syn-[^/]+\/frame\/\d+$/.test(p)) {
      return route.fulfill({ status: 200, body: Buffer.from(PNG_1PX.split(",")[1], "base64"), contentType: "image/png" }); // SYNTHETIC
    }
    if (p === "/api/rooms/public") {
      if (realInktober) return proxy(route); // REAL lobby order (MAIN, INKTOBER, …)
      // SYNTHETIC injection fallback: the contract puts INKTOBER after MAIN.
      const upstream = await fetch(API + p + url.search);
      const data = await upstream.json().catch(() => null);
      if (!data || !Array.isArray(data.rooms)) return proxy(route);
      const rooms = data.rooms.filter((r) => r.code !== "INKTOBER");
      const mainIdx = rooms.findIndex((r) => r.code === "MAIN");
      rooms.splice(mainIdx >= 0 ? mainIdx + 1 : 0, 0, INKTOBER_ROOM);
      return route.fulfill({ json: { rooms } });
    }
    return proxy(route);
  };
  const setupRoutes = (context) => context.route("**/api/**", handleApi);
  await setupRoutes(ctx);

  // Expected gallery counts come from the same source the page uses: the REAL
  // API in real mode, the SYNTHETIC fixtures otherwise.
  const expectedEventCount = async (day) => {
    if (realInktober) {
      const q = day ? `&day=${day}` : "";
      const d = await (await fetch(`${API}/api/wall?event=inktober-2026&sort=new&limit=60${q}`)).json();
      return (d.posts || []).length;
    }
    if (fx.wallEvent === "empty") return 0;
    return SYNTH_INK_POSTS.filter((p) => !day || p.eventDay === day).length;
  };

  // ============================== homepage ===================================
  await page.goto(UI + "/", { waitUntil: "domcontentloaded" });

  // Seasonal banner (phase-aware; in real mode the phase is the server's).
  const banner = page.locator(".seasonal-banner");
  await banner.waitFor({ timeout: 15000 });
  const bannerPhase = await banner.getAttribute("data-phase");
  const bannerText = (await banner.innerText()).replace(/\s+/g, " ");
  const expectedPhase = realInktober ? realInkState.phase : "upcoming";
  if (expectedPhase === "upcoming") {
    check(`homepage banner: 'Inktober is coming — get ready' (upcoming, ${MODE})`,
      bannerPhase === "upcoming" && /Inktober is coming — get ready/i.test(bannerText), bannerText.slice(0, 90));
  } else {
    check(`homepage banner matches real phase '${expectedPhase}'`, bannerPhase === expectedPhase, bannerText.slice(0, 90));
  }
  check("homepage banner links to /inktober", (await banner.locator('a[href="/inktober"]').count()) > 0);

  // Room cards inherit API order: MAIN first, INKTOBER second.
  await page.locator(".home-rooms .open-room-card").first().waitFor({ timeout: 15000 });
  const cardCodes = await page.locator(".home-rooms .open-room-card .open-room-code").allInnerTexts();
  check(`homepage room cards: MAIN first then INKTOBER (${MODE})`,
    cardCodes[0] === "MAIN" && cardCodes[1] === "INKTOBER", cardCodes.slice(0, 4).join(","));

  // MAIN fixed preview mounts a live canvas once scrolled into view.
  await page.locator(".home-live-preview").scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  check("homepage live preview mounts a canvas (MAIN, fixed)", (await page.locator(".home-viewer canvas").count()) === 1);

  // Prompt-specific artwork strips (real seeded posts / SYNTHETIC fixtures).
  await page.locator(".home-wall").scrollIntoViewIfNeeded();
  await page.waitForTimeout(900);
  check(`homepage shows daily-challenge artwork strip (${MODE})`,
    (await page.locator('.home-prompt-wall[data-kind="daily"]').count()) === 1);
  check(`homepage shows Inktober artwork strip (${MODE})`,
    (await page.locator('.home-prompt-wall[data-kind="inktober"]').count()) === 1);

  // Honest fallback: with no prompt-stamped posts, no prompt strips render and
  // the generic wall section still carries the section (nothing mislabelled).
  if (!realInktober) {
    fx.wallDaily = "empty";
    fx.wallEvent = "empty";
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".home-wall").scrollIntoViewIfNeeded();
    await page.waitForTimeout(900);
    check("honest fallback: no prompt strips when no prompt art exists",
      (await page.locator(".home-prompt-wall").count()) === 0 && (await page.locator(".home-wall").count()) === 1);
    fx.wallDaily = "posts";
    fx.wallEvent = "posts";
  } else {
    console.log("INFO  honest-fallback strip check skipped in REAL mode (seeded posts exist); covered by SYNTHETIC mode");
  }

  // ============================== /inktober ==================================
  await page.locator('.seasonal-banner a[href="/inktober"]').first().click();
  await page.waitForURL("**/inktober");
  check("SPA navigates to /inktober", page.url().includes("/inktober"));
  await page.locator("main.ink-page h1").waitFor({ timeout: 15000 });

  // Attribution + independence (contract: official rules source, no endorsement).
  check("/inktober links the official rules source", (await page.locator('main.ink-page a[href="https://inktober.com/rules"]').count()) > 0);
  const inkText = (await page.locator("main.ink-page").innerText()).replace(/\s+/g, " ");
  check("/inktober states independent / not endorsed", /not (affiliated|endorsed)/i.test(inkText) && /independent/i.test(inkText));

  // Day prompt selector present with 31 days + All.
  const daySelect = page.locator("#ink-day-filter");
  await daySelect.waitFor({ timeout: 10000 });
  const dayOptions = await daySelect.locator("option").allInnerTexts();
  check("/inktober day selector lists all 31 prompts + an All option", dayOptions.length === 32, `${dayOptions.length} options`);

  // Upcoming phase: honest 'not started yet' copy, no false day stamping.
  if (expectedPhase === "upcoming") {
    check("/inktober upcoming phase copy, no false current day",
      /(coming|starts|get ready)/i.test(inkText) && !/day \d+ of 31/i.test(inkText));
  }

  // Gallery renders the event wall cards (count matches the API exactly).
  await page.locator(".ink-gallery .wall-card").first().waitFor({ timeout: 10000 });
  const allCount = await expectedEventCount(0);
  const renderedAll = await page.locator(".ink-gallery .wall-card").count();
  check(`/inktober gallery renders every event post (${MODE})`, renderedAll === allCount && allCount > 0, `${renderedAll}/${allCount}`);

  // Report path stays reachable from the gallery (REAL moderation endpoint).
  page.once("dialog", (d) => d.accept());
  await page.locator(".ink-gallery .wall-report").first().click();
  await page.waitForTimeout(600);
  check("/inktober report button posts to /api/wall/:id/report", /^\/api\/wall\/[^/]+\/report$/.test(fx.reportPosted || ""), fx.reportPosted || "none");

  // Day filter → refetch with day=3; rendered count matches the API response.
  fx.lastEventQuery = null;
  await daySelect.selectOption("3");
  await page.waitForTimeout(800);
  check("/inktober day filter requests day=3 from the API", !!fx.lastEventQuery && /(^|[?&])day=3(&|$)/.test(fx.lastEventQuery), fx.lastEventQuery || "no request");
  const day3Expected = await expectedEventCount(3);
  await page.waitForTimeout(400);
  const day3Rendered = await page.locator(".ink-gallery .wall-card").count();
  check(`/inktober day=3 gallery matches API (${MODE})`, day3Rendered === day3Expected, `${day3Rendered}/${day3Expected}`);

  // Empty state (a day with no posts — day 31 in real mode, fixture in synthetic).
  if (!realInktober) fx.wallEvent = "empty";
  await daySelect.selectOption("31");
  await page.waitForTimeout(800);
  const emptyText = (await page.locator(".ink-gallery").innerText()).replace(/\s+/g, " ");
  check("/inktober usable empty state", /(no .*(art|drawings)|empty|be the first)/i.test(emptyText), emptyText.slice(0, 80));
  if (!realInktober) fx.wallEvent = "posts";

  // Error state + retry control (simulated outage in both modes).
  fx.forceWallFail = true;
  await daySelect.selectOption("3");
  await page.waitForTimeout(800);
  const errBox = page.locator(".ink-gallery .ink-error");
  check("/inktober usable error state with retry",
    (await errBox.count()) === 1 && (await errBox.locator("button").count()) >= 1);
  fx.forceWallFail = false;
  await errBox.locator("button").click();
  await page.waitForTimeout(800);
  check("/inktober retry recovers the gallery", (await page.locator(".ink-gallery .ink-error").count()) === 0);

  // Active phase copy (SYNTHETIC fixture only — the real phase is time-bound).
  if (!realInktober) {
    fx.inktober = INKTOBER_ACTIVE;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("main.ink-page h1").waitFor({ timeout: 15000 });
    const activeText = (await page.locator("main.ink-page").innerText()).replace(/\s+/g, " ");
    check("/inktober active phase shows day + prompt (SYNTHETIC)",
      /day 3/i.test(activeText) && /Miniature/.test(activeText));
  } else {
    console.log(`INFO  active-phase copy check skipped in REAL mode (real phase is '${realInkState.phase}'); covered by SYNTHETIC mode`);
  }
  if (expectedPhase === "active") {
    check("/inktober active phase has a join-room action for INKTOBER",
      (await page.locator('main.ink-page a[href="/join/INKTOBER"], main.ink-page button[data-join="INKTOBER"]').count()) > 0);
  }

  // ============================== /paintjar ==================================
  const jarExpect = realPaintjar ? realJar : PAINTJAR;
  const fmtNum = (n) => n.toLocaleString("en-US").replace(/,/g, "[,\\s ]?");
  await page.goto(UI + "/paintjar", { waitUntil: "domcontentloaded" });
  // /paintjar now lands on the Painted Planet (PlanetPage). It reads
  // /api/planet, whose strokes/sessions/countries/disclaimer are the same
  // aggregates as /api/paintjar.
  await page.locator("main.planet-main h1").waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);
  const jarText = (await page.locator("main.planet-main").innerText()).replace(/\s+/g, " ");
  check(`/paintjar shows real aggregate strokes (${MODE})`, new RegExp(fmtNum(jarExpect.strokes)).test(jarText), `${jarExpect.strokes}`);
  check("/paintjar shows sessions count", new RegExp(fmtNum(jarExpect.sessions)).test(jarText), `${jarExpect.sessions}`);
  check("/paintjar shows illustrative sheet equivalent", new RegExp(fmtNum(jarExpect.paperEquivalent.sheets)).test(jarText) && /sheet/i.test(jarText));
  check("/paintjar labels equivalent as illustrative, not measured savings",
    /illustrative/i.test(jarText) && !/litre|liter|CO2|carbon saved|trees saved/i.test(jarText.replace(/not a measured[^.]*carbon/i, "")));
  check("/paintjar includes the disclaimer", /Counts are aggregate recorded drawing activity/.test(jarText));
  check("/paintjar renders the painted world map", (await page.locator(".planet-map").count()) === 1 && (await page.locator("path.planet-country").count()) > 150);
  check("/paintjar renders the growing scene", (await page.locator(".scene").count()) === 1);
  const countries = await page.locator(".planet-list .jar-countries li").allInnerTexts();
  const expectedCountries = jarExpect.countries || [];
  check(`/paintjar lists country groups with counts (${MODE})`,
    countries.length === expectedCountries.length
      && (expectedCountries.length === 0 || (countries[0].includes(expectedCountries[0].code) && countries[0].includes(String(expectedCountries[0].count)))),
    `${countries.length}/${expectedCountries.length} groups`);

  // Accessible reduced motion: scene animations must stop.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".scene").waitFor({ timeout: 15000 });
  const sunAnim = await page.locator(".scene-sun").evaluate((el) => getComputedStyle(el).animationName);
  check("/paintjar honours prefers-reduced-motion (scene still)", sunAnim === "none", sunAnim);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // Error state (no fake numbers) — simulated outage in both modes.
  fx.forceJarFail = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  const jarErr = (await page.locator("main.planet-main").innerText()).replace(/\s+/g, " ");
  check("/paintjar error state shows no fabricated stats",
    /(couldn|try again)/i.test(jarErr) && !new RegExp(fmtNum(jarExpect.strokes)).test(jarErr));
  fx.forceJarFail = false;

  // ============================== nav / mobile ===============================
  await page.goto(UI + "/", { waitUntil: "domcontentloaded" });
  await page.locator(".site-nav-toggle").click();
  const menuText = await page.locator(".site-nav-links").innerText();
  check("mobile nav menu contains Inktober and Planet", /Inktober/.test(menuText) && /Planet/.test(menuText));
  await page.locator(".site-nav-toggle").click(); // close the menu

  // ---- auth CTA beside Draw now: guest ---------------------------------------
  const signin = page.locator(".site-nav-actions .site-nav-signin");
  await signin.waitFor({ timeout: 15000 });
  const paintCta = page.locator(".site-nav-actions .site-nav-paint");
  const [sb, pb] = await Promise.all([signin.boundingBox(), paintCta.boundingBox()]);
  check("guest: Sign in visible immediately beside Draw now on a 375px phone",
    !!sb && !!pb && Math.abs(sb.y - pb.y) < 10 && Math.abs(sb.x + sb.width - pb.x) < 26,
    sb && pb ? `signin@(${Math.round(sb.x)},${Math.round(sb.y)},w${Math.round(sb.width)}) paint@(${Math.round(pb.x)},${Math.round(pb.y)})` : "missing box");
  check("guest: no My account button while signed out", (await page.locator(".site-nav-account-cta").count()) === 0);
  // The wordmark yields to the auth CTA on the homepage at phone widths.
  const wordmarkDisplay = await page.locator(".home-page .site-brand .brand-name").evaluate((el) => getComputedStyle(el).display);
  check("mobile polish: homepage wordmark hidden at 375px so the CTA row fits", wordmarkDisplay === "none", wordmarkDisplay);
  await signin.click();
  await page.waitForURL("**/signup**", { timeout: 10000 });
  check("guest: Sign in routes to the existing login page", page.url().includes("/signup") && page.url().includes("mode=login"), page.url());

  // ---- auth CTA: signed in (SYNTHETIC local auth record — the exact shape
  // PocketBase's LocalAuthStore keeps in localStorage; no network involved) ----
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const synToken = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ id: "u_syn", type: "auth", exp: Math.floor(Date.now() / 1000) + 3600 })}.synthetic`;
  const synAuth = { token: synToken, record: { id: "u_syn", email: "syn@example.com", name: "Syn Artist", collectionId: "syn", collectionName: "users" } }; // SYNTHETIC
  const authCtx = await browser.newContext({ viewport: { width: 375, height: 760 } });
  await authCtx.addInitScript((rec) => {
    try { window.localStorage.setItem("pocketbase_auth", JSON.stringify(rec)); } catch { /* ignore */ }
  }, synAuth);
  await setupRoutes(authCtx);
  const authPage = await authCtx.newPage();
  await authPage.goto(UI + "/", { waitUntil: "domcontentloaded" });
  const myAccount = authPage.locator(".site-nav-actions .site-nav-account-cta");
  await myAccount.waitFor({ timeout: 15000 });
  const acctBox = await myAccount.boundingBox();
  const paintBox2 = await authPage.locator(".site-nav-actions .site-nav-paint").boundingBox();
  const acctText = (await myAccount.innerText()).trim();
  check("signed-in: My account shown beside Draw now on mobile (SYNTHETIC session)",
    /my account/i.test(acctText) && !!acctBox && !!paintBox2 && Math.abs(acctBox.y - paintBox2.y) < 10, acctText);
  check("signed-in: no duplicate/misleading Sign in button", (await authPage.locator(".site-nav-signin").count()) === 0);
  await myAccount.click();
  await authPage.waitForURL("**/rooms**", { timeout: 10000 });
  check("signed-in: My account routes to your rooms", authPage.url().includes("/rooms"), authPage.url());
  await authCtx.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? " — FAILURES:" : ""}`);
  for (const f of failed) console.log("  ✗ " + f.name);
  process.exitCode = failed.length ? 1 : 0;
};

run().catch((err) => {
  console.error("HARNESS ERROR:", err);
  process.exitCode = 2;
}).finally(cleanup);
