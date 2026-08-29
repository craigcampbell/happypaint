// Canvas Chat verification. The story: chat lines now carry server-minted ids;
// replies quote SERVER-derived context (never client text); tapbacks toggle on
// allowlisted emoji with only COUNTS leaving the server; hype reactions are
// curated + rate-limited; and everything that already guarded chat (moderation,
// the Draw & Guess word intercept, the FINGERS no-chat rule) still holds.
// Part A drives raw WS; Part B smoke-tests the overlay UI in a browser.
import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, rmSync } from "fs";
import path from "path";
import { WebSocket } from "ws";

const ROOT = "C:/Users/Craig Campbell/Projects/happypaint";
const SCRATCH = path.join(process.env.TEMP || "/tmp", "chat-verify-data");
const PORT = 8927;
const BASE = `http://localhost:${PORT}`;

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
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

function connect(room) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${room}`);
    const msgs = [];
    ws.on("message", (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
    ws.on("open", () => {
      // Task #40 handshake: the server holds the join for up to 1.5s waiting
      // for the client's first frame ({type:'auth'}). Send it like the real
      // web client does, or every raw-WS test races that window.
      ws.send(JSON.stringify({ type: "auth", token: null }));
      setTimeout(() => resolve({ ws, msgs, send: (o) => ws.send(JSON.stringify(o)) }), 300);
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

const run = async () => {
  for (let i = 0; i < 40; i += 1) {
    try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch { /* boot */ }
    await sleep(250);
  }

  // ---- Part A: raw WS ------------------------------------------------------
  const a = await connect("ZZCHAT");
  const b = await connect("ZZCHAT");

  // 1) Messages carry server-minted ids.
  a.send({ type: "chat", message: "hello world" });
  const m1 = await waitFor(b, (m) => m.type === "chat" && m.message === "hello world");
  check("chat lines carry a server-minted msgId", !!m1 && Number.isFinite(m1.msgId), `msgId=${m1 && m1.msgId}`);

  // 2) Reply-threading: server derives the quote from its own buffer.
  b.send({ type: "chat", message: "nice drawing!", replyToId: m1 ? m1.msgId : 1 });
  const m2 = await waitFor(a, (m) => m.type === "chat" && m.message === "nice drawing!");
  check("a reply carries server-derived quoted context",
    !!m2 && !!m1 && m2.replyTo && m2.replyTo.id === m1.msgId && m2.replyTo.snippet === "hello world");

  // 3) A bogus replyToId yields a plain message (no fabricated quotes).
  b.send({ type: "chat", message: "orphan reply", replyToId: 999999 });
  const m3 = await waitFor(a, (m) => m.type === "chat" && m.message === "orphan reply");
  check("an unknown replyToId is dropped (plain message)", !!m3 && !m3.replyTo);

  // 4) Tapbacks: the room sees COUNTS ONLY (no identity); the reactor alone
  //    gets a private on/off ack.
  a.send({ type: "chat_react", msgId: m1.msgId, emoji: "🔥" });
  const r1 = await waitFor(b, (m) => m.type === "chat_react" && m.msgId === m1.msgId);
  check("tapback broadcasts a count with NO reactor identity",
    !!r1 && r1.count === 1 && r1.emoji === "🔥" && r1.userId === undefined && r1.on === undefined);
  const selfAck = await waitFor(a, (m) => m.type === "chat_react_self" && m.msgId === m1.msgId);
  check("the reactor gets a private self ack", !!selfAck && selfAck.on === true);
  a.send({ type: "chat_react", msgId: m1.msgId, emoji: "🔥" });
  const r2 = await waitFor(b, (m) => m.type === "chat_react" && m.msgId === m1.msgId && m.count === 0, 3000);
  check("the same tapback toggles OFF", !!r2);

  // 5) Only allowlisted emoji count; unknown msgIds are ignored.
  b.msgs.length = 0;
  a.send({ type: "chat_react", msgId: m1.msgId, emoji: "💀" });
  a.send({ type: "chat_react", msgId: 424242, emoji: "🔥" });
  await sleep(500);
  check("non-allowlisted emoji and unknown msgIds are ignored",
    !b.msgs.some((m) => m.type === "chat_react"));

  // 6) Hype: allowed kind relays; junk kind doesn't; the rate limit bites.
  a.send({ type: "hype", kind: "confetti" });
  const h1 = await waitFor(b, (m) => m.type === "hype");
  check("an allowed hype kind relays with the sender's name", !!h1 && h1.kind === "confetti" && typeof h1.name === "string");
  b.msgs.length = 0;
  a.send({ type: "hype", kind: "giphy-anything" });
  a.send({ type: "hype", kind: "fire" });
  a.send({ type: "hype", kind: "fire" });
  a.send({ type: "hype", kind: "fire" }); // 4th real hype inside 5s → dropped (3 max incl. confetti)
  await sleep(600);
  const hypeCount = b.msgs.filter((m) => m.type === "hype").length;
  check("junk kinds are ignored + the hype rate limit holds", hypeCount === 2, `relayed=${hypeCount}`);

  // 7) chat_history carries ids + reaction COUNTS (never member lists).
  b.send({ type: "chat_react", msgId: m2.msgId, emoji: "❤️" });
  await sleep(400);
  const late = await connect("ZZCHAT");
  const hist = await waitFor(late, (m) => m.type === "chat_history");
  const histLine = hist && hist.messages.find((m) => m.msgId === m2.msgId);
  check("late joiners get ids + replyTo + reaction counts in history",
    !!histLine && histLine.replyTo && histLine.reactions && histLine.reactions["❤️"] === 1
    && !Array.isArray(histLine.reactions["❤️"]));
  late.ws.close();

  // 8) Flood guard: 12 rapid messages → at most 8 delivered.
  b.msgs.length = 0;
  for (let i = 0; i < 12; i += 1) a.send({ type: "chat", message: `flood ${i}` });
  await sleep(800);
  const flooded = b.msgs.filter((m) => m.type === "chat" && /^flood /.test(m.message)).length;
  check("chat flood guard caps a burst (≤8/10s)", flooded <= 8, `delivered=${flooded}`);

  // 9) Moderation is intact: mild is masked in a kid_safe room.
  const pub = await connect("MAIN");
  const pub2 = await connect("MAIN");
  pub.send({ type: "chat", message: "this is crap" });
  const masked = await waitFor(pub2, (m) => m.type === "chat" && /this is/.test(m.message));
  check("mild profanity still masks in public rooms", !!masked && !/crap/.test(masked.message), masked && masked.message);
  pub.ws.close(); pub2.ws.close();

  // 10) Draw & Guess: the word is still intercepted — even after machine-gun
  //     guessing (REGRESSION: the flood guard must never eat a correct guess).
  const g1 = await connect("GUESS");
  const g2 = await connect("GUESS");
  const role = await waitFor(g1, (m) => m.type === "game_role" && m.role === "drawer", 6000)
    || await waitFor(g2, (m) => m.type === "game_role" && m.role === "drawer", 2000);
  let guessOk = false;
  if (role && role.word) {
    const drawer = g1.msgs.some((m) => m.type === "game_role" && m.role === "drawer") ? g1 : g2;
    const guesser = drawer === g1 ? g2 : g1;
    guesser.msgs.length = 0;
    // REGRESSION (review): the DRAWER can't smuggle the word as a DRAWING —
    // doodles from word-knowers are spoiler-blocked while the round is LIVE
    // (so this runs before the correct guess ends the round).
    const PNGSPOIL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    drawer.msgs.length = 0;
    guesser.msgs.length = 0;
    drawer.send({ type: "chat", message: "", doodle: PNGSPOIL });
    const spoilBlock = await waitFor(drawer, (m) => m.type === "game_spoiler", 3000);
    const spoilLeak = guesser.msgs.some((m) => m.type === "chat" && m.doodle);
    check("the drawer can't doodle the secret word into chat", !!spoilBlock && !spoilLeak);

    // 25 rapid wrong guesses first — way past any flood cap.
    guesser.msgs.length = 0;
    for (let i = 0; i < 25; i += 1) guesser.send({ type: "chat", message: `zzguess${i}` });
    guesser.send({ type: "chat", message: role.word });
    const correct = await waitFor(guesser, (m) => m.type === "game_correct", 4000);
    const echoed = guesser.msgs.some((m) => m.type === "chat" && m.message === role.word);
    guessOk = !!correct && !echoed;
  } else {
    check("the drawer can't doodle the secret word into chat", false, "no game role");
  }
  check("a correct guess scores even after machine-gun guessing (flood-proof)", guessOk);
  g1.ws.close(); g2.ws.close();

  // 11) FINGERS: chat + tapbacks + hype all refused.
  const fp = await connect("FINGERS");
  const fp2 = await connect("FINGERS");
  fp.send({ type: "chat", message: "hi" });
  fp.send({ type: "hype", kind: "confetti" });
  await sleep(500);
  check("the finger-paint room refuses chat and hype",
    !fp2.msgs.some((m) => m.type === "chat" || m.type === "hype"));
  fp.ws.close(); fp2.ws.close();

  // 12) Doodle replies: a valid raster doodle relays as a cd_ id + serves;
  //     junk is rejected with feedback; doodles rate-limit separately.
  //     Fresh client — `a` deliberately burned its chat budget in check 8.
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const d = await connect("ZZCHAT");
  b.msgs.length = 0;
  d.send({ type: "chat", message: "look at this", doodle: PNG });
  const dmsg = await waitFor(b, (m) => m.type === "chat" && m.message === "look at this");
  check("a doodle reply relays with an unguessable cd_ id",
    !!dmsg && typeof dmsg.doodle === "string" && dmsg.doodle.startsWith("cd_"));
  const dserved = dmsg && await fetch(`${BASE}/api/sheets/${dmsg.doodle}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  check("the doodle serves via /api/sheets/cd_…", !!dserved && String(dserved.image).startsWith("data:image"));
  d.msgs.length = 0;
  d.send({ type: "chat", message: "", doodle: "data:image/svg+xml;base64," + Buffer.from("<svg/>").toString("base64") });
  const drej = await waitFor(d, (m) => m.type === "chat_blocked" && m.reason === "doodle", 3000);
  check("a non-raster doodle is rejected with feedback", !!drej);
  d.send({ type: "chat", message: "", doodle: PNG }); // 2nd ok
  d.send({ type: "chat", message: "", doodle: PNG }); // 3rd ok
  d.send({ type: "chat", message: "", doodle: PNG }); // 4th ok
  d.msgs.length = 0;
  d.send({ type: "chat", message: "", doodle: PNG }); // 5th within a minute → blocked
  const dlimit = await waitFor(d, (m) => m.type === "chat_blocked" && m.reason === "slow_down", 3000);
  check("doodles have their own tighter rate limit", !!dlimit);

  // REGRESSION (review): a decompression bomb — tiny bytes claiming enormous
  // pixel dimensions — must be rejected by the server's header parse.
  const bomb = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG magic
    Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"),
    Buffer.from([0, 0, 0x23, 0x28, 0, 0, 0x23, 0x28, 8, 6, 0, 0, 0]), // 9000x9000
  ]);
  const d2 = await connect("ZZCHAT");
  d2.msgs.length = 0;
  d2.send({ type: "chat", message: "", doodle: "data:image/png;base64," + bomb.toString("base64") });
  const bombRej = await waitFor(d2, (m) => m.type === "chat_blocked" && m.reason === "doodle", 3000);
  check("a dimension-bomb doodle is rejected (header parse)", !!bombRej);

  // REGRESSION (review): GIF/WEBP are no longer doodle formats (animation vector).
  const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
  d2.msgs.length = 0;
  d2.send({ type: "chat", message: "", doodle: GIF });
  const gifRej = await waitFor(d2, (m) => m.type === "chat_blocked" && m.reason === "doodle", 3000);
  check("GIF doodles are rejected (PNG/JPEG only)", !!gifRej);

  // REGRESSION (review): rejects must NOT burn the doodle quota — after the
  // two rejects above, a fresh client still sends a valid doodle first try.
  d2.msgs.length = 0;
  d2.send({ type: "chat", message: "quota check", doodle: PNG });
  const afterRejects = await waitFor(d2, (m) => m.type === "chat" && m.message === "quota check", 3000);
  check("rejected doodles don't burn the quota", !!afterRejects && !!afterRejects.doodle);

  // REGRESSION (review): admin takedown pushes a removal to live clients.
  const { readFileSync } = await import("fs");
  const adminKey = readFileSync(path.join(SCRATCH, ".admin-key"), "utf8").trim();
  const rmres = await fetch(`${BASE}/api/admin/doodle/${afterRejects.doodle}/remove`, { method: "POST", headers: { "x-admin-key": adminKey } });
  const removedPush = await waitFor(d2, (m) => m.type === "chat_doodle_removed" && m.doodle === afterRejects.doodle, 3000);
  const removedGone = await fetch(`${BASE}/api/sheets/${afterRejects.doodle}`).then((r) => r.status);
  check("admin takedown deletes the image AND pushes removal to live screens",
    rmres.ok && !!removedPush && removedGone === 404);
  d2.ws.close();
  d.ws.close();

  // 13) Spectators now get the conversation (Craig-approved stance change) —
  //     in PUBLIC listed rooms only (private rooms stay unwatchable): history
  //     on join + live chat + hype, a count-only roster, still read-only.
  const mtalk = await connect("MAIN");
  mtalk.send({ type: "chat", message: "main room banter" });
  await sleep(400);
  const spec = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=MAIN&spectate=1`);
    const msgs = [];
    ws.on("message", (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
    ws.on("open", () => setTimeout(() => resolve({ ws, msgs, send: (o) => ws.send(JSON.stringify(o)) }), 400));
  });
  const specHist = spec.msgs.find((m) => m.type === "chat_history");
  check("a spectator gets the room's recent banter on join",
    !!specHist && specHist.messages.some((m) => m.message === "main room banter"));
  const specRoster = spec.msgs.find((m) => m.type === "userList");
  check("the spectator roster stays count-only (no names)",
    !!specRoster && typeof specRoster.count === "number" && !specRoster.users);
  spec.msgs.length = 0;
  mtalk.send({ type: "chat", message: "live banter for the lurkers" });
  mtalk.send({ type: "hype", kind: "star" });
  const specLive = await waitFor(spec, (m) => m.type === "chat" && m.message === "live banter for the lurkers");
  const specHype = await waitFor(spec, (m) => m.type === "hype", 3000);
  check("live chat + hype reach the spectator", !!specLive && !!specHype);
  mtalk.msgs.length = 0;
  spec.send({ type: "chat", message: "spectators cannot talk" });
  await sleep(500);
  check("spectators remain read-only",
    !mtalk.msgs.some((m) => m.type === "chat" && /spectators cannot talk/.test(m.message || "")));
  const privSpec = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=ZZCHAT&spectate=1`);
    const msgs = [];
    ws.on("message", (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
    ws.on("open", () => setTimeout(() => resolve({ ws, msgs }), 400));
  });
  check("private rooms stay unwatchable (spectate refused)",
    privSpec.msgs.some((m) => m.type === "room_blocked"));
  try { privSpec.ws.close(); } catch { /* already closed by server */ }
  spec.ws.close(); mtalk.ws.close();

  a.ws.close(); b.ws.close();

  // ---- Part B: browser overlay smoke --------------------------------------
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto(`${BASE}/join/ZZCHATB`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  check("the chat pill renders over the canvas", await page.locator(".cc-pill").isVisible().catch(() => false));

  // Another client talks → an ambient bubble floats over the art.
  const peer = await connect("ZZCHATB");
  peer.send({ type: "chat", message: "ambient hello" });
  const ambient = await page.waitForSelector(".cc-ambient-line", { timeout: 5000 }).then(() => true).catch(() => false);
  check("an incoming message floats as an ambient bubble", ambient);
  const ambientInert = await page.evaluate(() => {
    const el = document.querySelector(".cc-ambient");
    return el ? getComputedStyle(el).pointerEvents === "none" : false;
  });
  check("the ambient layer is pointer-inert (drawing passes through)", ambientInert);

  // Open the panel: the message is in the log; send a reply from the input.
  await page.locator(".cc-pill").click();
  await sleep(600);
  check("the open panel shows the scrollback", await page.locator(".cc-log .cc-bubble").count().then((n) => n >= 1).catch(() => false));
  await page.locator(".cc-form input").fill("hi from the browser");
  await page.locator(".cc-send").click();
  const echoed = await page.waitForFunction(
    () => [...document.querySelectorAll(".cc-bubble")].some((b) => b.textContent.includes("hi from the browser")),
    { timeout: 5000 },
  ).then(() => true).catch(() => false);
  check("sending from the composer round-trips into the log", echoed);

  // Tapback via the picker; the badge appears.
  await page.locator(".cc-log .cc-bubble").first().click();
  await sleep(300);
  const pickerShown = await page.locator(".cc-picker").isVisible().catch(() => false);
  check("tapping a bubble opens the tapback picker", pickerShown);
  if (pickerShown) {
    await page.locator(".cc-picker button").first().click();
    const badge = await page.waitForSelector(".cc-tapback", { timeout: 4000 }).then(() => true).catch(() => false);
    check("a tapback badge lands on the bubble", badge);
  }

  // Hype: fire one from the tray → the burst layer mounts.
  await page.locator('[aria-label="Big reactions"]').click();
  await sleep(250);
  await page.locator(".cc-hype-tray button").first().click();
  const burst = await page.waitForSelector(".hype-burst", { timeout: 4000 }).then(() => true).catch(() => false);
  check("a hype reaction bursts over the canvas", burst);

  // Doodle reply: open the pad, scribble with the mouse, send → a doodle
  // bubble (real <img>) lands in the log.
  await page.locator('[aria-label="Doodle reply"]').click();
  await sleep(300);
  const pad = page.locator(".doodle-pad canvas");
  const pbox = await pad.boundingBox();
  check("the doodle pad opens from the composer", !!pbox);
  if (pbox) {
    await page.mouse.move(pbox.x + 30, pbox.y + 40);
    await page.mouse.down();
    await page.mouse.move(pbox.x + 120, pbox.y + 90, { steps: 6 });
    await page.mouse.up();
    await page.locator(".doodle-send").click();
    const doodleBubble = await page.waitForSelector(".cc-log img.cc-doodle", { timeout: 6000 }).then(() => true).catch(() => false);
    check("a drawn doodle sends and renders as a bubble", doodleBubble);
  }

  peer.ws.close();

  // Homepage: the viewed room's banter floats over the live viewport, with a
  // "Join the chat" bar one tap from the conversation.
  const mainTalker = await connect("MAIN");
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await sleep(2500);
  mainTalker.send({ type: "chat", message: "homepage banter test" });
  const banter = await page.waitForFunction(
    () => [...document.querySelectorAll(".home-banter-line")].some((el) => el.textContent.includes("homepage banter test")),
    { timeout: 6000 },
  ).then(() => true).catch(() => false);
  check("room banter floats over the homepage viewport", banter);
  check("the homepage shows a Join-the-chat bar", await page.locator(".home-join-chat").isVisible().catch(() => false));
  mainTalker.ws.close();

  // REGRESSION (review, was CRITICAL): on a phone the doodle pad + composer
  // must FIT the bottom sheet — the Send button was clipped off-screen.
  const mctx = await browser.newContext({ viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true });
  const mpage = await mctx.newPage();
  await mpage.goto(`${BASE}/join/ZZMOBILE`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  await mpage.locator(".mobile-quickbar .qb-btn", { hasText: "Chat" }).click();
  await sleep(600);
  await mpage.locator('[aria-label="Doodle reply"]').click();
  await sleep(500);
  const sendBox = await mpage.locator(".doodle-send").boundingBox();
  const composerBox = await mpage.locator(".cc-form").boundingBox();
  const fits = !!sendBox && sendBox.y + sendBox.height <= 667 && sendBox.y >= 0
    && !!composerBox && composerBox.y + composerBox.height <= 667;
  check("iPhone-SE: doodle pad Send + composer fit the mobile sheet",
    fits, `send=${sendBox && Math.round(sendBox.y + sendBox.height)} composer=${composerBox && Math.round(composerBox.y + composerBox.height)} (viewport 667)`);
  await mctx.close();

  const fatal = errors.filter((e) => !/favicon|manifest/i.test(e));
  check("zero page errors", fatal.length === 0, fatal.slice(0, 2).join(" | "));

  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
};

run().catch((e) => { console.error("harness error:", e); server.kill(); process.exit(1); });
