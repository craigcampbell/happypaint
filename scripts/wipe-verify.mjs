// Public canvas refresh (3-day cycle).
//
// A public room's mural resets every 3 days so there's always space to draw.
// The rules that matter:
//   - the deadline is DERIVED from a persisted timestamp, so a restart can
//     neither skip nor double-fire a wipe (the lesson from the daily wipe);
//   - rooms with their own faster cycle (DAILY, GUESS, PHONE) are excluded;
//   - private rooms are never wiped — someone's own room is not a commons;
//   - the room can VOTE to keep the canvas (needs 2 distinct people);
//   - anyone can fork the art into a private room, leaving the public one alone.
//
// The 3-day clock is simulated by writing a past wipeAt into the room file
// before boot, which is exactly the "deadline passed while we were down" case.
import { spawn } from "child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import path from "path";
import { WebSocket } from "ws";

const ROOT = "C:/Users/Craig Campbell/Projects/happypaint";
const SCRATCH = path.join(process.env.TEMP || "/tmp", "wipe-verify-data");
const PORT = 8929;
const BASE = `http://localhost:${PORT}`;
const ROOM_DIR = path.join(SCRATCH, ".rooms");

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(ROOM_DIR, { recursive: true });

// A public room whose refresh was due 10 minutes ago, holding old art.
const staleOps = [
  { kind: "draw", strokeId: "old1", points: [{ x: 10, y: 10 }, { x: 20, y: 20 }], userId: "u_old", opId: 1 },
  { kind: "draw", strokeId: "old2", points: [{ x: 30, y: 30 }, { x: 40, y: 40 }], userId: "u_old", opId: 2 },
];
writeFileSync(path.join(ROOM_DIR, "MAIN.json"), JSON.stringify({
  history: staleOps, audience: "kid_safe", listed: true,
  wipeAt: Date.now() - 10 * 60_000, savedAt: Date.now() - 10 * 60_000,
}));
// A PRIVATE room, equally old — must NOT be touched.
writeFileSync(path.join(ROOM_DIR, "ZZPRIV.json"), JSON.stringify({
  history: staleOps, audience: "friends", listed: false,
  wipeAt: Date.now() - 10 * 60_000, savedAt: Date.now() - 10 * 60_000,
}));

const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH }, stdio: "pipe",
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

let deviceSeed = 0;
function connect(room, deviceKey) {
  // Mirror a real browser: auth first, then client_info carrying the
  // localStorage device key that per-person actions key on.
  const key = deviceKey || `dk_test${(deviceSeed += 1)}${Date.now().toString(36)}`;
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${room}`);
    const msgs = [];
    ws.on("message", (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", token: null })); // server holds the join for this
      ws.send(JSON.stringify({ type: "client_info", deviceKey: key }));
      setTimeout(() => resolve({ ws, msgs, deviceKey: key, send: (o) => ws.send(JSON.stringify(o)) }), 350);
    });
  });
}
async function waitFor(c, pred, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const m = [...c.msgs].reverse().find(pred);
    if (m) return m;
    await sleep(70);
  }
  return null;
}
const DAY = 24 * 3600_000;

const run = async () => {
  for (let i = 0; i < 40; i += 1) {
    try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch { /* boot */ }
    await sleep(250);
  }

  // --- The overdue public room was refreshed at boot -----------------------
  const a = await connect("MAIN");
  const conn = await waitFor(a, (m) => m.type === "connected");
  const hist = await waitFor(a, (m) => m.type === "history");
  check("an overdue public canvas is refreshed (deadline passed while down)",
    !!hist && Array.isArray(hist.ops) && hist.ops.length === 0, `ops=${hist ? hist.ops.length : "?"}`);
  check("the handshake carries the countdown state",
    !!conn && conn.wipe && conn.wipe.wipeAt > Date.now() && conn.wipe.keepNeeded === 2,
    conn && conn.wipe ? `in ${Math.round((conn.wipe.wipeAt - Date.now()) / 3600_000)}h` : "missing");
  const nextIn = conn && conn.wipe ? conn.wipe.wipeAt - Date.now() : 0;
  check("the new deadline is a full 3-day cycle",
    nextIn > 2.9 * DAY && nextIn <= 3.01 * DAY, `${(nextIn / DAY).toFixed(2)}d`);

  // --- A private room of the same age is untouched -------------------------
  const priv = await connect("ZZPRIV");
  const privConn = await waitFor(priv, (m) => m.type === "connected");
  const privHist = await waitFor(priv, (m) => m.type === "history");
  check("private rooms are never auto-wiped (not a commons)",
    !!privHist && privHist.ops.length === staleOps.length, `ops=${privHist ? privHist.ops.length : "?"}`);
  check("private rooms show no countdown", !!privConn && !privConn.wipe);
  priv.ws.close();

  // --- Rooms with their own faster cycle are excluded ----------------------
  const daily = await connect("DAILY");
  const dailyConn = await waitFor(daily, (m) => m.type === "connected");
  check("DAILY is excluded (it already wipes at midnight)", !!dailyConn && !dailyConn.wipe);
  daily.ws.close();
  const guess = await connect("GUESS");
  const guessConn = await waitFor(guess, (m) => m.type === "connected");
  check("game rooms are excluded (they blank per round)", !!guessConn && !guessConn.wipe);
  guess.ws.close();

  // --- Keep-vote needs two distinct people ---------------------------------
  const before = conn.wipe.wipeAt;
  a.msgs.length = 0;
  a.send({ type: "wipe_keep" });
  const oneVote = await waitFor(a, (m) => m.type === "wipe_state");
  check("one vote is counted but does not extend yet",
    !!oneVote && oneVote.wipe.keepVotes === 1 && oneVote.wipe.wipeAt === before);
  a.msgs.length = 0;
  a.send({ type: "wipe_keep" }); // same person again
  await sleep(500);
  const dup = [...a.msgs].reverse().find((m) => m.type === "wipe_state");
  check("the same person cannot vote twice", !dup || dup.wipe.keepVotes === 1);

  // REGRESSION (review): reconnecting / a second tab must NOT count again —
  // a fresh socket reusing the same device key is still one person.
  const aAgain = await connect("MAIN", a.deviceKey);
  aAgain.msgs.length = 0;
  aAgain.send({ type: "wipe_keep" });
  const reVote = await waitFor(aAgain, (m) => m.type === "wipe_denied" && m.reason === "already_voted", 3000);
  const reState = [...aAgain.msgs].reverse().find((m) => m.type === "wipe_state");
  check("reloading or opening a 2nd tab doesn't buy another vote",
    !!reVote && (!reState || reState.wipe.keepVotes === 1));
  aAgain.ws.close();

  const b = await connect("MAIN");
  b.msgs.length = 0;
  b.send({ type: "wipe_keep" });
  const extended = await waitFor(b, (m) => m.type === "wipe_state" && m.wipe.wipeAt > before);
  check("a second voter extends the canvas by another cycle",
    !!extended && extended.wipe.wipeAt - before > 2.9 * DAY && extended.wipe.keepVotes === 0,
    extended ? `+${((extended.wipe.wipeAt - before) / DAY).toFixed(2)}d` : "no extension");

  // --- Fork to a private room ----------------------------------------------
  // Draw something first so there is art worth rescuing.
  a.send({ type: "op", op: { kind: "draw", strokeId: "keepme", points: [{ x: 5, y: 5 }, { x: 9, y: 9 }], end: true } });
  await sleep(500);
  a.msgs.length = 0;
  a.send({ type: "fork_private" });
  const fork = await waitFor(a, (m) => m.type === "fork_ready", 6000);
  check("fork hands back a private room code", !!fork && typeof fork.code === "string" && fork.code.length > 0, fork && fork.code);

  if (fork) {
    const copy = await connect(fork.code);
    const copyConn = await waitFor(copy, (m) => m.type === "connected");
    const copyHist = await waitFor(copy, (m) => m.type === "history");
    check("the fork carries the art across", !!copyHist && copyHist.ops.length >= 1, `ops=${copyHist ? copyHist.ops.length : "?"}`);
    check("the fork is private (and so has no countdown)",
      !!copyConn && copyConn.audience === "friends" && !copyConn.wipe, copyConn && copyConn.audience);
    copy.ws.close();
    // The public room must be left exactly as it was.
    const stillPublic = await fetch(`${BASE}/api/rooms/public`).then((r) => r.json()).catch(() => ({ rooms: [] }));
    const mainRow = (stillPublic.rooms || []).find((r) => r.code === "MAIN");
    check("forking does not disturb the public room", !!mainRow && mainRow.ops >= 1, mainRow ? `ops=${mainRow.ops}` : "missing");
    check("the lobby exposes the countdown too", !!mainRow && mainRow.wipeAt > Date.now());
  }

  // --- REGRESSIONS from the adversarial review ------------------------------
  // Keep-votes are capped: a room can't be held open indefinitely by voting.
  const c1 = await connect("MAIN");
  const beforeCap = (await waitFor(c1, (m) => m.type === "connected")).wipe.wipeAt;
  c1.msgs.length = 0;
  c1.send({ type: "wipe_keep" });
  const capDenied = await waitFor(c1, (m) => m.type === "wipe_denied" && m.reason === "already_extended", 3000);
  const capState = [...c1.msgs].reverse().find((m) => m.type === "wipe_state");
  check("keep-votes are capped at a horizon (can't be pushed out forever)",
    !!capDenied && (!capState || capState.wipe.wipeAt <= beforeCap + 60_000),
    capDenied ? `denied: ${capDenied.reason}` : `no denial; horizon ${((beforeCap - Date.now()) / DAY).toFixed(2)}d out`);

  // A guard that refuses must SAY so — silent failure was a confirmed finding.
  const priv2 = await connect("ZZPRIV");
  priv2.send({ type: "fork_private" });
  const forkDenied = await waitFor(priv2, (m) => m.type === "fork_denied", 3000);
  check("fork is refused (with a reason) outside the refresh cycle",
    !!forkDenied && forkDenied.reason === "not_forkable", forkDenied && forkDenied.reason);
  priv2.ws.close();

  // A forked animation room must keep its film strip, or the rescue strands
  // every frame but the first.
  const flip = await connect("FLIPBOOK");
  flip.send({ type: "op", op: { kind: "draw", strokeId: "f1", points: [{ x: 3, y: 3 }, { x: 8, y: 8 }], end: true } });
  await sleep(600);
  flip.msgs.length = 0;
  flip.send({ type: "fork_private" });
  const flipFork = await waitFor(flip, (m) => m.type === "fork_ready", 6000);
  if (flipFork) {
    const flipCopy = await connect(flipFork.code);
    const flipConn = await waitFor(flipCopy, (m) => m.type === "connected");
    check("a forked animation room keeps its film strip",
      !!flipConn && flipConn.animation === true, flipConn ? `animation=${flipConn.animation}` : "no handshake");
    flipCopy.ws.close();
  } else {
    check("a forked animation room keeps its film strip", false, "fork failed");
  }
  flip.ws.close();
  c1.ws.close();

  // --- The deadline survives a restart --------------------------------------
  const persisted = conn.wipe.wipeAt;
  a.ws.close(); b.ws.close();
  await sleep(3000); // let the debounced room persist land
  const saved = existsSync(path.join(ROOM_DIR, "MAIN.json"))
    ? JSON.parse(readFileSync(path.join(ROOM_DIR, "MAIN.json"), "utf8"))
    : null;
  check("the deadline is persisted (survives a restart)",
    !!saved && Number(saved.wipeAt) > persisted - 1, saved ? `wipeAt=${saved.wipeAt}` : "no file");

  server.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
};

run().catch((e) => { console.error("harness error:", e); server.kill(); process.exit(1); });
