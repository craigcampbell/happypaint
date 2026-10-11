// Sketchbook catch-up + tablet banner regression (isolated: scratch server,
// scratch vite, mock PocketBase; never port 8787).
//
//   A. Tablet/coarse-pointer studio (iPad 12.9 / Wacom-style 1024x1366): the
//      fixed Home/Rooms/Invite FAB row does NOT overlap the sketchbook banner's
//      prompt chip or Prev/Next buttons (the reported bug).
//   B. Guest (unsaved) book owner, from the studio: the "Other days" picker
//      lists every official day, a missed PRIOR day mints a new page in the
//      SAME book and lands in its studio, the day chip for a drawn page just
//      opens it (no duplicate page).
//   C. /inktober hero: the catch-up strip offers all 31 days; tapping a prior
//      day starts a page for THAT day (server-stamped prompt), not today's.
//   D. Account owner (reader + studio): the picker adds a prior day's page.
//   E. Stranger on someone else's unsaved page: NO day picker, one honest
//      "only the artist" note (no duplicated CTA text in the banner).
import { chromium, webkit } from "playwright";
import { spawn } from "child_process";
import http from "http";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "node:os";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRATCH = path.join(homedir(), ".hermes", "cache", "scratch", "sketchbook-catchup-verify");
const CLOCK_FILE = path.join(SCRATCH, "inktober-clock.txt");
const API_PORT = 9031;
const VITE_PORT = 9032;
const PB_PORT = 9033;
const API = `http://127.0.0.1:${API_PORT}`;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const PB = `http://127.0.0.1:${PB_PORT}`;

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
writeFileSync(CLOCK_FILE, "2026-10-05T12:00:00.000Z"); // active, day 5 (days 1-4 "missed")

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const makeJwt = (id) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ id, exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;
const OWNER = { id: "skbcu_owner1", name: "Olive Owner", email: "olive@example.test" };
const OWNER_JWT = makeJwt(OWNER.id);

const mock = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
  if (req.url === "/api/collections/users/auth-refresh" && req.method === "POST") {
    const raw = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (raw === OWNER_JWT) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ record: OWNER })); return; }
    res.writeHead(401).end("{}");
    return;
  }
  if (req.url === "/api/collections/users/auth-methods") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ oauth2: { providers: [] } }));
    return;
  }
  res.writeHead(404).end("{}");
});
await new Promise((r) => mock.listen(PB_PORT, "127.0.0.1", r));

const procs = [];
const serverLog = [];
const spawnBg = (argv, env) => {
  const p = spawn(process.execPath, argv, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "pipe" });
  p.stderr.on("data", (d) => { serverLog.push(String(d)); if (serverLog.length > 40) serverLog.shift(); });
  procs.push(p);
  return p;
};
spawnBg(["server.js"], { PORT: String(API_PORT), DATA_DIR: path.join(SCRATCH, "data"), PB_URL: PB, INKTOBER_CLOCK_FILE: CLOCK_FILE });
spawnBg(["node_modules/vite/bin/vite.js", ...(process.env.VERIFY_BUILT ? ["preview"] : []), "--port", String(VITE_PORT), "--strictPort", "--host", "127.0.0.1"], {
  VITE_WS_URL: `ws://127.0.0.1:${API_PORT}/ws`,
  VITE_PB_URL: PB,
});
const killAll = () => {
  for (const p of procs) { try { p.kill("SIGTERM"); } catch { /* gone */ } }
  try { mock.close(); } catch { /* gone */ }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ": " + String(detail).slice(0, 240) : ""}`);
};
async function waitHttp(url, tries = 160) {
  for (let i = 0; i < tries; i += 1) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* boot */ }
    await sleep(250);
  }
  return false;
}
async function api(pathname, { method = "GET", token = null, body = null } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${pathname}`, { method, headers, body: body == null ? null : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}

let browser = null;
const DEVICE_KEY = "dk_catchup_guest_0001";
async function newPage({ viewport, coarse = false, identity = false, deviceKey = DEVICE_KEY } = {}) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: "block", ...(coarse ? { isMobile: true, hasTouch: true } : {}) });
  await ctx.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.port !== String(VITE_PORT)) return route.continue();
    try {
      const req = route.request();
      const resp = await fetch(`${API}${url.pathname}${url.search}`, {
        method: req.method(), headers: req.headers(),
        body: req.method() === "GET" || req.method() === "HEAD" ? undefined : req.postData() || undefined,
      });
      const buf = Buffer.from(await resp.arrayBuffer());
      return route.fulfill({ status: resp.status, body: buf, headers: { "content-type": resp.headers.get("content-type") || "application/json" } });
    } catch (e) {
      console.log("  [proxy error]", url.pathname, String(e));
      return route.fulfill({ status: 502, body: JSON.stringify({ error: "proxy", detail: String(e) }) });
    }
  });
  await ctx.addInitScript(({ dk, auth }) => {
    try {
      if (dk) window.localStorage.setItem("drawesome:userkey:v1", dk);
      if (auth) window.localStorage.setItem("pocketbase_auth", JSON.stringify(auth));
    } catch { /* */ }
  }, { dk: deviceKey, auth: identity ? { token: OWNER_JWT, record: OWNER, model: OWNER } : null });
  const page = await ctx.newPage();
  page.on("pageerror", (err) => console.log("  [pageerror]", String(err).slice(0, 200)));
  page.on("dialog", (d) => d.accept());
  return { ctx, page };
}
async function settleStudio(page) {
  await sleep(2500);
  const okCurtain = page.locator("button.load-ok");
  if (await okCurtain.waitFor({ state: "visible", timeout: 8000 }).then(() => true).catch(() => false)) await okCurtain.click();
  await page.locator(".modal-backdrop").first().waitFor({ state: "detached", timeout: 8000 }).catch(() => null);
  await sleep(300);
}
async function gotoStudio(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".overlay-canvas", { state: "visible", timeout: 60000 });
  await settleStudio(page);
}
const rect = async (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right };
}, sel);
const overlaps = (a, b) => !!a && !!b && a.w > 0 && b.w > 0 && a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;

const run = async () => {
  check("backend boots", await waitHttp(`${API}/healthz`), serverLog.join("").slice(-240));
  check("vite dev server up", await waitHttp(`${BASE}/`));
  browser = await (process.env.TEST_BROWSER === "webkit" ? webkit : chromium).launch();

  const live = await api("/api/inktober");
  check("seed: event active on day 5", live.json?.phase === "active" && live.json?.day === 5, JSON.stringify(live.json?.day));

  // Seed: the device's unsaved book with today's page (day 5).
  const seed = await api("/api/sketchbooks/guest", { method: "POST", body: { device: DEVICE_KEY, day: null } });
  const BOOK = seed.json?.bookId;
  const ROOM5 = seed.json?.room;
  check("seed: guest book minted for today's page", seed.status === 200 && !!BOOK && !!ROOM5 && seed.json?.page?.day === 5, JSON.stringify(seed.json));

  // ---- A. Tablet studio: FAB row must not cover the banner ------------------
  const tab = await newPage({ viewport: { width: 1024, height: 1366 }, coarse: true });
  await gotoStudio(tab.page, `${BASE}/join/${ROOM5}`);
  await tab.page.waitForSelector(".skb-banner", { timeout: 30000 });
  const fab = await rect(tab.page, ".studio-rooms-fab");
  const chip = await rect(tab.page, ".skb-banner .skb-prompt-chip");
  const flip = await rect(tab.page, ".skb-banner-flip");
  const otherDays = await rect(tab.page, ".skb-banner button[aria-expanded]");
  check("A: FAB row is visible on the tablet layout", !!fab && fab.w > 0 && fab.h > 0, JSON.stringify(fab));
  check("A: FAB row does NOT overlap the prompt chip", !overlaps(fab, chip), JSON.stringify({ fab, chip }));
  check("A: FAB row does NOT overlap Prev/Next", !overlaps(fab, flip), JSON.stringify({ fab, flip }));
  check("A: FAB row does NOT overlap the Other days button", !overlaps(fab, otherDays), JSON.stringify({ fab, otherDays }));
  const stage = await rect(tab.page, ".canvas-stage");
  const bannerWrap = await rect(tab.page, ".skb-banner-wrap");
  check("A: banner stays in-flow above the canvas stage", !!stage && !!bannerWrap && bannerWrap.bottom <= stage.y + 1, JSON.stringify({ bannerWrap, stage }));

  // ---- B. Guest owner catch-up from the studio ------------------------------
  await tab.page.tap(".skb-banner button[aria-expanded]");
  await tab.page.waitForSelector(".skb-days-pick", { timeout: 10000 });
  await tab.page.waitForFunction(() => document.querySelectorAll(".skb-days-pick button").length >= 31, null, { timeout: 10000 });
  const dayCount = await tab.page.locator(".skb-days-pick button").count();
  check("B: picker lists all 31 official days", dayCount === 31, String(dayCount));
  const touch = await tab.page.evaluate(() => ({coarse:matchMedia('(pointer:coarse)').matches,touch:navigator.maxTouchPoints}));
  // Linux WebKit reports maxTouchPoints=0 even with Playwright hasTouch; the
  // media query and actual tap above are the CSS/input branch acceptance.
  check("B: tablet test genuinely exercises the coarse-pointer branch", touch.coarse, JSON.stringify(touch));
  const target = await rect(tab.page, ".skb-days-pick button");
  check("B: touch day chips measure at least 44x44 CSS pixels", target.w >= 44 && target.h >= 44, JSON.stringify(target));
  await tab.page.setViewportSize({ width:1366,height:1024 });
  const landscapeFab = await rect(tab.page, ".studio-rooms-fab");
  const landscapeChip = await rect(tab.page, ".skb-prompt-chip");
  check("B: iPad landscape FAB does not overlap the prompt", !overlaps(landscapeFab,landscapeChip));
  await tab.page.setViewportSize({width:1024,height:1366});
  const todayChip = tab.page.locator(".skb-days-pick button[aria-current='true']");
  check("B: the current page's day is marked current and disabled", (await todayChip.count()) === 1 && (await todayChip.getAttribute("disabled")) !== null);
  const has5 = await tab.page.locator(".skb-days-pick button.skb-day-has-page").count();
  check("B: only the drawn/existing day carries the page marker", has5 === 1, String(has5));
  // Tap Day 2 (missed): mints a page in the SAME book and navigates.
  await tab.page.locator(".skb-days-pick button", { hasText: /^\s*2\s*$/ }).click();
  await tab.page.waitForURL((u) => u.pathname.startsWith("/join/") && !u.pathname.endsWith(ROOM5), { timeout: 20000 });
  const ROOM2 = tab.page.url().split("/").pop();
  const bookAfter = await api(`/api/sketchbooks/${BOOK}`);
  const pages = bookAfter.json?.book?.pages || [];
  check("B: picking a missed day navigates to a NEW page room", !!ROOM2 && ROOM2 !== ROOM5, ROOM2);
  check("B: the page landed in the SAME unsaved book (2 pages: days 2 and 5)",
    pages.length === 2 && pages.map((p) => p.day).join(",") === "2,5" && pages.find((p) => p.day === 2)?.room === ROOM2, JSON.stringify(pages.map((p) => [p.day, p.room])));
  check("B: the prior-day page is stamped with ITS prompt + date, not today's",
    pages.find((p) => p.day === 2)?.date === "2026-10-02" && pages.find((p) => p.day === 2)?.prompt !== pages.find((p) => p.day === 5)?.prompt, JSON.stringify(pages));
  await tab.page.waitForSelector(".skb-banner", { timeout: 30000 });
  await settleStudio(tab.page);
  const chip2 = await tab.page.textContent(".skb-prompt-chip");
  check("B: the new room's banner pins Day 2", /Day 2\b/.test(chip2), chip2);
  // The device can draw on its own prior-day page.
  const canDraw = await api(`/api/sketchbooks/by-room/${ROOM2}?dk=${DEVICE_KEY}`);
  check("B: the device owner canDraw on the caught-up page", canDraw.json?.canDraw === true && canDraw.json?.isGuestOwner === true, JSON.stringify(canDraw.json));
  // Re-open the picker: Day 5 now just opens the existing room (no new page).
  await tab.page.click(".skb-banner button[aria-expanded]");
  await tab.page.waitForFunction(() => document.querySelectorAll(".skb-days-pick button").length >= 31, null, { timeout: 10000 });
  await tab.page.locator(".skb-days-pick button", { hasText: /^\s*●?\s*5\s*$/ }).click();
  await tab.page.waitForURL((u) => u.pathname.endsWith(ROOM5), { timeout: 20000 });
  const bookAgain = await api(`/api/sketchbooks/${BOOK}`);
  check("B: tapping a drawn day opens its existing room, no duplicate page",
    tab.page.url().endsWith(ROOM5) && (bookAgain.json?.book?.pages || []).length === 2, JSON.stringify(bookAgain.json?.book?.pageCount));
  // The same device's View book reader must offer catch-up too; it is still
  // the author of an unsaved book, not an unrelated gallery visitor.
  await tab.page.goto(`${BASE}/sketchbook/${BOOK}`, { waitUntil: "domcontentloaded" });
  await tab.page.waitForSelector(".skb-reader-head", { timeout: 30000 });
  const guestCatchup = tab.page.getByRole("button", { name: /Catch up on a day/ });
  const canCatchupInReader = await guestCatchup.count();
  check("B: guest book author can catch up from View book", canCatchupInReader === 1);
  if (canCatchupInReader) {
    await guestCatchup.click();
    await tab.page.waitForFunction(() => document.querySelectorAll(".skb-days-catchup button").length === 31);
    await tab.page.locator(".skb-days-catchup button", { hasText: /^\s*1\s*$/ }).click();
    await tab.page.waitForURL((u) => u.pathname.startsWith("/join/"), { timeout: 20000 });
    const fromReader = await api(`/api/sketchbooks/${BOOK}`);
    check("B: guest reader catch-up creates Day 1 in the SAME book",
      fromReader.json?.book?.pages?.map(p => p.day).join(",") === "1,2,5");
  }
  await tab.ctx.close();

  // ---- C. /inktober hero catch-up strip ------------------------------------
  const ink = await newPage({ viewport: { width: 390, height: 844 }, coarse: true, deviceKey: "dk_catchup_inkpage_002" });
  await ink.page.goto(`${BASE}/inktober`, { waitUntil: "domcontentloaded" });
  await ink.page.waitForSelector(".ink-catchup-days", { timeout: 30000 });
  const inkDays = await ink.page.locator(".ink-catchup-days button").count();
  check("C: /inktober hero offers all 31 prompt days", inkDays === 31, String(inkDays));
  const inkToday = await ink.page.locator(".ink-catchup-days button[aria-current='true']").textContent();
  check("C: today's day is marked current in the strip", (inkToday || "").trim() === "5", inkToday);
  await ink.page.locator(".ink-catchup-days button", { hasText: /^\s*3\s*$/ }).click();
  await ink.page.waitForURL((u) => u.pathname.startsWith("/join/"), { timeout: 20000 });
  const inkRoom = ink.page.url().split("/").pop();
  const inkInfo = await api(`/api/sketchbooks/by-room/${inkRoom}?dk=dk_catchup_inkpage_002`);
  check("C: tapping Day 3 starts a page for DAY 3 (not today) in this device's own book",
    inkInfo.json?.day === 3 && inkInfo.json?.isGuestOwner === true && inkInfo.json?.bookId !== BOOK, JSON.stringify(inkInfo.json));
  await ink.ctx.close();

  // ---- D. Account owner: reader + studio picker add a prior day ------------
  const own = await api("/api/sketchbooks", { method: "POST", token: OWNER_JWT, body: { public: true } });
  const OBOOK = own.json?.book?.id;
  check("D: owner book created", own.status === 200 && !!OBOOK, JSON.stringify(own.json));
  const o = await newPage({ viewport: { width: 1280, height: 900 }, identity: true, deviceKey: "dk_catchup_owner_003" });
  await o.page.goto(`${BASE}/sketchbook/${OBOOK}`, { waitUntil: "domcontentloaded" });
  await o.page.waitForSelector(".skb-reader-head", { timeout: 30000 });
  // Empty book: add the first (today's) page, then the catch-up picker.
  await o.page.click("text=Add the first page");
  await o.page.waitForSelector(".skb-reader-nav", { timeout: 15000 });
  await o.page.click("text=Catch up on a day");
  await o.page.waitForFunction(() => document.querySelectorAll(".skb-days-catchup button").length >= 31, null, { timeout: 10000 });
  await o.page.locator(".skb-days-catchup button", { hasText: /^\s*1\s*$/ }).click();
  await o.page.waitForURL((u) => u.pathname.startsWith("/join/"), { timeout: 20000 });
  const oBook = await api(`/api/sketchbooks/${OBOOK}`, { token: OWNER_JWT });
  const oPages = oBook.json?.book?.pages || [];
  check("D: reader catch-up added Day 1 and opened its studio",
    oPages.map((p) => p.day).join(",") === "1,5" && o.page.url().endsWith(oPages.find((p) => p.day === 1)?.room || "~"), JSON.stringify(oPages.map((p) => p.day)));
  await o.page.waitForSelector(".overlay-canvas", { state: "visible", timeout: 60000 });
  await settleStudio(o.page);
  await o.page.waitForSelector(".skb-banner button[aria-expanded]", { timeout: 30000 });
  await o.page.click(".skb-banner button[aria-expanded]");
  await o.page.waitForFunction(() => document.querySelectorAll(".skb-days-pick button").length >= 31, null, { timeout: 10000 });
  const oToday = o.page.locator(".skb-panel-row .skb-banner-primary");
  check("D: studio picker offers 'Open today's page' from a prior-day page", /today/i.test(await oToday.textContent()) && (await oToday.getAttribute("disabled")) === null);
  await o.page.locator(".skb-days-pick button", { hasText: /^\s*4\s*$/ }).click();
  await o.page.waitForURL((u) => u.pathname.startsWith("/join/") && !u.pathname.endsWith(oPages.find((p) => p.day === 1)?.room), { timeout: 20000 });
  const oBook2 = await api(`/api/sketchbooks/${OBOOK}`, { token: OWNER_JWT });
  check("D: studio picker added Day 4 to the owner's book",
    (oBook2.json?.book?.pages || []).map((p) => p.day).join(",") === "1,4,5", JSON.stringify((oBook2.json?.book?.pages || []).map((p) => p.day)));
  // A signed-in artist picking an EXISTING day from the event page must land
  // directly in that account's page, not a new public guest page which is then
  // detached by the claim/merge flow. This is the cross-device return path.
  await o.page.goto(`${BASE}/inktober`, { waitUntil: "domcontentloaded" });
  await o.page.waitForSelector(".ink-catchup-days", { timeout: 30000 });
  const requests = [];
  o.page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/sketchbooks/guest") requests.push(r.url()); });
  await o.page.locator(".ink-catchup-days button", { hasText: /^\s*1\s*$/ }).click();
  await o.page.waitForURL((u) => u.pathname.startsWith("/join/"), { timeout: 20000 });
  check("D: signed-in /inktober catch-up resumes the ACCOUNT's existing day",
    o.page.url().endsWith(oPages.find((p) => p.day === 1)?.room || "~"), o.page.url());
  check("D: signed-in catch-up creates NO temporary public guest book", requests.length === 0, String(requests.length));
  // Other top-level entry buttons must use the same account routing.
  const todayRoom = oPages.find((p) => p.day === 5)?.room;
  await o.page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await o.page.waitForSelector(".home-paper-ink[data-phase='active']", { timeout: 30000 });
  await o.page.click(".home-paper-ink[data-phase='active']");
  await o.page.waitForURL((u) => u.pathname.startsWith("/join/"), { timeout: 20000 });
  check("D: signed-in HOME Inktober button resumes the account's today's page", o.page.url().endsWith(todayRoom || "~"), o.page.url());

  await gotoStudio(o.page, `${BASE}/join/INKTOBER`);
  await o.page.getByRole("button", { name: "Draw this prompt in your own sketchbook →", exact: true }).click();
  await o.page.waitForURL((u) => u.pathname.startsWith("/join/") && !u.pathname.endsWith("INKTOBER"), { timeout: 20000 });
  check("D: signed-in SHARED-ROOM button resumes the account's today's page", o.page.url().endsWith(todayRoom || "~"), o.page.url());

  await o.page.goto(`${BASE}/sketchbook/${BOOK}`, { waitUntil: "domcontentloaded" });
  await o.page.waitForSelector(".skb-reader-unsaved", { timeout: 30000 });
  await o.page.locator(".skb-reader-unsaved button").click();
  await o.page.waitForURL((u) => u.pathname.startsWith("/join/"), { timeout: 20000 });
  check("D: signed-in VISITOR reader button opens the account's today's page", o.page.url().endsWith(todayRoom || "~"), o.page.url());
  await o.ctx.close();

  // ---- E. Stranger on the guest's page: no picker, single honest note -------
  const s = await newPage({ viewport: { width: 1024, height: 1366 }, coarse: true, deviceKey: "dk_catchup_stranger_004" });
  await gotoStudio(s.page, `${BASE}/join/${ROOM5}`);
  await s.page.waitForSelector(".skb-banner", { timeout: 30000 });
  check("E: stranger gets NO day picker", (await s.page.locator(".skb-banner button[aria-expanded]").count()) === 0);
  const bannerText = await s.page.textContent(".skb-banner-wrap");
  const noteCount = (bannerText.match(/Only the artist on this page can draw here/g) || []).length;
  check("E: the 'only the artist' note appears once in the sketchbook banner", noteCount === 1, String(noteCount));
  check("E: the watch-only strip still offers the one-tap start-your-own door",
    (await s.page.locator(".skb-watch-note button", { hasText: /Start your own page/ }).count()) === 1);
  await s.ctx.close();
};

try {
  await run();
} catch (e) {
  check("suite ran to completion", false, String(e?.stack || e));
} finally {
  try { await browser?.close(); } catch { /* */ }
  killAll();
}
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
