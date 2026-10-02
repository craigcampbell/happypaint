// Sketchbook STUDIO integration verification (docs/SKETCHBOOKS-CONTRACT.md).
// Drives the REAL studio (src/App.jsx) with the SketchbookRoomBanner mounted
// against the REAL backend; ONLY PocketBase auth is mocked (fake-JWT, the
// artist-studio-verify pattern). Strictly isolated: scratch DATA_DIR under
// the Hermes scratch cache, backend 9013, vite 9014, mock PB 9015. Never
// touches 8787, production app_data, or any process it did not spawn.
//
// The clock is pinned to 2026-11-15: AFTER the event ended, so every
// "pinned, not today" assertion is honest: the live event is Classic/ended,
// only the server-stamped page metadata can produce an Inktober Day chip.
//
// Flow:
//   A. Owner opens a day-1 page room -> banner pins "#inktober 2026 · Day 1"
//      with the OFFICIAL day-1 prompt (not today's, not the rotating one).
//   B. Owner draws on page 1, adds a day-2 page from the banner -> new room,
//      canvas is SEPARATE (ops counts prove it), draws there too, flips
//      back with the banner's Prev button.
//   C. Share sheet in the page room gets the PINNED metadata: Inktober theme
//      under a November clock and NO /api/inktober fetch (the pin replaces
//      the live event).
//   D. Artist count stays fresh: mint invite -> second account accepts ->
//      owner revokes the link -> banner shows 2 of 6; owner removes the
//      artist -> 1 of 6.
//   E. by-room network failure shows an in-banner error + Retry (the banner
//      never silently disappears on a lookup error); Retry recovers.
//   F. Guest viewer: prominent "Draw this prompt in your own sketchbook"
//      CTA with the publicly-viewable / invite-only explainer, no owner
//      controls, and a pointer stroke changes NOTHING server-side.
//   G. Mobile 390px: the banner is in-flow ABOVE the canvas stage (no
//      overlap, no canvas blocking) and fits the viewport.
//   H. Regression: chat (pill/panel/quickbar button) and the host Animation
//      toggle are ABSENT on sketchbook pages, and zero chat frames go over
//      the socket, ordinary rooms keep both.
import { chromium } from "playwright";
import { spawn } from "child_process";
import http from "http";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "node:os";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRATCH = path.join(homedir(), ".hermes", "cache", "scratch", "sketchbook-studio-verify");
const CLOCK_FILE = path.join(SCRATCH, "inktober-clock.txt");
const API_PORT = 9013; // realtime backend (never 8787)
const VITE_PORT = 9014; // scratch vite dev server
const PB_PORT = 9015; // mock PocketBase
const API = `http://127.0.0.1:${API_PORT}`;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const PB = `http://127.0.0.1:${PB_PORT}`;

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
writeFileSync(CLOCK_FILE, "2026-11-15T12:00:00.000Z"); // AFTER the event: phase "ended"

// ---- mock PocketBase (fake-JWT tokens; the ONLY mocked piece) --------------
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const makeJwt = (id) =>
  `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ id, exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;
const IDENTITIES = {
  owner: { id: "skbstu_owner1", name: "Olive Owner", email: "olive@example.test" },
  artist: { id: "skbstu_artist2", name: "Ari Artist", email: "ari@example.test" },
};
const TOKENS = new Map(Object.values(IDENTITIES).map((rec) => [makeJwt(rec.id), rec]));
const jwtFor = (key) => [...TOKENS.entries()].find(([, rec]) => rec.id === IDENTITIES[key].id)[0];

const mock = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
  if (req.url === "/api/collections/users/auth-refresh" && req.method === "POST") {
    const raw = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const rec = TOKENS.get(raw);
    if (rec) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ record: rec })); return; }
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

// ---- processes (ONLY these two are ever killed, our own tracked handles) --
const procs = [];
const serverLog = [];
const spawnBg = (argv, env) => {
  const p = spawn(process.execPath, argv, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "pipe" });
  p.stderr.on("data", (d) => { serverLog.push(String(d)); if (serverLog.length > 40) serverLog.shift(); });
  procs.push(p);
  return p;
};
spawnBg(["server.js"], {
  PORT: String(API_PORT),
  DATA_DIR: path.join(SCRATCH, "data"),
  PB_URL: PB,
  INKTOBER_CLOCK_FILE: CLOCK_FILE,
});
spawnBg(["node_modules/vite/bin/vite.js", "--port", String(VITE_PORT), "--strictPort", "--host", "127.0.0.1"], {
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
async function waitOps(bookId, day, min, tries = 25) {
  for (let i = 0; i < tries; i += 1) {
    const r = await api(`/api/sketchbooks/${bookId}`);
    const page = r.json?.book?.pages?.find((p) => p.day === day);
    if (page && (page.ops || 0) >= min) return page.ops;
    await sleep(400); // gentle: the book reader is rate-limited per IP
  }
  const r = await api(`/api/sketchbooks/${bookId}`);
  return r.json?.book?.pages?.find((p) => p.day === day)?.ops ?? -1;
}

// ---- browser helpers ---------------------------------------------------------
let browser = null;
const inktoberApiHits = []; // /api/inktober requests made from any studio page
async function newStudioPage({ identity = null, viewport = { width: 1280, height: 900 }, breakByRoom = false } = {}) {
  const ctx = await browser.newContext({ viewport, ...(viewport.width < 700 ? { isMobile: true, hasTouch: true } : {}) });
  // Proxy same-origin /api to the real backend (vite dev has no proxy here).
  await ctx.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.port !== String(VITE_PORT)) return route.continue();
    if (url.pathname === "/api/inktober") inktoberApiHits.push(url.pathname);
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
  if (breakByRoom) {
    // Registered AFTER the proxy so it wins for by-room lookups: simulate a
    // hard network failure on the banner's one endpoint only.
    await ctx.route("**/api/sketchbooks/by-room/**", (route) => route.abort());
  }
  if (identity) {
    const auth = { token: jwtFor(identity), record: IDENTITIES[identity], model: IDENTITIES[identity] };
    await ctx.addInitScript((value) => {
      try { window.localStorage.setItem("pocketbase_auth", JSON.stringify(value)); } catch { /* */ }
    }, auth);
  }
  // Socket spy: record any client->server frame mentioning "chat" so the
  // no-chat-sends regression can prove silence even after drawing/joining.
  await ctx.addInitScript(() => {
    const NativeWS = window.WebSocket;
    window.__wsChatSends = [];
    window.WebSocket = class extends NativeWS {
      send(data) {
        try { if (typeof data === "string" && data.includes("\"chat\"")) window.__wsChatSends.push(data); } catch { /* spy */ }
        return super.send(data);
      }
    };
  });
  const page = await ctx.newPage();
  page.on("pageerror", (err) => console.log("  [pageerror]", String(err).slice(0, 200)));
  page.on("dialog", (d) => d.accept()); // owner remove-artist confirm
  return { ctx, page };
}
// The proven studio settle (artist-studio-verify): overlay visible, load
// curtain dismissed, any modal backdrop gone: THEN the canvas takes strokes.
async function settleStudio(page) {
  await sleep(2500); // WS handshake + canPaint role flip must land first
  const okCurtain = page.locator("button.load-ok");
  if (await okCurtain.waitFor({ state: "visible", timeout: 8000 }).then(() => true).catch(() => false)) {
    await okCurtain.click();
  }
  await page.locator(".modal-backdrop").first().waitFor({ state: "detached", timeout: 8000 }).catch(() => null);
  await sleep(300);
}
async function gotoStudio(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".overlay-canvas", { state: "visible", timeout: 60000 });
  await settleStudio(page);
}
async function drawStroke(page) {
  const box = await page.locator(".overlay-canvas").boundingBox();
  const fx = box.x + box.width * 0.5;
  const fy = box.y + box.height * 0.5;
  await page.mouse.move(fx - 60, fy - 40);
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) {
    await page.mouse.move(fx - 60 + i * 10, fy - 40 + i * 7);
    await sleep(25);
  }
  await page.mouse.up();
  await sleep(400);
}

const run = async () => {
  check("backend boots", await waitHttp(`${API}/healthz`), serverLog.join("").slice(-240));
  check("vite dev server up", await waitHttp(`${BASE}/`));
  browser = await chromium.launch();

  // Seed: owner's public book with ONE page, day 1 (today is Nov 15; day 1
  // is an OLD pinned prompt, never derivable from the live event).
  const created = await api("/api/sketchbooks", {
    method: "POST", token: jwtFor("owner"), body: { event: "inktober-2026", public: true, title: "Olive's Studio Book" },
  });
  const BOOK = created.json?.book?.id;
  check("seed: book created", created.status === 200 && !!BOOK, JSON.stringify(created).slice(0, 200));
  const day1 = await api(`/api/sketchbooks/${BOOK}/pages`, { method: "POST", token: jwtFor("owner"), body: { day: 1 } });
  const ROOM1 = day1.json?.page?.room;
  const PROMPT1 = day1.json?.page?.prompt;
  check("seed: day-1 page with server-stamped prompt", !!ROOM1 && !!PROMPT1);
  const live = await api("/api/inktober");
  check("clock is AFTER the event (live phase ended, pin is the only inktober source)",
    live.json?.phase === "ended", JSON.stringify(live.json?.phase));

  // ---- A. Owner opens the page room: banner pins the OLD prompt -----------
  const owner = await newStudioPage({ identity: "owner" });
  await gotoStudio(owner.page, `${BASE}/join/${ROOM1}`);
  const bannerOk = await owner.page.waitForSelector(".skb-banner", { timeout: 30000 }).then(() => true).catch(() => false);
  check("A: banner mounts in the studio for a sketchbook page room", bannerOk);
  const chip = bannerOk ? await owner.page.textContent(".skb-prompt-chip") : "";
  check("A: banner pins #inktober 2026 · Day 1 with the official prompt (not today)",
    chip.includes("#inktober 2026") && chip.includes("Day 1") && chip.includes(PROMPT1), chip);
  const ownerControls = bannerOk ? await owner.page.$("text=+ Add page") : null;
  check("A: owner sees the add-page control", !!ownerControls);

  // ---- B. Draw, add a second page, separate canvases, flip back -----------
  const pageOps = async (day) => {
    const r = await api(`/api/sketchbooks/${BOOK}`);
    return r.json?.book?.pages?.find((p) => p.day === day)?.ops ?? -1;
  };
  await drawStroke(owner.page);
  const ops1First = await waitOps(BOOK, 1, 1);
  check("B: owner's stroke lands on page 1", ops1First >= 1, `ops=${ops1First}`);
  await sleep(1500); // let the stroke's segment flush finish, then pin the count
  const ops1 = await pageOps(1);
  await owner.page.click("text=+ Add page");
  await owner.page.waitForSelector("#skb-day-pick", { timeout: 10000 });
  await owner.page.selectOption("#skb-day-pick", "2");
  await owner.page.waitForURL((url) => url.pathname.startsWith("/join/") && !url.pathname.endsWith(ROOM1), { timeout: 15000 });
  const ROOM2 = owner.page.url().split("/").pop();
  check("B: adding a page navigates to the new DISTINCT page room", !!ROOM2 && ROOM2 !== ROOM1, ROOM2);
  await owner.page.waitForSelector(".skb-banner", { timeout: 30000 });
  const chip2 = await owner.page.textContent(".skb-prompt-chip");
  check("B: new room's banner pins Day 2 with its own prompt", chip2.includes("Day 2") && !chip2.includes(PROMPT1), chip2);
  const ops2Before = await pageOps(2);
  check("B: page 2 canvas starts EMPTY (pages are separate canvases)", ops2Before === 0, `ops=${ops2Before}`);
  await settleStudio(owner.page); // the banner hop is a full load, settle again before drawing
  await drawStroke(owner.page);
  const ops2 = await waitOps(BOOK, 2, 1);
  await sleep(1200);
  const ops1After = await pageOps(1);
  check("B: drawing on page 2 does not leak into page 1", ops2 >= 1 && ops1After === ops1, `p1=${ops1}->${ops1After} p2=${ops2}`);
  await owner.page.click("button[aria-label='Previous sketchbook page']");
  await owner.page.waitForURL(`**/join/${ROOM1}`, { timeout: 15000 });
  await owner.page.waitForSelector(".skb-banner", { timeout: 30000 });
  const chipBack = await owner.page.textContent(".skb-prompt-chip");
  check("B: banner Prev flips back to page 1 with its pinned prompt", chipBack.includes("Day 1") && chipBack.includes(PROMPT1), chipBack);

  // ---- C. Share sheet gets the PINNED metadata, not today ------------------
  inktoberApiHits.length = 0;
  await owner.page.click(".desktop-studio-toggle");
  await owner.page.click("text=📤 Share");
  const sheetOk = await owner.page.waitForSelector(".share-invite-sheet", { timeout: 15000 }).then(() => true).catch(() => false);
  check("C: invite sheet opens from the studio", sheetOk);
  if (sheetOk) {
    await owner.page.waitForTimeout(1200); // the sheet's (skipped) fetch window
    const theme = await owner.page.getAttribute(".share-invite-sheet", "data-card-theme");
    check("C: sheet defaults to Inktober under a NOVEMBER clock (pinned page wins over live 'ended')",
      theme === "inktober", String(theme));
    check("C: pinned sheet never fetches the live /api/inktober event", inktoberApiHits.length === 0, String(inktoberApiHits.length));
    const codeText = await owner.page.textContent(".share-invite-code");
    check("C: sheet shares THIS page room", codeText.includes(ROOM1), codeText);
    await owner.page.keyboard.press("Escape");
    await owner.page.click(".topbar-close"); // close the desktop actions overlay (it covers the banner)
  }

  // ---- D. Fresh artist count across invite / accept / revoke --------------
  await owner.page.click("text=Invitations");
  await owner.page.waitForSelector("text=Mint & copy an invite link", { timeout: 10000 });
  await owner.page.click("text=Mint & copy an invite link");
  await owner.page.waitForSelector(".skb-invite-link", { timeout: 10000 });
  const inviteText = await owner.page.textContent(".skb-invite-link");
  const inviteToken = (inviteText.match(/\/sketchbook\/invite\/(\S+)/) || [])[1];
  check("D: owner mints a one-time invite link from the banner", !!inviteToken, inviteText);
  const accepted = await api("/api/sketchbooks/accept", { method: "POST", token: jwtFor("artist"), body: { token: inviteToken } });
  check("D: second account accepts the invite", accepted.status === 200, JSON.stringify(accepted).slice(0, 200));
  await owner.page.click(".skb-list .skb-danger"); // revoke the (now-used) link -> banner reloads
  await owner.page.waitForFunction(
    () => document.querySelector(".skb-banner-artists")?.textContent?.includes("2 of 6"),
    null, { timeout: 10000 },
  ).catch(() => {});
  const artistsAfterAccept = await owner.page.textContent(".skb-banner-artists");
  check("D: banner reflects the accepted artist (2 of 6) without a reload", artistsAfterAccept.includes("2 of 6"), artistsAfterAccept);
  await owner.page.click("text=Remove"); // confirm auto-accepted
  await owner.page.waitForFunction(
    () => document.querySelector(".skb-banner-artists")?.textContent?.includes("1 of 6"),
    null, { timeout: 10000 },
  ).catch(() => {});
  const artistsAfterRemove = await owner.page.textContent(".skb-banner-artists");
  check("D: removing the artist drops the banner back to 1 of 6", artistsAfterRemove.includes("1 of 6"), artistsAfterRemove);

  // ---- E. by-room failure: honest error + Retry, never a silent vanish -----
  const broken = await newStudioPage({ identity: "owner", breakByRoom: true });
  await broken.page.goto(`${BASE}/join/${ROOM1}`, { waitUntil: "domcontentloaded" });
  const errOk = await broken.page.waitForSelector(".skb-banner-error", { timeout: 30000 }).then(() => true).catch(() => false);
  check("E: a failed by-room lookup shows an in-banner error (banner does not silently disappear)", errOk);
  if (errOk) {
    await broken.ctx.unroute("**/api/sketchbooks/by-room/**");
    await broken.page.click(".skb-banner-error button");
    const recovered = await broken.page.waitForSelector(".skb-prompt-chip", { timeout: 15000 }).then(() => true).catch(() => false);
    check("E: Retry recovers the pinned banner", recovered);
  }
  await broken.ctx.close();

  // ---- F. Guest viewer: own-sketchbook CTA, no owner powers, no drawing ----
  const guest = await newStudioPage();
  await gotoStudio(guest.page, `${BASE}/join/${ROOM1}`);
  const guestBanner = await guest.page.waitForSelector(".skb-banner", { timeout: 30000 }).then(() => true).catch(() => false);
  check("F: guest sees the banner on the page room", guestBanner);
  const cta = guestBanner ? await guest.page.$("text=Draw this prompt in your own sketchbook") : null;
  check("F: prominent 'Draw this prompt in your own sketchbook' CTA for viewers", !!cta);
  const ctaNote = guestBanner ? await guest.page.textContent(".skb-banner") : "";
  check("F: CTA offers private OR public (no blanket public promise) + invite-only drawing",
    /choose private or public/i.test(ctaNote) && /invite-only/i.test(ctaNote), ctaNote.slice(0, 220));
  check("F: guest gets NO owner controls", !(await guest.page.$("text=+ Add page")) && !(await guest.page.$("text=Invitations")));
  const opsBeforeGuest = await waitOps(BOOK, 1, 1);
  await drawStroke(guest.page);
  await guest.page.waitForTimeout(1200);
  const opsAfterGuest = await waitOps(BOOK, 1, 1);
  check("F: viewer pointer stroke changes NOTHING on the shared page", opsAfterGuest === opsBeforeGuest, `before=${opsBeforeGuest} after=${opsAfterGuest}`);

  // ---- G. Mobile: banner in-flow above the canvas, fits the viewport ------
  const mob = await newStudioPage({ viewport: { width: 390, height: 844 } });
  await gotoStudio(mob.page, `${BASE}/join/${ROOM1}`);
  const mobBanner = await mob.page.waitForSelector(".skb-banner", { timeout: 30000 }).then(() => true).catch(() => false);
  check("G: banner mounts on mobile", mobBanner);
  if (mobBanner) {
    const bBox = await mob.page.locator(".skb-banner").boundingBox();
    const stageBox = await mob.page.locator(".canvas-stage").boundingBox();
    check("G: banner fits the 390px viewport", bBox && bBox.x >= 0 && bBox.x + bBox.width <= 391, JSON.stringify(bBox));
    check("G: banner is in-flow ABOVE the canvas stage (no overlap, canvas not blocked)",
      bBox && stageBox && bBox.y + bBox.height <= stageBox.y + 1,
      `banner bottom=${bBox && bBox.y + bBox.height} stage top=${stageBox && stageBox.y}`);
    check("G: mobile shows the own-sketchbook CTA too", !!(await mob.page.$("text=Draw this prompt in your own sketchbook")));
  }

  // ---- H. Chat + animation are OFF on sketchbook pages (regression) --------
  // The owner is a HOST in this room, in any ordinary host room both the
  // chat pill and the animation toggle render. Here neither may exist, and
  // the whole session must not have sent a single chat frame.
  check("H: no chat pill/panel on the page room (desktop)", !(await owner.page.$(".cc-pill")) && !(await owner.page.$(".cc-panel")));
  check("H: no host Animation toggle on the page room", !(await owner.page.$(".mp-anim-toggle")));
  const quickbarText = (await mob.page.textContent(".mobile-quickbar").catch(() => "")) || "";
  check("H: no quickbar Chat button on mobile", !quickbarText.includes("Chat"), quickbarText.slice(0, 120));
  const chatSends = await owner.page.evaluate(() => window.__wsChatSends?.length ?? -1);
  const guestChatSends = await guest.page.evaluate(() => window.__wsChatSends?.length ?? -1);
  check("H: zero chat frames sent over the socket (owner + guest sessions)", chatSends === 0 && guestChatSends === 0, `owner=${chatSends} guest=${guestChatSends}`);
  await owner.ctx.close();
  await mob.ctx.close();
  await guest.ctx.close();
};

run()
  .catch((err) => {
    console.error("suite error:", err);
    results.push({ name: "suite completed", ok: false });
  })
  .finally(async () => {
    try { await browser?.close(); } catch { /* gone */ }
    killAll(); // ONLY our own tracked child handles + the mock listener
    await sleep(400);
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ""}`);
    if (failed.length) {
      console.log("server log tail:\n" + serverLog.join("").slice(-1200));
      process.exit(1);
    }
  });
