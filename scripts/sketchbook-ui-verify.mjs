// Inktober sketchbook UI smoke, real backend, real vite dev server, real
// browser; ONLY auth is mocked (fake-JWT PocketBase, same pattern as
// artist-studio-verify). Isolated: scratch DATA_DIR, backend 9023, vite 9024
// (9003/9004 belong to the backend child's suite). Never touches 8787 or
// production app_data.
//
// Flow:
//   guest /sketchbook -> honest sign-in card (no fake identity) + shared-room
//     link; login/signup links carry return=/sketchbook
//   owner /sketchbook -> GET mine auto-resume ONLY (zero POSTs) -> book reader
//   new signed-in user /sketchbook -> NO create POST before a choice is made;
//     PRIVATE is the default selection, PUBLIC is an explicit opt-in with the
//     viewing + automatic-gallery disclosure; the create POST carries the
//     chosen boolean exactly
//   API: POST /api/sketchbooks without `public` defaults to private; a
//     private book 404s the public reader + by-room for strangers and is
//     absent from the gallery; invited artists pass after accepting
//   reader: guest on a private book gets the honest "private, or not here"
//     card with a sign-in return path; the owner visibility toggle asks an
//     explicit confirm before going public (dismiss = no POST)
//   guest /sketchbook/invite/:token -> sign-in links carry return=<this exact
//     invite path>; the token is never console-logged; signed-in accept works
//   guest reader -> pinned #inktober prompt chip, page flip (Prev/Next + day
//     strip), start-own CTA; only the selected page's canvas mounts
//   homepage -> hero Inktober card CTA opens /sketchbook (own), shared-room
//     quiet link preserved; "New Inktober sketchbooks" strip lists the book
//   /inktober -> own-sketchbook CTA + sketchbooks section
import { spawn } from "child_process";
import http from "http";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";
import { chromium } from "playwright";
import { createServer as createViteServer } from "/home/craig/Projects/happypaint/node_modules/vite/dist/node/index.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRATCH = path.join(process.env.TMPDIR || "/tmp", "sketchbook-ui-verify-data");
const CLOCK_FILE = path.join(SCRATCH, "inktober-clock.txt");
const API_PORT = 9023;
const VITE_PORT = 9024;

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
writeFileSync(CLOCK_FILE, "2026-10-05T12:00:00.000Z"); // active event, day 5

// ---- mock PocketBase (fake-JWT tokens; the ONLY mocked piece) --------------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = (id) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ id, type: "auth", exp: Math.floor(Date.now() / 1000) + 7200 })}.fakesig`;
const OWNER_JWT = fakeJwt("book_owner01");
const NEWBIE_JWT = fakeJwt("book_newbie1");
const QUIET_JWT = fakeJwt("book_quiet01"); // picks the PRIVATE default in the choice card
const PRIV_JWT = fakeJwt("book_priv_own"); // API-seeded private book owner
const ARTIE_JWT = fakeJwt("book_artie01"); // invited artist on the private book
const CLAIM_JWT = fakeJwt("book_claim01"); // the account that SAVES a guest book
const TOKENS = {
  [OWNER_JWT]: { id: "book_owner01", name: "Olive Owner" },
  [NEWBIE_JWT]: { id: "book_newbie1", name: "Nina Newbie" },
  [QUIET_JWT]: { id: "book_quiet01", name: "Quinn Quiet" },
  [PRIV_JWT]: { id: "book_priv_own", name: "Priya Private" },
  [ARTIE_JWT]: { id: "book_artie01", name: "Artie Artist" },
  [CLAIM_JWT]: { id: "book_claim01", name: "Casey Claim" },
};
const mock = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
  if (req.url === "/api/collections/users/auth-refresh" && req.method === "POST") {
    const raw = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const rec = TOKENS[raw];
    if (rec) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ record: rec })); return; }
    res.writeHead(401).end("{}");
    return;
  }
  res.writeHead(404).end("{}");
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const PB = `http://127.0.0.1:${mock.address().port}`;

// ---- harness ----------------------------------------------------------------
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ": " + String(detail).slice(0, 240) : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const serverLog = [];
const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(API_PORT),
    DATA_DIR: SCRATCH,
    PB_URL: PB,
    INKTOBER_CLOCK_FILE: CLOCK_FILE,
  },
  stdio: "pipe",
});
server.stderr.on("data", (d) => { serverLog.push(String(d)); if (serverLog.length > 30) serverLog.shift(); });

async function waitHealthy(port) {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) return true; } catch { /* boot */ }
    await sleep(250);
  }
  return false;
}
async function api(pathname, { method = "GET", token = null, body = null } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${API_PORT}${pathname}`, {
    method, headers, body: body == null ? null : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}

let vite = null;
let browser = null;
const run = async () => {
  check("backend boots", await waitHealthy(API_PORT), serverLog.join("").slice(-240));

  // Seed: owner's book with two pages and real ink on the day-5 page.
  const created = await api("/api/sketchbooks", {
    method: "POST", token: OWNER_JWT, body: { event: "inktober-2026", public: true, title: "Olive's Inks" },
  });
  const BOOK = created.json?.book?.id;
  check("seed: book created", created.status === 200 && !!BOOK, JSON.stringify(created).slice(0, 200));
  const day5 = await api(`/api/sketchbooks/${BOOK}/pages`, { method: "POST", token: OWNER_JWT, body: {} });
  const day1 = await api(`/api/sketchbooks/${BOOK}/pages`, { method: "POST", token: OWNER_JWT, body: { day: 1 } });
  const ROOM5 = day5.json?.page?.room;
  const PROMPT5 = day5.json?.page?.prompt;
  const PROMPT1 = day1.json?.page?.prompt;
  check("seed: two pages with server-stamped prompts", !!ROOM5 && !!PROMPT5 && !!PROMPT1 && PROMPT5 !== PROMPT1);

  const ws = new WebSocket(`ws://127.0.0.1:${API_PORT}/ws?room=${ROOM5}`);
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  ws.send(JSON.stringify({ type: "auth", token: OWNER_JWT, userKey: "dk_uiverify1" }));
  await sleep(500);
  ws.send(JSON.stringify({ type: "op", op: { kind: "draw", strokeId: "ui1", settings: { brush: "ink", color: "#11212b", size: 4 }, points: [{ x: 20, y: 20 }, { x: 60, y: 60 }], end: true } }));
  await sleep(500);
  ws.close();

  // Mint an invitation for the invite-page checks (token used in URLs only -
  // never printed by this suite).
  const minted = await api(`/api/sketchbooks/${BOOK}/invites`, { method: "POST", token: OWNER_JWT });
  const INVITE_TOKEN = minted.json?.token;
  check("seed: invitation minted", minted.status === 200 && typeof INVITE_TOKEN === "string" && INVITE_TOKEN.length > 8);

  // ---- privacy seeds + API-level contract (no browser needed) -------------
  // Default-private create: the body deliberately OMITS `public`.
  const privCreated = await api("/api/sketchbooks", {
    method: "POST", token: PRIV_JWT, body: { event: "inktober-2026", title: "Priya's Private Pages" },
  });
  const PRIVBOOK = privCreated.json?.book?.id;
  check("create without `public` defaults to PRIVATE server-side",
    privCreated.status === 200 && !!PRIVBOOK && privCreated.json.book.public === false,
    JSON.stringify(privCreated.json?.book).slice(0, 160));
  const privPage = await api(`/api/sketchbooks/${PRIVBOOK}/pages`, { method: "POST", token: PRIV_JWT, body: { day: 2 } });
  const PRIVROOM = privPage.json?.page?.room;
  check("seed: private book has a day-2 page", !!PRIVROOM);
  const privMinted = await api(`/api/sketchbooks/${PRIVBOOK}/invites`, { method: "POST", token: PRIV_JWT });
  const PRIV_INVITE = privMinted.json?.token;
  check("seed: private book invitation minted", typeof PRIV_INVITE === "string" && PRIV_INVITE.length > 8);

  // Strangers get the same 404 as a missing book, reader AND by-room.
  const guestRead = await api(`/api/sketchbooks/${PRIVBOOK}`);
  check("private book reader 404s for a guest", guestRead.status === 404, String(guestRead.status));
  const outsiderRead = await api(`/api/sketchbooks/${PRIVBOOK}`, { token: NEWBIE_JWT });
  check("private book reader 404s for a signed-in non-artist", outsiderRead.status === 404, String(outsiderRead.status));
  const guestByRoom = await api(`/api/sketchbooks/by-room/${PRIVROOM}`);
  check("private page by-room 404s for a guest (no banner leak)", guestByRoom.status === 404, String(guestByRoom.status));
  const ownerByRoom = await api(`/api/sketchbooks/by-room/${PRIVROOM}`, { token: PRIV_JWT });
  check("private page by-room resolves for the owner with public:false",
    ownerByRoom.status === 200 && ownerByRoom.json?.public === false && ownerByRoom.json?.isOwner === true,
    JSON.stringify(ownerByRoom.json).slice(0, 160));
  const gallery = await api(`/api/sketchbooks?event=inktober-2026&limit=60`);
  check("gallery excludes the private book",
    (gallery.json?.books || []).every((b) => b.id !== PRIVBOOK));

  // Visibility endpoint: owner-only, boolean-only.
  const visOutsider = await api(`/api/sketchbooks/${PRIVBOOK}/visibility`, { method: "POST", token: NEWBIE_JWT, body: { public: true } });
  check("visibility change is owner-only", visOutsider.status === 403, String(visOutsider.status));
  const visBad = await api(`/api/sketchbooks/${PRIVBOOK}/visibility`, { method: "POST", token: PRIV_JWT, body: { public: "yes" } });
  check("visibility change rejects non-boolean", visBad.status === 400, String(visBad.status));
  const stillPrivate = await api(`/api/sketchbooks/${PRIVBOOK}`, { token: PRIV_JWT });
  check("failed visibility attempts leave the book private", stillPrivate.json?.book?.public === false);

  // Vite dev server with /api + /ws proxied to the real backend.
  // VITE_WS_URL matters: without it the studio's socket helper redirects any
  // non-8787 page to the PRODUCTION port, so a suite-hosted studio silently
  // talks to the live server instead of this one (same setting the
  // artist-studio suite uses).
  process.env.VITE_PB_URL = PB;
  process.env.VITE_WS_URL = `ws://127.0.0.1:${API_PORT}/ws`;
  vite = await createViteServer({
    root: ROOT,
    logLevel: "silent",
    server: {
      host: "127.0.0.1",
      port: VITE_PORT,
      strictPort: true,
      proxy: {
        "/api": { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true },
        "/ws": { target: `ws://127.0.0.1:${API_PORT}`, ws: true },
      },
    },
  });
  await vite.listen();
  check("vite dev server up", true);
  const BASE = `http://127.0.0.1:${VITE_PORT}`;

  browser = await chromium.launch();
  const authFor = (jwt, id, name, email) => ({
    token: jwt,
    record: { id, name, email },
    model: { id, name, email },
  });
  const ownerAuth = authFor(OWNER_JWT, "book_owner01", "Olive Owner", "olive@example.test");
  const newbieAuth = authFor(NEWBIE_JWT, "book_newbie1", "Nina Newbie", "nina@example.test");
  const quietAuth = authFor(QUIET_JWT, "book_quiet01", "Quinn Quiet", "quinn@example.test");
  const privAuth = authFor(PRIV_JWT, "book_priv_own", "Priya Private", "priya@example.test");
  const artieAuth = authFor(ARTIE_JWT, "book_artie01", "Artie Artist", "artie@example.test");
  // Track create-POSTs hitting the collection endpoint (NOT /accept, /pages,
  // /invites…): the consent contract is about exactly `POST /api/sketchbooks`.
  const trackCreatePosts = (page) => {
    const posts = [];
    page.on("request", (req) => {
      if (req.method() !== "POST") return;
      const { pathname } = new URL(req.url());
      if (pathname !== "/api/sketchbooks") return;
      let body = null;
      try { body = req.postDataJSON(); } catch { /* not json */ }
      posts.push(body);
    });
    return posts;
  };
  // Track owner visibility POSTs (/api/sketchbooks/:id/visibility).
  const trackVisibilityPosts = (page) => {
    const posts = [];
    page.on("request", (req) => {
      if (req.method() !== "POST") return;
      if (!/^\/api\/sketchbooks\/sb_[a-f0-9]{16}\/visibility$/.test(new URL(req.url()).pathname)) return;
      let body = null;
      try { body = req.postDataJSON(); } catch { /* not json */ }
      posts.push(body);
    });
    return posts;
  };
  // Track the UNSAVED (guest) mint calls: `POST /api/sketchbooks/guest`.
  const trackGuestPosts = (page) => {
    const posts = [];
    page.on("request", (req) => {
      if (req.method() !== "POST") return;
      if (new URL(req.url()).pathname !== "/api/sketchbooks/guest") return;
      let body = null;
      try { body = req.postDataJSON(); } catch { /* not json */ }
      posts.push(body);
    });
    return posts;
  };
  const newPage = async ({ auth = null } = {}) => {
    const context = await browser.newContext();
    if (auth) {
      await context.addInitScript((a) => {
        window.localStorage.setItem("pocketbase_auth", JSON.stringify(a));
      }, auth);
    }
    const page = await context.newPage();
    page.on("pageerror", (err) => console.log("  [pageerror]", String(err).slice(0, 200)));
    return page;
  };

  // 1. Guest /sketchbook: STRAIGHT into the drawing experience. No sign-in
  //    wall: the device gets an unsaved public sketchbook page and lands in the
  //    studio, with the save prompt on top. (This is the behaviour that
  //    replaced the old account wall, so the old wall assertions are gone.)
  const guestStart = await newPage();
  const guestPosts = trackGuestPosts(guestStart);
  // Diagnostics: what the page actually asked the server, and with which key.
  const byRoomCalls = [];
  guestStart.on("request", (req) => {
    if (req.url().includes("/api/sketchbooks/by-room/")) byRoomCalls.push({ url: req.url() });
  });
  guestStart.on("response", async (res) => {
    if (!res.url().includes("/api/sketchbooks/by-room/")) return;
    let body = null;
    try { body = await res.json(); } catch { /* none */ }
    byRoomCalls.push({ status: res.status(), body });
  });
  await guestStart.goto(`${BASE}/sketchbook`, { waitUntil: "domcontentloaded" });
  let guestRoom = null;
  try {
    await guestStart.waitForURL((u) => u.pathname.startsWith("/join/"), { timeout: 25000 });
    guestRoom = new URL(guestStart.url()).pathname.split("/")[2];
  } catch { /* stayed on /sketchbook */ }
  check("guest /sketchbook goes straight into the studio (no sign-in wall)", !!guestRoom, guestStart.url());
  check("guest entry mints an UNSAVED sketchbook for this device",
    guestPosts.length >= 1 && typeof guestPosts[0]?.device === "string" && guestPosts[0].device.length >= 6,
    JSON.stringify(guestPosts).slice(0, 200));
  check("no sign-in wall is rendered on the way in",
    !(await guestStart.$("text=Log in to start your sketchbook")));
  const savedRaw = await guestStart.evaluate(() => window.localStorage.getItem("drawesome:guestbook:v1"));
  let savedRec = null;
  try { savedRec = JSON.parse(savedRaw); } catch { /* none */ }
  check("the device keeps the one-time save token for later",
    !!savedRec?.token && String(savedRec.token).startsWith("sbkc_") && !!savedRec?.bookId,
    String(savedRaw).slice(0, 100));
  let stripSeen = true;
  try { await guestStart.waitForSelector(".skb-save-strip", { state: "attached", timeout: 20000 }); }
  catch { stripSeen = false; }
  const stripText = stripSeen ? ((await guestStart.textContent(".skb-save-strip")) || "") : "";
  const diag = {
    url: guestStart.url(),
    banner: !!(await guestStart.$(".skb-banner-wrap")),
    canvasStage: !!(await guestStart.$(".canvas-stage")),
    studioShell: !!(await guestStart.$(".studio-shell")),
    roomBar: (await guestStart.$(".room-bar, .room-bar-line")) ? true : false,
    bodyHead: (await guestStart.evaluate(() => document.body.innerText || "")).slice(0, 200),
    deviceKey: await guestStart.evaluate(() => window.localStorage.getItem("drawesome:userkey:v1")),
    byRoomCalls,
  };
  check("the studio asks the guest to save the sketchbook, and promises no spam",
    stripSeen && /sign up to save your sketchbook/i.test(stripText) && /don.t send spam/i.test(stripText),
    stripSeen ? stripText.slice(0, 200) : JSON.stringify(diag).slice(0, 700));
  const saveBtn = await guestStart.$(".skb-save-strip .skb-save-btn");
  let saveReturn = null;
  if (saveBtn) {
    await saveBtn.click({ force: true }).catch(() => {});
    try { await guestStart.waitForURL((u) => u.pathname === "/signup", { timeout: 10000 }); } catch { /* no nav */ }
    const u = new URL(guestStart.url());
    if (u.pathname === "/signup") saveReturn = decodeURIComponent(u.search);
  }
  check("the save prompt comes back to the SAME page room after sign-up",
    !!saveReturn && saveReturn.includes("return=") && saveReturn.includes(`/join/${guestRoom}`),
    String(saveReturn));

  // 1b. The round trip nothing else covers end to end: the SAME device (same
  //     per-browser key) signs in, and the unsaved book is saved to the
  //     account automatically, without the visitor doing anything else.
  const guestDeviceKey = await guestStart.evaluate(() => window.localStorage.getItem("drawesome:userkey:v1"));
  check("the guest studio used a real device key (the book's binding)",
    typeof guestDeviceKey === "string" && guestDeviceKey.length >= 6, String(guestDeviceKey).slice(0, 40));
  const trackClaimPosts = (page) => {
    const posts = [];
    page.on("request", (req) => {
      if (req.method() !== "POST") return;
      if (new URL(req.url()).pathname !== "/api/sketchbooks/claim") return;
      let body = null;
      try { body = req.postDataJSON(); } catch { /* not json */ }
      posts.push(body);
    });
    return posts;
  };
  const claimPage = await newPage({ auth: authFor(CLAIM_JWT, "book_claim01", "Casey Claim", "casey@example.test") });
  await claimPage.addInitScript((rec) => {
    window.localStorage.setItem("drawesome:userkey:v1", rec.device);
    window.localStorage.setItem("drawesome:guestbook:v1", JSON.stringify({ bookId: rec.bookId, token: rec.token }));
  }, { device: guestDeviceKey, bookId: savedRec.bookId, token: savedRec.token });
  const claims = trackClaimPosts(claimPage);
  await claimPage.goto(`${BASE}/join/${guestRoom}`, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 25 && claims.length === 0; i += 1) await sleep(400);
  check("signing in on the SAME device saves the unsaved sketchbook automatically",
    claims.length >= 1 && claims[0]?.token === savedRec.token, JSON.stringify(claims).slice(0, 160));
  const savedBook = await api(`/api/sketchbooks/${savedRec.bookId}`, { token: CLAIM_JWT });
  check("the book now belongs to the account and is no longer unsaved",
    savedBook.json?.book?.owner === true && savedBook.json?.book?.unsaved === false,
    JSON.stringify(savedBook.json?.book).slice(0, 160));
  const roomAfterClaim = await api(`/api/sketchbooks/by-room/${guestRoom}`, { token: CLAIM_JWT });
  check("the page is an account-owned studio the owner can draw in",
    roomAfterClaim.json?.unsaved === false && roomAfterClaim.json?.isOwner === true
      && roomAfterClaim.json?.canDraw === true,
    JSON.stringify(roomAfterClaim.json).slice(0, 200));
  for (let i = 0; i < 25 && (await claimPage.$(".skb-save-strip")); i += 1) await sleep(400);
  check("the save prompt disappears once the book is saved",
    !(await claimPage.$(".skb-save-strip")));
  check("the spent save record is cleared from the device",
    !(await claimPage.evaluate(() => window.localStorage.getItem("drawesome:guestbook:v1"))));

  // 2. Owner /sketchbook: GET mine auto-resume ONLY, not a single create POST.
  const ownerPage = await newPage({ auth: ownerAuth });
  const ownerPosts = trackCreatePosts(ownerPage);
  await ownerPage.goto(`${BASE}/sketchbook`, { waitUntil: "domcontentloaded" });
  await ownerPage.waitForURL(`**/sketchbook/${BOOK}`, { timeout: 20000 });
  check("owner /sketchbook auto-resumes and lands on the book", true);
  check("owner resume made NO create POST (GET mine only)", ownerPosts.length === 0, `${ownerPosts.length} POST(s)`);
  await ownerPage.waitForSelector(".skb-prompt-chip", { timeout: 15000 });
  const chip = await ownerPage.textContent(".skb-prompt-chip");
  check("reader pins #inktober 2026 + the day's prompt in the top corner",
    chip.includes("#inktober 2026") && chip.includes("Day 5") && chip.includes(PROMPT5), chip);

  // 2b. First-time signed-in user: NO create before an explicit visibility
  // choice; PRIVATE is the default selection, PUBLIC is the disclosed opt-in.
  const newbie = await newPage({ auth: newbieAuth });
  const newbiePosts = trackCreatePosts(newbie);
  await newbie.goto(`${BASE}/sketchbook`, { waitUntil: "domcontentloaded" });
  let choiceShown = true;
  try {
    await newbie.waitForSelector(".skb-visibility-choice", { timeout: 15000 });
  } catch { choiceShown = false; }
  check("first-time signed-in user gets the explicit visibility choice (not auto-create)", choiceShown);
  check("NO create POST before the choice is made", newbiePosts.length === 0, `${newbiePosts.length} POST(s)`);
  if (choiceShown) {
    const choiceText = await (await newbie.$(".skb-consent"))?.textContent() || "";
    check("choice card discloses the PRIVATE default (owner + invited artists only)",
      /private/i.test(choiceText) && /default/i.test(choiceText) && /invited artists/i.test(choiceText), choiceText.slice(0, 200));
    check("choice card discloses the PUBLIC view + automatic gallery listing",
      /anyone with the link/i.test(choiceText) && /gallery/i.test(choiceText) && /automatic/i.test(choiceText), choiceText.slice(0, 240));
    const defaultLabel = await newbie.textContent(".skb-consent .primary-action");
    check("the default selection is PRIVATE",
      /create my private sketchbook/i.test(defaultLabel || ""), defaultLabel);
    // Opt in to PUBLIC deliberately.
    await newbie.click(".skb-visibility-option:nth-child(2)");
    await newbie.click("text=Create my public sketchbook");
    await newbie.waitForURL("**/sketchbook/sb_*", { timeout: 20000 });
    check("public choice creates the book and lands on it", true);
    check("exactly ONE create POST, with the explicit public:true opt-in",
      newbiePosts.length === 1 && newbiePosts[0]?.public === true, JSON.stringify(newbiePosts).slice(0, 200));
    await newbie.waitForSelector("text=Add the first page", { timeout: 15000 });
    check("brand-new book offers the direct first-page drawing flow", true);
    const pubBadge = await newbie.textContent(".skb-badge");
    check("new public book shows the Public badge", /public/i.test(pubBadge || ""), pubBadge);
  }

  // 2b2. The PRIVATE default path: create fires with public:false.
  const quiet = await newPage({ auth: quietAuth });
  const quietPosts = trackCreatePosts(quiet);
  await quiet.goto(`${BASE}/sketchbook`, { waitUntil: "domcontentloaded" });
  await quiet.waitForSelector(".skb-visibility-choice", { timeout: 15000 });
  await quiet.click("text=Create my private sketchbook");
  await quiet.waitForURL("**/sketchbook/sb_*", { timeout: 20000 });
  check("private-default choice creates the book and lands on it", true);
  check("exactly ONE create POST, with the explicit public:false",
    quietPosts.length === 1 && quietPosts[0]?.public === false, JSON.stringify(quietPosts).slice(0, 200));
  await quiet.waitForSelector(".skb-badge", { timeout: 15000 });
  const privBadge = await quiet.textContent(".skb-badge");
  check("new private book shows the Private badge", /private/i.test(privBadge || ""), privBadge);

  // 2c. Invite page: scoped return path through sign-in; token never logged.
  const inviteGuest = await newPage();
  const inviteConsole = [];
  inviteGuest.on("console", (msg) => inviteConsole.push(msg.text()));
  await inviteGuest.goto(`${BASE}/sketchbook/invite/${INVITE_TOKEN}`, { waitUntil: "domcontentloaded" });
  await inviteGuest.waitForSelector("text=Log in to accept", { timeout: 15000 });
  await inviteGuest.click("text=Log in to accept");
  await inviteGuest.waitForURL((u) => u.pathname === "/signup", { timeout: 10000 });
  const inviteLoginUrl = new URL(inviteGuest.url());
  check("invite login link returns to the exact invitation path",
    inviteLoginUrl.searchParams.get("return") === `/sketchbook/invite/${INVITE_TOKEN}`);
  check("invite token is never console-logged",
    !inviteConsole.some((line) => line.includes(INVITE_TOKEN)));

  const inviteGuest2 = await newPage();
  await inviteGuest2.goto(`${BASE}/sketchbook/invite/${INVITE_TOKEN}`, { waitUntil: "domcontentloaded" });
  await inviteGuest2.waitForSelector("text=Sign up free", { timeout: 15000 });
  await inviteGuest2.click("text=Sign up free");
  await inviteGuest2.waitForURL((u) => u.pathname === "/signup", { timeout: 10000 });
  const inviteSignupUrl = new URL(inviteGuest2.url());
  check("invite signup link returns to the exact invitation path",
    inviteSignupUrl.searchParams.get("return") === `/sketchbook/invite/${INVITE_TOKEN}`);

  const inviteAccept = await newPage({ auth: newbieAuth });
  await inviteAccept.goto(`${BASE}/sketchbook/invite/${INVITE_TOKEN}`, { waitUntil: "domcontentloaded" });
  await inviteAccept.waitForSelector("text=Open the sketchbook", { timeout: 20000 });
  check("signed-in invitee still accepts the invitation automatically", true);

  // 2d. Private book denial: the reader fails closed with an honest card.
  const deniedGuest = await newPage();
  await deniedGuest.goto(`${BASE}/sketchbook/${PRIVBOOK}`, { waitUntil: "domcontentloaded" });
  let denialShown = true;
  try {
    await deniedGuest.waitForSelector("text=This sketchbook is private, or isn’t here", { timeout: 15000 });
  } catch { denialShown = false; }
  check("guest on a private book gets the honest private-or-missing card", denialShown);
  if (denialShown) {
    await deniedGuest.click("text=Log in to view this sketchbook");
    await deniedGuest.waitForURL((u) => u.pathname === "/signup", { timeout: 10000 });
    const denialUrl = new URL(deniedGuest.url());
    check("denial card's sign-in returns to the exact book path",
      denialUrl.searchParams.get("mode") === "login"
        && denialUrl.searchParams.get("return") === `/sketchbook/${PRIVBOOK}`, deniedGuest.url());
  }
  const deniedOutsider = await newPage({ auth: quietAuth }); // signed in, not an artist of the private book
  await deniedOutsider.goto(`${BASE}/sketchbook/${PRIVBOOK}`, { waitUntil: "domcontentloaded" });
  let outsiderCopy = true;
  try {
    await deniedOutsider.waitForSelector("text=hasn’t invited you", { timeout: 15000 });
  } catch { outsiderCopy = false; }
  check("signed-in outsider gets the not-invited copy (no fake view)", outsiderCopy);

  // 2e. The invited artist passes: accept the private book's invitation, then
  // the reader opens with the Private badge and NO anonymous spectate canvas
  // (the team views through the book-gated studio instead).
  const artieAccept = await newPage({ auth: artieAuth });
  await artieAccept.goto(`${BASE}/sketchbook/invite/${PRIV_INVITE}`, { waitUntil: "domcontentloaded" });
  await artieAccept.waitForSelector("text=Open the sketchbook", { timeout: 20000 });
  check("invited artist accepts the private book's invitation", true);
  check("private invite done-copy says the book is private",
    !!(await artieAccept.$("text=private sketchbook")));
  await artieAccept.click("text=Open the sketchbook");
  await artieAccept.waitForURL(`**/sketchbook/${PRIVBOOK}`, { timeout: 10000 });
  await artieAccept.waitForSelector(".skb-badge", { timeout: 15000 });
  const artieBadge = await artieAccept.textContent(".skb-badge");
  check("invited artist reads the private book with the Private badge", /private/i.test(artieBadge || ""), artieBadge);
  const artieCanvas = await artieAccept.locator(".skb-reader-canvas canvas").count();
  check("private reader mounts NO anonymous spectate canvas", artieCanvas === 0, String(artieCanvas));
  check("private reader routes the team to the page studio",
    !!(await artieAccept.$("text=Open the page studio to view & draw →")));
  check("private reader hides the public Watch-live route", !(await artieAccept.$("text=Watch live")));

  // 2f. Owner visibility toggle: PUBLIC needs the explicit confirm, a
  // dismissed confirm must not POST; an accepted one POSTs { public: true }
  // exactly once and the badge flips.
  const privOwner = await newPage({ auth: privAuth });
  const visPosts = trackVisibilityPosts(privOwner);
  let confirmSeen = 0;
  privOwner.on("dialog", async (dialog) => {
    confirmSeen += 1;
    if (confirmSeen === 1) await dialog.dismiss(); // first attempt: owner backs out
    else await dialog.accept();
  });
  await privOwner.goto(`${BASE}/sketchbook/${PRIVBOOK}`, { waitUntil: "domcontentloaded" });
  await privOwner.waitForSelector(".skb-badge", { timeout: 15000 });
  await privOwner.click("text=Make public…");
  await sleep(400);
  check("going public asks an explicit confirm first", confirmSeen === 1, String(confirmSeen));
  check("dismissing the public confirm makes NO visibility POST", visPosts.length === 0, JSON.stringify(visPosts));
  await privOwner.click("text=Make public…");
  await privOwner.waitForFunction(
    () => /public/i.test(document.querySelector(".skb-badge")?.textContent || ""),
    null, { timeout: 10000 },
  );
  check("accepting the confirm flips the badge to Public", true);
  check("exactly ONE visibility POST, with public:true",
    visPosts.length === 1 && visPosts[0]?.public === true, JSON.stringify(visPosts));
  const guestNowReads = await api(`/api/sketchbooks/${PRIVBOOK}`);
  check("book is publicly readable after the toggle", guestNowReads.status === 200, String(guestNowReads.status));
  // The immediate private downgrade: no confirm, one POST, badge flips back.
  await privOwner.click("text=Make private");
  await privOwner.waitForFunction(
    () => /private/i.test(document.querySelector(".skb-badge")?.textContent || ""),
    null, { timeout: 10000 },
  );
  check("private downgrade is immediate (no confirm) and flips the badge", confirmSeen === 2);
  check("downgrade POSTed public:false once",
    visPosts.length === 2 && visPosts[1]?.public === false, JSON.stringify(visPosts));
  const guestLockedAgain = await api(`/api/sketchbooks/${PRIVBOOK}`);
  check("book 404s for guests again after the downgrade", guestLockedAgain.status === 404, String(guestLockedAgain.status));
  // Restore public for any later discovery checks (via the API; UI already proven).
  await api(`/api/sketchbooks/${PRIVBOOK}/visibility`, { method: "POST", token: PRIV_JWT, body: { public: true } });

  // 3. Guest reader: flip pages; only the selected page's canvas mounts.
  const reader = await newPage();
  await reader.goto(`${BASE}/sketchbook/${BOOK}`, { waitUntil: "domcontentloaded" });
  await reader.waitForSelector(".skb-prompt-chip", { timeout: 15000 });
  const guestChip = await reader.textContent(".skb-prompt-chip");
  check("guest sees the same pinned prompt chip", guestChip.includes("Day 5") && guestChip.includes(PROMPT5), guestChip);
  check("start-your-own CTA is offered to visitors", !!(await reader.waitForSelector("text=Start your own sketchbook →", { timeout: 8000 })));
  await reader.click("text=‹ Previous page");
  await reader.waitForFunction((prompt) => document.querySelector(".skb-prompt-chip")?.textContent?.includes(prompt), PROMPT1, { timeout: 8000 });
  check("flip to the previous page swaps the pinned prompt", true);
  const canvasCount = await reader.locator(".skb-reader-canvas canvas").count();
  check("only the selected page mounts a canvas", canvasCount <= 1, String(canvasCount));
  const dayButtons = await reader.locator(".skb-days button").count();
  check("day strip lists the book's pages", dayButtons === 2, String(dayButtons));

  // 4. Homepage: hero card CTA -> own sketchbook; shared room link preserved; strip lists the book.
  const home = await newPage();
  await home.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await home.waitForSelector(".home-paper-ink", { timeout: 20000 });
  await home.click(".home-paper-ink");
  let homeRoom = null;
  try {
    await home.waitForURL((u) => u.pathname.startsWith("/join/"), { timeout: 25000 });
    homeRoom = new URL(home.url()).pathname.split("/")[2];
  } catch { /* stayed on the homepage */ }
  check("homepage Inktober hero card drops the visitor straight into an unsaved sketchbook page",
    !!homeRoom, home.url());
  let homeStrip = true;
  try { await home.waitForSelector(".skb-save-strip", { state: "attached", timeout: 20000 }); }
  catch { homeStrip = false; }
  check("the homepage entry carries the save prompt", homeStrip);
  await home.goBack();
  await home.waitForSelector(".home-inktober-shared-link", { timeout: 10000 });
  check("shared public INKTOBER room link remains on the homepage", true);
  await home.waitForSelector("text=New Inktober sketchbooks", { timeout: 15000 });
  const stripCard = await home.textContent(".home-prompt-wall[data-kind='inktober-sketchbooks'] .skb-card");
  check("homepage strip discovers the seeded sketchbook",
    stripCard.includes("Olive's Inks") && stripCard.includes("Day 5"), stripCard);

  // 5. /inktober: own-sketchbook CTA + sketchbooks section.
  const inkPage = await newPage();
  await inkPage.goto(`${BASE}/inktober`, { waitUntil: "domcontentloaded" });
  await inkPage.waitForSelector("text=Inktober sketchbooks", { timeout: 20000 });
  check("Inktober page has the sketchbooks section", true);
  check("Inktober page hero CTA starts an own sketchbook",
    !!(await inkPage.$("text=Draw today’s page in your sketchbook →")));
  check("Inktober page keeps the shared-room secondary route",
    !!(await inkPage.$("text=or draw together in the shared Ink & Pencil room →")));
  const inkCard = await inkPage.textContent(".ink-studios .skb-card");
  check("Inktober page lists the seeded sketchbook", inkCard.includes("Olive's Inks"), inkCard);
  await inkPage.click(".ink-studios .skb-card");
  await inkPage.waitForURL(`**/sketchbook/${BOOK}`, { timeout: 10000 });
  check("sketchbook card navigates to the reader", true);

  // 5b. The exact path the owner asked for: tapping the PROMPT on /inktober as
  //     a guest goes into the drawing experience on a public unsaved page, not
  //     through an entry page or a sign-in wall.
  const promptTap = await newPage();
  await promptTap.goto(`${BASE}/inktober`, { waitUntil: "domcontentloaded" });
  await promptTap.waitForSelector("text=Draw today’s page in your sketchbook →", { timeout: 20000 });
  await promptTap.click("text=Draw today’s page in your sketchbook →");
  let promptRoom = null;
  try {
    await promptTap.waitForURL((u) => u.pathname.startsWith("/join/"), { timeout: 25000 });
    promptRoom = new URL(promptTap.url()).pathname.split("/")[2];
  } catch { /* stayed */ }
  check("the Inktober prompt CTA opens the drawing experience directly", !!promptRoom, promptTap.url());
  let promptStrip = true;
  try { await promptTap.waitForSelector(".skb-save-strip", { state: "attached", timeout: 20000 }); }
  catch { promptStrip = false; }
  const promptStripText = promptStrip ? ((await promptTap.textContent(".skb-save-strip")) || "") : "";
  check("that page asks the guest to save the sketchbook (and promises no spam)",
    promptStrip && /sign up to save your sketchbook/i.test(promptStripText) && /don.t send spam/i.test(promptStripText),
    promptStripText.slice(0, 200));
  await promptTap.waitForSelector(".skb-prompt-chip", { state: "attached", timeout: 20000 });
  const promptChip = (await promptTap.textContent(".skb-prompt-chip")) || "";
  check("the page keeps the pinned Inktober prompt chip",
    promptChip.includes("#inktober") && promptChip.includes("Day"), promptChip.slice(0, 160));

  // 6. PublicWatch links a page room back to its book.
  const watch = await newPage();
  await watch.goto(`${BASE}/live/${ROOM5}`, { waitUntil: "domcontentloaded" });
  await watch.waitForSelector("text=Flip through the whole book →", { timeout: 20000 });
  check("/live/<page room> links back to the sketchbook", true);
};

run()
  .catch((err) => {
    console.error("suite error:", err);
    results.push({ name: "suite completed", ok: false });
  })
  .finally(async () => {
    try { await browser?.close(); } catch { /* gone */ }
    try { await vite?.close(); } catch { /* gone */ }
    try { server.kill("SIGTERM"); } catch { /* gone */ }
    await sleep(400);
    try { server.kill("SIGKILL"); } catch { /* gone */ }
    mock.close();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ""}`);
    if (failed.length) {
      console.log("server log tail:\n" + serverLog.join("").slice(-1000));
      process.exit(1);
    }
  });
