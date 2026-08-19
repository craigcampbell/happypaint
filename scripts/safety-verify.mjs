// Safety-hardening verification: spectator lockdown (allowlist, caps, no
// private-room watching, no lazy room creation), capability-gated mention
// watching, first-frame WS auth, severe drawn-text blocking in private rooms,
// report rate limiting, and admin-key transport hardening.
// Drives a LOCAL isolated server with a scratch DATA_DIR.
import { spawn } from "child_process";
import { mkdirSync, rmSync } from "fs";
import path from "path";
import { WebSocket } from "ws";
import { SimClient } from "../test/harness/client.mjs";

const ROOT = process.cwd();
const SCRATCH = path.join(process.env.TEMP || "/tmp", "safety-verify-data");
const PORT = 8929;
const BASE = `http://localhost:${PORT}`;
const BASE_WS = `ws://localhost:${PORT}`;
const ADMIN_KEY = "safety-test-admin";

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH, ADMIN_KEY },
  stdio: "pipe",
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

// A bare spectator/notify socket that records every frame.
function rawSocket(qs) {
  const ws = new WebSocket(`${BASE_WS}/ws?${qs}`);
  const frames = [];
  ws.on("message", (raw) => {
    try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
  });
  const waitFor = (test, timeoutMs = 3000) =>
    new Promise((resolve) => {
      const found = () => frames.find(test);
      if (found()) return resolve(found());
      const iv = setInterval(() => {
        const m = found();
        if (m) { clearInterval(iv); clearTimeout(tm); resolve(m); }
      }, 40);
      const tm = setTimeout(() => { clearInterval(iv); resolve(null); }, timeoutMs);
    });
  return { ws, frames, waitFor, close: () => { try { ws.close(); } catch { /* ok */ } } };
}

const run = async () => {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(BASE + "/healthz"); if (r.ok) break; } catch { /* boot */ }
    await sleep(250);
  }

  // ---- 1. Spectator lockdown ------------------------------------------------
  {
    // Nonexistent room: blocked, and the probe must NOT create the room.
    const probe = rawSocket("room=GHOSTY1&spectate=1");
    const blocked = await probe.waitFor((m) => m.type === "room_blocked");
    check("spectate on a nonexistent room is blocked", !!blocked, JSON.stringify(blocked));
    probe.close();
    // Prove no room materialized: join it as a member and check history is empty
    // AND the admin room list doesn't show it before the join.
    const adminRooms = await fetch(`${BASE}/api/admin/rooms`, { headers: { "x-admin-key": ADMIN_KEY } }).then((r) => r.json());
    const ghost = (adminRooms.rooms || []).find((r) => r.code === "GHOSTY1");
    check("spectate probe did not lazily create the room", !ghost);

    // Private (friends) room: a live member, then a spectate attempt → blocked.
    const member = new SimClient(BASE_WS, { room: "PRIVSPEC", name: "kid" });
    await member.connect();
    const peek = rawSocket("room=PRIVSPEC&spectate=1");
    const denied = await peek.waitFor((m) => m.type === "room_blocked");
    check("private rooms cannot be spectated", !!denied);
    peek.close();

    // Public room: spectator connects, then a member joins, renames, chats,
    // draws. The spectator must see ONLY the mural traffic.
    const spec = rawSocket("room=MAIN&spectate=1");
    const specConnected = await spec.waitFor((m) => m.type === "connected");
    check("MAIN is spectatable (connected frame)", !!specConnected && specConnected.spectator === true);
    const firstList = await spec.waitFor((m) => m.type === "userList");
    check("spectator userList is a count, not a roster", !!firstList && typeof firstList.count === "number" && firstList.users === undefined);

    const painter = new SimClient(BASE_WS, { room: "MAIN", name: "painter" });
    await painter.connect();
    painter.send({ type: "rename", name: "SecretName" });
    painter.sendChat("hello wall");
    painter.sendOp({ kind: "draw", strokeId: "sp1", points: [[1, 1], [2, 2]] });
    const gotOp = await spec.waitFor((m) => m.type === "op");
    check("spectator receives draw ops", !!gotOp);
    await sleep(300);
    const leakTypes = spec.frames.filter((m) => !["connected", "userList", "history", "sheet", "op", "clear"].includes(m.type)).map((m) => m.type);
    check("spectator receives NOTHING but mural traffic", leakTypes.length === 0, JSON.stringify(leakTypes));
    const rosterLeak = JSON.stringify(spec.frames).includes("SecretName") || JSON.stringify(spec.frames).includes("painter");
    check("no member name ever reaches a spectator", !rosterLeak);
    spec.close();
    await painter.close();
    await member.close();
  }

  // ---- 2. Capability-gated mention watching ---------------------------------
  {
    const alice = new SimClient(BASE_WS, { room: "WATCHME", name: "alice" });
    const joined = await alice.connect();
    const aliceName = joined.userName;
    const key = joined.mentionKey;
    check("join handshake issues a mentionKey", typeof key === "string" && key.length > 6);

    // Wrong key: watch silently refused → no mention delivered.
    const spy = rawSocket("notify=1");
    await spy.waitFor((m) => m.type === "notify_ready");
    spy.ws.send(JSON.stringify({ type: "watch", rooms: [{ code: "WATCHME", name: aliceName, key: "forged-key" }] }));
    // Right key on a second socket.
    const real = rawSocket("notify=1");
    await real.waitFor((m) => m.type === "notify_ready");
    real.ws.send(JSON.stringify({ type: "watch", rooms: [{ code: "WATCHME", name: aliceName, key }] }));
    await sleep(200);

    const bob = new SimClient(BASE_WS, { room: "WATCHME", name: "bob" });
    await bob.connect();
    bob.sendChat(`hey @${aliceName} come back!`);

    const mention = await real.waitFor((m) => m.type === "mention", 3000);
    check("valid capability receives the mention", !!mention, JSON.stringify(mention));
    check("mention payload carries no message text", !!mention && mention.text === undefined && mention.message === undefined);
    await sleep(200);
    check("forged capability receives nothing", !spy.frames.some((m) => m.type === "mention"));
    // Legacy bare-code watch shape must also be refused.
    spy.ws.send(JSON.stringify({ type: "watch", rooms: ["WATCHME"], name: aliceName }));
    await sleep(150);
    bob.sendChat(`@${aliceName} are you there`);
    await sleep(400);
    check("legacy bare-code watch is refused", !spy.frames.some((m) => m.type === "mention"));
    spy.close();
    real.close();
    await alice.close();
    await bob.close();
  }

  // ---- 3. First-frame auth + no-token wait ---------------------------------
  {
    // SimClient now authenticates via first frame (token:null) — a normal join
    // must still complete fast.
    const t0 = Date.now();
    const c = new SimClient(BASE_WS, { room: "AUTHCHK", name: "c" });
    await c.connect();
    check("anonymous first-frame auth joins promptly", Date.now() - t0 < 1200, `${Date.now() - t0}ms`);
    await c.close();
  }

  // ---- 4. Severe drawn text blocked in PRIVATE rooms ------------------------
  {
    const a = new SimClient(BASE_WS, { room: "PRIVTXT", name: "a" });
    const b = new SimClient(BASE_WS, { room: "PRIVTXT", name: "b" });
    await a.connect();
    await b.connect();
    a.sendOp({ kind: "text", text: "you retard", x: 5, y: 5 });
    a.sendOp({ kind: "text", text: "a friendly hello", x: 6, y: 6 });
    const okOp = await b.waitFor((m) => m.type === "op" && m.op?.kind === "text" && /friendly/.test(m.op.text || ""), { timeoutMs: 3000, label: "clean text op relays" }).catch(() => null);
    check("clean drawn text relays in a private room", !!okOp);
    const leaked = b.all("op").some((m) => m.op?.kind === "text" && /retard/.test(m.op.text || ""));
    check("severe drawn text is blocked in a private room", !leaked);
    await a.close();
    await b.close();
  }

  // ---- 5. Report rate limit + receipt ---------------------------------------
  {
    let last = null;
    let firstUrgentFlag = null;
    for (let i = 0; i < 14; i += 1) {
      last = await fetch(`${BASE}/api/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: "MAIN", reason: `spam probe ${i}` }),
      });
      if (i === 0) firstUrgentFlag = (await last.clone().json().catch(() => ({}))).received;
    }
    check("report receipt on first submit", firstUrgentFlag === true);
    check("report flood hits the rate limit", last.status === 429);
  }

  // ---- 6. Admin key transport ------------------------------------------------
  {
    const viaQuery = await fetch(`${BASE}/api/admin/rooms?key=${ADMIN_KEY}`);
    check("admin key via query param is rejected", viaQuery.status === 401);
    const viaHeader = await fetch(`${BASE}/api/admin/rooms`, { headers: { "x-admin-key": ADMIN_KEY } });
    check("admin key via header still works", viaHeader.status === 200);
  }

  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
};

run()
  .catch((err) => {
    console.error("verify crashed:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    server.kill();
    setTimeout(() => process.exit(process.exitCode ?? 0), 400);
  });
