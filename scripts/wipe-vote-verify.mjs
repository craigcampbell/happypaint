// Member wipes (countdown + room vote) and the moderator's reset.
//
// A member's Clear is a REQUEST: 10s alone, 30s with one other person, a 30s
// room vote at 3+ that passes only if more than half the ROOM says yes. The
// asker can cancel until the last 3s; the chat survives; members can't "Bring
// it back" afterwards. A moderator's Wipe is a reset: mural AND chat, as if new,
// and only the moderator's own Undo restores it.
//
// Raw sockets against a throwaway server, real timers: every scenario runs in
// its own featured (public, hostless) room IN PARALLEL, so the whole run is
// about 40s. Private-room scenarios use ad-hoc codes (first joiner = guest host).
import { spawn } from "child_process";
import { mkdirSync, rmSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocket } from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = path.join(process.env.TEMP || "/tmp", "wipe-vote-verify-data");
const PORT = 8946;
const BASE = `http://localhost:${PORT}`;

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
// PB_URL/POCKETBASE_URL blanked: the repo-root .env (auto-loaded by server.js)
// configures accounts, which would refuse this harness's guest private-room joins.
const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH, PB_URL: "", POCKETBASE_URL: "" }, stdio: "pipe",
});
server.stderr.on("data", (d) => { if (process.env.SRV_LOG) process.stderr.write("[srv] " + d); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

let keySeq = 0;
// A member. `deviceKey` = the browser's local key: two sockets sharing one are
// two TABS of one person.
function connectMember(room, deviceKey = `dk_wipeqa${(keySeq += 1)}x`) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${room}`);
    const msgs = [];
    ws.on("message", (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* binary */ } });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", token: null, userKey: deviceKey }));
      ws.send(JSON.stringify({ type: "client_info", deviceKey }));
      setTimeout(() => {
        const hello = msgs.find((m) => m.type === "connected");
        resolve({ ws, msgs, id: hello?.userId, send: (o) => ws.send(JSON.stringify(o)) });
      }, 400);
    });
  });
}
function connectWatcher(room, key) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${room}&modwatch=1`);
    const msgs = [];
    ws.on("message", (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* binary */ } });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "mod_auth", key }));
      setTimeout(() => resolve({ ws, msgs, send: (o) => ws.send(JSON.stringify(o)) }), 400);
    });
  });
}
function connectSpectator(room) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${room}&spectate=1`);
    const msgs = [];
    ws.on("message", (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* binary */ } });
    ws.on("open", () => setTimeout(() => resolve({ ws, msgs }), 400));
  });
}
async function waitFor(c, pred, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const hit = c.msgs.find(pred);
    if (hit) return hit;
    await sleep(60);
  }
  return null;
}
const after = (c, mark) => c.msgs.slice(mark);
// Wait for a message that arrived AFTER a mark (ignores the backlog).
async function waitAfter(c, mark, pred, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const hit = after(c, mark).find(pred);
    if (hit) return hit;
    await sleep(60);
  }
  return null;
}
const has = (c, mark, pred) => after(c, mark).some(pred);
let strokeSeq = 0;
function draw(c) {
  strokeSeq += 1;
  c.send({ type: "op", op: { kind: "draw", strokeId: `wq-${strokeSeq}`, points: [{ x: 10, y: 10 }, { x: 60, y: 70 }], settings: { brush: "marker", color: "#111827", size: 20 }, end: true } });
}
// What a fresh joiner is handed: the mural's op count and the chat lines.
async function joinerView(room) {
  const j = await connectMember(room);
  await sleep(500);
  const hist = j.msgs.find((m) => m.type === "history");
  const chat = j.msgs.find((m) => m.type === "chat_history");
  j.ws.close();
  return { ops: hist ? (hist.ops || []).length : -1, chat: chat ? chat.messages.map((m) => m.message) : [] };
}
const isWipeReq = (m) => m.type === "wipe_req";
const ended = (outcome) => (m) => m.type === "wipe_req" && m.ended && m.ended.outcome === outcome;
const isClear = (m) => m.type === "clear";

// ---- Scenarios -------------------------------------------------------------

// A. Alone: 10s countdown, then wiped for real; chat kept; no "Bring it back".
async function soloScenario() {
  const R = "MAIN";
  const a = await connectMember(R);
  draw(a); draw(a);
  a.send({ type: "chat", message: "solo line survives" });
  await sleep(300);
  const m0 = a.msgs.length;
  a.send({ type: "wipe_request" });
  const req = await waitFor(a, (m) => isWipeReq(m) && m.req);
  check("A solo: a lone painter gets the 10s countdown", req?.req?.mode === "solo" && req.req.msLeft > 9000 && req.req.msLeft <= 10000,
    `mode=${req?.req?.mode} msLeft=${req?.req?.msLeft}`);
  check("A solo: nothing is wiped on the spot", !has(a, m0, isClear));
  await sleep(8000);
  check("A solo: still not wiped at 8s", !has(a, m0, isClear));
  const got = await waitAfter(a, m0, isClear, 3500);
  check("A solo: wiped at 10s — and the asker's own screen gets the clear", !!got && got.final === true && got.wipeMode === "solo", JSON.stringify(got));
  const view = await joinerView(R);
  check("A solo: the mural is empty for a new joiner", view.ops === 0, `ops=${view.ops}`);
  check("A solo: the chat is kept", view.chat.includes("solo line survives"), JSON.stringify(view.chat));
  const m1 = a.msgs.length;
  a.send({ type: "undo_clear" });
  await sleep(700);
  check("A solo: a member can't 'Bring it back' a countdown wipe", !has(a, m1, (m) => m.type === "history" && m.restored));
  a.ws.close();
}

// B. Two people: 30s countdown, no vote; the asker cancels; later the cancel
// locks in the last 3s and the wipe still lands.
async function pairScenario() {
  const R = "DOODLE";
  const a = await connectMember(R);
  const b = await connectMember(R);
  draw(a); draw(b);
  await sleep(300);
  a.send({ type: "wipe_request" });
  const reqB = await waitFor(b, (m) => isWipeReq(m) && m.req);
  check("B pair: two people get a 30s countdown, not a vote", reqB?.req?.mode === "countdown" && reqB.req.msLeft > 29000 && reqB.req.myVote === undefined,
    `mode=${reqB?.req?.mode} msLeft=${reqB?.req?.msLeft}`);
  check("B pair: the friend sees who asked", reqB?.req?.byName && reqB.req.byId === a.id);
  const mb = b.msgs.length;
  b.send({ type: "wipe_cancel", id: reqB.req.id });
  const notYours = await waitAfter(b, mb, (m) => m.type === "wipe_req_denied", 1500);
  check("B pair: only the asker can cancel", notYours?.reason === "not_yours", JSON.stringify(notYours));
  await sleep(1500);
  const ma = a.msgs.length;
  a.send({ type: "wipe_cancel", id: reqB.req.id });
  const cancelled = await waitFor(b, ended("cancelled"), 2000);
  check("B pair: the asker cancels — everyone is told", !!cancelled && !has(a, ma, isClear));
  const view = await joinerView(R);
  check("B pair: the mural survived the cancel", view.ops === 2, `ops=${view.ops}`);

  // Round two: let it run into the locked seconds.
  await sleep(300);
  a.send({ type: "wipe_request" });
  const req2 = await waitFor(a, (m) => isWipeReq(m) && m.req && m.req.id !== reqB.req.id);
  await sleep(Math.max(0, (req2?.req?.msLeft || 30000) - 1600)); // ~1.6s left
  const m2 = a.msgs.length;
  a.send({ type: "wipe_cancel", id: req2.req.id });
  const tooLate = await waitAfter(a, m2, (m) => m.type === "wipe_req_denied", 1200);
  check("B pair: cancel is refused in the last seconds", tooLate?.reason === "too_late", JSON.stringify(tooLate));
  const clearB = await waitAfter(b, m2, isClear, 3500);
  check("B pair: …and the wipe still lands", !!clearB && clearB.final === true && clearB.wipeMode === "countdown");
  a.ws.close(); b.ws.close();
}

// C. Vote of 3: two yes is a majority, but it waits for the third; when
// everyone has voted it skips to the final 3s and wipes.
async function votePassScenario() {
  const R = "DINOS";
  const a = await connectMember(R);
  const b = await connectMember(R);
  const c = await connectMember(R);
  draw(a); draw(b); draw(c);
  await sleep(300);
  a.send({ type: "wipe_request" });
  const reqC = await waitFor(c, (m) => isWipeReq(m) && m.req);
  check("C vote: 3 people get a vote", reqC?.req?.mode === "vote" && reqC.req.people === 3 && reqC.req.needed === 2 && reqC.req.yes === 1 && reqC.req.myVote === null,
    JSON.stringify(reqC?.req));
  const reqA = await waitFor(a, (m) => isWipeReq(m) && m.req);
  check("C vote: asking counts as the asker's yes", reqA?.req?.myVote === "yes");
  const mb = c.msgs.length;
  b.send({ type: "wipe_vote", id: reqC.req.id, yes: true });
  const tally = await waitAfter(c, mb, (m) => isWipeReq(m) && m.req && m.req.yes === 2, 1500);
  check("C vote: majority reached, but it waits for the undecided", !!tally && tally.req.msLeft > 20000 && !has(c, mb, isClear), `msLeft=${tally?.req?.msLeft}`);
  b.send({ type: "wipe_vote", id: reqC.req.id, yes: false });
  const again = await waitAfter(b, mb, (m) => m.type === "wipe_req_denied", 1500);
  check("C vote: votes are final", again?.reason === "already_voted");
  const mc = c.msgs.length;
  c.send({ type: "wipe_vote", id: reqC.req.id, yes: true });
  const fast = await waitAfter(c, mc, (m) => isWipeReq(m) && m.req && m.req.yes === 3, 1500);
  check("C vote: everyone voted → skips to the final locked seconds", !!fast && fast.req.msLeft <= 3000, `msLeft=${fast?.req?.msLeft}`);
  const clear = await waitAfter(c, mc, isClear, 4500);
  check("C vote: wiped", !!clear && clear.final === true && clear.wipeMode === "vote");
  const note = await waitFor(c, (m) => m.type === "chat" && m.system && /voted to wipe/.test(m.message), 1000);
  check("C vote: the result is noted in chat", !!note, note?.message);
  a.ws.close(); b.ws.close(); c.ws.close();
}

// D. Vote of 3 with two NOs: can't pass → fails at once; the room gets a
// short cooldown before anyone can ask again.
async function voteFailEarlyScenario() {
  const R = "SPACE";
  const a = await connectMember(R);
  const b = await connectMember(R);
  const c = await connectMember(R);
  draw(a);
  await sleep(300);
  a.send({ type: "wipe_request" });
  const req = await waitFor(b, (m) => isWipeReq(m) && m.req);
  b.send({ type: "wipe_vote", id: req.req.id, yes: false });
  await sleep(300);
  const midway = c.msgs.some(ended("failed"));
  c.send({ type: "wipe_vote", id: req.req.id, yes: false });
  const failed = await waitFor(a, ended("failed"), 1500);
  check("D fail: one no still leaves room to pass", !midway);
  check("D fail: two no of three → fails at once", !!failed && failed.ended.yes === 1 && failed.ended.needed === 2, JSON.stringify(failed?.ended));
  const mb = b.msgs.length;
  b.send({ type: "wipe_request" });
  const cool = await waitAfter(b, mb, (m) => m.type === "wipe_req_denied", 1500);
  check("D fail: the room isn't re-asked straight away", cool?.reason === "cooldown", JSON.stringify(cool));
  const view = await joinerView(R);
  check("D fail: the mural is untouched", view.ops === 1, `ops=${view.ops}`);
  a.ws.close(); b.ws.close(); c.ws.close();
}

// E. Vote of 4 at the deadline: 2 yes of 4 isn't MORE than half → kept.
async function voteFailDeadlineScenario() {
  const R = "OCEAN";
  const a = await connectMember(R);
  const b = await connectMember(R);
  const c = await connectMember(R);
  const d = await connectMember(R);
  draw(a);
  await sleep(300);
  a.send({ type: "wipe_request" });
  const req = await waitFor(b, (m) => isWipeReq(m) && m.req);
  check("E deadline: 4 people need 3 yes", req?.req?.needed === 3, JSON.stringify(req?.req));
  b.send({ type: "wipe_vote", id: req.req.id, yes: true });
  const failed = await waitFor(d, ended("failed"), 33000);
  check("E deadline: 2 of 4 at the buzzer → the room keeps it", !!failed && failed.ended.yes === 2 && !d.msgs.some(isClear), JSON.stringify(failed?.ended));
  a.ws.close(); b.ws.close(); c.ws.close(); d.ws.close();
}

// F. Vote of 3, one undecided at the deadline: 2 yes of 3 passes.
async function votePassDeadlineScenario() {
  const R = "PETS";
  const a = await connectMember(R);
  const b = await connectMember(R);
  const c = await connectMember(R);
  draw(a);
  await sleep(300);
  a.send({ type: "wipe_request" });
  const req = await waitFor(b, (m) => isWipeReq(m) && m.req);
  b.send({ type: "wipe_vote", id: req.req.id, yes: true });
  const clear = await waitFor(c, isClear, 33000);
  check("F deadline: 2 of 3 yes at the buzzer → wiped", !!clear && clear.final === true && clear.wipeMode === "vote");
  a.ws.close(); b.ws.close(); c.ws.close();
}

// G. The asker leaves mid-countdown → called off.
async function askerLeavesScenario() {
  const R = "RAINBOW";
  const a = await connectMember(R);
  const b = await connectMember(R);
  draw(a);
  await sleep(300);
  a.send({ type: "wipe_request" });
  await waitFor(b, (m) => isWipeReq(m) && m.req);
  a.ws.close();
  const left = await waitFor(b, ended("left"), 2000);
  check("G left: the asker leaving calls the wipe off", !!left);
  await sleep(500);
  const view = await joinerView(R);
  check("G left: the mural stays", view.ops === 1, `ops=${view.ops}`);
  b.ws.close();
}

// H. An older client's bare `clear` in a public room is a request, not a wipe.
async function legacyClearScenario() {
  const R = "CASTLE";
  const a = await connectMember(R);
  const b = await connectMember(R);
  draw(a);
  await sleep(300);
  const mb = b.msgs.length;
  a.send({ type: "clear" });
  const req = await waitFor(b, (m) => isWipeReq(m) && m.req, 1500);
  await sleep(400);
  check("H legacy: a bare clear becomes a countdown", req?.req?.mode === "countdown" && !has(b, mb, isClear));
  a.send({ type: "wipe_cancel", id: req.req.id });
  await waitFor(b, ended("cancelled"), 1500);
  a.ws.close(); b.ws.close();
}

// I. Two tabs of one browser are one person: 1 person + a friend = a pair.
async function tabsScenario() {
  const R = "MEMEWALL";
  const a1 = await connectMember(R, "dk_sametab01");
  const a2 = await connectMember(R, "dk_sametab01");
  const b = await connectMember(R);
  draw(b);
  await sleep(300);
  b.send({ type: "wipe_request" });
  const req = await waitFor(a2, (m) => isWipeReq(m) && m.req);
  check("I tabs: 3 sockets but 2 people → countdown, not a vote", req?.req?.mode === "countdown", `mode=${req?.req?.mode}`);
  b.send({ type: "wipe_cancel", id: req.req.id });
  await waitFor(a1, ended("cancelled"), 1500);
  a1.ws.close(); a2.ws.close(); b.ws.close();
}

// J. Moderator reset: mural + chat gone for members AND homepage spectators,
// a pending member request is called off, members can't undo it — the
// moderator can, chat included.
async function modResetScenario(adminKey) {
  const R = "VIBES";
  const a = await connectMember(R);
  const b = await connectMember(R);
  draw(a); draw(b);
  a.send({ type: "chat", message: "before the reset" });
  await sleep(400);
  const spec = await connectSpectator(R);
  b.send({ type: "wipe_request" });
  await waitFor(a, (m) => isWipeReq(m) && m.req);
  const w = await connectWatcher(R, adminKey);
  const ma = a.msgs.length;
  const ms = spec.msgs.length;
  w.send({ type: "clear" });
  const clear = await waitAfter(a, ma, isClear, 2000);
  check("J reset: members get a final, moderator-marked clear", !!clear && clear.modReset === true && clear.userId === "admin");
  const chatReset = await waitAfter(a, ma, (m) => m.type === "chat_history" && m.messages.length === 0, 1500);
  check("J reset: the members' chat is emptied", !!chatReset);
  const specReset = await waitAfter(spec, ms, (m) => m.type === "chat_history" && m.messages.length === 0, 1500);
  check("J reset: homepage spectators' chat is emptied too", !!specReset);
  const called = await waitAfter(a, ma, ended("cleared"), 1500);
  check("J reset: a pending member wipe is called off", !!called);
  const view = await joinerView(R);
  check("J reset: a new joiner sees a brand-new room (no ops, no chat)", view.ops === 0 && view.chat.length === 0, JSON.stringify(view));
  const m1 = a.msgs.length;
  a.send({ type: "undo_clear" });
  await sleep(700);
  check("J reset: members can't bring it back", !has(a, m1, (m) => m.type === "history" && m.restored));
  a.send({ type: "chat", message: "after the reset" });
  await sleep(300);
  const m2 = a.msgs.length;
  w.send({ type: "undo_clear" });
  const restored = await waitAfter(a, m2, (m) => m.type === "history" && m.restored, 2000);
  const chatBack = await waitAfter(a, m2, (m) => m.type === "chat_history" && m.messages.length > 0, 2000);
  const lines = (chatBack?.messages || []).map((m) => m.message);
  check("J reset: the moderator's Undo restores the mural", !!restored && restored.ops.length === 2, `ops=${restored?.ops?.length}`);
  check("J reset: …and the chat, older lines first", lines.indexOf("before the reset") > -1 && lines.indexOf("before the reset") < lines.indexOf("after the reset"), JSON.stringify(lines));
  a.ws.close(); b.ws.close(); spec.ws.close(); w.ws.close();
}

// K. The /admin HTTP "Clear room" is the same reset.
async function httpResetScenario(adminKey) {
  const R = "OCCORNER";
  const a = await connectMember(R);
  draw(a);
  a.send({ type: "chat", message: "http line" });
  await sleep(400);
  const ma = a.msgs.length;
  const res = await fetch(`${BASE}/api/admin/rooms/${R}/clear`, { method: "POST", headers: { "x-admin-key": adminKey } });
  const chatReset = await waitAfter(a, ma, (m) => m.type === "chat_history" && m.messages.length === 0, 2000);
  check("K http: /admin Clear room resets the chat too", res.ok && !!chatReset);
  a.ws.close();
}

// L. Private room with a guest host: the host's Clear (host panel) stays
// instant + undoable; the host's request skips the vote; a guest's request
// in a 3-person room is a vote.
async function hostScenario() {
  const R = "ZZWIPEHOST";
  const h = await connectMember(R);
  const g1 = await connectMember(R);
  const g2 = await connectMember(R);
  draw(h); draw(g1);
  await sleep(300);
  const m0 = g1.msgs.length;
  h.send({ type: "clear" });
  const instant = await waitAfter(g1, m0, isClear, 1500);
  check("L host: the host panel Clear is instant", !!instant && !instant.final);
  g1.send({ type: "undo_clear" });
  const back = await waitAfter(g1, m0, (m) => m.type === "history" && m.restored, 1500);
  check("L host: …and can still be brought back", !!back && back.ops.length === 2, `ops=${back?.ops?.length}`);
  h.send({ type: "wipe_request" });
  const hr = await waitFor(g2, (m) => isWipeReq(m) && m.req, 1500);
  check("L host: the host's own request skips the vote", hr?.req?.mode === "countdown", `mode=${hr?.req?.mode}`);
  h.send({ type: "wipe_cancel", id: hr.req.id });
  await waitFor(g2, ended("cancelled"), 1500);
  const mg = g2.msgs.length;
  g1.send({ type: "wipe_request" });
  const gr = await waitAfter(g2, mg, (m) => isWipeReq(m) && m.req, 1500);
  check("L host: a guest's request with 3 people is a vote", gr?.req?.mode === "vote", `mode=${gr?.req?.mode}`);
  g1.send({ type: "wipe_cancel", id: gr?.req?.id });
  h.ws.close(); g1.ws.close(); g2.ws.close();
}

// M. A coloring sheet picked over art: the wipe lands WITH the new sheet.
async function sheetScenario() {
  const R = "GRAFFITI";
  const a = await connectMember(R);
  draw(a);
  await sleep(300);
  a.send({ type: "wipe_request", sheetId: "lib:test-sheet" });
  const req = await waitFor(a, (m) => isWipeReq(m) && m.req);
  check("M sheet: the request carries the sheet", req?.req?.sheet === true);
  const sheet = await waitFor(a, (m) => m.type === "sheet" && m.sheetId === "lib:test-sheet", 12000);
  check("M sheet: after the countdown the new sheet is set", !!sheet && a.msgs.some(isClear));
  const ma = a.msgs.length;
  a.send({ type: "wipe_request", sheetId: "trace_abc" });
  await sleep(500);
  check("M sheet: trace-photo ids are refused", !has(a, ma, (m) => isWipeReq(m) && m.req));
  a.ws.close();
}

const run = async () => {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch { /* booting */ }
    await sleep(250);
  }
  const adminKey = readFileSync(path.join(SCRATCH, ".admin-key"), "utf8").trim();
  const guard = (name, fn) => fn().catch((e) => check(name, false, "harness threw: " + String(e).slice(0, 200)));
  await Promise.all([
    guard("A", soloScenario),
    guard("B", pairScenario),
    guard("C", votePassScenario),
    guard("D", voteFailEarlyScenario),
    guard("E", voteFailDeadlineScenario),
    guard("F", votePassDeadlineScenario),
    guard("G", askerLeavesScenario),
    guard("H", legacyClearScenario),
    guard("I", tabsScenario),
    guard("J", () => modResetScenario(adminKey)),
    guard("K", () => httpResetScenario(adminKey)),
    guard("L", hostScenario),
    guard("M", sheetScenario),
  ]);
};

run()
  .catch((e) => check("harness", false, String(e)))
  .finally(() => {
    server.kill();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  });
