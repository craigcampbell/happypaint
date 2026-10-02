// Unsaved (guest) public sketchbooks, verification suite.
// Contract: docs/SKETCHBOOKS-CONTRACT.md, section "Unsaved (guest) public
// sketchbooks". Strictly isolated: throwaway DATA_DIR under the scratch dir,
// mock PocketBase (the only identity endpoint server.js calls), ports
// 9006 (main) / 9007 (fail-closed, no PB) / 9008 (sweep + restart legs).
// Never touches 8787 or any real app_data.
//
// Covers, over real HTTP + WebSocket sessions for every role:
//   create/resume: no-account mint, save token ONCE (sbkc_...), same book and
//     page on the second tap, no token on resume, another device gets its own
//     book, racing taps mint one book, bad_device / need_day / bad_day
//   pages: server-stamped prompt metadata, duplicate day resumes, 31-page cap
//     (book_full), per-day distinct rooms
//   room shape: kid_safe audience, listed:false, inktober:true, no account
//     owner, no painters, book back-reference, write-behind op persistence
//   device-scoped drawing: the owning device draws and relays; another
//     device, a plain guest, a signed-in stranger and an oversized device key
//     cannot draw, clear, set sheets or mutate layers/frames/animation, and
//     page rooms are canvas-only (chat_blocked book_page) while chat still
//     works in an ordinary room; the read/social allowlist survives (reactions)
//   ink & pencil: enforced on the page while the event is active, NOT before
//     it starts (clock re-pinned to a pre-event date), and the page's pinned
//     prompt is immutable across a UTC-midnight rollover
//   gallery: unsaved book invisible with 0 ops, visible once drawn, unsaved
//     flag on the card + reader + by-room, honest pagination total alongside
//     a saved account book
//   claim: 401 without a session, bad_token, claim_invalid for unknown/spent
//     tokens, adopt flips every page room to artist_public owned by the
//     account with artwork intact, anonymous owner socket demoted via
//     role_changed, session socket draws, fresh guest watches but cannot draw
//   MERGE: an account that already has a book keeps it; a duplicate day keeps
//     the page with artwork and detaches the other into an unlisted studio;
//     no painted page is lost; the spent guest record disappears
//   token hygiene: the save token appears ONLY in the creation reply; only
//     its SHA-256 (claimHash) is on disk; no token/hash/device/account ids in
//     any public response (gallery, reader, by-room, claim)
//   sweep: an empty unsaved book is dropped once its createdAt is older than
//     SKETCHBOOK_GUEST_MAX_EMPTY_MS; a book with artwork is never swept
//   moderation: admin hide removes an unsaved book from the gallery, 404s its
//     reader and by-room for strangers, refuses spectator/member joins
//     (moderation_hidden) while the owning device keeps the banner; restore
//     reverses everything
//   blocked device (403), rate limiting (429) on guest mint spam
//   restart persistence: books, the unsaved device binding, resume and the
//     save-token-once rule survive a restart
import { spawn } from "child_process";
import http from "http";
import { createHash } from "crypto";
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRATCH = path.join(process.env.TMPDIR || "/tmp", "sb-guest-verify-data");
const CLOCK_FILE = path.join(SCRATCH, "inktober-clock.txt");
const BLOCKED_FILE = path.join(SCRATCH, ".blocked.json");
const ROOMS_DIR = path.join(SCRATCH, ".rooms");
const BOOKS_DIR = path.join(SCRATCH, ".sketchbooks");
const PORT = 9006;
const PORT_NOPB = 9007;
const PORT_LATE = 9008;
const ACTIVE_CLOCK = "2026-10-05T12:00:00.000Z"; // active event, day 5

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
const setClock = (iso) => writeFileSync(CLOCK_FILE, iso);
setClock(ACTIVE_CLOCK);
// The blocked-device leg boots later (the block list is read at boot).
writeFileSync(BLOCKED_FILE, JSON.stringify([{ key: "dev:blocked_666", ts: Date.now(), reason: "test", by: "test" }]));

// ---- mock PocketBase --------------------------------------------------------
const TOKENS = {
  owner_token: { id: "book_owner01", name: "Olive Owner" },
  saver_token: { id: "saver_acct02", name: "Sue Saver" }, // claims the main guest book (no prior book of its own)
  merge_token: { id: "merge_acct01", name: "Mia Merge" },
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

// ---- harness -----------------------------------------------------------------
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? "  << " + String(detail).slice(0, 300) : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const spawned = [];
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
  const log = [];
  proc.stderr.on("data", (d) => { log.push(String(d)); if (log.length > 30) log.shift(); });
  spawned.push(proc);
  proc.__log = log;
  return proc;
}
async function waitHealthy(port) {
  for (let i = 0; i < 80; i += 1) {
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
async function connect(room, { token = null, userKey = null, spectate = false, port = PORT } = {}) {
  const qs = spectate ? `room=${room}&spectate=1` : `room=${room}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${qs}`);
  const c = { ws, msgs: [], closed: false, room };
  ws.on("message", (raw) => { try { c.msgs.push(JSON.parse(raw.toString())); } catch { /* binary */ } });
  ws.on("close", () => { c.closed = true; });
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
  if (!spectate) {
    // The auth frame is the FIRST frame, carrying the session token (if any)
    // and the per-browser device key the guest book is bound to.
    ws.send(JSON.stringify({ type: "auth", token, userKey: userKey || `dk_${Math.random().toString(36).slice(2, 12)}` }));
  }
  await sleep(450); // join + history (raw clients shake hands first)
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

// Room meta persistence is write-behind (~2.5s schedule): POLL the file until
// it matches the expected shape instead of reading whatever is on disk now.
const roomFileJson = (code) => JSON.parse(readFileSync(path.join(ROOMS_DIR, `${code}.json`), "utf8"));
async function waitRoomFileJson(code, ms = 9000) {
  const start = Date.now();
  for (;;) {
    try { return roomFileJson(code); } catch { /* not flushed yet */ }
    if (Date.now() - start > ms) throw new Error(`room file for ${code} never appeared`);
    await sleep(300);
  }
}
async function waitRoomFile(code, pred, ms = 12000) {
  const start = Date.now();
  let last = null;
  for (;;) {
    try { last = roomFileJson(code); if (pred(last)) return last; } catch { /* not flushed */ }
    if (Date.now() - start > ms) return last;
    await sleep(300);
  }
}

let strokeSeq = 0;
const sendDraw = (c, settings, end = true) => {
  strokeSeq += 1;
  const id = `gs${strokeSeq}`;
  c.ws.send(JSON.stringify({ type: "op", op: { kind: "draw", strokeId: id, settings, points: [{ x: 5, y: 5 }, { x: 15, y: 15 }], end } }));
  return id;
};
const gotStroke = (c, strokeId, ms = 900) => waitFor(c, (m) => m.type === "op" && m.op && m.op.strokeId === strokeId, ms);
// A late-joining spectator receives the whole op history: {type:'history', ops:[...]}.
const historyHas = async (room, strokeId, port = PORT) => {
  const spec = await connect(room, { spectate: true, port });
  const ops = (spec.msgs.find((m) => m.type === "history")?.ops) || [];
  return ops.some((op) => op && op.strokeId === strokeId);
};
const INK = { brush: "ink", color: "#11212b", size: 4 };
const PENCIL = { brush: "pencil", color: "#4a4a4a", size: 2 };
const WATERCOLOR = { brush: "watercolor", color: "#11212b", size: 8 };
// A valid kid-safe sheet id (an existing published sheet slug).
const SHEET_ID = "kitten";

const DEV = "dev_main_001"; // the device that starts the main unsaved book
const OTHER = "dev_other_002"; // a second device
const HIDE = "dev_hide_003"; // the moderation leg's device
const MERGE = "dev_merge_004"; // the merge leg's device
const SWEEPD = "swept_dev_005"; // the sweep leg's (doomed, empty) device
const KEEP = "keepd_dev_006"; // the sweep leg's (kept, drawn) device
const RESTART = "rest_dev_007"; // the restart-persistence device
const BLOCKED = "blocked_666"; // in .blocked.json before any late boot
const CAP = "capdev00_8"; // the 31-page cap device
const PIDS = ["book_owner01", "saver_acct02", "merge_acct01", "book_stranger"];

// ---- shared assertions ---------------------------------------------------
// Privacy: no device keys, device-key hashes, account ids or save tokens in a
// public response body.
const PRIVACY_SECRETS = [DEV, OTHER, HIDE, MERGE, SWEEPD, KEEP, RESTART, BLOCKED, CAP, ...PIDS];
function privacySweep(label, obj, extra = []) {
  const hay = JSON.stringify(obj || {});
  for (const secret of [...PRIVACY_SECRETS, ...extra]) {
    check(`${label}: leaks no "${secret}"`, !hay.includes(secret), hay.slice(0, 200));
  }
}

const run = async () => {
  // ==========================================================================
  // 0. FAIL CLOSED when accounts are unconfigured
  // ==========================================================================
  const noPb = boot(PORT_NOPB, { PB_URL: "", POCKETBASE_URL: "" });
  check("unconfigured server boots", await waitHealthy(PORT_NOPB));
  const noPbClaim = await api("/api/sketchbooks/claim", { method: "POST", body: { token: "sbkc_whatever123456" }, port: PORT_NOPB });
  check("unconfigured: claim fails closed with accounts_required",
    noPbClaim.status === 401 && noPbClaim.json?.error === "accounts_required", JSON.stringify(noPbClaim));
  await killServer(noPb);

  // ==========================================================================
  // 1. Create / resume semantics (no account)
  // ==========================================================================
  const srv = boot(PORT);
  check("server boots", await waitHealthy(PORT));

  const noDevice = await api("/api/sketchbooks/guest", { method: "POST", body: {} });
  check("missing device rejected (bad_device)", noDevice.status === 400 && noDevice.json?.error === "bad_device", JSON.stringify(noDevice));
  const shortDevice = await api("/api/sketchbooks/guest", { method: "POST", body: { device: "abc" } });
  check("short device rejected (bad_device)", shortDevice.status === 400 && shortDevice.json?.error === "bad_device", JSON.stringify(shortDevice));

  const first = await api("/api/sketchbooks/guest", { method: "POST", body: { device: DEV } });
  check("guest book minted with no account", first.status === 200 && first.json?.ok === true && !!first.json?.bookId, JSON.stringify(first));
  const claimToken = first.json?.token || "";
  check("save token handed out ONCE, on first creation (sbkc_...)",
    typeof claimToken === "string" && claimToken.startsWith("sbkc_") && claimToken.length > 10, JSON.stringify(first.json).slice(0, 120));
  const BOOK = first.json?.bookId;
  const RM5 = first.json?.room;
  const PAGE5 = first.json?.page;
  check("event day 5 pinned server-side with prompt + date",
    PAGE5?.day === 5 && typeof PAGE5?.prompt === "string" && PAGE5.prompt.length > 0 && PAGE5?.date === "2026-10-05", JSON.stringify(PAGE5));
  check("response room === page room, url points at it",
    first.json?.room === PAGE5?.room && first.json?.url === `/join/${RM5}`, JSON.stringify({ room: first.json?.room, url: first.json?.url }));
  check("creation is not a resume", first.json?.resumed === false && first.json?.unsaved === true);

  const second = await api("/api/sketchbooks/guest", { method: "POST", body: { device: DEV } });
  check("second tap resumes the SAME book and page",
    second.status === 200 && second.json?.bookId === BOOK && second.json?.room === RM5 && second.json?.resumed === true, JSON.stringify(second.json));
  check("resume never re-issues the save token", second.json?.token === undefined, JSON.stringify(second.json));

  const other = await api("/api/sketchbooks/guest", { method: "POST", body: { device: OTHER } });
  check("a different device gets its OWN book (never someone else's)",
    other.status === 200 && other.json?.bookId && other.json?.bookId !== BOOK && other.json?.token, JSON.stringify(other.json).slice(0, 120));
  const OTHER_BOOK = other.json?.bookId;

  const race = await Promise.all([1, 2, 3].map(() => api("/api/sketchbooks/guest", { method: "POST", body: { device: DEV } })));
  const raceIds = new Set(race.map((r) => r.json?.bookId));
  check("racing taps mint exactly one book", race.every((r) => r.status === 200) && raceIds.size === 1 && raceIds.has(BOOK),
    JSON.stringify(race.map((r) => [r.status, r.json?.bookId])));
  check("a racing resume never mints a second save token", race.every((r) => r.json?.token === undefined));

  for (const [day, label] of [[0, "0"], [99, "99"], ["five", "five"], [5.5, "5.5"]]) {
    const bad = await api("/api/sketchbooks/guest", { method: "POST", body: { device: DEV, day } });
    check(`day ${label} off the official list rejected (bad_day)`, bad.status === 400 && bad.json?.error === "bad_day", JSON.stringify(bad));
  }

  // One page per prompt day: a second day mints a new page; the same day resumes.
  const day9 = await api("/api/sketchbooks/guest", { method: "POST", body: { device: DEV, day: 9 } });
  check("a new day mints a second page on the SAME book",
    day9.status === 200 && day9.json?.bookId === BOOK && day9.json?.page?.day === 9 && day9.json?.room !== RM5, JSON.stringify(day9.json));
  const RM9 = day9.json?.room;
  const dupDay = await api("/api/sketchbooks/guest", { method: "POST", body: { device: DEV, day: 9 } });
  check("a duplicate day resumes the existing page (no second room)",
    dupDay.status === 200 && dupDay.json?.room === RM9, JSON.stringify(dupDay.json));

  // The 31-page cap: a fresh device fills every official day (31 pages), then
  // duplicates must resume idempotently. book_full itself is defensive only -
  // it cannot be reached with distinct days because the official list holds
  // exactly 31, so the cap is proven by pageCount never exceeding 31.
  let capFull = null;
  for (let d = 1; d <= 31; d += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await api("/api/sketchbooks/guest", { method: "POST", body: { device: CAP, day: d } });
    if (r.status !== 200) { capFull = r; break; }
  }
  check("a guest book fills all 31 official days without error", capFull === null, JSON.stringify(capFull));
  const capFirst = await api("/api/sketchbooks/guest", { method: "POST", body: { device: CAP, day: 1 } });
  const capBookId = capFirst.json?.bookId;
  const capReader = await api(`/api/sketchbooks/${capBookId}`);
  check("the capped book holds exactly 31 pages", capReader.json?.book?.pageCount === 31, String(capReader.json?.book?.pageCount));
  check("a duplicate day on the FULL book resumes the same page (never a 32nd)",
    capFirst.status === 200 && capFirst.json?.resumed === true && capFirst.json?.page?.day === 1
    && (await api(`/api/sketchbooks/${capBookId}`)).json?.book?.pageCount === 31,
    JSON.stringify(capFirst.json).slice(0, 160));

  // ==========================================================================
  // 2. Page room shape (unsaved): a public kid_safe mural, unlisted, inktober
  // ==========================================================================
  const meta5 = await waitRoomFileJson(RM5);
  check("unsaved page room is audience kid_safe", meta5.audience === "kid_safe", JSON.stringify({ audience: meta5.audience }));
  check("unsaved page room is unlisted (discovery is the book's)", meta5.listed === false, JSON.stringify({ listed: meta5.listed }));
  check("unsaved page room is inktober-opted", meta5.inktober === true);
  check("unsaved page room has NO account owner and no painters",
    !meta5.ownerProfileId && (!meta5.painters || meta5.painters.length === 0), JSON.stringify({ owner: meta5.ownerProfileId, painters: meta5.painters }));
  check("page room carries the book back-reference with the pinned prompt",
    meta5.sketchbook?.book === BOOK && meta5.sketchbook?.day === 5 && meta5.sketchbook?.prompt === PAGE5.prompt,
    JSON.stringify(meta5.sketchbook));
  const roomGallery = await api("/api/rooms/gallery?event=inktober-2026&limit=60");
  const galCodes = (roomGallery.json?.rooms || []).map((r) => r.code);
  check("page rooms never appear in the artist room gallery", !galCodes.includes(RM5) && !galCodes.includes(RM9), galCodes.join(","));

  // ==========================================================================
  // 3. WS: device-scoped drawing + the viewer allowlist
  // ==========================================================================
  const owner = await connect(RM5, { userKey: DEV });
  const watcher = await connect(RM5, { userKey: OTHER });
  const connO = lastOf(owner, "connected");
  const connW = lastOf(watcher, "connected");
  check("the owning device canPaint:true on its page", connO?.canPaint === true, JSON.stringify({ canPaint: connO?.canPaint }));
  check("another device canPaint:false on the same page", connW?.canPaint === false, JSON.stringify({ canPaint: connW?.canPaint }));
  check("handshake flags the page as an unsaved sketchbook page",
    connO?.sketchbook === true && connO?.sketchbookUnsaved === true && connO?.audience === "kid_safe", JSON.stringify(connO).slice(0, 200));
  check("handshake carries the PAGE's pinned prompt", connO?.prompt === PAGE5.prompt, JSON.stringify({ prompt: connO?.prompt }));
  check("ink & pencil enforced on the page while the event is active", connO?.inkOnly === true, JSON.stringify({ inkOnly: connO?.inkOnly }));

  // A plain anonymous guest (random device key) and a signed-in stranger
  // cannot draw either, the right belongs to the one device.
  const plain = await connect(RM5, {});
  const stranger = await connect(RM5, { token: "stranger_token" });
  check("a plain anonymous guest canPaint:false", lastOf(plain, "connected")?.canPaint === false);
  check("a signed-in stranger canPaint:false", lastOf(stranger, "connected")?.canPaint === false);
  // An oversized device key must not silently match the owner's key.
  const longKey = `${DEV}_${"x".repeat(80)}`;
  const spoofer = await connect(RM5, { userKey: longKey });
  check("an oversized/padded device key gets no drawing right", lastOf(spoofer, "connected")?.canPaint === false);

  const sLeak = sendDraw(watcher, INK);
  check("a watcher's draw op is dropped (never relayed)", !(await gotStroke(owner, sLeak)));
  const sPlain = sendDraw(plain, INK);
  check("a plain guest's draw op is dropped", !(await gotStroke(owner, sPlain)));
  const sStranger = sendDraw(stranger, INK);
  check("a stranger's draw op is dropped", !(await gotStroke(owner, sStranger)));
  const sSpoof = sendDraw(spoofer, INK);
  check("a padded-key spoof's draw op is dropped", !(await gotStroke(owner, sSpoof)));

  const sOwner = sendDraw(owner, INK);
  check("the owning device's draw op relays to watchers", !!(await gotStroke(watcher, sOwner)));
  const sOwner2 = sendDraw(owner, PENCIL);
  check("pencil strokes are legal on the page", !!(await gotStroke(watcher, sOwner2)));
  const sWc = sendDraw(owner, WATERCOLOR);
  check("ink enforcement: watercolor refused on the page", !(await gotStroke(watcher, sWc)));

  // Mutation denylist for canPaint:false members (dropped BEFORE the switch).
  watcher.ws.send(JSON.stringify({ type: "clear" }));
  await sleep(300);
  check("a watcher cannot clear the mural", !watcher.msgs.some((m) => m.type === "clear") && !owner.msgs.some((m, i) => i > owner.msgs.length - 20 && m.type === "clear"));
  watcher.ws.send(JSON.stringify({ type: "set_sheet", sheetId: SHEET_ID }));
  await sleep(300);
  check("a watcher cannot set a coloring sheet",
    !owner.msgs.slice(-20).some((m) => m.type === "sheet" && m.sheetId === SHEET_ID));
  for (const t of [
    { type: "layer_add" }, { type: "layer_del", layerId: "l1" }, { type: "frame_add" },
    { type: "set_animation", enabled: true }, { type: "wipe_request" }, { type: "undo_clear" },
    { type: "set_wet", wet: false }, { type: "set_brush_mode", mode: "fun" },
  ]) {
    watcher.ws.send(JSON.stringify(t));
  }
  await sleep(400);
  const mutTypes = new Set(["layer_add", "layer_del", "layers", "frame_add", "room_animation", "wipe_request", "undo_clear", "room_wet", "room_brush_mode"]);
  check("a watcher's layer/frame/animation/room-management messages are all dropped",
    !watcher.msgs.some((m) => mutTypes.has(m.type)) && !owner.msgs.slice(-30).some((m) => mutTypes.has(m.type)),
    JSON.stringify(watcher.msgs.filter((m) => mutTypes.has(m.type)).slice(0, 3)));

  // The read/social allowlist still works for a watcher on the page.
  watcher.ws.send(JSON.stringify({ type: "reaction", emoji: "❤️", x: 4, y: 4 }));
  check("a watcher's emoji reaction still relays (read/social allowlist intact)",
    !!(await waitFor(owner, (m) => m.type === "reaction" && m.emoji === "❤️")));

  // Chat is canvas-only on a book page, but STILL WORKS in an ordinary room.
  owner.ws.send(JSON.stringify({ type: "chat", message: "hello page" }));
  check("chat on a book page is rejected (chat_blocked book_page)",
    !!(await waitFor(owner, (m) => m.type === "chat_blocked" && m.reason === "book_page")));
  check("no chat is relayed to page watchers", !watcher.msgs.some((m) => m.type === "chat"));
  const mainA = await connect("MAIN", {});
  const mainB = await connect("MAIN", {});
  mainA.ws.send(JSON.stringify({ type: "chat", message: "hello main" }));
  check("chat still works in an ordinary room", !!(await waitFor(mainB, (m) => m.type === "chat" && m.message === "hello main")));
  try { mainA.ws.close(); } catch { /* gone */ }
  try { mainB.ws.close(); } catch { /* gone */ }

  // ==========================================================================
  // 4. Gallery / reader / by-room visibility of an unsaved book
  // ==========================================================================
  // (The book has 3 relayed strokes on day 5, it holds REAL drawing now.)
  const empty = await api("/api/sketchbooks?event=inktober-2026&limit=60");
  check("drawn unsaved book is gallery-eligible",
    (empty.json?.books || []).some((b) => b.id === BOOK), JSON.stringify((empty.json?.books || []).map((b) => b.id)));
  const card = (empty.json?.books || []).find((b) => b.id === BOOK);
  check("gallery card is labelled unsaved:true", card?.unsaved === true, JSON.stringify(card));
  const reader = await api(`/api/sketchbooks/${BOOK}`);
  check("reader flags the book unsaved with its pages",
    reader.json?.book?.unsaved === true && reader.json?.book?.pageCount === 2, JSON.stringify(reader.json?.book).slice(0, 160));
  check("reader page shows the artwork op count (day 5 holds 2 relayed strokes)",
    (reader.json?.book?.pages || []).find((p) => p.day === 5)?.ops === 2,
    JSON.stringify((reader.json?.book?.pages || []).map((p) => [p.day, p.ops])));

  // An EMPTY unsaved book (OTHER's book, no drawing) must NOT be listed.
  check("an unsaved book with zero ops is NOT in the gallery",
    !(empty.json?.books || []).some((b) => b.id === OTHER_BOOK), JSON.stringify((empty.json?.books || []).map((b) => b.id)));

  // Honest pagination alongside a saved account book.
  const ownerBook = await api("/api/sketchbooks", { method: "POST", token: "owner_token", body: { public: true } });
  const OB = ownerBook.json?.book?.id;
  const obPage = await api(`/api/sketchbooks/${OB}/pages`, { method: "POST", token: "owner_token", body: { day: 3 } });
  const OB_ROOM = obPage.json?.page?.room;
  const obSock = await connect(OB_ROOM, { token: "owner_token" });
  sendDraw(obSock, INK);
  await sleep(400);
  const obMeta = await waitRoomFile(OB_ROOM, (m) => Number(m.opCount || 0) >= 1);
  check("saved book setup: its page holds real drawing", Number(obMeta?.opCount || 0) >= 1, JSON.stringify({ opCount: obMeta?.opCount }));

  const page1 = await api("/api/sketchbooks?event=inktober-2026&limit=2&offset=0");
  const page2 = await api("/api/sketchbooks?event=inktober-2026&limit=2&offset=2");
  const eligibleIds = new Set([...(page1.json?.books || []), ...(page2.json?.books || [])].map((b) => b.id));
  check("honest pagination total counts every eligible book (saved + unsaved)",
    page1.json?.total === 2 && page2.json?.total === 2 && eligibleIds.has(BOOK) && eligibleIds.has(OB)
    && !(eligibleIds.has(OTHER_BOOK)),
    JSON.stringify({ total: page1.json?.total, ids: [...eligibleIds] }));
  const otherCard = (await api("/api/sketchbooks?event=inktober-2026&limit=60")).json?.books?.find((b) => b.id === OTHER_BOOK);
  check("the unsaved flag is false on a SAVED book's card", (await api("/api/sketchbooks?event=inktober-2026&limit=60")).json?.books?.find((b) => b.id === OB)?.unsaved === false, JSON.stringify(otherCard));

  // by-room device gating.
  const byO = await api(`/api/sketchbooks/by-room/${RM5}?dk=${DEV}`);
  const byW = await api(`/api/sketchbooks/by-room/${RM5}?dk=${OTHER}`);
  const byN = await api(`/api/sketchbooks/by-room/${RM5}`);
  check("by-room: the owning device is the guest owner and may draw",
    byO.json?.unsaved === true && byO.json?.isGuestOwner === true && byO.json?.canDraw === true, JSON.stringify(byO.json));
  check("by-room: another device neither owns nor draws",
    byW.json?.unsaved === true && byW.json?.isGuestOwner === false && byW.json?.canDraw === false, JSON.stringify(byW.json));
  check("by-room: no dk means no guest flags",
    byN.json?.unsaved === true && byN.json?.isGuestOwner === false && byN.json?.canDraw === false, JSON.stringify(byN.json));
  const byBogus = await api(`/api/sketchbooks/by-room/${RM5}?dk=${"z".repeat(120)}`);
  check("by-room: a bogus/oversized dk is ignored (no owner flags)",
    byBogus.json?.isGuestOwner === false && byBogus.json?.canDraw === false, JSON.stringify(byBogus.json));
  check("by-room: the pinned prompt rides the banner",
    byO.json?.prompt === PAGE5.prompt && byO.json?.day === 5, JSON.stringify(byO.json));

  // ==========================================================================
  // 5. Ink NOT enforced before the event starts + prompt immutability
  // ==========================================================================
  setClock("2026-09-20T12:00:00.000Z"); // pre-event (upcoming phase)
  const pre = await api("/api/sketchbooks/guest", { method: "POST", body: { device: "dev_preev_009", day: 2 } });
  check("pre-event: no day in the body is need_day (prompt list only)",
    (await api("/api/sketchbooks/guest", { method: "POST", body: { device: "dev_preev_009" } })).status === 400,
    "expected need_day without a day before the event");
  check("pre-event: an explicit day still creates the page", pre.status === 200 && pre.json?.page?.day === 2, JSON.stringify(pre.json));
  const PRE_ROOM = pre.json?.room;
  const PRE_PROMPT = pre.json?.page?.prompt;
  const preSock = await connect(PRE_ROOM, { userKey: "dev_preev_009" });
  const preConn = lastOf(preSock, "connected");
  check("pre-event: ink & pencil is NOT enforced before the event starts", preConn?.inkOnly === false, JSON.stringify({ inkOnly: preConn?.inkOnly }));
  check("pre-event: the page still carries its pinned prompt", preConn?.prompt === PRE_PROMPT, JSON.stringify({ prompt: preConn?.prompt }));
  const preWc = sendDraw(preSock, WATERCOLOR);
  check("pre-event: a watercolor stroke is accepted on the page", await historyHas(PRE_ROOM, preWc));
  // Rollover: flip the clock two days; the pinned prompt must not rotate.
  setClock("2026-10-07T23:59:00.000Z");
  const afterRoll = await api(`/api/sketchbooks/${BOOK}`);
  const rolledPage = (afterRoll.json?.book?.pages || []).find((p) => p.day === 5);
  check("the pinned prompt is immutable across a UTC-midnight rollover",
    rolledPage?.prompt === PAGE5.prompt && rolledPage?.date === "2026-10-05", JSON.stringify(rolledPage));
  const sockRoll = await connect(RM5, { userKey: DEV });
  check("the page handshake keeps the pinned prompt after rollover (not day 7's)",
    lastOf(sockRoll, "connected")?.prompt === PAGE5.prompt, JSON.stringify({ prompt: lastOf(sockRoll, "connected")?.prompt }));
  setClock(ACTIVE_CLOCK);

  // ==========================================================================
  // 6. The claim flow (save)
  // ==========================================================================
  const noAuth = await api("/api/sketchbooks/claim", { method: "POST", body: { token: claimToken } });
  check("claim without a session is 401 accounts_required",
    noAuth.status === 401 && noAuth.json?.error === "accounts_required", JSON.stringify(noAuth));
  const badTok = await api("/api/sketchbooks/claim", { method: "POST", token: "owner_token", body: { token: "nope" } });
  check("claim rejects a malformed token (bad_token)", badTok.status === 400 && badTok.json?.error === "bad_token", JSON.stringify(badTok));
  const unknownTok = await api("/api/sketchbooks/claim", { method: "POST", token: "owner_token", body: { token: "sbkc_unknownunknownunknown" } });
  check("claim rejects an unknown token (claim_invalid)", unknownTok.status === 404 && unknownTok.json?.error === "claim_invalid", JSON.stringify(unknownTok));

  const claim = await api("/api/sketchbooks/claim", { method: "POST", token: "saver_token", body: { token: claimToken } });
  check("claim adopts the book for the account",
    claim.status === 200 && claim.json?.adopted === true && claim.json?.merged === false && claim.json?.bookId === BOOK, JSON.stringify(claim).slice(0, 200));
  check("the saved book is owner-viewed and no longer unsaved",
    claim.json?.book?.owner === true && claim.json?.book?.unsaved === false, JSON.stringify(claim.json?.book).slice(0, 120));
  const spent = await api("/api/sketchbooks/claim", { method: "POST", token: "saver_token", body: { token: claimToken } });
  check("a spent save token is refused (claim_invalid, one-time)", spent.status === 404 && spent.json?.error === "claim_invalid", JSON.stringify(spent));

  const flipMeta = await waitRoomFile(RM5, (m) => m.audience === "artist_public" && m.ownerProfileId === "saver_acct02");
  check("the page room flipped to an artist studio owned by the account",
    flipMeta?.audience === "artist_public" && flipMeta?.ownerProfileId === "saver_acct02",
    JSON.stringify({ audience: flipMeta?.audience, owner: flipMeta?.ownerProfileId }));
  check("the artwork survived the flip (opCount > 0)", Number(flipMeta?.opCount || 0) >= 2, JSON.stringify({ opCount: flipMeta?.opCount }));
  const flip9 = await waitRoomFile(RM9, (m) => m.audience === "artist_public" && m.ownerProfileId === "saver_acct02");
  check("EVERY page room flipped (day 9 too)", flip9?.audience === "artist_public" && flip9?.ownerProfileId === "saver_acct02",
    JSON.stringify({ audience: flip9?.audience, owner: flip9?.ownerProfileId }));
  check("the flipped page keeps its pinned prompt back-reference",
    flipMeta?.sketchbook?.book === BOOK && flipMeta?.sketchbook?.day === 5, JSON.stringify(flipMeta?.sketchbook));

  // The anonymous owner socket is demoted the moment the book is saved.
  const roleFlip = await waitFor(owner, (m) => m.type === "role_changed", 2500);
  check("the anonymous owner socket is demoted to viewer on save (role_changed)",
    roleFlip?.canPaint === false, JSON.stringify(roleFlip));
  const anonAfter = await connect(RM5, { userKey: DEV });
  check("a fresh anonymous socket of the same device can no longer draw",
    lastOf(anonAfter, "connected")?.canPaint === false && lastOf(anonAfter, "connected")?.sketchbookUnsaved === false,
    JSON.stringify({ canPaint: lastOf(anonAfter, "connected")?.canPaint }));
  const savedOwner = await connect(RM5, { token: "saver_token", userKey: DEV });
  check("the signed-in owner draws on the saved studio", lastOf(savedOwner, "connected")?.canPaint === true);
  const freshGuest = await connect(RM5, { userKey: "dev_fresh_010" });
  check("after saving, a fresh guest watches but cannot draw",
    lastOf(freshGuest, "connected")?.canPaint === false && lastOf(freshGuest, "connected")?.audience === "artist_public",
    JSON.stringify({ canPaint: lastOf(freshGuest, "connected")?.canPaint, audience: lastOf(freshGuest, "connected")?.audience }));
  const sFresh = sendDraw(freshGuest, INK);
  check("after saving, a guest's draw op is dropped", !(await gotStroke(savedOwner, sFresh)));

  const readerSaved = await api(`/api/sketchbooks/${BOOK}`);
  check("reader: the saved book is no longer flagged unsaved", readerSaved.json?.book?.unsaved === false);
  const mine = await api("/api/sketchbooks/mine?event=inktober-2026", { token: "saver_token" });
  check("the account finds the claimed book as its own", mine.status === 200 && mine.json?.book?.id === BOOK, JSON.stringify(mine).slice(0, 120));
  const bySavedDev = await api(`/api/sketchbooks/by-room/${RM5}?dk=${DEV}`);
  check("by-room after save: unsaved false, the device key no longer grants anything",
    bySavedDev.json?.unsaved === false && bySavedDev.json?.isGuestOwner === false && bySavedDev.json?.canDraw === false, JSON.stringify(bySavedDev.json));
  const bySavedOwner = await api(`/api/sketchbooks/by-room/${RM5}`, { token: "saver_token" });
  check("by-room after save: the account owner may draw",
    bySavedOwner.json?.isOwner === true && bySavedOwner.json?.canDraw === true, JSON.stringify(bySavedOwner.json));
  const resumeAfterClaim = await api("/api/sketchbooks/guest", { method: "POST", body: { device: DEV } });
  check("the device that saved gets a FRESH unsaved book on its next tap (never the claimed one)",
    resumeAfterClaim.status === 200 && resumeAfterClaim.json?.bookId !== BOOK && resumeAfterClaim.json?.unsaved === true && !!resumeAfterClaim.json?.token,
    JSON.stringify(resumeAfterClaim.json).slice(0, 160));
  const otherIntact = await api("/api/sketchbooks/guest", { method: "POST", body: { device: OTHER } });
  check("another device's unsaved book is untouched by the claim", otherIntact.json?.bookId === OTHER_BOOK, JSON.stringify(otherIntact.json).slice(0, 120));

  // ==========================================================================
  // 7. The MERGE path (the account already has a book for the event)
  // ==========================================================================
  // merge_token's existing book with an EMPTY day-5 page; the unsaved device
  // book holds art on day 5 (2 strokes) + day 3 (1 stroke).
  const mBook = await api("/api/sketchbooks", { method: "POST", token: "merge_token", body: { public: true } });
  const MB = mBook.json?.book?.id;
  const mDay5 = await api(`/api/sketchbooks/${MB}/pages`, { method: "POST", token: "merge_token", body: { day: 5 } });
  const MB5 = mDay5.json?.page?.room;
  const gBook = await api("/api/sketchbooks/guest", { method: "POST", body: { device: MERGE, day: 5 } });
  const GB = gBook.json?.bookId;
  const GB5 = gBook.json?.room;
  const gTok = gBook.json?.token;
  const gDay3 = await api("/api/sketchbooks/guest", { method: "POST", body: { device: MERGE, day: 3 } });
  const GB3 = gDay3.json?.room;
  const gOwner = await connect(GB5, { userKey: MERGE });
  sendDraw(gOwner, INK); // x2 on day 5
  sendDraw(gOwner, INK);
  await sleep(400);
  const g3Owner = await connect(GB3, { userKey: MERGE });
  sendDraw(g3Owner, INK); // x1 on day 3
  await sleep(400);
  const gb5Meta = await waitRoomFile(GB5, (m) => Number(m.opCount || 0) >= 2);
  const gb3Meta = await waitRoomFile(GB3, (m) => Number(m.opCount || 0) >= 1);
  check("merge setup: the guest pages hold artwork", Number(gb5Meta?.opCount || 0) >= 2 && Number(gb3Meta?.opCount || 0) >= 1,
    JSON.stringify({ gb5: gb5Meta?.opCount, gb3: gb3Meta?.opCount }));

  const merge = await api("/api/sketchbooks/claim", { method: "POST", token: "merge_token", body: { token: gTok } });
  check("claim MERGES into the account's existing book",
    merge.status === 200 && merge.json?.merged === true && merge.json?.adopted === false && merge.json?.bookId === MB,
    JSON.stringify(merge).slice(0, 200));
  const mergedView = merge.json?.book;
  check("the merged book keeps BOTH distinct days",
    mergedView?.pageCount === 2 && mergedView?.pages?.some((p) => p.day === 3) && mergedView?.pages?.some((p) => p.day === 5),
    JSON.stringify(mergedView?.pages?.map((p) => [p.day, p.room, p.ops])));
  const mergedDay5 = (mergedView?.pages || []).find((p) => p.day === 5);
  check("the duplicate day keeps the page WITH artwork (the guest page wins)",
    mergedDay5?.room === GB5 && mergedDay5?.ops >= 2, JSON.stringify(mergedDay5));
  const mergedDay3 = (mergedView?.pages || []).find((p) => p.day === 3);
  check("the non-duplicate day moved across with its artwork",
    mergedDay3?.room === GB3 && mergedDay3?.ops >= 1, JSON.stringify(mergedDay3));

  // A LIVE page moved by the merge must be re-stamped with the TARGET book on
  // its live object too, not just in the file: the old code left the moved room
  // pointing at the deleted guest book, so every join (even the merge account's)
  // failed closed as book_private. This join is the regression guard.
  const mergeJoin = await connect(GB5, { userKey: "dev_watch_013" });
  const mergeJoinConn = lastOf(mergeJoin, "connected");
  check("a merged live page still admits a stranger as a watcher (book ref re-stamped)",
    !!mergeJoinConn && mergeJoinConn.canPaint === false && !mergeJoin.msgs.some((m) => m.type === "room_blocked"),
    JSON.stringify(mergeJoin.msgs.map((m) => m.type)));
  const mergeOwnerJoin = await connect(GB5, { token: "merge_token", userKey: MERGE });
  check("the merge account itself can still join and draw its merged page",
    lastOf(mergeOwnerJoin, "connected")?.canPaint === true, JSON.stringify(lastOf(mergeOwnerJoin, "connected")));

  const mb5Meta = await waitRoomFile(MB5, (m) => m.audience === "artist_public" && m.ownerProfileId === "merge_acct01" && !m.sketchbook);
  check("the account's empty duplicate page is detached, not deleted (unlisted studio)",
    mb5Meta?.audience === "artist_public" && mb5Meta?.ownerProfileId === "merge_acct01" && !mb5Meta?.sketchbook
    && Number(mb5Meta?.opCount || 0) === 0,
    JSON.stringify({ audience: mb5Meta?.audience, owner: mb5Meta?.ownerProfileId, sketchbook: mb5Meta?.sketchbook, opCount: mb5Meta?.opCount }));
  const gb5After = await waitRoomFile(GB5, (m) => m.audience === "artist_public" && m.ownerProfileId === "merge_acct01");
  check("the moved guest page is an artist studio of the account, art intact",
    gb5After?.audience === "artist_public" && gb5After?.ownerProfileId === "merge_acct01"
    && Number(gb5After?.opCount || 0) >= 2,
    JSON.stringify({ audience: gb5After?.audience, owner: gb5After?.ownerProfileId, opCount: gb5After?.opCount }));
  check("the moved page's persisted ref points at the MERGED book (not the deleted guest book)",
    gb5After?.sketchbook?.book === MB && gb5After?.sketchbook?.day === 5,
    JSON.stringify(gb5After?.sketchbook));
  check("the spent guest book RECORD is gone after the merge", !existsSync(path.join(BOOKS_DIR, `${GB}.json`)));
  const mergeMine = await api("/api/sketchbooks/mine?event=inktober-2026", { token: "merge_token" });
  check("the account still has exactly ONE book (the merged one)", mergeMine.json?.book?.id === MB && mergeMine.json?.book?.pageCount === 2,
    JSON.stringify(mergeMine.json?.book).slice(0, 120));
  const mergeGallery = await api("/api/sketchbooks?event=inktober-2026&limit=60");
  check("the gallery shows the merged book, not the spent guest record",
    (mergeGallery.json?.books || []).some((b) => b.id === MB) && !(mergeGallery.json?.books || []).some((b) => b.id === GB),
    JSON.stringify((mergeGallery.json?.books || []).map((b) => b.id)));

  // ==========================================================================
  // 8. Moderation of an unsaved book (admin hide) + blocked device + rate limit
  // ==========================================================================
  const hCreate = await api("/api/sketchbooks/guest", { method: "POST", body: { device: HIDE } });
  const HB = hCreate.json?.bookId;
  const HRM = hCreate.json?.room;
  const hSock = await connect(HRM, { userKey: HIDE });
  sendDraw(hSock, INK);
  await sleep(500);
  await waitRoomFile(HRM, (m) => Number(m.opCount || 0) >= 1);
  const preHide = await api("/api/sketchbooks?event=inktober-2026&limit=60");
  check("hidden-leg setup: the drawn unsaved book is listed pre-hide",
    (preHide.json?.books || []).some((b) => b.id === HB), JSON.stringify((preHide.json?.books || []).map((b) => b.id)));

  const adminKey = readFileSync(path.join(SCRATCH, ".admin-key"), "utf8").trim();
  const hide = await api(`/api/admin/sketchbooks/${HB}/hide`, { method: "POST", adminKey });
  check("admin hide accepts the unsaved book", hide.status === 200 && hide.json?.ok === true, JSON.stringify(hide));
  const hidGallery = await api("/api/sketchbooks?event=inktober-2026&limit=60");
  check("a hidden unsaved book leaves the gallery immediately",
    !(hidGallery.json?.books || []).some((b) => b.id === HB));
  check("hiding one book drops the total by exactly one (the others stay)",
    hidGallery.json?.total === preHide.json?.total - 1
    && (hidGallery.json?.books || []).some((b) => b.id === BOOK) && (hidGallery.json?.books || []).some((b) => b.id === OB),
    JSON.stringify({ total: hidGallery.json?.total, before: preHide.json?.total }));
  const hidReader = await api(`/api/sketchbooks/${HB}`);
  check("a hidden unsaved book's reader 404s for strangers", hidReader.status === 404, JSON.stringify(hidReader));
  const hidByRoom = await api(`/api/sketchbooks/by-room/${HRM}?dk=${OTHER}`);
  check("a hidden unsaved book's by-room 404s for strangers", hidByRoom.status === 404, JSON.stringify(hidByRoom));
  const hidByRoomOwner = await api(`/api/sketchbooks/by-room/${HRM}?dk=${HIDE}`);
  check("the owning device still gets its banner (can still save the book)",
    hidByRoomOwner.status === 200 && hidByRoomOwner.json?.isGuestOwner === true, JSON.stringify(hidByRoomOwner.json));
  const hidSpec = await connect(HRM, { spectate: true });
  check("spectators are refused on a hidden book's page (moderation_hidden)",
    hidSpec.msgs.some((m) => m.type === "room_blocked" && m.reason === "moderation_hidden") || hidSpec.closed,
    JSON.stringify(hidSpec.msgs.map((m) => m.type).slice(0, 5)));
  const hidJoin = await connect(HRM, { userKey: "dev_joiner_011" });
  check("member joins are refused on a hidden book's page",
    hidJoin.msgs.some((m) => m.type === "room_blocked") || hidJoin.closed,
    JSON.stringify(hidJoin.msgs.map((m) => m.type).slice(0, 5)));
  const restore = await api(`/api/admin/sketchbooks/${HB}/restore`, { method: "POST", adminKey });
  check("admin restore reverses the hide", restore.status === 200
    && (await api("/api/sketchbooks?event=inktober-2026&limit=60")).json?.books?.some((b) => b.id === HB));

  const blockedProbe = await api("/api/sketchbooks/guest", { method: "POST", body: { device: "blocked_666" } });
  check("a blocked device is refused (403 blocked)", blockedProbe.status === 403 && blockedProbe.json?.error === "blocked", JSON.stringify(blockedProbe));

  // Rate limit: hammering the mint endpoint eventually answers 429.
  let saw429 = false;
  for (let i = 0; i < 50 && !saw429; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await api("/api/sketchbooks/guest", { method: "POST", body: { device: "spam_dev_012" } });
    if (r.status === 429 && r.json?.error === "rate_limited") saw429 = true;
  }
  check("guest-mint spam is rate limited (429 rate_limited)", saw429);

  // ==========================================================================
  // 9. Token + privacy hygiene: on disk and in every response
  // ==========================================================================
  const bookJson = JSON.parse(readFileSync(path.join(BOOKS_DIR, `${BOOK}.json`), "utf8"));
  const claimHash = bookJson.guest ? null : "claimed"; // BOOK was claimed in leg 6; use the OTHER book instead
  const otherBookJson = JSON.parse(readFileSync(path.join(BOOKS_DIR, `${OTHER_BOOK}.json`), "utf8"));
  check("the book file stores guest:{device,claimHash,createdAt} with no owner",
    otherBookJson.guest?.device === OTHER && /^[0-9a-f]{64}$/.test(otherBookJson.guest?.claimHash || "")
    && !!otherBookJson.guest?.createdAt && !otherBookJson.ownerProfileId && otherBookJson.public === true,
    JSON.stringify(otherBookJson.guest));
  void claimHash;
  const hashed = createHash("sha256").update(other.json?.token || "").digest("hex");
  check("claimHash on disk IS the SHA-256 of the save token", otherBookJson.guest?.claimHash === hashed,
    JSON.stringify({ onDisk: otherBookJson.guest?.claimHash, expected: hashed }));

  let diskClean = true;
  let diskWhere = "";
  const scanDirs = [BOOKS_DIR, ROOMS_DIR];
  for (const dir of scanDirs) {
    let files = [];
    try { files = readdirSync(dir); } catch { /* no dir */ }
    for (const f of files) {
      if (!f.endsWith(".json") && !f.endsWith(".jsonl")) continue;
      let txt = "";
      try { txt = readFileSync(path.join(dir, f), "utf8"); } catch { /* gone */ }
      if (txt.includes(other.json?.token || "\u0000") || txt.includes("sbkc_")) { diskClean = false; diskWhere = `${dir}/${f}`; }
    }
  }
  check("the save token NEVER appears on disk (no sbkc_ anywhere)", diskClean, diskWhere);

  const pubGallery = await api("/api/sketchbooks?event=inktober-2026&limit=60");
  privacySweep("gallery response", pubGallery.json, [other.json?.token, otherBookJson.guest?.claimHash]);
  const pubReader = await api(`/api/sketchbooks/${OTHER_BOOK}`);
  privacySweep("reader response", pubReader.json, [other.json?.token, otherBookJson.guest?.claimHash]);
  const pubByRoom = await api(`/api/sketchbooks/by-room/${RM9 || GB5}?dk=${OTHER}`);
  privacySweep("by-room response", pubByRoom.json, [other.json?.token, otherBookJson.guest?.claimHash]);
  // Privacy sweep on the claim reply: the caller's OWN opaque account id is
  // present by design (owner view); everything else, devices, other accounts,
  // tokens, hashes, must be absent.
  const claimSaverView = JSON.parse(JSON.stringify(claim.json || {}));
  delete claimSaverView.book?.artists;
  privacySweep("claim response", claimSaverView, [DEV, other.json?.token, otherBookJson.guest?.claimHash]);

  // ==========================================================================
  // 10. The empty-book sweep (SKETCHBOOK_GUEST_MAX_EMPTY_MS), port 9008
  // ==========================================================================
  clients.forEach((c) => { try { c.ws.close(); } catch { /* gone */ } });
  await killServer(srv);
  setClock("2026-10-10T12:00:00.000Z");
  const lateSrv = boot(PORT_LATE, { SKETCHBOOK_GUEST_SWEEP_MS: "0" });
  check("sweep-leg server boots", await waitHealthy(PORT_LATE));

  const sweepCreate = await api("/api/sketchbooks/guest", { method: "POST", body: { device: SWEEPD, day: 4 }, port: PORT_LATE });
  const sweepRoom = sweepCreate.json?.room;
  const sweepBook = sweepCreate.json?.bookId;
  const keepCreate = await api("/api/sketchbooks/guest", { method: "POST", body: { device: KEEP, day: 4 }, port: PORT_LATE });
  const keepRoom = keepCreate.json?.room;
  const keepBook = keepCreate.json?.bookId;
  const keepSock = await connect(keepRoom, { userKey: KEEP, port: PORT_LATE });
  sendDraw(keepSock, INK);
  await sleep(500);
  await waitRoomFile(keepRoom, (m) => Number(m.opCount || 0) >= 1);
  await waitRoomFileJson(sweepRoom);
  check("sweep setup: an empty book and a drawn book exist side by side",
    !!sweepBook && !!keepBook && sweepBook !== keepBook);

  await killServer(lateSrv);
  // Age ONLY the empty book past SKETCHBOOK_GUEST_MAX_EMPTY_MS (14 days): the
  // sweep must drop it and must NOT drop the book with artwork. The sweep
  // compares against the REAL system clock (INKTOBER_CLOCK_FILE only moves the
  // event state), so the stamp has to be far enough back to be past the window
  // in wall-clock terms, not just past the pinned event date.
  const AGED = "2026-01-01T00:00:00.000Z";
  const sweepFile = path.join(BOOKS_DIR, `${sweepBook}.json`);
  const aged = JSON.parse(readFileSync(sweepFile, "utf8"));
  aged.guest.createdAt = AGED;
  writeFileSync(sweepFile, JSON.stringify(aged));
  const keepFile = path.join(BOOKS_DIR, `${keepBook}.json`);
  const agedKeep = JSON.parse(readFileSync(keepFile, "utf8"));
  agedKeep.guest.createdAt = AGED;
  writeFileSync(keepFile, JSON.stringify(agedKeep));

  // The sweep runs at BOOT as well as on its interval, so this restart is what
  // fires it: the empty book aged past the window must be gone, and the book
  // with artwork aged identically must be untouched.
  const lateSrv2 = boot(PORT_LATE, { SKETCHBOOK_GUEST_SWEEP_MS: "0" });
  check("post-sweep server boots", await waitHealthy(PORT_LATE));
  await sleep(600); // the boot sweep runs before/at readiness
  const agedEmpty = await api(`/api/sketchbooks/${sweepBook}`, { port: PORT_LATE });
  check("the EMPTY unsaved book is swept once past the window",
    agedEmpty.status === 404, JSON.stringify(agedEmpty).slice(0, 80));
  check("the swept book's record file is removed",
    !existsSync(path.join(BOOKS_DIR, `${sweepBook}.json`)));
  check("the swept book's empty page room file is removed",
    !existsSync(path.join(ROOMS_DIR, `${sweepRoom}.json`)));
  const sweptByRoom = await api(`/api/sketchbooks/by-room/${sweepRoom}`, { port: PORT_LATE });
  check("the swept page no longer resolves to a book",
    sweptByRoom.status === 404, JSON.stringify(sweptByRoom).slice(0, 80));
  const keptReader = await api(`/api/sketchbooks/${keepBook}`, { port: PORT_LATE });
  check("a book WITH artwork is never swept (despite the same age)",
    keptReader.status === 200 && keptReader.json?.book?.unsaved === true, JSON.stringify(keptReader).slice(0, 120));
  const keepResume = await api("/api/sketchbooks/guest", { method: "POST", body: { device: KEEP, day: 4 }, port: PORT_LATE });
  check("the kept book still resumes for its device after the sweep", keepResume.json?.bookId === keepBook && keepResume.json?.resumed === true,
    JSON.stringify(keepResume.json).slice(0, 120));

  // ==========================================================================
  // 11. Restart persistence, unsaved binding, resume, token-once
  // ==========================================================================
  await killServer(lateSrv2);
  const lateSrv3 = boot(PORT_LATE);
  check("restart-leg server boots", await waitHealthy(PORT_LATE));
  const r1 = await api("/api/sketchbooks/guest", { method: "POST", body: { device: RESTART }, port: PORT_LATE });
  check("a fresh unsaved book mints before the restart", r1.status === 200 && r1.json?.unsaved === true && !!r1.json?.token, JSON.stringify(r1).slice(0, 120));
  const RBOOK = r1.json?.bookId;
  await killServer(lateSrv3);
  const lateSrv4 = boot(PORT_LATE);
  check("final restart server boots", await waitHealthy(PORT_LATE));
  const r2 = await api("/api/sketchbooks/guest", { method: "POST", body: { device: RESTART }, port: PORT_LATE });
  check("the unsaved device binding survives a restart (same book resumed)",
    r2.status === 200 && r2.json?.bookId === RBOOK && r2.json?.resumed === true, JSON.stringify(r2).slice(0, 160));
  check("resume after restart still never re-issues the save token", r2.json?.token === undefined, JSON.stringify(r2));
  const r3 = await api(`/api/sketchbooks/${RBOOK}`, { port: PORT_LATE });
  check("the book file survives the restart with the unsaved flag",
    r3.status === 200 && r3.json?.book?.unsaved === true, JSON.stringify(r3).slice(0, 120));
  const keptAfterRestart = await api(`/api/sketchbooks/${keepBook}`, { port: PORT_LATE });
  check("the drawn unsaved book from leg 10 also survives this restart",
    keptAfterRestart.json?.book?.id === keepBook && keptAfterRestart.json?.book?.unsaved === true,
    JSON.stringify(keptAfterRestart).slice(0, 120));
  const blockedRestart = await api("/api/sketchbooks/guest", { method: "POST", body: { device: BLOCKED }, port: PORT_LATE });
  check("the block list is honoured after a restart (403 blocked)",
    blockedRestart.status === 403 && blockedRestart.json?.error === "blocked", JSON.stringify(blockedRestart));
  await killServer(lateSrv4);
};

// ---- finish ------------------------------------------------------------------
run().then(() => {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\nFailing checks:");
    failed.forEach((f) => console.log(`  FAIL  ${f.name}`));
  }
  process.exitCode = failed.length ? 1 : 0;
}).catch(async (err) => {
  console.error("SUITE CRASH", err);
  process.exitCode = 1;
}).finally(async () => {
  for (const c of clients) { try { c.ws.close(); } catch { /* gone */ } }
  for (const p of spawned) { await killServer(p); }
  try { mock.close(); } catch { /* gone */ }
  if (process.exitCode) process.exit(process.exitCode);
});
