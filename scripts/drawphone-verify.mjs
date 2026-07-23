// Draw Phone (telephone) verification. The story: N players each get a secret
// prompt "book", draw it PRIVATELY, then pass it on — the next player guesses,
// the next draws the guess, until the books reveal. The secrets: your book's
// contents only ever reach the ONE player whose turn it is (never broadcast);
// drawings are private (draw ops are dropped while a game runs); guess text is
// profanity-filtered; the featured PHONE room is the only public place it
// runs (MAIN refuses it). Part A drives the full game over raw WS with 3
// clients; Part B is a browser smoke test of the HUD.
import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, rmSync } from "fs";
import path from "path";
import { WebSocket } from "ws";

const ROOT = "C:/Users/Craig Campbell/Projects/happypaint";
const SCRATCH = path.join(process.env.TEMP || "/tmp", "drawphone-verify-data");
const PORT = 8925;
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

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const NOT_IMAGE = "data:image/png;base64," + Buffer.from("definitely not a png").toString("base64");

function connect(room) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${room}`);
    const msgs = [];
    ws.on("message", (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
    ws.on("open", () => setTimeout(() => resolve({ ws, msgs, send: (o) => ws.send(JSON.stringify(o)) }), 300));
  });
}
async function waitFor(c, type, pred = () => true, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const m = [...c.msgs].reverse().find((x) => x.type === type && pred(x));
    if (m) return m;
    await sleep(80);
  }
  return null;
}
const taskFor = (c, round) => waitFor(c, "phone_task", (m) => m.round === round);

const run = async () => {
  for (let i = 0; i < 40; i += 1) {
    try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch { /* boot */ }
    await sleep(250);
  }

  // ---- Part A: full game over raw WS (3 players) --------------------------
  const c1 = await connect("PHONE");
  const c2 = await connect("PHONE");
  const c3 = await connect("PHONE");
  const clients = [c1, c2, c3];

  // The 3rd joiner tips the featured room into a game: everyone gets a private
  // DRAW task with their own book's seed prompt.
  const t0 = await Promise.all(clients.map((c) => taskFor(c, 0)));
  check("game auto-starts at 3 players → each gets a private draw task",
    t0.every((t) => t && t.phase === "drawing" && typeof t.prompt === "string" && t.prompt.length > 0),
    t0.map((t) => t && t.prompt).join(" | "));

  // PRIVACY: in the draw round nobody was handed an image (a peer's drawing).
  check("draw round leaks no drawings (only your own prompt)",
    clients.every((c) => !c.msgs.some((m) => m.type === "phone_task" && m.round === 0 && m.image)));

  // REGRESSION (review): mid drawing-round, a non-host Clear must be dropped
  // (never a room-wide wipe of everyone's private page), and a non-host
  // phone_skip must not force the featured game to advance.
  c2.msgs.length = 0; c3.msgs.length = 0;
  c1.send({ type: "clear" });
  c1.send({ type: "phone_skip" });
  await sleep(700);
  const clearLeaked = [c2, c3].some((c) => c.msgs.some((m) => m.type === "clear" && !m.gameRound));
  check("Clear is dropped during a Draw Phone round (pages stay private)", !clearLeaked);
  const skipAdvanced = clients.some((c) => c.msgs.some((m) => m.type === "phone_task" && m.round === 1));
  check("a non-host cannot phone_skip the hostless featured game", !skipAdvanced);

  // A non-raster page is rejected; then a real PNG is accepted.
  c1.msgs.length = 0;
  c1.send({ type: "phone_submit", round: 0, image: NOT_IMAGE });
  const rej = await waitFor(c1, "phone_rejected", () => true, 3000);
  check("a non-raster drawn page is rejected", !!rej && rej.reason === "image");

  // All three submit their drawings → the round advances to guessing.
  for (const c of clients) c.send({ type: "phone_submit", round: 0, image: PNG });

  const t1 = await Promise.all(clients.map((c) => taskFor(c, 1)));
  check("after all submit → each gets a private GUESS task with a drawing",
    t1.every((t) => t && t.phase === "guessing" && typeof t.image === "string" && t.image.startsWith("pp_")));

  // Each guesser sees a DIFFERENT book's drawing (the books rotated one seat).
  const imgs = t1.map((t) => t && t.image);
  check("each player guesses a different peer's drawing (books rotated)", new Set(imgs).size === 3, imgs.join(" | "));

  // The drawing is fetchable via the shared sheet route (unguessable id).
  const served = await fetch(`${BASE}/api/sheets/${imgs[0]}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  check("a drawn page is served via /api/sheets/pp_…", !!served && typeof served.image === "string" && served.image.startsWith("data:image"));

  // Guesses: c1 sends mild profanity (must be masked, not stored raw); the rest
  // send clean text. All count as submissions → advance to the final draw round.
  c1.send({ type: "phone_submit", round: 1, text: "crap" });
  c2.send({ type: "phone_submit", round: 1, text: "a happy cat" });
  c3.send({ type: "phone_submit", round: 1, text: "big blue house" });

  const t2 = await Promise.all(clients.map((c) => taskFor(c, 2)));
  check("guesses advance the game → final DRAW round (draw the guess)",
    t2.every((t) => t && t.phase === "drawing" && typeof t.prompt === "string"));

  for (const c of clients) c.send({ type: "phone_submit", round: 2, image: PNG });

  // Reveal: 3 complete books, each prompt → draw → guess → draw.
  const reveal = await waitFor(c1, "phone_reveal", () => true, 8000);
  const books = (reveal && reveal.books) || [];
  const shapeOk = books.length === 3 && books.every((b) =>
    b.pages.length === 4 &&
    b.pages[0].type === "prompt" && b.pages[1].type === "draw" &&
    b.pages[2].type === "guess" && b.pages[3].type === "draw" &&
    typeof b.pages[1].content === "string" && b.pages[1].content.startsWith("pp_"));
  check("reveal: 3 complete books (prompt→draw→guess→draw)", shapeOk, `books=${books.length}`);

  // The mild-profanity guess was masked — no book carries the raw word.
  const anyRaw = books.some((b) => b.pages.some((p) => p.type === "guess" && /crap/i.test(String(p.content))));
  check("mild-profanity guess is masked in the reveal", !anyRaw);

  // A late joiner during the reveal spectates: gets state + the reveal, no task.
  const c4 = await connect("PHONE");
  const c4reveal = await waitFor(c4, "phone_reveal", () => true, 3000);
  const c4task = c4.msgs.some((m) => m.type === "phone_task");
  check("a mid-game joiner spectates the reveal (no task dealt)", !!c4reveal && !c4task);

  // GATE: the hostless public drawing room (MAIN, kid_safe) refuses Draw Phone.
  const main = await connect("MAIN");
  main.send({ type: "set_phone", enabled: true });
  main.send({ type: "phone_start" });
  await sleep(700);
  const mainStarted = main.msgs.some((m) => (m.type === "room_phone" && m.enabled) || m.type === "phone_task" || (m.type === "phone_state" && m.phone));
  check("hostless public room (MAIN) refuses Draw Phone", !mainStarted);

  // The public lobby never exposes a pp_ page id (room.sheetId stays null in-game).
  const lobby = await fetch(`${BASE}/api/rooms/public`).then((r) => r.json()).catch(() => ({ rooms: [] }));
  check("public lobby never leaks a pp_ page id",
    !(lobby.rooms || []).some((r) => String(r.sheetId || "").startsWith("pp_")));

  // REGRESSION (review): set_sheet must REFUSE a pp_ id — otherwise a guesser
  // could re-broadcast an in-progress drawing to the whole room as the underlay.
  const shroom = await connect("ZZSHEET");
  shroom.msgs.length = 0;
  shroom.send({ type: "set_sheet", sheetId: "pp_deadbeefcafe1234" });
  await sleep(500);
  check("set_sheet refuses a pp_ id (no re-broadcasting a private page)",
    !shroom.msgs.some((m) => m.type === "sheet" && String(m.sheetId || "").startsWith("pp_")));
  shroom.ws.close();

  for (const c of [...clients, c4, main]) c.ws.close();

  // ---- Part B: browser HUD smoke -----------------------------------------
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto(`${BASE}/join/PHONE`, { waitUntil: "domcontentloaded" });
  await sleep(3800);
  // The browser joins the same featured room Part A just finished, so the HUD
  // mounts in SOME phase — the reveal viewer (Part A's books) or, once that
  // clears, a fresh waiting banner. Either proves the panel renders from state.
  const hud = await page.evaluate(() =>
    !!document.querySelector(".phone-banner, .phone-reveal, .phone-guess-card"));
  check("Draw Phone HUD renders in the browser (reveal/waiting)", hud);

  // CRITICAL regression: the reveal drawings must actually RENDER. PageImage
  // fetches /api/sheets/pp_ (JSON) and sets the .image data URL as the <img>
  // src — a raw <img src="/api/sheets/pp_…"> would be a broken image. If the
  // reveal is showing, at least one page <img> should resolve to a data: URL.
  if (await page.locator(".phone-reveal").count()) {
    const dataImg = await page.waitForFunction(
      () => [...document.querySelectorAll(".phone-reveal img")].some((i) => (i.currentSrc || i.src || "").startsWith("data:")),
      { timeout: 6000 },
    ).then(() => true).catch(() => false);
    check("reveal drawings render as real images (data URL, not broken JSON)", dataImg);
  }

  const fatal = errors.filter((e) => !/favicon|manifest/i.test(e));
  check("zero page errors", fatal.length === 0, fatal.slice(0, 2).join(" | "));

  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
};

run().catch((e) => { console.error("harness error:", e); server.kill(); process.exit(1); });
