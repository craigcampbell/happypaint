// Draw & Guess match podium verification: play 5 real rounds (drawer's word is
// read from its private game_role frame; the other client guesses it), then
// assert the game_podium broadcast fires with correct standings and that
// scores reset for the next match.
import { spawn } from "child_process";
import { mkdirSync, rmSync } from "fs";
import path from "path";
import { SimClient } from "../test/harness/client.mjs";

const ROOT = process.cwd();
const SCRATCH = path.join(process.env.TEMP || "/tmp", "podium-verify-data");
const PORT = 8931;
const BASE = `http://localhost:${PORT}`;
const BASE_WS = `ws://localhost:${PORT}`;

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  // Short timers so five rounds fit in seconds, not minutes.
  env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH, ADMIN_KEY: "podium-admin" },
  stdio: "pipe",
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const run = async () => {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(BASE + "/healthz"); if (r.ok) break; } catch { /* boot */ }
    await sleep(250);
  }

  const a = new SimClient(BASE_WS, { room: "GUESS", name: "a" });
  const b = new SimClient(BASE_WS, { room: "GUESS", name: "b" });
  await a.connect();
  await b.connect(); // second player auto-starts round 1

  let podium = null;
  let roundsPlayed = 0;
  const playRound = async () => {
    // Whichever client got the drawer role holds the word; the other guesses.
    const roleOf = async (c) =>
      c.waitFor((m) => m.type === "game_role" && m.roundNo === roundsPlayed + 1, { timeoutMs: 8000, label: `round ${roundsPlayed + 1} role` });
    const [ra, rb] = await Promise.all([roleOf(a), roleOf(b)]);
    const drawerIsA = ra.role === "drawer";
    const word = drawerIsA ? ra.word : rb.word;
    const guesser = drawerIsA ? b : a;
    guesser.sendChat(word);
    await guesser.waitFor((m) => m.type === "game_correct" || (m.type === "game_end" && m.reason === "allguessed"), { timeoutMs: 6000, label: `round ${roundsPlayed + 1} solved` }).catch(() => null);
    await a.waitFor((m) => m.type === "game_end", { timeoutMs: 6000, label: `round ${roundsPlayed + 1} end` });
    roundsPlayed += 1;
  };

  try {
    for (let round = 0; round < 5; round += 1) {
      await playRound();
      // Drain: waitFor scans the whole buffer; podium may land after round 5.
    }
    podium = await a.waitFor((m) => m.type === "game_podium", { timeoutMs: 6000, label: "game_podium after 5 rounds" });
    check("podium broadcast after 5 rounds", !!podium, JSON.stringify(podium?.standings));
    check("podium has ranked standings with positive top score", Array.isArray(podium?.standings) && podium.standings.length >= 2 && podium.standings[0].score > 0 && podium.standings[0].score >= podium.standings[podium.standings.length - 1].score);
    check("podium reports the match length", podium?.rounds === 5);

    // Next match: the following game_state must carry RESET scores.
    const fresh = await a.waitFor(
      (m) => m.type === "game_state" && m.game && m.game.phase === "playing" && m.game.roundNo === 1,
      { timeoutMs: 16000, label: "next match round 1" },
    );
    const scores = (fresh.game.scores || []).map((s) => s.score);
    check("scores reset for the new match", scores.every((s) => s === 0), JSON.stringify(fresh.game.scores));
  } finally {
    await a.close();
    await b.close();
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
