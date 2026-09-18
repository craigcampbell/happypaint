// Moderator watch ("glass room") verification. The story: an admin can open ANY
// room — private ones included — as an invisible observer. The socket never
// enters room.users, so the room's roster, headcount, join beacons and analytics
// never mention it; it can moderate (wipe, hide/restore/remove, kick, mute, lock)
// but it can NOT draw, chat, or impersonate anyone; a bad key, an unknown room
// and a silent socket are all refused. The fun roleplay value is zero, which is
// the point.
//
// Raw WS, no browser: this is the server boundary, and it is what has to hold.
import { spawn } from "child_process";
import { mkdirSync, rmSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocket } from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = path.join(process.env.TEMP || "/tmp", "modwatch-verify-data");
const PORT = 8943;
const BASE = `http://localhost:${PORT}`;
// A plain ad-hoc code: not featured, not kid_safe → a PRIVATE room, which is
// exactly the kind the homepage spectator path refuses.
const ROOM = "MODOBS01";
const WATCHER_STROKE = "watch-stroke-1";

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
// PB_URL/POCKETBASE_URL blanked: the repo-root .env (auto-loaded by server.js)
// configures accounts, which would refuse this harness's guest private-room joins.
const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH, PB_URL: "", POCKETBASE_URL: "" }, stdio: "pipe",
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

// A normal member: the join handshake wants {type:'auth'} first (task #40), or
// the server replays the first frame AFTER joining and we race the history.
function connectMember(room) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${room}`);
    const msgs = [];
    ws.on("message", (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* binary */ } });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", token: null }));
      setTimeout(() => resolve({ ws, msgs, send: (o) => ws.send(JSON.stringify(o)) }), 350);
    });
  });
}

// A moderator watcher: no auth frame, no token — it opens the modwatch mode and
// then proves the admin key in its first frame.
function connectWatcher(room, key) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${room}&modwatch=1`);
    const msgs = [];
    ws.on("message", (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* binary */ } });
    ws.on("open", () => {
      if (key !== undefined) ws.send(JSON.stringify({ type: "mod_auth", key }));
      setTimeout(() => resolve({ ws, msgs, send: (o) => ws.send(JSON.stringify(o)) }), 400);
    });
  });
}

const last = (c, type) => [...c.msgs].reverse().find((m) => m.type === type) || null;
const all = (c, type) => c.msgs.filter((m) => m.type === type);
async function waitFor(c, pred, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const hit = [...c.msgs].reverse().find(pred);
    if (hit) return hit;
    await sleep(70);
  }
  return null;
}
const opIdsIn = (msg) => (msg?.ops || []).map((op) => op.opId);
const drewStroke = (op, strokeId) => op?.kind === "draw" && op?.strokeId === strokeId;

const run = async () => {
  for (let i = 0; i < 40; i += 1) {
    try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch { /* booting */ }
    await sleep(250);
  }
  const adminKey = readFileSync(path.join(SCRATCH, ".admin-key"), "utf8").trim();
  check("server booted with an admin key", adminKey.length > 8);

  // ---- A painter in a private room ---------------------------------------
  const a = await connectMember(ROOM);
  const aConnected = await waitFor(a, (m) => m.type === "connected");
  check("member joined the private room", !!aConnected && aConnected.audience !== "kid_safe",
    `audience=${aConnected?.audience}`);
  await waitFor(a, (m) => m.type === "userList");
  const aId = aConnected?.userId;
  a.send({ type: "op", op: { kind: "draw", strokeId: "a-1", points: [{ x: 10, y: 10 }, { x: 40, y: 44 }], settings: { brush: "marker", color: "#111827", size: 24 }, end: true } });
  a.send({ type: "op", op: { kind: "draw", strokeId: "a-2", points: [{ x: 60, y: 60 }, { x: 90, y: 99 }], settings: { brush: "crayon", color: "#ef4444", size: 18 }, end: true } });
  a.send({ type: "chat", message: "hello room, just painting" });
  await sleep(400);

  // ---- Wrong key is refused ---------------------------------------------
  const bad = await connectWatcher(ROOM, "not-the-key");
  const badDenied = await waitFor(bad, (m) => m.type === "mod_denied");
  check("a wrong admin key is denied", badDenied?.reason === "bad_key", `reason=${badDenied?.reason}`);

  // ---- The good key attaches invisibly ----------------------------------
  const w = await connectWatcher(ROOM, adminKey);
  const wConn = await waitFor(w, (m) => m.type === "connected");
  check("watcher attached as a moderator", wConn?.moderator === true && wConn?.ghost === true);
  const wUsers = await waitFor(w, (m) => m.type === "userList" && Array.isArray(m.users));
  check("watcher sees the full roster with names", (wUsers?.users || []).length === 1 && !!wUsers?.users?.[0]?.name,
    `users=${JSON.stringify((wUsers?.users || []).map((u) => u.name))}`);
  const wChat = await waitFor(w, (m) => m.type === "chat_history");
  check("watcher reads the room's chat", (wChat?.messages || []).some((m) => m.message === "hello room, just painting"));
  const wHist = await waitFor(w, (m) => m.type === "history");
  check("watcher sees the mural as drawn", (wHist?.ops || []).length === 2);

  // ---- And the room cannot tell it is there ------------------------------
  check("no join beacon reached the room", all(a, "userJoined").length === 0);
  const aUsers = last(a, "userList");
  check("the room's roster still lists exactly one painter", (aUsers?.users || []).length === 1,
    `users=${(aUsers?.users || []).length}`);
  const roomsApi = await fetch(`${BASE}/api/admin/rooms`, { headers: { "x-admin-key": adminKey } }).then((r) => r.json());
  const roomRow = (roomsApi.rooms || []).find((r) => r.id === ROOM);
  check("the admin room list counts one user, not two", roomRow?.users === 1, `users=${roomRow?.users}`);

  // ---- The watcher cannot paint -----------------------------------------
  a.msgs.length = 0;
  w.send({ type: "op", op: { kind: "draw", strokeId: WATCHER_STROKE, points: [{ x: 5, y: 5 }, { x: 30, y: 30 }], settings: { brush: "marker" }, end: true } });
  await sleep(500);
  check("a watcher's draw op is dropped, not relayed", !all(a, "op").some((m) => drewStroke(m.op, WATCHER_STROKE)));

  // ---- And cannot chat or impersonate -----------------------------------
  a.msgs.length = 0;
  w.send({ type: "chat", message: "WATCHER-SAYS-HI" });
  await sleep(400);
  check("a watcher's chat is dropped, not relayed",
    !all(a, "chat").some((m) => m.message === "WATCHER-SAYS-HI"));

  // ---- Live activity still flows TO the watcher -------------------------
  a.send({ type: "op", op: { kind: "draw", strokeId: "a-3", points: [{ x: 70, y: 20 }, { x: 80, y: 30 }], settings: { brush: "marker" }, end: true } });
  const wLive = await waitFor(w, (m) => m.type === "op" && drewStroke(m.op, "a-3"));
  check("the watcher receives new strokes live", !!wLive);
  a.send({ type: "chat", message: "second line" });
  const wLiveChat = await waitFor(w, (m) => m.type === "chat" && m.message === "second line");
  check("the watcher receives new chat live", !!wLiveChat);

  // ---- Moderation: hide, restore, wipe, kick ----------------------------
  // Op ids come from the watcher's own view of the mural (the author never
  // receives its own ops, so A's message list is the wrong place to look).
  const target = opIdsIn(last(w, "history")).slice(0, 1);
  check("room history is addressable for moderation", target.length === 1, `op ${target[0]}`);
  a.msgs.length = 0;
  w.send({ type: "mod_hide", opIds: target });
  const hidden = await waitFor(a, (m) => m.type === "history" && !opIdsIn(m).includes(target[0]));
  check("hide removes an op from the room's rebuild", !!hidden, `hid op ${target[0]}`);

  a.msgs.length = 0;
  w.send({ type: "mod_restore", opIds: target });
  const restored = await waitFor(a, (m) => m.type === "history" && opIdsIn(m).includes(target[0]));
  check("restore puts it back", !!restored);

  a.msgs.length = 0;
  w.send({ type: "clear" });
  const cleared = await waitFor(a, (m) => m.type === "clear");
  check("wipe clears the room for its members", !!cleared && cleared.name === "a moderator",
    `by=${cleared?.name}`);
  a.msgs.length = 0;
  w.send({ type: "undo_clear" });
  const unWiped = await waitFor(a, (m) => m.type === "history" && (m.ops || []).length >= 3);
  check("a wipe can be undone (the room gets its mural back)", !!unWiped);

  a.msgs.length = 0;
  w.send({ type: "kick", targetId: aId });
  const kicked = await waitFor(a, (m) => m.type === "kicked");
  await sleep(250);
  check("kick removes a member from the room", !!kicked && a.ws.readyState >= 2,
    `state=${a.ws.readyState}`);

  // ---- Second member sees the room without the watcher in it ------------
  const b = await connectMember(ROOM);
  const bUsers = await waitFor(b, (m) => m.type === "userList" && Array.isArray(m.users));
  const bNames = (bUsers?.users || []).map((u) => u.name);
  check("a fresh joiner's roster has no moderator in it", bNames.length === 1 && !bNames.includes("moderator"),
    `roster=${JSON.stringify(bNames)}`);
  // A fresh client rebuilds the mural from the server's history: the painter's
  // strokes are there, the watcher's are not.
  const bHist = await waitFor(b, (m) => m.type === "history" && Array.isArray(m.ops));
  const bStrokes = (bHist?.ops || []).map((op) => op.strokeId);
  check("a fresh joiner sees the painter's strokes", bStrokes.includes("a-1") && bStrokes.includes("a-2"),
    `strokes=${JSON.stringify(bStrokes)}`);
  check("a fresh joiner never sees a watcher-drawn stroke", !bStrokes.includes(WATCHER_STROKE));

  // ---- Private rooms stay closed to the public spectator path -----------
  const spec = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${ROOM}&spectate=1`);
    const msgs = [];
    ws.on("message", (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
    setTimeout(() => resolve({ ws, msgs }), 500);
  });
  check("public spectating of a private room is still refused",
    spec.msgs.some((m) => m.type === "room_blocked" && m.reason === "not_watchable"));

  // ---- Unknown room, and a silent watcher -------------------------------
  const ghostRoom = await connectWatcher("NOSUCHROOM", adminKey);
  const ghostDenied = await waitFor(ghostRoom, (m) => m.type === "mod_denied");
  check("watching a room that isn't live is refused", ghostDenied?.reason === "no_room",
    `reason=${ghostDenied?.reason}`);

  const silent = await connectWatcher(ROOM, undefined);
  const timedOut = await waitFor(silent, (m) => m.type === "mod_denied", 8000);
  check("a watch socket that never authenticates is hung up", timedOut?.reason === "auth_timeout",
    `reason=${timedOut?.reason}`);

  // ---- The trail outlives the watch -------------------------------------
  const flagged = await fetch(`${BASE}/api/admin/rooms/${ROOM}/flag`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
    body: JSON.stringify({ reason: "test flag while watching", opIds: [1, 2] }),
  }).then((r) => r.json());
  check("a moderator flag lands in the reports queue",
    flagged.ok === true && flagged.report?.source === "admin" && /ops 1, 2/.test(flagged.report?.reason || ""),
    `reason=${flagged.report?.reason}`);

  // ---- Nothing leaks into the public lobby ------------------------------
  const lobby = await fetch(`${BASE}/api/rooms/public`).then((r) => r.json());
  const rooms = Array.isArray(lobby) ? lobby : lobby.rooms || [];
  check("the watcher never shows up as a public room participant",
    !rooms.some((r) => r.id === ROOM && r.users > 1));

  try { b.ws.close(); } catch { /* ignore */ }
  try { w.ws.close(); } catch { /* ignore */ }
};

run()
  .catch((err) => { console.error("HARNESS ERROR:", err); results.push({ name: "harness", ok: false }); })
  .finally(() => {
    server.kill();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) console.log("FAILED:", failed.map((f) => f.name).join(" | "));
    setTimeout(() => process.exit(failed.length ? 1 : 0), 300);
  });
