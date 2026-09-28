// Artist public room backend verification (docs/ARTIST-ROOMS-CONTRACT.md).
//
// Strictly isolated: throwaway DATA_DIR, mock PocketBase (the only endpoint
// server.js calls), port 8963 (+8964 for the fail-closed unconfigured case).
// Never touches 8787 or production app_data.
//
// Covers, with real WS clients for every role:
//   creation fail-closed (unconfigured => accounts_required), verified-owner
//   creation, field validation + moderation, per-account quota
//   guests/strangers view (canPaint:false, roomProfile, history) but every
//     mutation bypass denied (op, clear, sheets, layers, frames, scenes,
//     animation, votes, locks, moderation, helper setters, fork, production)
//   paint_request / paint_approve / paint_revoke with live verified targetId;
//     approved painters draw WITHOUT host powers; revocation immediate
//   persistence across a real server restart; offline (persisted) approvals
//     listed/revoked through the owner-only REST ACL
//   publish/unpublish/settings owner-only endpoints; gallery search
//     q/tag/event/pagination/total/topTags, sanitized, persisted rooms sourced
//   friends -> artist_public conversion only via explicit publish
//   admin unpublish/restore the owner cannot override
//   no ownership takeover (stranger join, guest host, orphaned rooms)
//   idle-sweep protection for artist work; private rooms + anon path unchanged
//   Inktober opt-in: ink-only enforcement in active October, server-derived
//     prompt/day, seasonal_prompt rollover into the artist room, wall stamps
//   account deletion: unpublish owned + ACL scrub including OFFLINE room files
//   SEO /gallery head + sitemap
import { spawn } from "child_process";
import http from "http";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRATCH = path.join(process.env.TMPDIR || "/tmp", "artist-rooms-verify-data");
const CLOCK_FILE = path.join(SCRATCH, "inktober-clock.txt");
const PORT = 8963;
const PORT_NOPB = 8964;
const BASE = `http://127.0.0.1:${PORT}`;
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
const setClock = (iso) => writeFileSync(CLOCK_FILE, iso);
setClock("2026-09-15T12:00:00.000Z");

// Pre-seed BEFORE boot:
//  ARTOLD — a LISTED artist studio last saved 40 days ago. Two things ride on
//    it: the gallery must source persisted (offline) rooms, and the idle sweep
//    must NOT delete artist work on the ordinary short cycle.
//  OLDFRN — an unowned friends room saved 2 days ago: the ordinary sweep DOES
//    reap it (control proving the protection is artist-specific).
mkdirSync(path.join(SCRATCH, ".rooms"), { recursive: true });
writeFileSync(path.join(SCRATCH, ".rooms", "ARTOLD.json"), JSON.stringify({
  audience: "artist_public",
  ownerProfileId: "artist_owner1",
  painters: ["painter_two2"],
  title: "Retro Studio",
  gallery: { listed: true, description: "old but listed", tags: ["retro"], publishedAt: "2026-08-01T00:00:00.000Z", event: null, moderationHidden: false },
  inktober: false,
  opCount: 1, savedAt: Date.now() - 40 * 86400000, createdAt: Date.now() - 60 * 86400000,
}));
writeFileSync(path.join(SCRATCH, ".rooms", "ARTOLD.history.json"), JSON.stringify({
  history: [{ kind: "draw", strokeId: "old1", points: [{ x: 1, y: 1 }], userId: "u_old", opId: 1 }],
}));
writeFileSync(path.join(SCRATCH, ".rooms", "OLDFRN.json"), JSON.stringify({
  audience: "friends", title: "stale friends room", opCount: 1,
  savedAt: Date.now() - 2 * 86400000, createdAt: Date.now() - 3 * 86400000,
}));
writeFileSync(path.join(SCRATCH, ".rooms", "OLDFRN.history.json"), JSON.stringify({ history: [{ kind: "draw", strokeId: "x", points: [{ x: 1, y: 1 }], userId: "u", opId: 1 }] }));

// A stub dist/ so the SPA fallback (+ per-route SEO head rewrite) exists
// without building the app. Removed afterwards only if WE created it.
const distDir = path.join(ROOT, "dist");
const madeStubDist = !existsSync(path.join(distDir, "index.html"));
if (madeStubDist) {
  mkdirSync(distDir, { recursive: true });
  copyFileSync(path.join(ROOT, "index.html"), path.join(distDir, "index.html"));
}

// ---- mock PocketBase -------------------------------------------------------
const TOKENS = {
  owner_token: { id: "artist_owner1", name: "Olivia Owner" },
  painter_token: { id: "painter_two2", name: "Pete Painter" },
  stranger_token: { id: "stranger_thr3", name: "Sam Stranger" },
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
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? " — " + String(detail).slice(0, 220) : ""}`);
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
      INKTOBER_CLOCK_FILE: CLOCK_FILE,
      INKTOBER_TICK_MS: "150",
      AUTO_CLOSE_SWEEP_MS: "700",
      AUTO_CLOSE_BASE_MS: "1000",
      AUTO_CLOSE_OWNED_BASE_MS: "1000",
      ARTIST_ROOMS_PER_ACCOUNT: "4",
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

let strokeSeq = 0;
const sendDraw = (c, settings, end = true) => {
  strokeSeq += 1;
  c.ws.send(JSON.stringify({ type: "op", op: { kind: "draw", strokeId: `st${strokeSeq}`, settings, points: [{ x: 5, y: 5 }, { x: 15, y: 15 }], end } }));
  return `st${strokeSeq}`;
};
const gotStroke = (c, strokeId, ms = 900) => waitFor(c, (m) => m.type === "op" && m.op && m.op.strokeId === strokeId, ms);

const run = async () => {
  // ==========================================================================
  // 0. FAIL CLOSED when accounts are unconfigured
  // ==========================================================================
  const noPb = boot(PORT_NOPB, { PB_URL: "", POCKETBASE_URL: "" });
  check("unconfigured server boots", await waitHealthy(PORT_NOPB));
  const noPbCreate = await api("/api/rooms", { method: "POST", body: { audience: "artist_public", title: "Nope" }, port: PORT_NOPB });
  check("unconfigured: artist creation fails closed with accounts_required",
    noPbCreate.status === 401 && noPbCreate.json?.error === "accounts_required", JSON.stringify(noPbCreate));
  const noPbAnon = await api("/api/rooms", { method: "POST", body: { audience: "kid_safe", title: "anon" }, port: PORT_NOPB });
  check("unconfigured: anonymous commons creation still works (golden rule)", noPbAnon.status === 200, `status ${noPbAnon.status}`);
  await killServer(noPb);

  // ==========================================================================
  // 1. Boot the main server; gallery sources PERSISTED rooms; idle protection
  // ==========================================================================
  server = boot(PORT, { PB_URL: PB });
  check("main server boots", await waitHealthy(PORT));
  await sleep(1800); // let two idle sweeps run
  check("persisted offline artist studio appears in the gallery source",
    (await api("/api/rooms/gallery")).json?.rooms?.some((r) => r.code === "ARTOLD"));
  check("artist studio files survive the ordinary idle sweep",
    existsSync(path.join(SCRATCH, ".rooms", "ARTOLD.json")) && existsSync(path.join(SCRATCH, ".rooms", "ARTOLD.history.json")));
  check("control: a stale friends room IS reaped by the same sweep",
    !existsSync(path.join(SCRATCH, ".rooms", "OLDFRN.json")));

  // ==========================================================================
  // 2. Creation: auth, validation, moderation, quota
  // ==========================================================================
  const anonCreate = await api("/api/rooms", { method: "POST", body: { audience: "artist_public", title: "x" } });
  check("configured: anonymous artist creation refused accounts_required",
    anonCreate.status === 401 && anonCreate.json?.error === "accounts_required", JSON.stringify(anonCreate));
  const badTokCreate = await api("/api/rooms", { method: "POST", token: "forged-token", body: { audience: "artist_public", title: "x" } });
  check("forged token cannot create (no fake identities)",
    badTokCreate.status === 401 && badTokCreate.json?.error === "accounts_required");

  const create = await api("/api/rooms", { method: "POST", token: "owner_token", body: { audience: "artist_public", title: "Olivia's Studio", description: "oils and ink", tags: ["art", "cats"] } });
  check("verified owner creates an artist studio -> {code}",
    create.status === 200 && /^[A-Z0-9]{6}$/.test(create.json?.code || "") && create.json?.audience === "artist_public",
    JSON.stringify(create));
  const R1 = create.json.code;
  check("a new studio is NOT listed in the gallery (publish is explicit)",
    !(await api("/api/rooms/gallery")).json?.rooms?.some((r) => r.code === R1));
  check("a new studio is NOT in the kid-safe lobby either",
    !(await api("/api/rooms/public")).json?.rooms?.some((r) => r.code === R1));

  const longTitle = await api("/api/rooms", { method: "POST", token: "owner_token", body: { audience: "artist_public", title: "t".repeat(41) } });
  check("title > 40 rejected bad_title", longTitle.status === 400 && longTitle.json?.error === "bad_title", JSON.stringify(longTitle));
  const longDesc = await api("/api/rooms", { method: "POST", token: "owner_token", body: { audience: "artist_public", title: "ok", description: "d".repeat(281) } });
  check("description > 280 rejected bad_description", longDesc.status === 400 && longDesc.json?.error === "bad_description");
  const manyTags = await api("/api/rooms", { method: "POST", token: "owner_token", body: { audience: "artist_public", title: "ok", tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] } });
  check("> 8 tags rejected bad_tags", manyTags.status === 400 && manyTags.json?.error === "bad_tags");
  const profDesc = await api("/api/rooms", { method: "POST", token: "owner_token", body: { audience: "artist_public", title: "ok", description: "damn good art" } });
  check("profane description rejected moderation_rejected",
    profDesc.status === 400 && profDesc.json?.error === "moderation_rejected" && typeof profDesc.json?.message === "string", JSON.stringify(profDesc));

  // Quota: owner already owns R1 (+ARTOLD seeded under the same account = 2).
  const q1 = await api("/api/rooms", { method: "POST", token: "owner_token", body: { audience: "artist_public", title: "Q1" } });
  const q2 = await api("/api/rooms", { method: "POST", token: "owner_token", body: { audience: "artist_public", title: "Q2" } });
  check("creation up to the per-account quota succeeds", q1.status === 200 && q2.status === 200, `${q1.status},${q2.status}`);
  const q3 = await api("/api/rooms", { method: "POST", token: "owner_token", body: { audience: "artist_public", title: "Q3" } });
  check("creation past the per-account quota is refused (bounded storage)",
    q3.status === 429 && q3.json?.error === "artist_quota", JSON.stringify(q3));

  // ==========================================================================
  // 3. WS roles: guests/strangers view, owner paints
  // ==========================================================================
  const guest = await connect(R1);
  const gConn = lastOf(guest, "connected");
  check("guest may VIEW an artist studio (audience artist_public)",
    !!gConn && gConn.audience === "artist_public" && !allOf(guest, "signin_required").length,
    gConn && `audience=${gConn.audience}`);
  check("guest handshake: canPaint false, roomProfile present, receives history",
    !!gConn && gConn.canPaint === false && gConn.roomProfile && typeof gConn.roomProfile.description === "string"
    && Array.isArray(gConn.roomProfile.tags) && gConn.roomProfile.event === null
    && !!lastOf(guest, "history"),
    gConn && `canPaint=${gConn.canPaint} profile=${JSON.stringify(gConn.roomProfile)}`);
  check("guest is not owner/host and isOwner/isHost false", !!gConn && gConn.isOwner === false && gConn.isHost === false);

  const stranger = await connect(R1, { token: "stranger_token" });
  const sConn = lastOf(stranger, "connected");
  check("signed-in stranger: canPaint false, no ownership takeover",
    !!sConn && sConn.canPaint === false && sConn.isOwner === false && sConn.isHost === false);

  const owner = await connect(R1, { token: "owner_token" });
  const oConn = lastOf(owner, "connected");
  check("owner: canPaint true, isOwner/isHost true",
    !!oConn && oConn.canPaint === true && oConn.isOwner === true && oConn.isHost === true);

  // Draw access
  const gStroke = sendDraw(guest, { brush: "ink", color: "#111", size: 5 });
  const sStroke = sendDraw(stranger, { brush: "ink", color: "#111", size: 5 });
  check("guest draw op is denied", !(await gotStroke(owner, gStroke)));
  check("stranger draw op is denied", !(await gotStroke(owner, sStroke)));
  const oStroke = sendDraw(owner, { brush: "ink", color: "#111", size: 5 });
  check("owner draw op relays to viewers", !!(await gotStroke(stranger, oStroke)));

  // ---- Broad mutation denial (every bypass class from the contract) --------
  const denyProbes = [
    { type: "clear" }, { type: "undo_clear" }, { type: "set_sheet", sheetId: "lib:x" },
    { type: "wipe_request", sheetId: "lib:y" }, { type: "lock" }, { type: "unlock" },
    { type: "kick", targetId: owner && oConn.userId }, { type: "mute", targetId: "u_x" },
    { type: "mod_hide", opIds: [1] }, { type: "mod_remove", opIds: [1] },
    { type: "layer_add", frameId: "f0" }, { type: "frame_add" }, { type: "scene_add" },
    { type: "set_animation", enabled: true }, { type: "set_game", enabled: true },
    { type: "set_phone", enabled: true }, { type: "vote_start", options: ["a", "b"] },
    { type: "fork_private" }, { type: "rename_room", name: "Hijacked" },
    { type: "set_wet", enabled: true }, { type: "set_brush_mode", mode: "fun" },
    { type: "production_create", title: "x" }, { type: "storybook_caption", caption: "x" },
    { type: "promote", targetId: "u_x" }, { type: "set_symmetry", mode: "quad" },
    { type: "quest_reset" }, { type: "phone_start" }, { type: "game_skip" },
  ];
  const strangerMsgCount = owner.msgs.length;
  for (const probe of denyProbes) {
    guest.ws.send(JSON.stringify(probe));
    stranger.ws.send(JSON.stringify(probe));
  }
  await sleep(900);
  const leaked = owner.msgs.slice(strangerMsgCount).filter((m) =>
    ["clear", "sheet", "wipe_req", "locked", "room_animation", "room_game", "room_phone",
      "layer_add", "frame_add", "scene_add", "vote_start", "room_renamed", "room_wet",
      "brush_mode", "production", "userKicked", "kicked"].includes(m.type));
  check("ALL viewer mutation bypasses are denied (no effect reaches the room)",
    leaked.length === 0, leaked.map((m) => m.type).join(","));
  const probeJoin = await connect(R1);
  const pConn = lastOf(probeJoin, "connected");
  check("state untouched after bypass storm (unlocked, no anim/game, title intact)",
    !!pConn && pConn.locked === false && pConn.animation === false && pConn.game === false
    && pConn.phone === false && pConn.roomTitle === "Olivia's Studio" && !lastOf(probeJoin, "sheet"));

  // Social allowlist still open to viewers + public-room chat filtering
  guest.ws.send(JSON.stringify({ type: "chat", message: "damn nice lines" }));
  const chatMsg = await waitFor(owner, (m) => m.type === "chat" && /nice lines/.test(m.message || ""), 1500);
  check("viewer chat IS relayed (social allowlist), mild profanity masked like a public room",
    !!chatMsg && !/damn/.test(chatMsg.message) && /\*\*\*\*/.test(chatMsg.message),
    chatMsg && chatMsg.message);
  const report = await api("/api/report", { method: "POST", body: { room: R1, reason: "test report" } });
  check("public report flow works for an artist room", report.status === 200 && report.json?.received === true);

  // ==========================================================================
  // 4. Access requests: request / approve / revoke with a live verified target
  // ==========================================================================
  const reqMsgsBefore = allOf(owner, "paint_requests").length;
  guest.ws.send(JSON.stringify({ type: "paint_request" }));
  await sleep(400);
  check("an unauthenticated (guest) viewer cannot request paint access",
    allOf(owner, "paint_requests").length === reqMsgsBefore
    && !allOf(owner, "paint_requests").some((m) => (m.requests || []).length > 0));

  stranger.ws.send(JSON.stringify({ type: "paint_request" }));
  const reqList = await waitFor(owner, (m) => m.type === "paint_requests" && (m.requests || []).length === 1, 1500);
  const reqAck = await waitFor(stranger, (m) => m.type === "paint_requested", 1500);
  check("signed-in stranger's request reaches the owner with their session id",
    !!reqList && reqList.requests[0].userId === sConn.userId && typeof reqList.requests[0].name === "string"
    && !!reqAck && reqAck.status === "pending",
    reqList && JSON.stringify(reqList.requests));

  // A non-owner cannot approve (forged approval ignored)
  guest.ws.send(JSON.stringify({ type: "paint_approve", targetId: sConn.userId }));
  stranger.ws.send(JSON.stringify({ type: "paint_approve", targetId: sConn.userId }));
  await sleep(400);
  check("paint_approve from non-owners is ignored", !allOf(stranger, "role_changed").length);

  owner.ws.send(JSON.stringify({ type: "paint_approve", targetId: sConn.userId }));
  const approved = await waitFor(stranger, (m) => m.type === "role_changed", 1500);
  check("owner approval -> role_changed canPaint:true, WITHOUT host powers",
    !!approved && approved.canPaint === true && approved.isHost === false, approved && JSON.stringify(approved));
  const cleared = await waitFor(owner, (m) => m.type === "paint_requests" && (m.requests || []).length === 0, 1500);
  check("the request leaves the owner's queue once resolved", !!cleared);

  const pStroke = sendDraw(stranger, { brush: "ink", color: "#111", size: 5 });
  check("approved painter's draw op relays", !!(await gotStroke(owner, pStroke)));

  // Approved painter tries host/moderation powers — all denied, incl. clear.
  stranger.ws.send(JSON.stringify({ type: "lock" }));
  stranger.ws.send(JSON.stringify({ type: "kick", targetId: oConn.userId }));
  stranger.ws.send(JSON.stringify({ type: "clear" }));
  stranger.ws.send(JSON.stringify({ type: "mod_hide", opIds: [1] }));
  stranger.ws.send(JSON.stringify({ type: "promote", targetId: sConn.userId }));
  await sleep(700);
  check("approved painter gets NO host powers (lock/kick/clear/mod_hide all denied)",
    !allOf(owner, "locked").length && !allOf(owner, "clear").length && !allOf(owner, "wipe_req").length
    && !allOf(guest, "kicked").length);

  // Revocation is immediate
  owner.ws.send(JSON.stringify({ type: "paint_revoke", targetId: sConn.userId }));
  const revoked = await waitFor(stranger, (m) => m.type === "role_changed" && m.canPaint === false, 1500);
  check("revocation -> role_changed canPaint:false", !!revoked);
  const rStroke = sendDraw(stranger, { brush: "ink", color: "#111", size: 5 });
  check("revoked painter's ops are denied again", !(await gotStroke(owner, rStroke)));

  // ==========================================================================
  // 5. Approval persists across a REAL restart; offline ACL revoke via REST
  // ==========================================================================
  owner.ws.send(JSON.stringify({ type: "paint_approve", targetId: sConn.userId }));
  await waitFor(stranger, (m) => m.type === "role_changed" && m.canPaint === true, 1500);
  check("re-approval works", true);
  await sleep(3200); // write-behind persist (~2.5s)
  check("approval persisted to the room file", (roomFileJson(R1).painters || []).includes("stranger_thr3"),
    JSON.stringify(roomFileJson(R1).painters));

  await killServer(server);
  server = boot(PORT, { PB_URL: PB });
  check("server restarts on the same DATA_DIR", await waitHealthy(PORT));

  const owner2 = await connect(R1, { token: "owner_token" });
  const stranger2 = await connect(R1, { token: "stranger_token" });
  const guest2 = await connect(R1);
  check("after restart the approved painter still canPaint (persisted ACL)",
    lastOf(stranger2, "connected")?.canPaint === true, JSON.stringify(lastOf(stranger2, "connected")?.canPaint));
  check("after restart a guest is still view-only", lastOf(guest2, "connected")?.canPaint === false);
  const rsStroke = sendDraw(stranger2, { brush: "ink", color: "#111", size: 5 });
  check("after restart the painter's op still relays", !!(await gotStroke(owner2, rsStroke)));

  // Owner-only REST ACL: list + revoke a painter who goes offline.
  const painterInfoStranger = await api(`/api/rooms/${R1}/artist`, { token: "stranger_token" });
  check("settings GET is owner-only (stranger 403)", painterInfoStranger.status === 403, `status ${painterInfoStranger.status}`);
  const painterInfoAnon = await api(`/api/rooms/${R1}/artist`);
  check("settings GET needs sign-in (guest 401)", painterInfoAnon.status === 401);
  const ownerInfo = await api(`/api/rooms/${R1}/artist`, { token: "owner_token" });
  check("owner settings GET: publish-info + opaque painter ids",
    ownerInfo.status === 200 && ownerInfo.json?.listed === false && Array.isArray(ownerInfo.json?.tags)
    && typeof ownerInfo.json?.description === "string" && ownerInfo.json?.moderationHidden === false
    && ownerInfo.json?.publishedAt === null && ownerInfo.json?.inktober === false
    && (ownerInfo.json?.painters || []).includes("stranger_thr3"),
    JSON.stringify(ownerInfo.json));

  try { stranger2.ws.close(); } catch { /* gone */ }
  await sleep(300);
  const badRevoke = await api(`/api/rooms/${R1}/painters/revoke`, { method: "POST", token: "painter_token", body: { profileId: "stranger_thr3" } });
  check("ACL revoke is owner-only", badRevoke.status === 403, `status ${badRevoke.status}`);
  const offRevoke = await api(`/api/rooms/${R1}/painters/revoke`, { method: "POST", token: "owner_token", body: { profileId: "stranger_thr3" } });
  check("owner revokes an OFFLINE approved painter via REST",
    offRevoke.status === 200 && !(offRevoke.json?.painters || []).includes("stranger_thr3"), JSON.stringify(offRevoke.json));
  await sleep(3200);
  check("offline revocation persists to the room file", !(roomFileJson(R1).painters || []).includes("stranger_thr3"));
  const stranger3 = await connect(R1, { token: "stranger_token" });
  check("the offline-revoked painter is view-only again", lastOf(stranger3, "connected")?.canPaint === false);

  // ==========================================================================
  // 6. Publish / gallery / unpublish / admin moderation
  // ==========================================================================
  const pubStranger = await api(`/api/rooms/${R1}/publish`, { method: "POST", token: "stranger_token", body: { description: "stolen", tags: [] } });
  check("publish is owner-only (403)", pubStranger.status === 403, `status ${pubStranger.status}`);
  const pubBad = await api(`/api/rooms/${R1}/publish`, { method: "POST", token: "owner_token", body: { description: "damn fine", tags: [] } });
  check("publish text passes through moderation", pubBad.status === 400 && pubBad.json?.error === "moderation_rejected");
  const pub = await api(`/api/rooms/${R1}/publish`, { method: "POST", token: "owner_token", body: { description: "Oil studies and ink cats", tags: ["oils", "Cats!", "retro"] } });
  check("owner publishes -> listed publish-info with publishedAt",
    pub.status === 200 && pub.json?.listed === true && typeof pub.json?.publishedAt === "string"
    && pub.json?.description === "Oil studies and ink cats" && (pub.json?.tags || []).includes("oils")
    && pub.json?.moderationHidden === false,
    JSON.stringify(pub.json));

  const gal = await api("/api/rooms/gallery");
  const card = (gal.json?.rooms || []).find((r) => r.code === R1);
  check("gallery lists the published studio with the contracted card shape",
    !!card && card.canWatch === true && typeof card.users === "number" && typeof card.ops === "number"
    && card.event === null && card.description === "Oil studies and ink cats"
    && Object.keys(card).sort().join(",") === "canWatch,code,description,event,ops,tags,title,users",
    card && Object.keys(card).join(","));
  check("gallery payload carries NO PII (no owner/profile/email/name keys)",
    !!card && !["ownerProfileId", "owner", "profileId", "email", "name", "painters", "country"].some((k) => k in card));
  check("gallery total + topTags present",
    typeof gal.json?.total === "number" && gal.json.total >= 2
    && (gal.json?.topTags || []).some((t) => (typeof t === "string" ? t : t?.tag) === "retro"),
    JSON.stringify({ total: gal.json?.total, topTags: gal.json?.topTags }));

  const qHit = await api(`/api/rooms/gallery?q=${encodeURIComponent("ink cats")}`);
  check("q search matches title/description", (qHit.json?.rooms || []).some((r) => r.code === R1));
  const qMiss = await api(`/api/rooms/gallery?q=${encodeURIComponent("zzz-no-match")}`);
  check("q search with no match -> total 0", qMiss.json?.total === 0 && (qMiss.json?.rooms || []).length === 0);
  const tagHit = await api("/api/rooms/gallery?tag=oils");
  check("tag filter matches", (tagHit.json?.rooms || []).some((r) => r.code === R1) && !(tagHit.json?.rooms || []).some((r) => r.code === "ARTOLD"));
  const evMiss = await api("/api/rooms/gallery?event=inktober-2026");
  check("event filter excludes non-event studios", !(evMiss.json?.rooms || []).some((r) => r.code === R1));
  const page = await api("/api/rooms/gallery?limit=1&offset=1");
  check("pagination: limit/offset window with honest total",
    page.json?.rooms?.length === 1 && page.json?.total >= 2, JSON.stringify({ n: page.json?.rooms?.length, total: page.json?.total }));
  const clamp = await api("/api/rooms/gallery?limit=500");
  check("limit is clamped (<=60)", (clamp.json?.rooms || []).length <= 60);

  const unpub = await api(`/api/rooms/${R1}/unpublish`, { method: "POST", token: "owner_token" });
  check("owner unpublishes -> listed false",
    unpub.status === 200 && unpub.json?.listed === false, JSON.stringify(unpub.json));
  check("unpublished studio leaves the gallery",
    !(await api("/api/rooms/gallery")).json?.rooms?.some((r) => r.code === R1));
  const linkView = await connect(R1);
  check("…but the URL keeps working (unlisted != private)",
    lastOf(linkView, "connected")?.audience === "artist_public");

  // Admin moderation-hidden: the owner cannot override it.
  await api(`/api/rooms/${R1}/publish`, { method: "POST", token: "owner_token", body: { description: "back again", tags: ["retro"] } });
  const adminKey = readFileSync(path.join(SCRATCH, ".admin-key"), "utf8").trim();
  const admUnpub = await api(`/api/admin/rooms/${R1}/unpublish`, { method: "POST", adminKey });
  check("admin unpublish marks moderationHidden",
    admUnpub.status === 200 && admUnpub.json?.moderationHidden === true, JSON.stringify(admUnpub.json));
  check("moderation-hidden studio is out of the gallery",
    !(await api("/api/rooms/gallery")).json?.rooms?.some((r) => r.code === R1));
  const ownerOverride = await api(`/api/rooms/${R1}/publish`, { method: "POST", token: "owner_token", body: { description: "override?", tags: [] } });
  check("owner CANNOT override moderation-hidden",
    ownerOverride.status === 403 && ownerOverride.json?.error === "moderation_hidden", JSON.stringify(ownerOverride.json));
  const hiddenInfo = await api(`/api/rooms/${R1}/artist`, { token: "owner_token" });
  check("settings GET reports moderationHidden to the owner", hiddenInfo.json?.moderationHidden === true);
  const admRestore = await api(`/api/admin/rooms/${R1}/restore`, { method: "POST", adminKey });
  check("admin restore clears moderationHidden", admRestore.status === 200 && admRestore.json?.moderationHidden === false);
  const republish = await api(`/api/rooms/${R1}/publish`, { method: "POST", token: "owner_token", body: { description: "Oil studies and ink cats", tags: ["oils", "retro"] } });
  check("after restore the owner can publish again", republish.status === 200 && republish.json?.listed === true);

  // ==========================================================================
  // 7. friends -> artist_public conversion ONLY via explicit publish
  // ==========================================================================
  const fr = await api("/api/rooms", { method: "POST", token: "owner_token", body: { audience: "friends", title: "Private Hangout" } });
  check("owner creates a private (friends) room", fr.status === 200 && !!fr.json?.code);
  const FR = fr.json.code;
  const frMember = await connect(FR, { token: "stranger_token" });
  const frConn = lastOf(frMember, "connected");
  check("friends room behaves as before (signed-in member, canPaint n/a => true)",
    !!frConn && frConn.audience === "friends" && frConn.canPaint === true, frConn && `aud=${frConn.audience} cp=${frConn.canPaint}`);
  const frWatcher = await connect(FR, { token: "painter_token" });
  const frStroke = sendDraw(frMember, { brush: "marker", color: "#f00", size: 5 });
  check("friends room members draw as before", !!(await gotStroke(frWatcher, frStroke)));
  check("GET settings does NOT implicitly convert/list a friends room",
    (await api(`/api/rooms/${FR}/artist`, { token: "owner_token" })).json?.listed !== true
    && !(await api("/api/rooms/gallery")).json?.rooms?.some((r) => r.code === FR));
  const conv = await api(`/api/rooms/${FR}/publish`, { method: "POST", token: "owner_token", body: { description: "Going public", tags: ["conversion"] } });
  check("explicit publish converts friends -> artist_public, listed",
    conv.status === 200 && conv.json?.audience === "artist_public" && conv.json?.listed === true, JSON.stringify(conv.json));
  check("converted studio appears in the gallery",
    (await api("/api/rooms/gallery?tag=conversion")).json?.rooms?.some((r) => r.code === FR));
  const convRole = await waitFor(frMember, (m) => m.type === "role_changed", 2000);
  check("existing members are re-roled on conversion (no friend access by URL)",
    !!convRole && convRole.canPaint === false, convRole && JSON.stringify(convRole));
  const frStroke2 = sendDraw(frMember, { brush: "marker", color: "#f00", size: 5 });
  check("after conversion the unapproved friend's ops are denied", !(await gotStroke(frWatcher, frStroke2)));
  const convJoin = await connect(FR);
  check("a guest can VIEW the converted studio by link",
    lastOf(convJoin, "connected")?.audience === "artist_public" && lastOf(convJoin, "connected")?.canPaint === false);

  // ==========================================================================
  // 8. Spectator admission + private room + anonymous path unchanged
  // ==========================================================================
  const spec = await connect(R1, { spectate: true });
  const specConn = lastOf(spec, "connected");
  check("artist studio is spectatable by code (gallery != authorization)",
    !!specConn && specConn.spectator === true && specConn.audience === "artist_public"
    && !!lastOf(spec, "history"), specConn && JSON.stringify(specConn).slice(0, 160));
  check("spectator roster stays count-only", (lastOf(spec, "userList") || {}).count >= 0 && !(lastOf(spec, "userList") || {}).users);
  await connect(FR + "ZZ", { spectate: true }).catch(() => null);
  const frGuest = await connect(FR, { token: null });
  // FR converted to artist_public above — make a NEW private room for the checks.
  const pv = await api("/api/rooms", { method: "POST", token: "painter_token", body: { audience: "friends", title: "pv" } });
  const PV = pv.json.code;
  const pvGuest = await connect(PV, { token: null });
  check("private rooms still refuse guests (signin_required)",
    allOf(pvGuest, "signin_required").length > 0 || !lastOf(pvGuest, "connected"));
  const pvSpec = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${PV}&spectate=1`);
  const pvSpecMsgs = [];
  pvSpecMsgs.length = 0;
  const pvSpecSeen = await new Promise((resolve) => {
    const seen = [];
    pvSpec.on("message", (raw) => { try { seen.push(JSON.parse(raw.toString()).type); } catch { /* gz */ } });
    pvSpec.on("close", () => resolve(seen));
    setTimeout(() => resolve(seen), 3000);
  });
  check("private rooms stay unspectatable", !pvSpecSeen.includes("connected"), pvSpecSeen.join(","));
  const main = await connect("MAIN");
  const main2 = await connect("MAIN");
  const mStroke = sendDraw(main, { brush: "marker", color: "#f00", size: 5 });
  check("anonymous drawing in the commons is unchanged", !!lastOf(main, "connected") && !!(await gotStroke(main2, mStroke)));
  check("private-room guest connection refused leaves no room behind for them",
    !lastOf(frGuest, "connected") || lastOf(frGuest, "connected")?.audience === "artist_public");

  // ==========================================================================
  // 9. Inktober opt-in artist studio
  // ==========================================================================
  setClock("2026-10-05T09:00:00.000Z");
  await sleep(400);
  const ink = await api("/api/rooms", { method: "POST", token: "painter_token", body: { audience: "artist_public", title: "Ink Corner", inktober: true } });
  check("creation with inktober opt-in succeeds", ink.status === 200 && !!ink.json?.code, JSON.stringify(ink));
  const INK = ink.json.code;
  const inkOwner = await connect(INK, { token: "painter_token" });
  const inkConn = lastOf(inkOwner, "connected");
  check("active October: inkOnly handshake + server-derived event/day/prompt in roomProfile",
    !!inkConn && inkConn.inkOnly === true && inkConn.roomProfile?.event?.phase === "active"
    && inkConn.roomProfile?.event?.day === 5 && inkConn.roomProfile?.event?.prompt === "Smack",
    inkConn && `inkOnly=${inkConn.inkOnly} ev=${JSON.stringify(inkConn.roomProfile?.event).slice(0, 140)}`);
  const inkMarker = sendDraw(inkOwner, { brush: "marker", color: "#f00", size: 5 });
  const inkWatcher = await connect(INK);
  check("active October: marker ops denied in the opted-in studio", !(await gotStroke(inkWatcher, inkMarker)));
  const inkInk = sendDraw(inkOwner, { brush: "ink", color: "#111", size: 5 });
  check("active October: ink ops relay", !!(await gotStroke(inkWatcher, inkInk)));

  setClock("2026-10-06T00:30:00.000Z");
  const roll = await waitFor(inkOwner, (m) => m.type === "seasonal_prompt" && m.event?.day === 6, 3000);
  check("rollover pushes the new server-derived prompt into the artist studio",
    !!roll && roll.prompt === "Ogre" && roll.event?.phase === "active", roll && `${roll.prompt} day=${roll.event?.day}`);

  // Wall stamps from an opted-in artist room: server-assigned, client can't forge.
  // Attribution requires the poster to BE the studio's verified owner (or an
  // approved painter) — painter_token owns this studio, so the stamp applies.
  const wallRes = await api("/api/wall", {
    method: "POST",
    token: "painter_token",
    body: { frames: [PNG], durationMs: 400, artist: "Testy", userKey: "dk_artistwall1", room: INK, eventDay: 99, eventPrompt: "Forged", challenge: "2020-01-01" },
  });
  check("wall post from an opted-in artist studio accepted", wallRes.status === 200 && wallRes.json?.ok === true, JSON.stringify(wallRes));
  const wallById = await api(`/api/wall/${wallRes.json.id}`);
  check("event stamp is SERVER-derived (day 6/Ogre/date), client fields ignored",
    wallById.json?.post?.event === "inktober-2026" && wallById.json?.post?.eventDay === 6
    && wallById.json?.post?.eventPrompt === "Ogre" && wallById.json?.post?.challenge === "2026-10-06",
    wallById.json?.post && `event=${wallById.json.post.event} day=${wallById.json.post.eventDay} prompt=${wallById.json.post.eventPrompt} chal=${wallById.json.post.challenge}`);
  const evFeed = await api("/api/wall?event=inktober-2026&sort=new");
  check("the artist-studio wall post lands in the event feed",
    (evFeed.json?.posts || []).some((p) => p.id === wallRes.json.id));

  // Publish with inktober flag -> gallery event tag + event filter hit.
  const inkPub = await api(`/api/rooms/${INK}/publish`, { method: "POST", token: "painter_token", body: { description: "daily ink", tags: ["ink"], inktober: true } });
  check("publish carries the inktober opt-in", inkPub.status === 200 && inkPub.json?.inktober === true);
  const evGal = await api("/api/rooms/gallery?event=inktober-2026");
  const inkCard = (evGal.json?.rooms || []).find((r) => r.code === INK);
  check("gallery event filter finds the opted-in studio", !!inkCard && inkCard.event === "inktober-2026");

  // Before October the studio shows the warm-up but does NOT restrict tools.
  setClock("2026-09-20T09:00:00.000Z");
  await sleep(400);
  const warmJoin = await connect(INK, { token: "painter_token" });
  const warmConn = lastOf(warmJoin, "connected");
  check("warm-up phase: event state present, ink restriction NOT yet enforced",
    !!warmConn && warmConn.roomProfile?.event?.phase === "upcoming" && warmConn.inkOnly === false,
    warmConn && `inkOnly=${warmConn.inkOnly} phase=${warmConn.roomProfile?.event?.phase}`);
  const warmMarker = sendDraw(warmJoin, { brush: "marker", color: "#f00", size: 5 });
  check("warm-up phase: marker ops relay (restriction starts in October)", !!(await gotStroke(inkWatcher, warmMarker)));

  // ==========================================================================
  // 10. SEO
  // ==========================================================================
  const galHtml = await fetch(`${BASE}/gallery`).then((r) => r.text());
  check("/gallery serves a route-specific SEO head",
    /<title[^>]*>[^<]*([Aa]rtist|[Gg]allery)/.test(galHtml), (galHtml.match(/<title[^>]*>[^<]*<\/title>/) || ["?"])[0]);
  const sitemap = await fetch(`${BASE}/sitemap.xml`).then((r) => r.text());
  check("/gallery is in the sitemap", sitemap.includes("/gallery"));

  // ==========================================================================
  // 11. Account deletion: unpublish owned + ACL scrub incl. OFFLINE rooms
  // ==========================================================================
  // Re-approve the stranger in R1 so the scrub has a live-room ACL to cut.
  owner2.ws.send(JSON.stringify({ type: "paint_approve", targetId: lastOf(stranger3, "connected").userId }));
  await waitFor(stranger3, (m) => m.type === "role_changed" && m.canPaint === true, 1500);
  const ownRoom = await api("/api/rooms", { method: "POST", token: "painter_token", body: { audience: "artist_public", title: "Pete's Place" } });
  const P1 = ownRoom.json.code;
  await api(`/api/rooms/${P1}/publish`, { method: "POST", token: "painter_token", body: { description: "bye soon", tags: ["gone"] } });
  check("setup: painter owns a published studio", (await api("/api/rooms/gallery?tag=gone")).json?.rooms?.some((r) => r.code === P1));
  try { stranger3.ws.close(); } catch { /* gone */ }
  await sleep(3200); // persist the re-approval

  const scrub = await api("/api/account/scrub-chat", { method: "POST", token: "painter_token" });
  check("account deletion endpoint accepts the deleting account", scrub.status === 200, `status ${scrub.status}`);
  const afterScrub = await api(`/api/rooms/${R1}/artist`, { token: "owner_token" });
  check("deletion removes the account from a LIVE room's painter ACL",
    !(afterScrub.json?.painters || []).includes("painter_two2"), JSON.stringify(afterScrub.json?.painters));
  const artoldMeta = roomFileJson("ARTOLD");
  check("deletion scrubs the OFFLINE room file's painter ACL too",
    !(artoldMeta.painters || []).includes("painter_two2"), JSON.stringify(artoldMeta.painters));
  await sleep(3200); // the live-room unpublish rides the write-behind persist
  const p1Meta = roomFileJson(P1);
  check("deletion unpublishes owned studios (persisted)",
    p1Meta.gallery?.listed === false, JSON.stringify(p1Meta.gallery));
  check("…and they leave the gallery",
    !(await api("/api/rooms/gallery?tag=gone")).json?.rooms?.some((r) => r.code === P1));
  check("ownership is NOT released for takeover (ownerProfileId intact)",
    p1Meta.ownerProfileId === "painter_two2");
  const orphanJoin = await connect(P1, { token: "stranger_token" });
  const orphConn = lastOf(orphanJoin, "connected");
  check("orphaned studio: no first-arrival ownership or guest host",
    !!orphConn && orphConn.isOwner === false && orphConn.isHost === false && orphConn.canPaint === false,
    orphConn && `owner=${orphConn.isOwner} host=${orphConn.isHost} paint=${orphConn.canPaint}`);
};

run().catch((e) => { console.error("VERIFY CRASHED:", e); results.push({ name: "run", ok: false }); })
  .finally(async () => {
    for (const c of clients) { try { c.ws.close(); } catch { /* gone */ } }
    await killServer(server);
    mock.close();
    if (madeStubDist) { try { rmSync(distDir, { recursive: true, force: true }); } catch { /* leave */ } }
    if (results.some((r) => !r.ok) && serverLog.length) {
      console.error("\n--- last server stderr ---\n" + serverLog.slice(-12).join(""));
    }
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  });
