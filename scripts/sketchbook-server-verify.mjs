// Inktober sketchbook backend verification (docs/SKETCHBOOKS-CONTRACT.md).
//
// Strictly isolated: throwaway DATA_DIR under ~/.hermes/cache/scratch, mock
// PocketBase (the only endpoint server.js calls for identity), ports
// 9003 (main) / 9004 (fail-closed, no PB) / 9005 (restart leg).
// Never touches 8787 or production app_data.
//
// Covers, with real WS clients for every role:
//   create fail-closed (unconfigured => accounts_required); visibility
//     DEFAULTS PRIVATE when `public` is omitted; resume never changes it;
//     explicit public:true creates public; the owner-only visibility
//     endpoint validates + persists + sweeps sessions on downgrade
//   pages: server-stamped immutable day/prompt/date from the verified list,
//     invalid days rejected, duplicate days resume, 31 cap, racing adds,
//     page rooms are artist_public + inktober-opted + NOT in the room gallery
//   direct room endpoints: publish/unpublish on a page room refused
//     (book_managed); painters/revoke routes through the WHOLE book
//   ACL: guests watch PUBLIC books but every mutation denied; stranger
//     denied; owner draws; page rooms are DISTINCT canvases (art on one
//     never leaks to another); ink-only enforcement active in October
//   page rooms are canvas-only: chat/chat_react rejected (book_page),
//     animation can never be enabled; ordinary rooms unaffected
//   invites: token returned once, only the hash on disk (token never in any
//     response/file); acceptance resolves the authenticated account; the
//     6-DISTINCT-ACCOUNT cap holds incl. direct WS paint_approve bypass
//     attempts; invite revoke blocks future redemption; artist revoke hits
//     EVERY tab on EVERY page + persists across restart
//   rollover: a page's day/prompt survive the UTC-midnight flip untouched
//   gallery: public + real-drawing eligibility, pagination with honest
//     total, moderation-hidden books/pages excluded, admin restore
//   moderation-hidden books: reader/by-room 404 for non-owners, spectator +
//     member joins refused (moderation_hidden), owner/team keep managing
//   PRIVATE books: reader/by-room 404 for non-team, spectator refused
//     BEFORE materialization, member joins refused (book_private), never
//     gallery-listed even with drawing, cannot be wall-posted; public flip
//     reopens everything; downgrade closes every unauthorized tab/spectator
//   privacy: public view carries no account ids / invite material
//   restart persistence of books, pages, ACLs, visibility
//   lifecycle: page rooms NEVER idle-expire (plain studios do); a missing
//     page file rematerializes from the book (no squatting/takeover);
//     missing BOOK record => WS paint approve/revoke fail CLOSED
//     (book_missing, grants untouched); admin room delete drops the book's
//     page reference safely
import { spawn } from "child_process";
import http from "http";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, copyFileSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRATCH = path.join(process.env.TMPDIR || "/tmp", "sketchbook-verify-data");
const CLOCK_FILE = path.join(SCRATCH, "inktober-clock.txt");
const PORT = 9003;
const PORT_NOPB = 9004;
const PORT_RESTART = 9005;

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
const setClock = (iso) => writeFileSync(CLOCK_FILE, iso);
setClock("2026-10-05T12:00:00.000Z"); // active event, day 5

// A stub dist/ so the SPA fallback exists without building the app.
const distDir = path.join(ROOT, "dist");
const madeStubDist = !existsSync(path.join(distDir, "index.html"));
if (madeStubDist) {
  mkdirSync(distDir, { recursive: true });
  copyFileSync(path.join(ROOT, "index.html"), path.join(distDir, "index.html"));
}

// ---- mock PocketBase -------------------------------------------------------
const TOKENS = {
  owner_token: { id: "book_owner01", name: "Olive Owner" },
  artist1_token: { id: "book_artist1", name: "Amy Artist" },
  artist2_token: { id: "book_artist2", name: "Bo Brush" },
  artist3_token: { id: "book_artist3", name: "Cy Color" },
  artist4_token: { id: "book_artist4", name: "Dee Draw" },
  artist5_token: { id: "book_artist5", name: "Eli Easel" },
  artist6_token: { id: "book_artist6", name: "Fay Frame" },
  stranger_token: { id: "book_stranger", name: "Sam Stranger" },
};
const mock = http.createServer((req, res) => {
  if (req.url === "/api/collections/users/auth-refresh" && req.method === "POST") {
    const raw = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const rec = TOKENS[raw];
    if (rec) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ record: rec }));
      return;
    }
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
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? " — " + String(detail).slice(0, 260) : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
const serverLog = [];
function boot(port, extraEnv = {}) {
  const proc = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: SCRATCH,
      PB_URL: PB,
      INKTOBER_CLOCK_FILE: CLOCK_FILE,
      INKTOBER_TICK_MS: "150",
      AUTO_CLOSE_SWEEP_MS: "700",
      AUTO_CLOSE_BASE_MS: "1000",
      AUTO_CLOSE_OWNED_BASE_MS: "1000",
      ...extraEnv,
    },
    stdio: "pipe",
  });
  proc.stderr.on("data", (d) => { serverLog.push(String(d)); if (serverLog.length > 40) serverLog.shift(); });
  return proc;
}
async function waitHealthy(port) {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) return true; } catch { /* boot */ }
    await sleep(250);
  }
  return false;
}
async function killServer(proc) {
  if (!proc) return;
  try { proc.kill("SIGTERM"); } catch { /* gone */ }
  await sleep(500);
  try { proc.kill("SIGKILL"); } catch { /* gone */ }
}

const clients = [];
async function connect(room, { token = null, spectate = false, port = PORT } = {}) {
  const qs = spectate ? `room=${room}&spectate=1` : `room=${room}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${qs}`);
  const c = { ws, msgs: [], room };
  ws.on("message", (raw) => { try { c.msgs.push(JSON.parse(raw.toString())); } catch { /* binary/gz */ } });
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
  if (!spectate) ws.send(JSON.stringify({ type: "auth", token, userKey: `dk_${Math.random().toString(36).slice(2, 12)}` }));
  await sleep(400); // join + history (raw clients shake hands first)
  clients.push(c);
  return c;
}
const lastOf = (c, type) => [...c.msgs].reverse().find((m) => m.type === type);
async function waitFor(c, pred, ms = 3000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const hit = c.msgs.find(pred);
    if (hit) return hit;
    await sleep(60);
  }
  return null;
}
async function api(pathname, { method = "GET", token = null, body = null, adminKey = null, port = PORT } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (adminKey) headers["x-admin-key"] = adminKey;
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method, headers, body: body == null ? null : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}
const roomFileJson = (code) => JSON.parse(readFileSync(path.join(SCRATCH, ".rooms", `${code}.json`), "utf8"));
// Room meta persistence is write-behind (~2.5s schedule) — poll for the file.
async function waitRoomFileJson(code, ms = 8000) {
  const start = Date.now();
  for (;;) {
    try { return roomFileJson(code); } catch { /* not flushed yet */ }
    if (Date.now() - start > ms) throw new Error(`room file for ${code} never appeared`);
    await sleep(300);
  }
}

let strokeSeq = 0;
const sendDraw = (c, settings, end = true) => {
  strokeSeq += 1;
  c.ws.send(JSON.stringify({ type: "op", op: { kind: "draw", strokeId: `st${strokeSeq}`, settings, points: [{ x: 5, y: 5 }, { x: 15, y: 15 }], end } }));
  return `st${strokeSeq}`;
};
const gotStroke = (c, strokeId, ms = 900) => waitFor(c, (m) => m.type === "op" && m.op && m.op.strokeId === strokeId, ms);
const INK = { brush: "ink", color: "#11212b", size: 4 };
const WATERCOLOR = { brush: "watercolor", color: "#11212b", size: 8 };
// Smallest valid raster for wall-post probes (magic-byte checked server-side).
const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const run = async () => {
  // ==========================================================================
  // 0. FAIL CLOSED when accounts are unconfigured
  // ==========================================================================
  const noPb = boot(PORT_NOPB, { PB_URL: "", POCKETBASE_URL: "" });
  check("unconfigured server boots", await waitHealthy(PORT_NOPB));
  const noPbCreate = await api("/api/sketchbooks", { method: "POST", body: { public: true }, port: PORT_NOPB });
  check("unconfigured: sketchbook creation fails closed with accounts_required",
    noPbCreate.status === 401 && noPbCreate.json?.error === "accounts_required", JSON.stringify(noPbCreate));
  await killServer(noPb);

  // ==========================================================================
  // 1. Boot the real server + create/resume semantics
  // ==========================================================================
  server = boot(PORT);
  check("server boots", await waitHealthy(PORT), serverLog.join("").slice(-300));

  const guestCreate = await api("/api/sketchbooks", { method: "POST", body: { public: true } });
  check("guest create -> accounts_required", guestCreate.status === 401, JSON.stringify(guestCreate));

  // Visibility is EXPLICIT and defaults to PRIVATE (the safe end). Omitting
  // `public` creates a private book; resume NEVER changes visibility.
  const created = await api("/api/sketchbooks", {
    method: "POST", token: "owner_token",
    body: { event: "inktober-2026", title: "Olive's Inks" }, // no public flag
  });
  check("create without `public` succeeds as a PRIVATE book (safe default)",
    created.status === 200 && created.json?.resumed === false && created.json?.book?.public === false
    && /^sb_[0-9a-f]{16}$/.test(created.json?.book?.id || ""), JSON.stringify(created));
  const BOOK = created.json?.book?.id;
  check("new book: owner is the only artist, no pages, public view hides nothing yet",
    created.json?.book?.artistCount === 1 && created.json?.book?.pageCount === 0 && Array.isArray(created.json?.book?.artists));

  const resumed = await api("/api/sketchbooks", { method: "POST", token: "owner_token", body: { public: true } });
  check("resume returns the SAME book and NEVER changes its visibility",
    resumed.status === 200 && resumed.json?.resumed === true && resumed.json?.book?.id === BOOK
    && resumed.json?.book?.public === false, JSON.stringify(resumed));

  // The owner flips it public through the dedicated endpoint (pinned shape).
  const madePublic = await api(`/api/sketchbooks/${BOOK}/visibility`, { method: "POST", token: "owner_token", body: { public: true } });
  check("owner sets the book public (owner view returns public:true)",
    madePublic.status === 200 && madePublic.json?.book?.public === true && madePublic.json?.book?.owner === true,
    JSON.stringify(madePublic));
  const badVisibility = await api(`/api/sketchbooks/${BOOK}/visibility`, { method: "POST", token: "owner_token", body: { public: "yes" } });
  check("visibility endpoint rejects a non-boolean body", badVisibility.status === 400 && badVisibility.json?.error === "bad_visibility");
  const strangerVisibility = await api(`/api/sketchbooks/${BOOK}/visibility`, { method: "POST", token: "stranger_token", body: { public: false } });
  check("non-owner cannot change visibility", strangerVisibility.status === 403, JSON.stringify(strangerVisibility));

  // Racing creates still mint exactly one book.
  const race = await Promise.all([1, 2, 3, 4].map(() =>
    api("/api/sketchbooks", { method: "POST", token: "artist1_token", body: { public: true } })));
  const raceIds = new Set(race.map((r) => r.json?.book?.id));
  check("racing creates mint exactly one book per owner+event", race.every((r) => r.status === 200) && raceIds.size === 1,
    JSON.stringify(race.map((r) => [r.status, r.json?.book?.id, r.json?.resumed])));
  check("explicit public:true at first create makes a PUBLIC book", race[0].json?.book?.public === true);

  const badEvent = await api("/api/sketchbooks", { method: "POST", token: "stranger_token", body: { event: "inktober-1999", public: true } });
  check("unknown event rejected", badEvent.status === 400 && badEvent.json?.error === "bad_event", JSON.stringify(badEvent));

  // ==========================================================================
  // 2. Pages: server-stamped prompt metadata, validation, caps, races
  // ==========================================================================
  // The prompt is the SERVER's truth for the faked clock day — never hardcoded.
  const inkDay5 = await api("/api/inktober");
  const DAY5_PROMPT = inkDay5.json?.prompt;
  check("event is active on day 5 under the test clock", inkDay5.json?.phase === "active" && inkDay5.json?.day === 5 && !!DAY5_PROMPT,
    JSON.stringify({ phase: inkDay5.json?.phase, day: inkDay5.json?.day, prompt: DAY5_PROMPT }));
  const pageToday = await api(`/api/sketchbooks/${BOOK}/pages`, { method: "POST", token: "owner_token", body: {} });
  check("page add with no day picks TODAY server-side (day 5)",
    pageToday.status === 200 && pageToday.json?.page?.day === 5 && pageToday.json?.page?.prompt === DAY5_PROMPT,
    JSON.stringify(pageToday));
  const PAGE5 = pageToday.json?.page?.room;
  check("page room minted by server", /^[A-Z0-9]{6}$/.test(PAGE5 || ""), PAGE5);

  const page1 = await api(`/api/sketchbooks/${BOOK}/pages`, { method: "POST", token: "owner_token", body: { day: 1 } });
  check("explicit valid day accepted (day 1)",
    page1.status === 200 && page1.json?.page?.day === 1 && typeof page1.json?.page?.prompt === "string" && page1.json.page.prompt.length > 0,
    JSON.stringify(page1));
  const PAGE1 = page1.json?.page?.room;

  for (const [day, label] of [[99, "99"], [0, "0"], [-3, "-3"], ["five", "five"], [5.5, "5.5"]]) {
    const bad = await api(`/api/sketchbooks/${BOOK}/pages`, { method: "POST", token: "owner_token", body: { day } });
    check(`invalid day ${label} rejected`, bad.status === 400 && bad.json?.error === "bad_day", JSON.stringify(bad));
  }

  const dupDay = await api(`/api/sketchbooks/${BOOK}/pages`, { method: "POST", token: "owner_token", body: { day: 5 } });
  check("duplicate day resumes the existing page (no second room)",
    dupDay.status === 200 && dupDay.json?.resumed === true && dupDay.json?.page?.room === PAGE5, JSON.stringify(dupDay));

  const pageRace = await Promise.all([1, 2, 3].map(() =>
    api(`/api/sketchbooks/${BOOK}/pages`, { method: "POST", token: "owner_token", body: { day: 7 } })));
  const pageRooms = new Set(pageRace.map((r) => r.json?.page?.room));
  check("racing page adds for one day mint exactly one room",
    pageRace.every((r) => r.status === 200) && pageRooms.size === 1, JSON.stringify(pageRace.map((r) => r.json?.page?.room)));

  const notOwner = await api(`/api/sketchbooks/${BOOK}/pages`, { method: "POST", token: "stranger_token", body: { day: 2 } });
  check("non-owner cannot add pages", notOwner.status === 403 && notOwner.json?.error === "not_owner", JSON.stringify(notOwner));

  // Fill to the 31 cap (28 more: days 2..31 minus existing 1,5,7 = 26, then cap check).
  for (let d = 2; d <= 31; d += 1) {
    if (d === 5 || d === 7) continue; // already exist
    // eslint-disable-next-line no-await-in-loop
    const r = await api(`/api/sketchbooks/${BOOK}/pages`, { method: "POST", token: "owner_token", body: { day: d } });
    if (r.status !== 200) { check(`page day ${d} added`, false, JSON.stringify(r)); break; }
  }
  const fullBook = await api(`/api/sketchbooks/${BOOK}`, { token: "owner_token" });
  check("book holds all 31 prompt pages", fullBook.json?.book?.pageCount === 31, String(fullBook.json?.book?.pageCount));
  // Every day was used; the cap error surfaces when trying ANY further page.
  const overCap = await api(`/api/sketchbooks/${BOOK}/pages`, { method: "POST", token: "owner_token", body: { day: 5 } });
  check("31st+ page impossible (duplicate resumes instead of overflowing)",
    overCap.status === 200 && overCap.json?.resumed === true, JSON.stringify(overCap));

  // Page room shape on disk: artist_public, inktober, book back-reference.
  const meta5 = await waitRoomFileJson(PAGE5);
  check("page room persists audience artist_public + inktober + book ref with immutable day/prompt",
    meta5.audience === "artist_public" && meta5.inktober === true
    && meta5.sketchbook?.book === BOOK && meta5.sketchbook?.day === 5 && meta5.sketchbook?.prompt === DAY5_PROMPT,
    JSON.stringify(meta5.sketchbook));
  check("page rooms never list in the artist room gallery", meta5.gallery?.listed !== true);

  // Direct room publish/unpublish must refuse book-managed pages loudly —
  // listing + the Inktober flag belong to the BOOK (409 book_managed).
  const pagePublish = await api(`/api/rooms/${PAGE5}/publish`, {
    method: "POST", token: "owner_token", body: { inktober: false, description: "hijack", tags: ["x"] },
  });
  check("direct publish on a page room refused (book_managed)",
    pagePublish.status === 409 && pagePublish.json?.error === "book_managed", JSON.stringify(pagePublish));
  const pageUnpublish = await api(`/api/rooms/${PAGE5}/unpublish`, { method: "POST", token: "owner_token" });
  check("direct unpublish on a page room refused (book_managed)",
    pageUnpublish.status === 409 && pageUnpublish.json?.error === "book_managed", JSON.stringify(pageUnpublish));
  const metaAfterRefusal = await waitRoomFileJson(PAGE5);
  check("refused publish changed nothing (still inktober, still unlisted)",
    metaAfterRefusal.inktober === true && metaAfterRefusal.gallery?.listed !== true,
    JSON.stringify({ inktober: metaAfterRefusal.inktober, listed: metaAfterRefusal.gallery?.listed }));

  const roomGallery = await api("/api/rooms/gallery?event=inktober-2026&limit=60");
  const galleryCodes = (roomGallery.json?.rooms || []).map((r) => r.code);
  check("room gallery contains no sketchbook page rooms",
    !galleryCodes.includes(PAGE5) && !galleryCodes.includes(PAGE1), galleryCodes.join(","));

  // ==========================================================================
  // 3. Roles on a page room: guest/stranger/owner + distinct canvases + ink
  // ==========================================================================
  const guestSpec = await connect(PAGE5, { spectate: true });
  check("guest spectator watches a page room (canPaint false, gets history)",
    lastOf(guestSpec, "connected")?.spectator === true && lastOf(guestSpec, "connected")?.canPaint === false
    && !!lastOf(guestSpec, "history"),
    JSON.stringify(lastOf(guestSpec, "connected")?.type));

  const guestMember = await connect(PAGE5, {});
  check("guest member canPaint:false on a page room", lastOf(guestMember, "connected")?.canPaint === false);
  const guestStroke = sendDraw(guestMember, INK);
  check("guest draw op on a page room is denied", !(await gotStroke(guestSpec, guestStroke, 700)));

  const stranger = await connect(PAGE5, { token: "stranger_token" });
  check("verified stranger (not a book artist) canPaint:false", lastOf(stranger, "connected")?.canPaint === false);
  const strangerStroke = sendDraw(stranger, INK);
  check("stranger draw op denied", !(await gotStroke(guestSpec, strangerStroke, 700)));

  const owner = await connect(PAGE5, { token: "owner_token" });
  check("owner canPaint:true on their page room", lastOf(owner, "connected")?.canPaint === true);

  const wcStroke = sendDraw(owner, WATERCOLOR);
  check("ink enforcement: watercolor refused on an Inktober page room", !(await gotStroke(guestSpec, wcStroke, 700)));
  const inkStroke = sendDraw(owner, INK);
  check("owner ink stroke lands for watchers", !!(await gotStroke(guestSpec, inkStroke)));

  // Pages are DISTINCT canvases: ink on page 5 never appears on page 1.
  const page1Spec = await connect(PAGE1, { spectate: true });
  const inkStroke2 = sendDraw(owner, INK);
  check("page canvases are distinct (page-5 ink never reaches page 1)",
    !!(await gotStroke(guestSpec, inkStroke2)) && !(await gotStroke(page1Spec, inkStroke2, 700)));
  const page1Stroke = sendDraw(owner, INK); // owner is still in PAGE5 socket; draw there
  void page1Stroke;

  // Draw directly on page 1 with a fresh owner socket.
  const ownerP1 = await connect(PAGE1, { token: "owner_token" });
  const p1Stroke = sendDraw(ownerP1, INK);
  check("owner draws on page 1 too (distinct saved artwork per page)", !!(await gotStroke(page1Spec, p1Stroke)));

  // Page rooms are canvas-only: chat + tapbacks rejected, animation refused.
  owner.ws.send(JSON.stringify({ type: "chat", message: "hello page" }));
  check("chat on a page room is rejected (chat_blocked book_page)",
    !!(await waitFor(owner, (m) => m.type === "chat_blocked" && m.reason === "book_page")));
  check("no chat broadcast reaches other page watchers", !guestMember.msgs.some((m) => m.type === "chat"));
  owner.ws.send(JSON.stringify({ type: "chat_react", msgId: 1, emoji: "❤️" }));
  owner.ws.send(JSON.stringify({ type: "set_animation", enabled: true }));
  owner.ws.send(JSON.stringify({ type: "frame_add" }));
  await sleep(300);
  check("chat_react on a page room is a no-op", !guestMember.msgs.some((m) => m.type === "chat_react"));
  check("animation cannot be enabled/mutated on a page room (no room_animation/frame_add)",
    !owner.msgs.some((m) => m.type === "room_animation" || m.type === "frame_add"));

  // Ordinary rooms are UNAFFECTED: chat + animation still work elsewhere.
  const mainA = await connect("MAIN", {});
  const mainB = await connect("MAIN", {});
  mainA.ws.send(JSON.stringify({ type: "chat", message: "hello main" }));
  check("chat still works in an ordinary public room",
    !!(await waitFor(mainB, (m) => m.type === "chat" && m.message === "hello main")));
  try { mainA.ws.close(); } catch { /* gone */ }
  try { mainB.ws.close(); } catch { /* gone */ }
  const animRoom = await connect("ANIMCHK", { token: "artist3_token" });
  animRoom.ws.send(JSON.stringify({ type: "set_animation", enabled: true }));
  check("set_animation still works in an ordinary private room",
    !!(await waitFor(animRoom, (m) => m.type === "room_animation" && m.enabled === true)));
  try { animRoom.ws.close(); } catch { /* gone */ }

  // ==========================================================================
  // 4. Invites: hashed on disk, acceptance, cap, revocation
  // ==========================================================================
  const invite = await api(`/api/sketchbooks/${BOOK}/invites`, { method: "POST", token: "owner_token" });
  check("owner mints an invite (token + url returned once)",
    invite.status === 200 && /^sbk_/.test(invite.json?.token || "") && invite.json?.url?.includes(invite.json?.token),
    JSON.stringify(invite));
  const TOKEN1 = invite.json?.token;
  const INVITE1 = invite.json?.inviteId;

  const bookDir = path.join(SCRATCH, ".sketchbooks");
  const bookFileRaw = readFileSync(path.join(bookDir, `${BOOK}.json`), "utf8");
  check("invite token NEVER touches disk (only its hash)", !bookFileRaw.includes(TOKEN1) && bookFileRaw.includes('"hash":"'));

  const inviteStranger = await api(`/api/sketchbooks/${BOOK}/invites`, { method: "POST", token: "stranger_token" });
  check("non-owner cannot mint invites", inviteStranger.status === 403, JSON.stringify(inviteStranger));

  const acceptGuest = await api("/api/sketchbooks/accept", { method: "POST", body: { token: TOKEN1 } });
  check("guest acceptance -> accounts_required", acceptGuest.status === 401, JSON.stringify(acceptGuest));

  const accept1 = await api("/api/sketchbooks/accept", { method: "POST", token: "artist1_token", body: { token: TOKEN1 } });
  check("artist1 accepts the invite", accept1.status === 200 && accept1.json?.joined === true && accept1.json?.bookId === BOOK,
    JSON.stringify(accept1));
  check("acceptance response carries NO token/invite material",
    !JSON.stringify(accept1.json).includes(TOKEN1) && accept1.json?.book?.invites === undefined);

  const acceptAgain = await api("/api/sketchbooks/accept", { method: "POST", token: "artist1_token", body: { token: TOKEN1 } });
  check("re-acceptance is idempotent (already an artist, no duplicate)",
    acceptAgain.status === 200 && acceptAgain.json?.joined === false && acceptAgain.json?.book?.artistCount === 2,
    JSON.stringify(acceptAgain));

  // artist1 can now paint on EVERY page (live role flip + persisted ACL).
  const a1p5 = await connect(PAGE5, { token: "artist1_token" });
  check("invited artist canPaint:true on page 5", lastOf(a1p5, "connected")?.canPaint === true);
  const a1p1 = await connect(PAGE1, { token: "artist1_token" });
  check("invited artist canPaint:true on page 1 (book-wide grant)", lastOf(a1p1, "connected")?.canPaint === true);
  const a1Stroke = sendDraw(a1p5, INK);
  check("invited artist's ink lands", !!(await gotStroke(guestSpec, a1Stroke)));

  // The direct WS paint_request -> paint_approve path on a page room routes
  // through the BOOK: approval lands on every page.
  const requester = await connect(PAGE1, { token: "artist2_token" });
  requester.ws.send(JSON.stringify({ type: "paint_request" }));
  check("stranger's paint_request reaches the owner",
    !!(await waitFor(ownerP1, (m) => m.type === "paint_requests" && m.requests.some((r) => r.userId === lastOf(requester, "connected")?.userId))));
  ownerP1.ws.send(JSON.stringify({ type: "paint_approve", targetId: lastOf(requester, "connected")?.userId }));
  check("WS paint_approve on a page room grants via the BOOK (approved frame)",
    !!(await waitFor(requester, (m) => m.type === "paint_requested" && m.status === "approved")));
  check("WS-approved artist canPaint on the OTHER page too",
    lastOf(await connect(PAGE5, { token: "artist2_token" }), "connected")?.canPaint === true);

  // Fill the book to the 6-account cap (owner + 5).
  for (const t of ["artist3_token", "artist4_token", "artist5_token"]) {
    const inv = await api(`/api/sketchbooks/${BOOK}/invites`, { method: "POST", token: "owner_token" }); // eslint-disable-line no-await-in-loop
    const acc = await api("/api/sketchbooks/accept", { method: "POST", token: t, body: { token: inv.json?.token } }); // eslint-disable-line no-await-in-loop
    if (acc.status !== 200) check(`fill cap with ${t}`, false, JSON.stringify(acc));
  }
  const atCap = await api(`/api/sketchbooks/${BOOK}`, { token: "owner_token" });
  check("book at the 6-artist cap (owner + 5)", atCap.json?.book?.artistCount === 6, String(atCap.json?.book?.artistCount));

  const inv6 = await api(`/api/sketchbooks/${BOOK}/invites`, { method: "POST", token: "owner_token" });
  const overBook = await api("/api/sketchbooks/accept", { method: "POST", token: "artist6_token", body: { token: inv6.json?.token } });
  check("7th distinct account refused at the cap (REST)", overBook.status === 403 && overBook.json?.error === "book_full",
    JSON.stringify(overBook));

  // Direct WS approve must NOT bypass the cap either.
  const seventh = await connect(PAGE5, { token: "artist6_token" });
  seventh.ws.send(JSON.stringify({ type: "paint_request" }));
  await waitFor(owner, (m) => m.type === "paint_requests" && m.requests.length > 0);
  owner.ws.send(JSON.stringify({ type: "paint_approve", targetId: lastOf(seventh, "connected")?.userId }));
  check("WS paint_approve at the cap -> book_full notice to the owner, no grant",
    !!(await waitFor(owner, (m) => m.type === "paint_requested" && m.status === "book_full")));
  check("7th account still cannot paint after the bypass attempt", lastOf(seventh, "connected")?.canPaint === false
    && !(await gotStroke(guestSpec, sendDraw(seventh, INK), 700)));
  const stillSix = await api(`/api/sketchbooks/${BOOK}`, { token: "owner_token" });
  check("cap holds at 6 distinct accounts after all bypass attempts",
    stillSix.json?.book?.artistCount === 6, String(stillSix.json?.book?.artistCount));

  // Invite revocation blocks FUTURE redemption.
  const invRev = await api(`/api/sketchbooks/${BOOK}/invites`, { method: "POST", token: "owner_token" });
  const revokeInv = await api(`/api/sketchbooks/${BOOK}/invites/${invRev.json?.inviteId}/revoke`, { method: "POST", token: "owner_token" });
  check("owner revokes an invite link", revokeInv.status === 200);
  const deadAccept = await api("/api/sketchbooks/accept", { method: "POST", token: "artist6_token", body: { token: invRev.json?.token } });
  check("revoked invite cannot be redeemed", deadAccept.status === 404 && deadAccept.json?.error === "invite_invalid",
    JSON.stringify(deadAccept));
  void INVITE1;

  // ==========================================================================
  // 5. Artist revocation: every tab, every page, immediate + persisted
  // ==========================================================================
  const a1tabA = await connect(PAGE1, { token: "artist1_token" }); // second tab of artist1 on page 1
  const a1tabB = await connect(PAGE5, { token: "artist1_token" }); // and page 5
  check("artist1 holds two live tabs on two pages (canPaint on both)",
    lastOf(a1tabA, "connected")?.canPaint === true && lastOf(a1tabB, "connected")?.canPaint === true);
  const revokeArtist = await api(`/api/sketchbooks/${BOOK}/artists/revoke`, {
    method: "POST", token: "owner_token", body: { profileId: "book_artist1" },
  });
  check("owner revokes artist1 from the whole book", revokeArtist.status === 200 && revokeArtist.json?.book?.artistCount === 5,
    JSON.stringify(revokeArtist.json?.book?.artistCount));
  check("revoke flips EVERY live tab on EVERY page (role_changed + revoked notice)",
    !!(await waitFor(a1tabA, (m) => m.type === "role_changed" && m.canPaint === false))
    && !!(await waitFor(a1tabB, (m) => m.type === "role_changed" && m.canPaint === false))
    && !!(await waitFor(a1tabA, (m) => m.type === "paint_requested" && m.status === "revoked")));
  check("revoked artist's next op is denied", !(await gotStroke(page1Spec, sendDraw(a1tabA, INK), 700)));
  check("fresh join after revoke finds no grant",
    lastOf(await connect(PAGE1, { token: "artist1_token" }), "connected")?.canPaint === false);
  const p1MetaAfterRevoke = await (async () => {
    const start = Date.now();
    for (;;) {
      const meta = await waitRoomFileJson(PAGE1);
      if (!(meta.painters || []).includes("book_artist1")) return meta;
      if (Date.now() - start > 8000) return meta; // fall through to the failing assert
      await sleep(300);
    }
  })();
  check("revoke persisted to the page room file", !(p1MetaAfterRevoke.painters || []).includes("book_artist1"));
  const ownerRevoke = await api(`/api/sketchbooks/${BOOK}/artists/revoke`, {
    method: "POST", token: "owner_token", body: { profileId: "book_owner01" },
  });
  check("the owner can never be revoked from their own book",
    ownerRevoke.status === 400 && ownerRevoke.json?.error === "cannot_revoke_owner", JSON.stringify(ownerRevoke));

  // The direct room-ACL endpoint on a page room ROUTES through the book:
  // revoking artist2 from ONE page strips them book-wide (the only honest
  // semantics — a room-local edit would be re-granted by the next sync).
  const a2tab = await connect(PAGE1, { token: "artist2_token" });
  check("artist2 holds a live tab on page 1", lastOf(a2tab, "connected")?.canPaint === true);
  const roomRevoke = await api(`/api/rooms/${PAGE1}/painters/revoke`, {
    method: "POST", token: "owner_token", body: { profileId: "book_artist2" },
  });
  check("room painters/revoke on a page room routes through the whole book",
    roomRevoke.status === 200 && roomRevoke.json?.book === BOOK && !(roomRevoke.json?.painters || []).includes("book_artist2"),
    JSON.stringify(roomRevoke));
  check("room-routed revoke flips the artist's live tabs book-wide",
    !!(await waitFor(a2tab, (m) => m.type === "role_changed" && m.canPaint === false)));
  const bookAfterRoomRevoke = await api(`/api/sketchbooks/${BOOK}`, { token: "owner_token" });
  check("book artist list reflects the room-routed revoke (4 artists)",
    bookAfterRoomRevoke.json?.book?.artistCount === 4, String(bookAfterRoomRevoke.json?.book?.artistCount));
  check("room-routed revoke holds on fresh joins on OTHER pages",
    lastOf(await connect(PAGE5, { token: "artist2_token" }), "connected")?.canPaint === false);
  const p5MetaAfterRoomRevoke = await (async () => {
    const start = Date.now();
    for (;;) {
      const meta = await waitRoomFileJson(PAGE5);
      if (!(meta.painters || []).includes("book_artist2")) return meta;
      if (Date.now() - start > 8000) return meta;
      await sleep(300);
    }
  })();
  check("room-routed revoke persisted to every page file",
    !(p5MetaAfterRoomRevoke.painters || []).includes("book_artist2"));
  const revokeOwnerViaRoom = await api(`/api/rooms/${PAGE1}/painters/revoke`, {
    method: "POST", token: "owner_token", body: { profileId: "book_owner01" },
  });
  check("the owner still can't be revoked via the room endpoint",
    revokeOwnerViaRoom.status === 400 && revokeOwnerViaRoom.json?.error === "cannot_revoke_owner", JSON.stringify(revokeOwnerViaRoom));
  const strangerRoomRevoke = await api(`/api/rooms/${PAGE1}/painters/revoke`, {
    method: "POST", token: "stranger_token", body: { profileId: "book_artist3" },
  });
  check("non-owner room revoke refused", strangerRoomRevoke.status === 403, JSON.stringify(strangerRoomRevoke));

  // ==========================================================================
  // 6. Rollover: page day/prompt are IMMUTABLE across the UTC-midnight flip
  // ==========================================================================
  const before = await api(`/api/sketchbooks/by-room/${PAGE5}`, { token: "owner_token" });
  check("by-room banner data: pinned prompt + neighbours + owner flag",
    before.json?.day === 5 && before.json?.prompt === DAY5_PROMPT && before.json?.isOwner === true
    && before.json?.prevRoom && before.json?.nextRoom && before.json?.pageCount === 31,
    JSON.stringify(before.json));
  const beforeStranger = await api(`/api/sketchbooks/by-room/${PAGE5}`, { token: "stranger_token" });
  check("by-room for a stranger: public fields, no owner/artist flags",
    beforeStranger.json?.isOwner === false && beforeStranger.json?.isArtist === false && beforeStranger.json?.canDraw === false);
  setClock("2026-10-06T00:00:30.000Z"); // the day flips to 6
  await sleep(500); // rollover tick
  const inkNow = await api("/api/inktober");
  check("event actually rolled to day 6", inkNow.json?.day === 6, JSON.stringify(inkNow.json?.day));
  const after = await api(`/api/sketchbooks/by-room/${PAGE5}`);
  check("page keeps its stamped day/prompt across rollover",
    after.json?.day === 5 && after.json?.prompt === DAY5_PROMPT, JSON.stringify(after.json));
  const bookAfterRoll = await api(`/api/sketchbooks/${BOOK}`, { token: "owner_token" });
  const page5After = (bookAfterRoll.json?.book?.pages || []).find((p) => p.room === PAGE5);
  check("book view keeps the immutable page metadata too",
    page5After?.day === 5 && page5After?.prompt === DAY5_PROMPT, JSON.stringify(page5After));

  // ==========================================================================
  // 7. Gallery: eligibility, pagination, moderation
  // ==========================================================================
  const galleryEmpty = await api("/api/sketchbooks?event=inktober-2026");
  const emptyIds = (galleryEmpty.json?.books || []).map((b) => b.id);
  check("book with real drawing IS discoverable; untouched book is NOT",
    emptyIds.includes(BOOK) && emptyIds.length === 1, JSON.stringify(galleryEmpty.json));
  const card = (galleryEmpty.json?.books || [])[0];
  check("gallery card: drawn pages + cover + no account material",
    card?.drawnPages >= 1 && typeof card?.coverRoom === "string" && !JSON.stringify(card).includes("book_owner01")
    && card?.artistCount === 4, JSON.stringify(card));

  // artist1's empty book never listed (created during the race test).
  const mineA1 = await api("/api/sketchbooks/mine?event=inktober-2026", { token: "artist1_token" });
  check("mine returns the caller's own book", mineA1.status === 200 && mineA1.json?.book?.owner === true);
  check("mine 404s for an account with no book", (await api("/api/sketchbooks/mine", { token: "stranger_token" })).status === 404);

  // Pagination walks the whole set with an honest total (no silent cap).
  // Seed 4 more drawn books directly via the API (each draws once).
  for (const t of ["artist2_token", "artist3_token", "artist4_token", "artist5_token"]) {
    const mk = await api("/api/sketchbooks", { method: "POST", token: t, body: { public: true } }); // eslint-disable-line no-await-in-loop
    const bid = mk.json?.book?.id;
    const pg = await api(`/api/sketchbooks/${bid}/pages`, { method: "POST", token: t, body: { day: 6 } }); // eslint-disable-line no-await-in-loop
    const room = pg.json?.page?.room;
    const c = await connect(room, { token: t }); // eslint-disable-line no-await-in-loop
    const s = sendDraw(c, INK); // eslint-disable-line no-await-in-loop
    const spec = await connect(room, { spectate: true }); // eslint-disable-line no-await-in-loop
    await gotStroke(spec, s, 1200); // eslint-disable-line no-await-in-loop
    await sleep(150); // let the op persist land in live history (memory is enough) // eslint-disable-line no-await-in-loop
  }
  const pageAll = await api("/api/sketchbooks?event=inktober-2026&limit=60");
  check("gallery total counts every eligible book", pageAll.json?.total === 5, JSON.stringify(pageAll.json?.total));
  const page0 = await api("/api/sketchbooks?event=inktober-2026&offset=0&limit=2");
  const page2 = await api("/api/sketchbooks?event=inktober-2026&offset=2&limit=2");
  const page4 = await api("/api/sketchbooks?event=inktober-2026&offset=4&limit=2");
  const walked = [...(page0.json?.books || []), ...(page2.json?.books || []), ...(page4.json?.books || [])];
  check("offset/limit pagination walks the whole set (load more, no silent 12/60 cap)",
    page0.json?.books?.length === 2 && page2.json?.books?.length === 2 && page4.json?.books?.length === 1
    && new Set(walked.map((b) => b.id)).size === 5,
    JSON.stringify([page0.json?.books?.length, page2.json?.books?.length, page4.json?.books?.length]));

  // Moderation: hiding the ONLY drawn page's room pulls the book from the
  // gallery; admin book hide/restore works; the owner cannot override.
  const adminKey = readFileSync(path.join(SCRATCH, ".admin-key"), "utf8").trim();
  const a2book = (await api("/api/sketchbooks/mine", { token: "artist2_token" })).json?.book;
  const a2room = a2book?.pages?.[0]?.room;
  const hideRoom = await api(`/api/admin/rooms/${a2room}/unpublish`, { method: "POST", adminKey });
  check("admin hides a page room (moderationHidden)", hideRoom.status === 200);
  const afterRoomHide = await api("/api/sketchbooks?event=inktober-2026&limit=60");
  check("book whose only drawn page is moderation-hidden leaves the gallery",
    !(afterRoomHide.json?.books || []).some((b) => b.id === a2book?.id), JSON.stringify(afterRoomHide.json?.total));
  const publicView = await api(`/api/sketchbooks/${a2book?.id}`);
  check("hidden page omitted from the PUBLIC book view", (publicView.json?.book?.pages || []).length === 0,
    JSON.stringify(publicView.json?.book?.pages));
  const ownerViewHidden = await api(`/api/sketchbooks/${a2book?.id}`, { token: "artist2_token" });
  check("owner still sees their hidden page, flagged", ownerViewHidden.json?.book?.pages?.[0]?.hidden === true);
  await api(`/api/admin/rooms/${a2room}/restore`, { method: "POST", adminKey });

  const beforeHideSpec = await connect(PAGE5, { spectate: true });
  const beforeHideStranger = await connect(PAGE5, { token: "stranger_token" });
  const hideBook = await api(`/api/admin/sketchbooks/${BOOK}/hide`, { method: "POST", adminKey });
  check("admin hide disconnects existing spectator", !!(await waitFor(beforeHideSpec, (m) => m.type === "room_blocked")));
  check("admin hide disconnects existing stranger", !!(await waitFor(beforeHideStranger, (m) => m.type === "room_blocked")));
  check("hidden book cannot be wall-posted", (await api("/api/wall", {method:"POST", token:"owner_token", body:{room:PAGE5,title:"hidden page",frames:[PNG_1PX]}})).status === 403);
  check("admin hides a whole book", hideBook.status === 200 && hideBook.json?.moderationHidden === true);
  const afterBookHide = await api("/api/sketchbooks?event=inktober-2026&limit=60");
  check("moderation-hidden book leaves the gallery",
    !(afterBookHide.json?.books || []).some((b) => b.id === BOOK));

  // A hidden book closes to the public EVERYWHERE — reader, banner,
  // spectator, member joins — while the owner/team keep managing it.
  check("hidden book: reader 404s for guests", (await api(`/api/sketchbooks/${BOOK}`)).status === 404);
  check("hidden book: reader 404s for non-owner accounts",
    (await api(`/api/sketchbooks/${BOOK}`, { token: "stranger_token" })).status === 404);
  const hiddenBookOwner = await api(`/api/sketchbooks/${BOOK}`, { token: "owner_token" });
  check("hidden book: owner keeps managing (200 + moderationHidden flag)",
    hiddenBookOwner.status === 200 && hiddenBookOwner.json?.book?.moderationHidden === true);
  check("hidden book: by-room 404s for the public, still serves the owner",
    (await api(`/api/sketchbooks/by-room/${PAGE5}`)).status === 404
    && (await api(`/api/sketchbooks/by-room/${PAGE5}`, { token: "owner_token" })).json?.bookId === BOOK);
  const hiddenSpec = await connect(PAGE5, { spectate: true });
  check("hidden book page: spectator refused (moderation_hidden)",
    lastOf(hiddenSpec, "room_blocked")?.reason === "moderation_hidden");
  const hiddenGuest = await connect(PAGE5, {});
  check("hidden book page: guest member refused", lastOf(hiddenGuest, "room_blocked")?.reason === "moderation_hidden");
  const hiddenStrangerWs = await connect(PAGE5, { token: "stranger_token" });
  check("hidden book page: non-artist account refused", lastOf(hiddenStrangerWs, "room_blocked")?.reason === "moderation_hidden");
  const hiddenOwnerWs = await connect(PAGE5, { token: "owner_token" });
  check("hidden book page: the owner still joins and draws", lastOf(hiddenOwnerWs, "connected")?.canPaint === true);
  const hiddenArtistWs = await connect(PAGE5, { token: "artist3_token" });
  check("hidden book page: a book artist still joins", lastOf(hiddenArtistWs, "connected")?.canPaint === true);

  await api(`/api/admin/sketchbooks/${BOOK}/restore`, { method: "POST", adminKey });
  const afterRestore = await api("/api/sketchbooks?event=inktober-2026&limit=60");
  check("admin restore returns the book to the gallery",
    (afterRestore.json?.books || []).some((b) => b.id === BOOK));
  const restoredSpec = await connect(PAGE5, { spectate: true });
  check("restore reopens public spectating", lastOf(restoredSpec, "connected")?.spectator === true);

  // Admin room delete on a PAGE room drops the book's page reference safely.
  const a5book = (await api("/api/sketchbooks/mine", { token: "artist5_token" })).json?.book;
  const a5room = a5book?.pages?.[0]?.room;
  const delPage = await api(`/api/admin/rooms/${a5room}/delete`, { method: "POST", adminKey });
  check("admin deletes a page room", delPage.status === 200, JSON.stringify(delPage));
  const a5After = await api(`/api/sketchbooks/${a5book?.id}`, { token: "artist5_token" });
  check("admin delete removed the page reference from the book (no dangling page)",
    a5After.json?.book?.pageCount === 0 && !existsSync(path.join(SCRATCH, ".rooms", `${a5room}.json`)),
    JSON.stringify(a5After.json?.book?.pages));
  check("deleted page code no longer resolves as a book page",
    (await api(`/api/sketchbooks/by-room/${a5room}`)).status === 404);

  // Privacy: the public book view carries no account ids / invite material.
  const pubView = await api(`/api/sketchbooks/${BOOK}`);
  const pubRaw = JSON.stringify(pubView.json);
  check("public book view: no account ids, no invite/token material",
    !pubRaw.includes("book_owner01") && !pubRaw.includes('"invites"') && !pubRaw.includes(TOKEN1)
    && pubView.json?.book?.artistCount === 4 && Array.isArray(pubView.json?.book?.pages));

  const notAPage = await api("/api/sketchbooks/by-room/MAIN");
  check("by-room 404s for a non-page room", notAPage.status === 404 && notAPage.json?.error === "not_a_page");

  // ==========================================================================
  // 7.5 Private visibility: default-private books are view-restricted
  // ==========================================================================
  const privCreate = await api("/api/sketchbooks", { method: "POST", token: "artist6_token", body: { title: "Fay's Hidden Inks" } });
  const PRIV = privCreate.json?.book?.id;
  check("artist6's book is PRIVATE by default", privCreate.status === 200 && privCreate.json?.book?.public === false);
  const privPage = await api(`/api/sketchbooks/${PRIV}/pages`, { method: "POST", token: "artist6_token", body: { day: 2 } });
  const PRIVPAGE = privPage.json?.page?.room;
  const PROMPT2 = privPage.json?.page?.prompt;
  check("private book page created with its server-stamped prompt", /^[A-Z0-9]{6}$/.test(PRIVPAGE || "") && !!PROMPT2);

  // Nobody outside the book team can VIEW anything about it.
  check("private book: reader 404s for guests", (await api(`/api/sketchbooks/${PRIV}`)).status === 404);
  check("private book: reader 404s for non-artist accounts",
    (await api(`/api/sketchbooks/${PRIV}`, { token: "stranger_token" })).status === 404);
  check("private book: by-room 404s for the public", (await api(`/api/sketchbooks/by-room/${PRIVPAGE}`)).status === 404);
  const privSpec = await connect(PRIVPAGE, { spectate: true });
  check("private page: spectator refused BEFORE materialization (book_private)",
    lastOf(privSpec, "room_blocked")?.reason === "book_private");
  const privGuest = await connect(PRIVPAGE, {});
  check("private page: guest member refused (book_private)", lastOf(privGuest, "room_blocked")?.reason === "book_private");
  const privStranger = await connect(PRIVPAGE, { token: "stranger_token" });
  check("private page: non-artist account refused (book_private)", lastOf(privStranger, "room_blocked")?.reason === "book_private");
  const privOwner = await connect(PRIVPAGE, { token: "artist6_token" });
  check("private page: the owner joins and draws", lastOf(privOwner, "connected")?.canPaint === true);
  const privStroke = sendDraw(privOwner, INK);
  const privOwner2 = await connect(PRIVPAGE, { token: "artist6_token" });
  check("owner's private ink replays for the team",
    (lastOf(privOwner2, "history")?.ops || []).some((op) => op.strokeId === privStroke));

  // Invited artist: team membership opens the private book.
  const privInvite = await api(`/api/sketchbooks/${PRIV}/invites`, { method: "POST", token: "artist6_token" });
  const privAccept = await api("/api/sketchbooks/accept", { method: "POST", token: "artist4_token", body: { token: privInvite.json?.token } });
  check("artist4 joins the private book by invite", privAccept.status === 200, JSON.stringify(privAccept));
  check("private book: invited artist gets the reader",
    (await api(`/api/sketchbooks/${PRIV}`, { token: "artist4_token" })).status === 200);
  check("private book: invited artist gets by-room (with the public flag)",
    (await api(`/api/sketchbooks/by-room/${PRIVPAGE}`, { token: "artist4_token" })).json?.bookId === PRIV
    && (await api(`/api/sketchbooks/by-room/${PRIVPAGE}`, { token: "artist4_token" })).json?.public === false);
  const privArtistWs = await connect(PRIVPAGE, { token: "artist4_token" });
  check("private page: invited artist joins and paints", lastOf(privArtistWs, "connected")?.canPaint === true);

  // No public exposure while private: gallery + wall.
  const privGallery = await api("/api/sketchbooks?event=inktober-2026&limit=60");
  check("private book with REAL drawing never enters the public gallery",
    !(privGallery.json?.books || []).some((b) => b.id === PRIV));
  const wallPriv = await api("/api/wall", {
    method: "POST", token: "artist6_token",
    body: { room: PRIVPAGE, title: "private page", frames: [PNG_1PX] },
  });
  check("private page cannot be wall-posted by claiming its room (book_private)",
    wallPriv.status === 403 && wallPriv.json?.error === "book_private", JSON.stringify(wallPriv));

  // Flip public: everyone can watch; the wall + gallery open.
  const toPublic = await api(`/api/sketchbooks/${PRIV}/visibility`, { method: "POST", token: "artist6_token", body: { public: true } });
  check("owner flips the book public", toPublic.status === 200 && toPublic.json?.book?.public === true);
  const pubSpec = await connect(PRIVPAGE, { spectate: true });
  check("public page: spectator watches again", lastOf(pubSpec, "connected")?.spectator === true);
  const pubStranger = await connect(PRIVPAGE, { token: "stranger_token" });
  check("public page: stranger watches (canPaint false)", lastOf(pubStranger, "connected")?.canPaint === false);
  const pubGallery = await api("/api/sketchbooks?event=inktober-2026&limit=60");
  check("public flip makes the drawn book gallery-eligible",
    (pubGallery.json?.books || []).some((b) => b.id === PRIV));
  const wallPub = await api("/api/wall", {
    method: "POST", token: "artist6_token",
    body: { room: PRIVPAGE, title: "public page", frames: [PNG_1PX] },
  });
  check("public page CAN be wall-posted by its owner", wallPub.status === 200 && wallPub.json?.ok === true, JSON.stringify(wallPub));

  // Downgrade: every unauthorized session on EVERY page closes at once.
  const downgrade = await api(`/api/sketchbooks/${PRIV}/visibility`, { method: "POST", token: "artist6_token", body: { public: false } });
  check("owner downgrades the book to private", downgrade.status === 200 && downgrade.json?.book?.public === false);
  check("downgrade closes the live spectator (book_private)",
    !!(await waitFor(pubSpec, (m) => m.type === "room_blocked" && m.reason === "book_private")));
  check("downgrade closes the stranger member tab (book_private)",
    !!(await waitFor(pubStranger, (m) => m.type === "room_blocked" && m.reason === "book_private")));
  await sleep(400);
  check("downgrade leaves the owner + artist sessions untouched",
    privOwner.ws.readyState === 1 && privOwner2.ws.readyState === 1 && privArtistWs.ws.readyState === 1);
  check("downgraded book leaves the gallery immediately",
    !((await api("/api/sketchbooks?event=inktober-2026&limit=60")).json?.books || []).some((b) => b.id === PRIV));
  check("downgrade persisted (fresh owner read shows public:false)",
    (await api(`/api/sketchbooks/${PRIV}`, { token: "artist6_token" })).json?.book?.public === false);
  // Later legs need this book public again (spectator/rematerialization).
  await api(`/api/sketchbooks/${PRIV}/visibility`, { method: "POST", token: "artist6_token", body: { public: true } });

  // ==========================================================================
  // 8. Restart: books, pages, ACLs, gallery all survive
  // ==========================================================================
  await killServer(server);
  server = null;
  server = boot(PORT_RESTART);
  check("server reboots for the persistence leg", await waitHealthy(PORT_RESTART));

  const boot2Book = await api(`/api/sketchbooks/${BOOK}`, { token: "owner_token", port: PORT_RESTART });
  check("book + all 31 pages survive restart", boot2Book.json?.book?.pageCount === 31
    && boot2Book.json?.book?.artistCount === 4, JSON.stringify([boot2Book.json?.book?.pageCount, boot2Book.json?.book?.artistCount]));
  const boot2ByRoom = await api(`/api/sketchbooks/by-room/${PAGE5}`, { port: PORT_RESTART });
  check("page metadata survives restart (day 5 'Apple')",
    boot2ByRoom.json?.day === 5 && boot2ByRoom.json?.prompt === DAY5_PROMPT && boot2ByRoom.json?.bookId === BOOK);
  const boot2Resume = await api("/api/sketchbooks", { method: "POST", token: "owner_token", body: { public: true }, port: PORT_RESTART });
  check("create-after-restart RESUMES (no duplicate book)", boot2Resume.json?.resumed === true && boot2Resume.json?.book?.id === BOOK);
  const revokedAfterRestart = await connect(PAGE1, { token: "artist1_token", port: PORT_RESTART });
  check("revoked artist stays revoked after restart", lastOf(revokedAfterRestart, "connected")?.canPaint === false);
  const artistAfterRestart = await connect(PAGE1, { token: "artist3_token", port: PORT_RESTART });
  check("granted artist keeps access after restart", lastOf(artistAfterRestart, "connected")?.canPaint === true);
  const roomRevokedAfterRestart = await connect(PAGE5, { token: "artist2_token", port: PORT_RESTART });
  check("room-routed revoke survives restart", lastOf(roomRevokedAfterRestart, "connected")?.canPaint === false);
  const boot2Gallery = await api("/api/sketchbooks?event=inktober-2026&limit=60", { port: PORT_RESTART });
  check("gallery survives restart (dormant pages count their saved ops)",
    (boot2Gallery.json?.books || []).some((b) => b.id === BOOK && b.drawnPages >= 1), JSON.stringify(boot2Gallery.json?.total));
  const boot2Spec = await connect(PAGE5, { spectate: true, port: PORT_RESTART });
  check("page room artwork survives restart (spectator replays saved ink)",
    (lastOf(boot2Spec, "history")?.ops || []).length >= 1, String((lastOf(boot2Spec, "history")?.ops || []).length));

  // ==========================================================================
  // 9. Idle lifecycle: page rooms never expire, ordinary studios do
  // ==========================================================================
  await killServer(server);
  server = null;
  server = boot(PORT_RESTART, {
    AUTO_CLOSE_ARTIST_BASE_MS: "4000",
    AUTO_CLOSE_ARTIST_MAX_MS: "5000",
    AUTO_CLOSE_PER_OP_MS: "0",
    AUTO_CLOSE_PER_USER_SEC_MS: "0",
  });
  check("server reboots for the idle-lifecycle leg", await waitHealthy(PORT_RESTART));

  // A plain artist studio on the SAME shortened TTL as the sweep sees...
  const plain = await api("/api/rooms", {
    method: "POST", token: "stranger_token",
    body: { audience: "artist_public", title: "Plain Studio" }, port: PORT_RESTART,
  });
  const PLAIN = plain.json?.code;
  check("plain artist studio created for the TTL comparison", /^[A-Z0-9]{6}$/.test(PLAIN || ""), JSON.stringify(plain));
  await waitRoomFileJson(PLAIN);
  await waitRoomFileJson(PRIVPAGE); // the private-visibility leg's page, on disk

  await sleep(6500); // several sweeps past the 5s artist ceiling
  check("ordinary artist studio IS reaped by the idle sweep",
    !existsSync(path.join(SCRATCH, ".rooms", `${PLAIN}.json`)));
  check("sketchbook page room is PROTECTED from the same idle sweep (file intact)",
    existsSync(path.join(SCRATCH, ".rooms", `${PRIVPAGE}.json`)));
  check("dormant page rooms from earlier legs survived the sweep too",
    existsSync(path.join(SCRATCH, ".rooms", `${PAGE5}.json`)));
  const spec9 = await connect(PRIVPAGE, { spectate: true, port: PORT_RESTART });
  check("protected page still replays its artwork",
    (lastOf(spec9, "history")?.ops || []).length >= 1);
  try { spec9.ws.close(); } catch { /* gone */ }

  // ==========================================================================
  // 10. Missing page file: rematerialize from the book, never a generic room
  // ==========================================================================
  await killServer(server);
  server = null;
  // Simulate catastrophic loss of ONE page's room files (book record intact).
  for (const suffix of [".json", ".history.json", ".ops.jsonl"]) {
    try { rmSync(path.join(SCRATCH, ".rooms", `${PRIVPAGE}${suffix}`)); } catch { /* absent */ }
  }
  server = boot(PORT_RESTART);
  check("server reboots with the page room file missing", await waitHealthy(PORT_RESTART));

  const book10 = await api(`/api/sketchbooks/${PRIV}`, { token: "artist6_token", port: PORT_RESTART });
  check("book still references the lost page", (book10.json?.book?.pages || []).some((p) => p.room === PRIVPAGE));

  // A STRANGER lands on the code first: it must rematerialize as the book's
  // page — never as a generic, ownable room the stranger could squat on.
  const squatter = await connect(PRIVPAGE, { token: "stranger_token", port: PORT_RESTART });
  const squatHello = lastOf(squatter, "connected");
  check("missing page rematerializes as artist_public on first touch (no takeover)",
    squatHello?.audience === "artist_public" && squatHello?.canPaint === false && squatHello?.isOwner === false,
    JSON.stringify(squatHello));
  check("squatter cannot draw on the rematerialized page",
    !(await gotStroke(squatter, sendDraw(squatter, INK), 700)));
  const byRoom10 = await api(`/api/sketchbooks/by-room/${PRIVPAGE}`, { port: PORT_RESTART });
  check("rematerialized page keeps its immutable prompt metadata",
    byRoom10.status === 200 && byRoom10.json?.day === 2 && byRoom10.json?.prompt === PROMPT2 && byRoom10.json?.bookId === PRIV,
    JSON.stringify(byRoom10.json));
  const owner10 = await connect(PRIVPAGE, { token: "artist6_token", port: PORT_RESTART });
  check("book owner still owns + paints the rematerialized page",
    lastOf(owner10, "connected")?.canPaint === true && lastOf(owner10, "connected")?.isOwner === true);
  const meta10 = await waitRoomFileJson(PRIVPAGE);
  check("rematerialized page re-persists its book shape (ref + audience + inktober + owner)",
    meta10.sketchbook?.book === PRIV && meta10.audience === "artist_public" && meta10.inktober === true
    && meta10.ownerProfileId === "book_artist6",
    JSON.stringify({ s: meta10.sketchbook, a: meta10.audience, o: meta10.ownerProfileId }));

  // ==========================================================================
  // 11. Missing BOOK record: WS paint approve/revoke fail CLOSED
  // ==========================================================================
  await killServer(server);
  server = null;
  // The page room file survives; the BOOK record itself is lost.
  try { rmSync(path.join(SCRATCH, ".sketchbooks", `${PRIV}.json`)); } catch { /* absent */ }
  const damagedPagePath = path.join(SCRATCH, ".rooms", `${PRIVPAGE}.json`);
  const damagedPage = JSON.parse(readFileSync(damagedPagePath, "utf8"));
  writeFileSync(damagedPagePath, JSON.stringify({ ...damagedPage, animation: true }));
  server = boot(PORT_RESTART);
  check("server reboots with the BOOK record missing", await waitHealthy(PORT_RESTART));
  check("book page rejects film export even with corrupt animation flag", (await api(`/api/rooms/${PRIVPAGE}/film`, {token:"stranger_token",port:PORT_RESTART})).status === 404);

  const owner11 = await connect(PRIVPAGE, { token: "artist6_token", port: PORT_RESTART });
  const artist11 = await connect(PRIVPAGE, { token: "artist4_token", port: PORT_RESTART });
  check("page room still loads with its persisted grant (artist paints)",
    lastOf(artist11, "connected")?.canPaint === true);
  const requester11 = await connect(PRIVPAGE, { token: "stranger_token", port: PORT_RESTART });
  const guest11 = await connect(PRIVPAGE, { port: PORT_RESTART });
  const spec11 = await connect(PRIVPAGE, { spectate: true, port: PORT_RESTART });
  for (const [label, client] of [["stranger", requester11], ["guest", guest11], ["spectator", spec11]]) {
    check(`missing book denies ${label} before history`, !!lastOf(client, "room_blocked") && !lastOf(client, "history") && !lastOf(client, "connected"));
  }
  owner11.ws.send(JSON.stringify({ type: "paint_approve", targetId: lastOf(artist11, "connected")?.userId }));
  check("WS approve with a missing book fails CLOSED (book_missing notice)",
    !!(await waitFor(owner11, (m) => m.type === "paint_requested" && m.status === "book_missing")));
  // Fail-closed REVOKE: the persisted grant must NOT be stripped by the
  // direct-room fallback either.
  owner11.ws.send(JSON.stringify({ type: "paint_revoke", targetId: lastOf(artist11, "connected")?.userId }));
  await sleep(500);
  check("WS revoke with a missing book fails CLOSED (grant untouched, no role flip)",
    !artist11.msgs.some((m) => m.type === "role_changed" && m.canPaint === false));
  check("the persisted grant still works after the refused revoke",
    !!(await gotStroke(owner11, sendDraw(artist11, INK))));
  const meta11 = await waitRoomFileJson(PRIVPAGE);
  check("page file painters unchanged by the fail-closed attempts",
    (meta11.painters || []).includes("book_artist4"), JSON.stringify(meta11.painters));
  check("by-room 404s while the book record is missing",
    (await api(`/api/sketchbooks/by-room/${PRIVPAGE}`, { port: PORT_RESTART })).status === 404);

  // ==========================================================================
  // Teardown
  // ==========================================================================
  await killServer(server);
  server = null;
  for (const c of clients) { try { c.ws.close(); } catch { /* gone */ } }
  mock.close();
  if (madeStubDist) { try { rmSync(distDir, { recursive: true, force: true }); } catch { /* leave it */ } }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — ${failed.length} FAILED` : ""}`);
  if (failed.length) {
    console.log("server log tail:\n" + serverLog.join("").slice(-1200));
    process.exit(1);
  }
};

run().catch((err) => {
  console.error("suite error:", err);
  console.log("server log tail:\n" + serverLog.join("").slice(-1200));
  process.exit(1);
});
