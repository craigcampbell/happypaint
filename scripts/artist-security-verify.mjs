// Artist-studio + seasonal security regression verification.
//
// Strictly isolated: throwaway DATA_DIR, mock PocketBase (the only endpoint
// server.js calls), port 8973. Never touches 8787 or production app_data.
//
// Covers the reviewed backend correctness/security fixes:
//   1. paint_revoke / paint_approve recompute canPaint + role_changed for ALL
//      live sessions of the account (two-tab revoke/approve), persisted
//   2. approved NON-HOST painters have no room-management powers (set_wet,
//      set_brush_mode, set_symmetry, vote_start) but keep drawing
//   3. bounded rate limits on owner publish / unpublish / offline revoke
//   4. countryFromReq trusts ONLY cf-ipcountry (this deployment sits behind
//      the Cloudflare tunnel); x-country-code spoof suppressed; XX/T1 excluded
//   5. spectate: stored audience prechecked BEFORE materializing; room ids
//      canonicalized so aliases can't fork the live map
//   6. friends -> artist publish 409s on active game/phone/storybook/
//      animation state and leaves the private room UNCHANGED; a clean
//      conversion still works
//   7. INKTOBER + retired DINOS murals refuse ordinary member wipe_request /
//      clear countdown; the admin moderation wipe is retained
//   8. wall event attribution: INKTOBER self-submission still stamps (prompt
//      participation, not proof of medium), but an artist-studio stamp
//      requires the poster to be the verified owner or an approved painter -
//      a stranger quoting the room code gets NO event, offline rooms included
import { spawn } from "child_process";
import http from "http";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRATCH = path.join(process.env.TMPDIR || "/tmp", "artist-security-verify-data");
const CLOCK_FILE = path.join(SCRATCH, "inktober-clock.txt");
const PORT = 8973;
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
// Active October (day 5) so event stamps carry a real server-derived day.
writeFileSync(CLOCK_FILE, "2026-10-05T12:00:00.000Z");

// Pre-seed BEFORE boot:
//  SECWALL, an OFFLINE Inktober-opted-in artist studio (owner sec_owner1,
//    approved painter sec_paint2). Never joined before the wall tests, so the
//    persisted-file attribution path is exercised, not just the live one.
//  SECFRN, a private friends room with art: a spectate probe (even through
//    an alias) must never make it watchable.
//  DINOS, the retired seasonal mural: member wipes refused, art preserved.
mkdirSync(path.join(SCRATCH, ".rooms"), { recursive: true });
writeFileSync(path.join(SCRATCH, ".rooms", "SECWALL.json"), JSON.stringify({
  audience: "artist_public",
  ownerProfileId: "sec_owner1",
  painters: ["sec_paint2"],
  title: "Offline Ink Studio",
  inktober: true,
  gallery: { listed: true, description: "offline studio", tags: ["ink"], publishedAt: "2026-10-01T00:00:00.000Z", event: "inktober-2026", moderationHidden: false },
  opCount: 1, savedAt: Date.now(), createdAt: Date.now() - 86400000,
}));
writeFileSync(path.join(SCRATCH, ".rooms", "SECWALL.history.json"), JSON.stringify({
  history: [{ kind: "draw", strokeId: "secwall1", points: [{ x: 1, y: 1 }], userId: "u_old", opId: 1 }],
}));
writeFileSync(path.join(SCRATCH, ".rooms", "SECFRN.json"), JSON.stringify({
  audience: "friends", title: "private room", opCount: 1,
  savedAt: Date.now(), createdAt: Date.now() - 3600000,
}));
writeFileSync(path.join(SCRATCH, ".rooms", "SECFRN.history.json"), JSON.stringify({
  history: [{ kind: "draw", strokeId: "secfrn1", points: [{ x: 2, y: 2 }], userId: "u", opId: 1 }],
}));
writeFileSync(path.join(SCRATCH, ".rooms", "DINOS.json"), JSON.stringify({
  audience: "kid_safe", listed: false, title: "Dinosaur Park", opCount: 1,
  savedAt: Date.now(), createdAt: Date.now() - 30 * 86400000,
}));
writeFileSync(path.join(SCRATCH, ".rooms", "DINOS.history.json"), JSON.stringify({
  history: [{ kind: "draw", strokeId: "dino1", points: [{ x: 3, y: 3 }], userId: "u_dino", opId: 1 }],
}));
// The INKTOBER mural as production has it: a public (kid_safe) seasonal room.
// Without a file getRoom would default it to 'friends', and, with accounts
// configured in this suite, guest joiners would be turned away at the door.
writeFileSync(path.join(SCRATCH, ".rooms", "INKTOBER.json"), JSON.stringify({
  audience: "kid_safe", listed: true, title: "Ink & Pencil", opCount: 0,
  savedAt: Date.now(), createdAt: Date.now() - 86400000,
}));
writeFileSync(path.join(SCRATCH, ".rooms", "INKTOBER.history.json"), JSON.stringify({ history: [] }));

// A stub dist/ so the SPA fallback exists without building the app.
const distDir = path.join(ROOT, "dist");
const madeStubDist = !existsSync(path.join(distDir, "index.html"));
if (madeStubDist) {
  mkdirSync(distDir, { recursive: true });
  copyFileSync(path.join(ROOT, "index.html"), path.join(distDir, "index.html"));
}

// ---- mock PocketBase -------------------------------------------------------
const TOKENS = {
  owner_token: { id: "sec_owner1", name: "Olivia Owner" },
  owner2_token: { id: "sec_owner2", name: "Oscar Owner" },
  painter_token: { id: "sec_paint2", name: "Pete Painter" },
  stranger_token: { id: "sec_strang3", name: "Sam Stranger" },
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
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ": " + String(detail).slice(0, 220) : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
const serverLog = [];
function boot() {
  const proc = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: SCRATCH,
      PB_URL: PB,
      INKTOBER_CLOCK_FILE: CLOCK_FILE,
      INKTOBER_TICK_MS: "150",
      AUTO_CLOSE_SWEEP_MS: "5000",
      AUTO_CLOSE_BASE_MS: "60000",
      AUTO_CLOSE_OWNED_BASE_MS: "60000",
      ARTIST_ROOMS_PER_ACCOUNT: "20",
    },
    stdio: "pipe",
  });
  proc.stderr.on("data", (d) => { serverLog.push(String(d)); if (serverLog.length > 40) serverLog.shift(); });
  return proc;
}
async function waitHealthy() {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) return true; } catch { /* boot */ }
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
async function connect(room, { token = null, headers = {} } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${encodeURIComponent(room)}`, { headers });
  const c = { ws, msgs: [], room };
  ws.on("message", (raw) => { try { c.msgs.push(JSON.parse(raw.toString())); } catch { /* binary/gz */ } });
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
  ws.send(JSON.stringify({ type: "auth", token, userKey: `dk_${Math.random().toString(36).slice(2, 12)}` }));
  await sleep(400); // join + history (raw clients shake hands first)
  clients.push(c);
  return c;
}
// Spectator handshake: resolves with the FIRST of connected / room_blocked.
function spectate(room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${encodeURIComponent(room)}&spectate=1`);
    const c = { ws, msgs: [], room };
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        c.msgs.push(m);
        if (m.type === "connected" || m.type === "room_blocked" || m.type === "room_full") resolve(c);
      } catch { /* binary/gz */ }
    });
    ws.on("error", reject);
    setTimeout(() => resolve(c), 3000);
    clients.push(c);
  });
}
const lastOf = (c, type) => [...c.msgs].reverse().find((m) => m.type === type);
const allOf = (c, type) => c.msgs.filter((m) => m.type === type);
async function waitFor(c, pred, ms = 3000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const hit = c.msgs.find(pred);
    if (hit) return hit;
    await sleep(60);
  }
  return null;
}
async function api(pathname, { method = "GET", token = null, body = null, adminKey = null } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (adminKey) headers["x-admin-key"] = adminKey;
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method, headers, body: body == null ? null : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}
const roomFileJson = (code) => JSON.parse(readFileSync(path.join(SCRATCH, ".rooms", `${code}.json`), "utf8"));
// persistRoom is debounced, poll the file until the predicate holds.
async function roomFileWait(code, pred, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const data = roomFileJson(code);
      if (pred(data)) return data;
    } catch { /* not written yet */ }
    await sleep(200);
  }
  try { return roomFileJson(code); } catch { return null; }
}

let strokeSeq = 0;
const sendDraw = (c, settings, end = true) => {
  strokeSeq += 1;
  c.ws.send(JSON.stringify({ type: "op", op: { kind: "draw", strokeId: `st${strokeSeq}`, settings, points: [{ x: 5, y: 5 }, { x: 15, y: 15 }], end } }));
  return `st${strokeSeq}`;
};
const gotStroke = (c, strokeId, ms = 900) => waitFor(c, (m) => m.type === "op" && m.op && m.op.strokeId === strokeId, ms);

const run = async () => {
  server = boot();
  check("server boots", await waitHealthy());
  const adminKey = readFileSync(path.join(SCRATCH, ".admin-key"), "utf8").trim();

  // ==========================================================================
  // A. Two-tab approve/revoke: the ACL is account-wide, every live session flips
  // ==========================================================================
  const mk = await api("/api/rooms", { method: "POST", token: "owner_token", body: { audience: "artist_public", title: "Security Studio" } });
  check("artist room created", mk.status === 200 && !!mk.json?.code, JSON.stringify(mk.json));
  const R1 = mk.json.code;
  const owner = await connect(R1, { token: "owner_token" });
  const tab1 = await connect(R1, { token: "painter_token" });
  const tab2 = await connect(R1, { token: "painter_token" }); // same account, second tab
  const watcher = await connect(R1); // guest viewer
  const tab1Id = lastOf(tab1, "connected")?.userId;
  check("two tabs get distinct session ids", !!tab1Id && lastOf(tab2, "connected")?.userId !== tab1Id);

  owner.ws.send(JSON.stringify({ type: "paint_approve", targetId: tab1Id }));
  const appr1 = await waitFor(tab1, (m) => m.type === "role_changed" && m.canPaint === true);
  const appr2 = await waitFor(tab2, (m) => m.type === "role_changed" && m.canPaint === true);
  check("approve via ONE session id flips canPaint on BOTH tabs", !!appr1 && !!appr2);
  const tab2Stroke = sendDraw(tab2, { brush: "pen", color: "#123", size: 4 });
  check("the second tab can draw right after the account approval", !!(await gotStroke(watcher, tab2Stroke)));

  owner.ws.send(JSON.stringify({ type: "paint_revoke", targetId: tab1Id }));
  const rev1 = await waitFor(tab1, (m) => m.type === "role_changed" && m.canPaint === false);
  const rev2 = await waitFor(tab2, (m) => m.type === "role_changed" && m.canPaint === false);
  check("revoke via ONE session id reaches BOTH tabs (role_changed canPaint:false)", !!rev1 && !!rev2);
  check("both tabs hear the revocation notice",
    !!(await waitFor(tab1, (m) => m.type === "paint_requested" && m.status === "revoked"))
    && !!(await waitFor(tab2, (m) => m.type === "paint_requested" && m.status === "revoked")));
  const denied1 = sendDraw(tab1, { brush: "pen", color: "#123", size: 4 });
  const denied2 = sendDraw(tab2, { brush: "pen", color: "#123", size: 4 });
  check("neither tab can draw after the revoke", !(await gotStroke(watcher, denied1)) && !(await gotStroke(watcher, denied2)));
  const revokedFile = await roomFileWait(R1, (d) => !(d.painters || []).includes("sec_paint2"));
  check("the revocation is persisted in the room file", !!revokedFile);

  // ==========================================================================
  // B. Approved NON-HOST painter: drawing kept, room-management powers denied
  // ==========================================================================
  owner.ws.send(JSON.stringify({ type: "paint_approve", targetId: tab1Id }));
  await waitFor(tab1, (m) => m.type === "role_changed" && m.canPaint === true);
  await waitFor(tab2, (m) => m.type === "role_changed" && m.canPaint === true);
  const paintStroke = sendDraw(tab1, { brush: "pen", color: "#0a0", size: 4 });
  check("approved painter still draws", !!(await gotStroke(watcher, paintStroke)));

  const wetMark = watcher.msgs.length;
  tab1.ws.send(JSON.stringify({ type: "set_wet", wet: true }));
  await sleep(700);
  check("painter set_wet broadcast nothing", !watcher.msgs.slice(wetMark).some((m) => m.type === "wet_state"));
  owner.ws.send(JSON.stringify({ type: "set_wet", wet: true }));
  check("control: the owner (host) CAN set_wet",
    !!(await waitFor(watcher, (m) => m.type === "wet_state" && m.wet === true)));

  const bmMark = watcher.msgs.length;
  tab1.ws.send(JSON.stringify({ type: "set_brush_mode", brushMode: "fun" }));
  await sleep(700);
  check("painter set_brush_mode broadcast nothing", !watcher.msgs.slice(bmMark).some((m) => m.type === "brush_mode_state"));

  const syMark = watcher.msgs.length;
  tab1.ws.send(JSON.stringify({ type: "set_symmetry", mode: "quad" }));
  await sleep(700);
  check("painter set_symmetry broadcast nothing", !watcher.msgs.slice(syMark).some((m) => m.type === "symmetry_state"));

  const vtMark = watcher.msgs.length;
  tab1.ws.send(JSON.stringify({ type: "vote_start" }));
  await sleep(700);
  check("painter vote_start opens no vote", !watcher.msgs.slice(vtMark).some((m) => m.type === "vote_open"));
  owner.ws.send(JSON.stringify({ type: "vote_start" }));
  check("control: the owner (host) CAN start a theme vote", !!(await waitFor(watcher, (m) => m.type === "vote_open")));

  // ==========================================================================
  // C. Bounded rate limits: owner publish / unpublish / offline revoke
  // ==========================================================================
  const mk2 = await api("/api/rooms", { method: "POST", token: "owner2_token", body: { audience: "artist_public", title: "Rate Studio" } });
  const R2 = mk2.json.code;
  let pubLast = null;
  for (let i = 0; i < 13; i += 1) {
    pubLast = await api(`/api/rooms/${R2}/publish`, { method: "POST", token: "owner2_token", body: { description: "d", tags: ["t"] } });
  }
  check("publish is rate-limited after a bounded burst (12/min)", pubLast.status === 429 && pubLast.json?.error === "rate_limited", `status ${pubLast.status}`);
  let unpubLast = null;
  let unpubOk = 0;
  for (let i = 0; i < 13; i += 1) {
    unpubLast = await api(`/api/rooms/${R2}/unpublish`, { method: "POST", token: "owner2_token" });
    if (unpubLast.status === 200) unpubOk += 1;
  }
  check("unpublish allows ordinary use then 429s", unpubOk > 0 && unpubLast.status === 429 && unpubLast.json?.error === "rate_limited", `ok=${unpubOk} last=${unpubLast.status}`);
  let revLast = null;
  let revOk = 0;
  for (let i = 0; i < 31; i += 1) {
    revLast = await api(`/api/rooms/${R2}/painters/revoke`, { method: "POST", token: "owner2_token", body: { profileId: "zzz_nobody" } });
    if (revLast.status === 200) revOk += 1;
  }
  check("offline revoke allows ordinary use then 429s (30/min)", revOk === 30 && revLast.status === 429 && revLast.json?.error === "rate_limited", `ok=${revOk} last=${revLast.status}`);

  // ==========================================================================
  // D. Country attribution: cf-ipcountry ONLY; x-country-code spoof suppressed
  // ==========================================================================
  // Guests join the public MAIN hall (private rooms need an account here).
  for (let i = 0; i < 5; i += 1) await connect("MAIN", { headers: { "x-country-code": "FR" } }); // spoof attempt
  for (let i = 0; i < 5; i += 1) await connect("MAIN", { headers: { "cf-ipcountry": "DE" } }); // trusted edge header
  for (let i = 0; i < 5; i += 1) await connect("MAIN", { headers: { "cf-ipcountry": "T1" } }); // Tor, excluded
  const jarRes = await api("/api/paintjar");
  const jar = jarRes.json;
  const bag = Object.fromEntries((jar?.countries || []).map((c) => [c.code, c.count]));
  check("cf-ipcountry is recorded (DE present)", (bag.DE || 0) >= 5, JSON.stringify(bag));
  check("x-country-code spoof is NOT recorded (no FR)", !bag.FR, JSON.stringify(bag));
  check("T1 is excluded like XX", !bag.T1 && !bag.XX, JSON.stringify(bag));

  // ==========================================================================
  // E. friends -> artist publish: 409 on incompatible state, room UNCHANGED
  // ==========================================================================
  const mk3 = await api("/api/rooms", { method: "POST", token: "owner_token", body: { audience: "friends", title: "Flipbook Room" } });
  check("friends room created", mk3.status === 200 && !!mk3.json?.code, JSON.stringify(mk3.json));
  const R3 = mk3.json.code;
  const animOwner = await connect(R3, { token: "owner_token" });
  animOwner.ws.send(JSON.stringify({ type: "set_animation", enabled: true }));
  check("animation enabled in the private room",
    !!(await waitFor(animOwner, (m) => m.type === "room_animation" && m.enabled === true)));
  const badPub = await api(`/api/rooms/${R3}/publish`, { method: "POST", token: "owner_token", body: { description: "going public" } });
  check("publish of an animation room is rejected 409 incompatible_state",
    badPub.status === 409 && badPub.json?.error === "incompatible_state", JSON.stringify(badPub));
  const r3file = await roomFileWait(R3, (d) => d.audience === "friends" || d.audience === "artist_public");
  check("the private room is UNCHANGED after the denied conversion",
    !!r3file && r3file.audience === "friends" && !!r3file.animation && !(r3file.painters || []).length,
    r3file && `audience=${r3file.audience} animation=${!!r3file.animation}`);
  animOwner.ws.send(JSON.stringify({ type: "set_animation", enabled: false }));
  await waitFor(animOwner, (m) => m.type === "room_animation" && m.enabled === false);
  const goodPub = await api(`/api/rooms/${R3}/publish`, { method: "POST", token: "owner_token", body: { description: "going public" } });
  check("a clean friends room still converts on publish", goodPub.status === 200 && goodPub.json?.audience === "artist_public", JSON.stringify(goodPub.json).slice(0, 160));

  // ==========================================================================
  // F. Protected murals: INKTOBER + retired DINOS refuse member wipe requests
  // ==========================================================================
  const inkA = await connect("INKTOBER");
  const inkB = await connect("INKTOBER");
  const inkStroke = sendDraw(inkA, { brush: "ink", color: "#111", size: 5 });
  check("INKTOBER mural accepts ink", !!(await gotStroke(inkB, inkStroke)));
  inkA.ws.send(JSON.stringify({ type: "wipe_request" }));
  const inkDeny = await waitFor(inkA, (m) => m.type === "wipe_req_denied", 1500);
  check("INKTOBER member wipe_request is refused (protected mural)",
    !!inkDeny && inkDeny.reason === "protected" && !allOf(inkB, "wipe_req").length,
    JSON.stringify(inkDeny));
  inkA.ws.send(JSON.stringify({ type: "clear" }));
  const inkDeny2 = await waitFor(inkA, (m) => m.type === "wipe_req_denied" && m !== inkDeny, 1500);
  check("INKTOBER bare clear cannot degrade into a wipe countdown either",
    !!inkDeny2 && inkDeny2.reason === "protected" && !allOf(inkB, "wipe_req").length,
    JSON.stringify(inkDeny2));
  const inkC = await connect("INKTOBER");
  check("the shared INKTOBER art is still there for the next visitor",
    !!(await waitFor(inkC, (m) => m.type === "history" && (m.ops || []).some((op) => op.strokeId === inkStroke))));

  const dinoA = await connect("DINOS");
  check("retired DINOS mural loads its preserved art",
    !!(await waitFor(dinoA, (m) => m.type === "history" && (m.ops || []).some((op) => op.strokeId === "dino1"))));
  dinoA.ws.send(JSON.stringify({ type: "wipe_request" }));
  const dinoDeny = await waitFor(dinoA, (m) => m.type === "wipe_req_denied", 1500);
  check("retired DINOS member wipe_request is refused", !!dinoDeny && dinoDeny.reason === "protected", JSON.stringify(dinoDeny));
  const dinoB = await connect("DINOS");
  check("the DINOS art survives the refused wipe",
    !!(await waitFor(dinoB, (m) => m.type === "history" && (m.ops || []).some((op) => op.strokeId === "dino1"))));

  const admClear = await api("/api/admin/rooms/INKTOBER/clear", { method: "POST", adminKey });
  check("admin moderation wipe is retained on the protected mural", admClear.status === 200 && admClear.json?.ok === true, JSON.stringify(admClear));
  const inkD = await connect("INKTOBER");
  check("the admin wipe actually cleared the mural",
    !!(await waitFor(inkD, (m) => m.type === "history" && (m.ops || []).length === 0)));

  // ==========================================================================
  // G. Wall event attribution: artist-studio stamps need owner/approved painter
  // ==========================================================================
  const wallPost = (body, token = null) => api("/api/wall", { method: "POST", token, body });
  const anonPost = await wallPost({ frames: [PNG], durationMs: 400, userKey: "dk_secanon1", title: "anon claim", room: "SECWALL" });
  check("anonymous post quoting the studio code is accepted as ordinary art", anonPost.status === 200 && !!anonPost.json?.id, JSON.stringify(anonPost));
  const anonMeta = (await api(`/api/wall/${anonPost.json.id}`)).json?.post;
  check("...but gets NO event stamp and no inktober tag",
    anonMeta && anonMeta.event === null && !(anonMeta.tags || []).includes("inktober") && anonMeta.eventDay === null,
    anonMeta && `event=${anonMeta.event} tags=${(anonMeta.tags || []).join(",")}`);
  const strangerPost = await wallPost({ frames: [PNG], durationMs: 400, userKey: "dk_x", title: "stranger claim", room: "SECWALL" }, "stranger_token");
  const strangerMeta = strangerPost.json?.id ? (await api(`/api/wall/${strangerPost.json.id}`)).json?.post : null;
  check("a signed-in STRANGER quoting the studio code gets no event stamp either",
    strangerPost.status === 200 && strangerMeta && strangerMeta.event === null,
    strangerMeta && `event=${strangerMeta.event}`);
  const painterPost = await wallPost({ frames: [PNG], durationMs: 400, userKey: "dk_x", title: "painter ink", room: "SECWALL" }, "painter_token");
  const painterMeta = painterPost.json?.id ? (await api(`/api/wall/${painterPost.json.id}`)).json?.post : null;
  check("the APPROVED PAINTER (persisted ACL, offline room) is stamped",
    painterPost.status === 200 && painterMeta && painterMeta.event === "inktober-2026" && (painterMeta.tags || []).includes("inktober"),
    painterMeta && `event=${painterMeta.event} day=${painterMeta.eventDay}`);
  const ownerPost = await wallPost({ frames: [PNG], durationMs: 400, userKey: "dk_x", title: "owner ink", room: "SECWALL" }, "owner_token");
  const ownerMeta = ownerPost.json?.id ? (await api(`/api/wall/${ownerPost.json.id}`)).json?.post : null;
  check("the verified OWNER is stamped",
    ownerPost.status === 200 && ownerMeta && ownerMeta.event === "inktober-2026" && ownerMeta.eventDay === 5,
    ownerMeta && `event=${ownerMeta.event} day=${ownerMeta.eventDay}`);
  const sharedPost = await wallPost({ frames: [PNG], durationMs: 400, userKey: "dk_secshared1", title: "shared mural ink", room: "INKTOBER" });
  const sharedMeta = sharedPost.json?.id ? (await api(`/api/wall/${sharedPost.json.id}`)).json?.post : null;
  check("the shared INKTOBER room still self-stamps (prompt participation)",
    sharedPost.status === 200 && sharedMeta && sharedMeta.event === "inktober-2026",
    sharedMeta && `event=${sharedMeta.event}`);

  // ==========================================================================
  // H. Spectate: canonical ids, stored-audience precheck before materializing
  // ==========================================================================
  const aliasSpec = await spectate("SECWALL..");
  const aliasConn = lastOf(aliasSpec, "connected");
  check("an artist studio is watchable through an ALIAS, canonicalized to one room id",
    !!aliasConn && aliasConn.spectator === true && aliasConn.roomId === "SECWALL",
    aliasConn && `roomId=${aliasConn.roomId}`);
  const privAlias = await spectate("SECFRN!!");
  check("a private room is NOT watchable through an alias",
    !!lastOf(privAlias, "room_blocked") && !lastOf(privAlias, "connected"));
  const privCanon = await spectate("SECFRN");
  check("a private room is NOT watchable by its canonical code either",
    !!lastOf(privCanon, "room_blocked") && !lastOf(privCanon, "connected"));
  // Had the probes above materialized the friends room into the live map, this
  // member join would share state with them; a fresh join must still see the
  // untouched private room with its art.
  const frMember = await connect("SECFRN", { token: "owner_token" });
  check("the probed private room still joins cleanly with its art intact",
    !!(await waitFor(frMember, (m) => m.type === "history" && (m.ops || []).some((op) => op.strokeId === "secfrn1"))));
};

let failures = 0;
try {
  await run();
} catch (err) {
  check(`suite crashed: ${err && err.message}`, false);
  console.error(err);
  console.error("---- server log tail ----\n" + serverLog.join(""));
} finally {
  await killServer(server);
  for (const c of clients) { try { c.ws.close(); } catch { /* closed */ } }
  mock.close();
  if (madeStubDist) { try { rmSync(path.join(distDir, "index.html"), { force: true }); } catch { /* leave */ } }
}
failures = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
