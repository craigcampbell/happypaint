// Multi-client verification of Draw & Guess. Three players so the mid-round
// state is testable (one correct guess doesn't instantly end the round): a
// drawer sees the word, guessers see only blanks, a correct guess scores
// WITHOUT the word ever hitting the chat, draw ops still relay, Skip reveals +
// rotates the drawer. Drives a LOCAL isolated server.
import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, rmSync } from "fs";
import path from "path";

const ROOT = "C:/Users/Craig Campbell/Projects/happypaint";
const SCRATCH = path.join(process.env.TEMP || "/tmp", "game-verify-data");
const PORT = 8922;
const BASE = `http://localhost:${PORT}`;
const GAME_WAIT_NEXT = 6800; // server GAME_INTERMISSION_MS + slack

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH },
  stdio: "pipe",
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function darkPixels(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector(".display-canvas");
    if (!canvas) return -1;
    const ctx = canvas.getContext("2d");
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 16) {
      if (data[i + 3] > 100 && data[i] < 90 && data[i + 1] < 90 && data[i + 2] < 90) dark += 1;
    }
    return dark;
  });
}
async function drawStroke(page, fx = 0.45, fy = 0.45) {
  const overlay = page.locator(".overlay-canvas");
  const box = await overlay.boundingBox();
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
  await page.mouse.down();
  for (let i = 1; i <= 12; i += 1) {
    await page.mouse.move(box.x + box.width * (fx + i * 0.02), box.y + box.height * (fy + i * 0.012));
    await sleep(22);
  }
  await page.mouse.up();
  await sleep(500);
}
async function openChat(page) {
  const toggle = page.locator(".mp-chat-toggle");
  if (await toggle.isVisible().catch(() => false)) { await toggle.click(); await sleep(200); }
}
async function sendChat(page, text) {
  const input = page.locator(".mp-chat-form input");
  await input.fill(text);
  await input.press("Enter");
  await sleep(650);
}
const chatText = (page) => page.locator(".mp-chat-log").innerText().catch(() => "");
const bodyText = (page) => page.evaluate(() => document.body.innerText);
const isDrawer = (page) => page.locator(".game-word-draw").isVisible().catch(() => false);

const run = async () => {
  for (let i = 0; i < 40; i += 1) {
    try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch { /* boot */ }
    await sleep(250);
  }

  const browser = await chromium.launch({ headless: true });
  const pages = [];
  const errors = [];
  for (const tag of ["A", "B", "C"]) {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 860 } });
    const page = await ctx.newPage();
    page.on("pageerror", (err) => errors.push(`${tag}: ${err}`));
    page.on("console", (msg) => { if (msg.type() === "error") errors.push(`${tag}: ${msg.text()}`); });
    pages.push(page);
  }
  const [pageA, pageB, pageC] = pages;

  // 1) A alone → the HUD shows a "waiting for a player" state.
  await pageA.goto(`${BASE}/join/GUESS`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  check("GUESS shows the game HUD", await pageA.locator(".game-hud").isVisible().catch(() => false));
  check("solo: HUD waits for a second player", /waiting for another player/i.test(await bodyText(pageA)));

  // 2) B joins → a round auto-starts; C joins mid-round as a third guesser.
  await pageB.goto(`${BASE}/join/GUESS`, { waitUntil: "domcontentloaded" });
  await sleep(2600);
  await pageC.goto(`${BASE}/join/GUESS`, { waitUntil: "domcontentloaded" });
  await sleep(2600);
  const playing = await Promise.all(pages.map((p) => p.locator(".game-timer").isVisible().catch(() => false)));
  check("round is live for all three players", playing.every(Boolean), `timers=${playing}`);

  // 3) Exactly one drawer; the other two are guessers.
  const drawFlags = await Promise.all(pages.map(isDrawer));
  check("exactly one player is the drawer", drawFlags.filter(Boolean).length === 1, `flags=${drawFlags}`);
  const drawer = pages[drawFlags.indexOf(true)];
  const guessers = pages.filter((_, i) => !drawFlags[i]);

  // 4) Drawer sees the word; both guessers see blanks and never the word.
  const word = (await drawer.locator(".game-word-draw strong").innerText()).trim().toLowerCase();
  check("drawer is shown a secret word", /^[a-z ]{2,}$/.test(word), `word="${word}"`);
  let leaked = false;
  for (const g of guessers) {
    if (!(await g.locator(".game-blanks").isVisible().catch(() => false))) leaked = true;
    if ((await bodyText(g)).toLowerCase().includes(word)) leaked = true;
  }
  check("the word never leaks to either guesser's screen", !leaked, `word="${word}"`);

  // 5) Draw relay still works.
  const before = await darkPixels(guessers[0]);
  await drawStroke(drawer, 0.4, 0.4);
  await sleep(700);
  const after = await darkPixels(guessers[0]);
  check("drawer's strokes relay to the guessers", after > before + 30, `${before} -> ${after}`);

  // 6) One guesser guesses correctly → scores, celebrates, and the round KEEPS
  //    going (a second guesser remains) so the word must stay hidden + unspoken.
  await openChat(guessers[0]);
  await openChat(guessers[1]);
  await openChat(drawer);
  await sendChat(guessers[0], word);
  check("correct guess pops a celebration for the guesser", await guessers[0].locator(".game-pop-correct").isVisible().catch(() => false));
  check("guesser is marked as having guessed (scoreboard)", (await guessers[0].locator(".game-scores .has-guessed").count()) >= 1);
  check("guesser earns points", /[1-9]/.test(await guessers[0].locator(".game-scores .is-me .gs-score").innerText().catch(() => "0")));
  for (const p of pages) {
    const c = (await chatText(p)).toLowerCase();
    check(`word not echoed to chat (${p === drawer ? "drawer" : "guesser"})`, !c.includes(word), `chat="${c.slice(-70)}"`);
  }
  check("chat shows a 'guessed it!' system line", /guessed it/i.test(await chatText(guessers[0])));
  check("the still-guessing player STILL sees blanks", await guessers[1].locator(".game-blanks").isVisible().catch(() => false));

  // 7) Drawer typing the word is swallowed (no self-leak).
  await sendChat(drawer, word);
  check("drawer typing the word is suppressed", !(await chatText(drawer)).toLowerCase().includes(word));

  // 7a) Leak-guard: the word spelled letter-spaced ("b e l l") must NOT reach
  //     the room, and must NOT score (it isn't an exact guess).
  const spaced = word.split("").join(" ");
  const squishedWord = word.replace(/\s+/g, "");
  const scoresBefore = await guessers[1].locator(".game-scores .has-guessed").count();
  await sendChat(guessers[1], spaced);
  let anyLeak = false;
  for (const p of pages) {
    if ((await chatText(p)).toLowerCase().replace(/[^a-z0-9]+/g, "").includes(squishedWord)) anyLeak = true;
  }
  check("letter-spaced word is suppressed (no leak)", !anyLeak);
  check("letter-spaced word does not score", (await guessers[1].locator(".game-scores .has-guessed").count()) === scoresBefore);

  // 8) Skip ends the round → reveal shows the word, then the drawer rotates.
  const roundBefore = await guessers[1].locator(".game-round").innerText();
  await drawer.locator(".game-skip").click();
  await sleep(900);
  check("Skip reveals the word to everyone", (await bodyText(guessers[1])).toLowerCase().includes(word));
  await sleep(GAME_WAIT_NEXT);
  const roundAfter = await guessers[1].locator(".game-round").innerText().catch(() => roundBefore);
  check("a new round starts after the reveal", roundAfter !== roundBefore, `${roundBefore} -> ${roundAfter}`);
  const drawNow = await Promise.all(pages.map(isDrawer));
  check("the drawer rotated to a different player", drawNow.filter(Boolean).length === 1 && drawNow.indexOf(true) !== drawFlags.indexOf(true), `${drawFlags} -> ${drawNow}`);

  // 9) Ordinary (non-word) chat still works during a game.
  await sendChat(guessers[0], "this is so fun");
  check("ordinary chat still works during the game", /this is so fun/i.test(await chatText(drawer)));

  // 10) A normal drawing room has no game HUD.
  await pageA.goto(`${BASE}/join/MAIN`, { waitUntil: "domcontentloaded" });
  await sleep(2200);
  check("non-game rooms have no game HUD", !(await pageA.locator(".game-hud").isVisible().catch(() => false)));

  const fatal = errors.filter((e) => !/favicon|manifest/i.test(e));
  check("zero page errors across all clients", fatal.length === 0, fatal.slice(0, 2).join(" | "));

  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
};

run().catch((e) => { console.error("harness error:", e); server.kill(); process.exit(1); });
