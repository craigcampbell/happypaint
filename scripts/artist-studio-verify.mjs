// Artist-studio CLIENT integration verification (docs/ARTIST-ROOMS-CONTRACT.md).
/* global window, document */
// Drives the REAL studio (src/App.jsx + useMultiplayer + ArtistAccessPanel)
// against the REAL artist-room backend (server.js artist rooms are live) with
// a mock PocketBase, the full contract loop in browsers:
//
//   A. Guest viewer: sees the art, gets "Sign in to request access", and
//      CANNOT alter the local canvas by pointer, hotkeys (Cmd+Z included) or
//      image import, pan/zoom/chat stay available. No optimistic drawing.
//   B. Owner paint is visible to a viewer (shared truth, no reload).
//   C. Signed-in friend: Request paint access -> owner approves (WS targetId)
//      -> friend paints (visible to owner, NO host powers) -> owner revokes
//      (REST ACL) -> friend is locked again WITHOUT a reload.
//   D. Owner publishes from the Studio panel (real bearer API, real
//      ArtistRoomSettings) -> the studio is found in the REAL gallery
//      (/api/rooms/gallery AND the /gallery page) -> unpublish removes it.
//   E. Inktober opt-in: an artist studio follows the SERVER event phase live
//      (warm-up = full rail; October active = ink/pencil/eraser only) via
//      seasonal_prompt, no reload.
//   F. Regression: the anonymous commons (DOODLE) is untouched, a guest
//      draws immediately, no banner, no Studio button.
//
// Stack: server.js on 8971 (scratch DATA_DIR, mock PB), Vite dev on 8972
// (REST proxied to the server through Playwright routes: Vite has no proxy
// and vite.config.js is not owned here). No prod ports, no build.
import { chromium } from "playwright";
import { spawn } from "child_process";
import http from "http";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRATCH = "/home/craig/.hermes/cache/scratch/artist-studio-verify";
const CLOCK_FILE = path.join(SCRATCH, "inktober-clock.txt");
const API_PORT = 8971;
const VITE_PORT = 8972;
const API = `http://127.0.0.1:${API_PORT}`;
const BASE = `http://127.0.0.1:${VITE_PORT}`;

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
const setClock = (iso) => writeFileSync(CLOCK_FILE, iso);
setClock("2026-09-15T12:00:00.000Z"); // warm-up: Inktober opted-in rooms NOT ink-enforced yet

// ---- mock PocketBase -------------------------------------------------------
// server.js POSTs the RAW token to /api/collections/users/auth-refresh; the
// browser SDK only needs authStore validity (JWT shape + future exp).
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const makeJwt = (id) =>
  `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ id, exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;
const IDENTITIES = {
  owner: { id: "artist_owner1", name: "Olivia Owner", email: "olivia@example.test" },
  friend: { id: "friend_paint2", name: "Frank Friend", email: "frank@example.test" },
};
const TOKENS = new Map(Object.values(IDENTITIES).map((rec) => [makeJwt(rec.id), rec]));
const jwtFor = (key) => [...TOKENS.entries()].find(([, rec]) => rec.id === IDENTITIES[key].id)[0];

const mock = http.createServer((req, res) => {
  // The browser SDK calls the mock directly (session refresh, gallery sync) -
  // answer CORS preflights and tag every response so nothing reads as a
  // console error. Unknown collections 404 like a real PB without the data.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.url === "/api/collections/users/auth-refresh" && req.method === "POST") {
    const raw = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const rec = TOKENS.get(raw);
    if (rec) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ record: rec }));
      return;
    }
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
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const PB = `http://127.0.0.1:${mock.address().port}`;

// ---- processes ---------------------------------------------------------------
const procs = [];
const spawnBg = (argv, env) => {
  const p = spawn(process.execPath, argv, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "pipe" });
  p.stderr.on("data", (d) => process.stderr.write(`[${path.basename(argv[0])}] ` + d));
  procs.push(p);
  return p;
};
spawnBg(["server.js"], {
  PORT: String(API_PORT),
  DATA_DIR: path.join(SCRATCH, "data"),
  PB_URL: PB,
  INKTOBER_CLOCK_FILE: CLOCK_FILE,
  INKTOBER_TICK_MS: "150",
});
spawnBg(["node_modules/vite/bin/vite.js", "--port", String(VITE_PORT), "--strictPort", "--host", "127.0.0.1"], {
  VITE_WS_URL: `ws://127.0.0.1:${API_PORT}/ws`,
  VITE_PB_URL: PB,
});
const killAll = () => { for (const p of procs) { try { p.kill(); } catch { /* */ } } try { mock.close(); } catch { /* */ } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ": " + String(detail).slice(0, 200) : ""}`);
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

// ---- browser helpers ---------------------------------------------------------
const errors = [];
async function newStudioContext(browser, identityKey = null) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Proxy same-origin /api to the real server (Vite dev has no proxy).
  await ctx.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.port !== String(VITE_PORT)) return route.continue();
    try {
      const req = route.request();
      const resp = await fetch(`${API}${url.pathname}${url.search}`, {
        method: req.method(),
        headers: req.headers(),
        body: req.method() === "GET" || req.method() === "HEAD" ? undefined : req.postData() || undefined,
      });
      const buf = Buffer.from(await resp.arrayBuffer());
      return route.fulfill({ status: resp.status, body: buf, headers: { "content-type": resp.headers.get("content-type") || "application/json" } });
    } catch (e) {
      return route.fulfill({ status: 502, body: JSON.stringify({ error: "proxy", detail: String(e) }) });
    }
  });
  if (identityKey) {
    const auth = { token: jwtFor(identityKey), record: IDENTITIES[identityKey] };
    await ctx.addInitScript((value) => {
      try { window.localStorage.setItem("pocketbase_auth", JSON.stringify(value)); } catch { /* */ }
    }, auth);
  }
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  return { ctx, page };
}

async function gotoStudio(page, room) {
  await page.goto(`${BASE}/join/${room}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".overlay-canvas", { state: "visible", timeout: 60000 });
  await sleep(2500);
  const okCurtain = page.locator("button.load-ok");
  if (await okCurtain.waitFor({ state: "visible", timeout: 8000 }).then(() => true).catch(() => false)) {
    await okCurtain.click();
  }
  await page.locator(".modal-backdrop").first().waitFor({ state: "detached", timeout: 8000 }).catch(() => null);
  await sleep(300);
}

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

// Strided pixel sample of the visible composite (display canvas) over a
// mid-canvas region. Compared pairwise: a viewer who cannot mutate must
// produce ZERO changed samples; a shared stroke must change MANY.
const PROBE = `(() => {
  const canvas = document.querySelector(".display-canvas");
  if (!canvas || !canvas.width) return null;
  const ctx = canvas.getContext("2d");
  const x0 = Math.floor(canvas.width * 0.25), y0 = Math.floor(canvas.height * 0.3);
  const w = Math.floor(canvas.width * 0.5), h = Math.floor(canvas.height * 0.45);
  const data = ctx.getImageData(x0, y0, w, h).data;
  const out = [];
  for (let i = 0; i < data.length; i += 4 * 13) out.push(data[i] + data[i + 1] + data[i + 2]);
  return out;
})()`;
const probe = (page) => page.evaluate(PROBE);
const changedCount = (a, b) => {
  if (!a || !b || a.length !== b.length) return -1;
  let n = 0;
  for (let i = 0; i < a.length; i += 1) if (Math.abs(a[i] - b[i]) > 40) n += 1;
  return n;
};
async function waitProbeChange(page, baseline, minChanged, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const now = await probe(page);
    const n = changedCount(baseline, now);
    if (n >= minChanged) return n;
    await sleep(300);
  }
  return changedCount(baseline, await probe(page));
}

const brushChipNames = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".tool-section .brush-grid .brush-chip .chip-name")]
      .map((el) => el.textContent.trim())
      .filter(Boolean),
  );

// A tiny valid PNG for the import-input attempt.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR42mNk+M9QzwAEjAwMDAAAAA8BAf9+XwQ2AAAAAElFTkSuQmCC";

const run = async () => {
  if (!(await waitHttp(`${API}/healthz`))) throw new Error("server.js did not boot");
  if (!(await waitHttp(`${BASE}/join/MAIN`))) throw new Error("vite did not boot");
  for (const url of ["/", "/src/main.jsx", "/src/App.jsx"]) {
    try { await fetch(`${BASE}${url}`); } catch { /* warm the transform cache */ }
  }

  // The room exists before any browser joins (owner-only creation, real REST).
  const created = await api("/api/rooms", {
    method: "POST",
    token: jwtFor("owner"),
    body: { audience: "artist_public", title: "Harbour Studies", description: "Slow harbours, one a week.", tags: ["seascape"] },
  });
  if (created.status !== 200 || !created.json?.code) throw new Error(`room create failed: ${created.status} ${JSON.stringify(created.json)}`);
  const ROOM = created.json.code;
  const gallery0 = await api("/api/rooms/gallery?limit=60");
  check("creating a studio does NOT list it in the gallery", (gallery0.json?.rooms || []).every((r) => r.code !== ROOM), JSON.stringify(gallery0.json));

  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: "chrome" });
  } catch {
    browser = await chromium.launch({ headless: true });
  }

  // =================== owner joins, paints; guest watches ===================
  const ownerS = await newStudioContext(browser, "owner");
  await gotoStudio(ownerS.page, ROOM);
  await sleep(1200);
  const studioBtn = ownerS.page.locator('button:has-text("🖌 Studio")');
  check("owner sees the Studio button in the topbar", (await studioBtn.count()) === 1, `${await studioBtn.count()}`);

  const guestS = await newStudioContext(browser, null);
  await gotoStudio(guestS.page, ROOM);
  await sleep(1200);

  // Owner paints -> the guest sees it arrive (shared truth, no reload).
  const guestBase = await probe(guestS.page);
  await drawStroke(ownerS.page, 0.4, 0.45);
  const arrived = await waitProbeChange(guestS.page, guestBase, 40);
  check("owner's stroke becomes visible to the watching guest", arrived >= 40, `${arrived} changed samples`);

  // ---- A: guest lockdown, no optimistic drawing by ANY local path --------
  const signinCta = guestS.page.locator('.aap-banner button:has-text("Sign in to request access")');
  check("guest gets the sign-in-to-request CTA", (await signinCta.count()) === 1, `${await signinCta.count()}`);
  const ctaHref = await guestS.page.evaluate(() => {
    const btn = document.querySelector(".aap-banner button");
    return btn ? btn.textContent : "";
  });
  check("CTA copy mentions sign in", /sign in/i.test(ctaHref), ctaHref);

  const lockBase = await probe(guestS.page);
  await drawStroke(guestS.page, 0.5, 0.5); // pointer gesture
  await page_pressAll(guestS.page, ["Control+z", "b", "Backspace", "[", "]"]); // hotkeys
  // Image import via the real file input (the importImage entrypoint).
  const fileInput = guestS.page.locator('input[accept="image/*,image/gif"]');
  if ((await fileInput.count()) > 0) {
    await fileInput.setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: Buffer.from(PNG_B64, "base64") });
    await sleep(600);
  }
  await sleep(900);
  const afterAttempts = await probe(guestS.page);
  check(
    "guest cannot alter the local canvas (pointer + hotkeys + import)",
    changedCount(lockBase, afterAttempts) === 0,
    `${changedCount(lockBase, afterAttempts)} changed samples`,
  );
  // Pan stays available (space toggles the hand tool); chat affordance exists.
  await guestS.page.keyboard.press(" ");
  await sleep(250);
  const panOn = await guestS.page.evaluate(() => document.querySelector(".overlay-canvas")?.className.includes("is-pan"));
  check("pan/zoom stays available to watchers", panOn === true, String(panOn));
  await guestS.page.keyboard.press(" ");
  const chatPill = await guestS.page.locator('button[aria-label="Open chat"]').count();
  check("chat stays available to watchers", chatPill >= 1, `${chatPill}`);

  // ============ C: friend request -> approve -> paint -> revoke ============
  const friendS = await newStudioContext(browser, "friend");
  await gotoStudio(friendS.page, ROOM);
  await sleep(1200);
  const reqBtn = friendS.page.locator('.aap-banner button:has-text("Request paint access")');
  check("signed-in watcher gets a Request paint access button", (await reqBtn.count()) === 1, `${await reqBtn.count()}`);
  await reqBtn.click();
  await friendS.page.locator('.aap-banner .aap-status-pill:has-text("Request sent")').waitFor({ state: "visible", timeout: 6000 }).catch(() => null);
  const pendingPill = await friendS.page.locator('.aap-banner .aap-status-pill').count();
  check("request goes to pending on the requester", pendingPill === 1, `${pendingPill}`);

  // Owner sees the request live (toast baseline) and approves by session id.
  await studioBtn.click();
  await ownerS.page.locator(".aap-modal").waitFor({ state: "visible", timeout: 6000 });
  const requestRow = ownerS.page.locator(".aap-request", { hasText: "Frank Friend" });
  check("owner's Studio panel lists the live request", (await requestRow.count()) === 1, `${await requestRow.count()}`);
  await requestRow.locator('button:has-text("Approve")').click();
  await friendS.page.locator(".aap-chip-painter").waitFor({ state: "visible", timeout: 8000 }).catch(() => null);
  check("approved friend becomes a painter without a reload", (await friendS.page.locator(".aap-chip-painter").count()) === 1);
  const ownerPainters = ownerS.page.locator(".aap-painter");
  await ownerS.page.waitForFunction(() => document.querySelectorAll(".aap-painter").length === 1, null, { timeout: 6000 }).catch(() => null);
  check("owner's approved-painter ACL shows the new painter", (await ownerPainters.count()) === 1, `${await ownerPainters.count()}`);
  const hostBtns = await friendS.page.locator('button:has-text("⭐ Host")').count();
  check("approved painter gets NO host powers", hostBtns === 0, `${hostBtns}`);

  // Friend paints -> visible to the owner.
  const ownerBase = await probe(ownerS.page);
  await drawStroke(friendS.page, 0.55, 0.55);
  const friendLanded = await waitProbeChange(ownerS.page, ownerBase, 40);
  check("approved painter's stroke is visible to the owner", friendLanded >= 40, `${friendLanded} changed samples`);

  // Owner revokes (REST ACL, works online AND offline) -> friend locks live.
  await ownerS.page.locator(".aap-painter .aap-danger").click();
  await friendS.page.locator('.aap-banner button:has-text("Request paint access"), .aap-banner button:has-text("Ask again")')
    .first().waitFor({ state: "visible", timeout: 8000 }).catch(() => null);
  const friendRelocked = await friendS.page.locator(".aap-banner").count();
  const friendChipGone = await friendS.page.locator(".aap-chip-painter").count();
  check("revoke re-locks the painter live (banner back, chip gone)", friendRelocked === 1 && friendChipGone === 0, `banner=${friendRelocked} chip=${friendChipGone}`);
  const friendLockBase = await probe(friendS.page);
  await drawStroke(friendS.page, 0.6, 0.45);
  await sleep(900);
  check(
    "revoked painter cannot alter the canvas (no reload needed)",
    changedCount(friendLockBase, await probe(friendS.page)) === 0,
    `${changedCount(friendLockBase, await probe(friendS.page))} changed samples`,
  );

  // ============== D: publish from the real UI -> real gallery ==============
  const descBox = ownerS.page.locator("#ars-desc");
  await descBox.fill("Slow harbours, one a week, ink and wash.");
  await ownerS.page.locator("#ars-tags").fill("seascape, ink");
  await ownerS.page.locator('button:has-text("Publish to gallery…")').click();
  await ownerS.page.locator('.ars-confirm button:has-text("Yes, publish it")').click();
  await ownerS.page.locator(".ars-state-listed").waitFor({ state: "visible", timeout: 8000 }).catch(() => null);
  check("Studio panel publishes to the gallery (real bearer API)", (await ownerS.page.locator(".ars-state-listed").count()) === 1);

  const gallery1 = await api("/api/rooms/gallery?q=harbour");
  const card = (gallery1.json?.rooms || []).find((r) => r.code === ROOM);
  check(
    "published studio is found by the real gallery search",
    Boolean(card) && card.title === "Harbour Studies" && card.tags.includes("seascape"),
    JSON.stringify(gallery1.json),
  );
  check("gallery card carries no PII", card && !/profileId|email|@example/i.test(JSON.stringify(card)), JSON.stringify(card));

  // The real /gallery page (through the same API proxy) shows the card.
  const galleryS = await newStudioContext(browser, null);
  await galleryS.page.goto(`${BASE}/gallery`, { waitUntil: "domcontentloaded" });
  await galleryS.page.locator('text=Harbour Studies').first().waitFor({ state: "visible", timeout: 15000 }).catch(() => null);
  const galleryCardCount = await galleryS.page.locator('text=Harbour Studies').count();
  check("the /gallery page lists the published studio", galleryCardCount >= 1, `${galleryCardCount}`);
  await galleryS.ctx.close();

  // Unpublish from the same panel -> discovery gone, link still viewable.
  await ownerS.page.locator('button:has-text("Unpublish…")').click();
  await ownerS.page.locator('.ars-confirm button:has-text("Yes, unpublish")').click();
  await ownerS.page.locator(".ars-state-unlisted").waitFor({ state: "visible", timeout: 8000 }).catch(() => null);
  const gallery2 = await api("/api/rooms/gallery?q=harbour");
  check(
    "unpublish removes gallery discovery (link keeps working)",
    (gallery2.json?.rooms || []).every((r) => r.code !== ROOM) && (await ownerS.page.locator(".ars-state-unlisted").count()) === 1,
    JSON.stringify(gallery2.json),
  );
  await ownerS.page.locator(".aap-modal .modal-title-row button").click();
  await sleep(300);

  // ===== E: Inktober opt-in follows the server event phase live ============
  const created2 = await api("/api/rooms", {
    method: "POST",
    token: jwtFor("owner"),
    body: { audience: "artist_public", title: "Ink Daily", inktober: true },
  });
  const ROOM2 = created2.json?.code;
  check("inktober studio created (eligibility separate from publishing)", Boolean(ROOM2), JSON.stringify(created2.json));
  const owner2 = await newStudioContext(browser, "owner");
  await gotoStudio(owner2.page, ROOM2);
  await sleep(1500);
  const warmupChips = await brushChipNames(owner2.page);
  check("warm-up phase keeps the full brush rail (server authority)", warmupChips.includes("Marker") && warmupChips.length > 3, JSON.stringify(warmupChips.slice(0, 6)));
  // Flip the server clock into October: the rollover tick pushes seasonal_prompt.
  setClock("2026-10-05T12:00:00.000Z");
  await owner2.page.waitForFunction(
    () => [...document.querySelectorAll(".tool-section .brush-grid .brush-chip .chip-name")].length === 3,
    null,
    { timeout: 10000 },
  ).catch(() => null);
  const activeChips = await brushChipNames(owner2.page);
  const inkNote = await owner2.page.evaluate(() => !!document.querySelector(".ink-only-note"));
  check(
    "October-active phase collapses the rail to ink/pencil/eraser LIVE (seasonal_prompt)",
    activeChips.length === 3 && ["Brushed ink", "Pencil", "Eraser"].every((b) => activeChips.includes(b)) && inkNote,
    JSON.stringify(activeChips),
  );
  // And back to warm-up: the restriction lifts live too.
  setClock("2026-09-20T12:00:00.000Z");
  await owner2.page.waitForFunction(
    () => [...document.querySelectorAll(".tool-section .brush-grid .brush-chip .chip-name")].length > 3,
    null,
    { timeout: 10000 },
  ).catch(() => null);
  const liftedChips = await brushChipNames(owner2.page);
  check("leaving October lifts the ink-only restriction live", liftedChips.includes("Marker"), JSON.stringify(liftedChips.slice(0, 6)));
  await owner2.ctx.close();

  // ================= F: the anonymous commons is unchanged =================
  const commonsS = await newStudioContext(browser, null);
  await gotoStudio(commonsS.page, "DOODLE");
  await sleep(1000);
  const commonsBase = await probe(commonsS.page);
  await drawStroke(commonsS.page, 0.4, 0.4);
  await sleep(800);
  const commonsChanged = changedCount(commonsBase, await probe(commonsS.page));
  check("anonymous commons: a guest still draws immediately", commonsChanged > 20, `${commonsChanged} changed samples`);
  const commonsBanner = await commonsS.page.locator(".aap-banner").count();
  const commonsStudio = await commonsS.page.locator('button:has-text("🖌 Studio")').count();
  check("anonymous commons: no artist-studio UI anywhere", commonsBanner === 0 && commonsStudio === 0, `banner=${commonsBanner} studio=${commonsStudio}`);
  await commonsS.ctx.close();

  await guestS.ctx.close();
  await friendS.ctx.close();
  await ownerS.ctx.close();

  const fatal = errors.filter((e) => !/favicon|manifest|ResizeObserver|Download the React DevTools|ERR_FILE_NOT_FOUND|status of 404|Failed to load resource|pocketbase|sync/i.test(e));
  check("zero page errors", fatal.length === 0, fatal.slice(0, 3).join(" | "));

  await browser.close();
  killAll();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log("failed:", failed.map((f) => f.name).join(" | ")); }
  process.exit(failed.length ? 1 : 0);
};

// Small helper: press a list of keys/chords with a beat between them.
async function page_pressAll(page, keys) {
  for (const key of keys) {
    await page.keyboard.press(key);
    await sleep(200);
  }
}

run().catch((e) => { console.error("harness error:", e); killAll(); process.exit(1); });
