// Daily Challenge + streak verification. The story: the homepage shows ONE
// fresh challenge per UTC day with a countdown; "Draw it now" lands in the
// DAILY room whose prompt IS the challenge; posting to the wall from that room
// auto-joins today's gallery (challenge stamp + tag); the homepage strip and
// /api/daily's entries count reflect it; and the day's first finished stroke
// ticks the device-local streak exactly once.
import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, rmSync } from "fs";
import path from "path";

const ROOT = "C:/Users/Craig Campbell/Projects/happypaint";
const SCRATCH = path.join(process.env.TEMP || "/tmp", "daily-verify-data");
const PORT = 8926;
const BASE = `http://localhost:${PORT}`;

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });

// REGRESSION (review): the midnight wipe must be DERIVED, not RAM-latched.
// Pre-seed a DAILY room file that claims YESTERDAY's challenge date + a stale
// mural — a boot (i.e. a deploy that restarted across midnight) must wipe it.
const { writeFileSync } = await import("fs");
mkdirSync(path.join(SCRATCH, ".rooms"), { recursive: true });
const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
writeFileSync(path.join(SCRATCH, ".rooms", "DAILY.json"), JSON.stringify({
  history: [{ kind: "draw", strokeId: "stale1", points: [{ x: 1, y: 1 }], userId: "u_old", opId: 1 }],
  sheetId: null, dailyDate: yest, savedAt: Date.now() - 86400000,
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

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const run = async () => {
  for (let i = 0; i < 40; i += 1) {
    try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch { /* boot */ }
    await sleep(250);
  }

  // The pre-seeded stale DAILY mural (yesterday's dailyDate) must be wiped at
  // boot — the derived rollover, not a RAM latch, owns the midnight contract.
  const { WebSocket } = await import("ws");
  const staleCheck = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=DAILY`);
    const msgs = [];
    ws.on("message", (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
    ws.on("open", () => setTimeout(() => { ws.close(); resolve(msgs); }, 900));
    ws.on("error", () => resolve(msgs));
  });
  const histMsg = staleCheck.find((m) => m.type === "history");
  check("boot after a midnight-spanning restart wipes yesterday's DAILY mural",
    !!histMsg && Array.isArray(histMsg.ops) && histMsg.ops.length === 0,
    `ops=${histMsg ? histMsg.ops.length : "?"}`);

  // ---- API layer ----------------------------------------------------------
  const daily = await fetch(`${BASE}/api/daily`).then((r) => r.json());
  check("/api/daily returns today's challenge",
    !!daily && typeof daily.prompt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(daily.date) && daily.endsAt > Date.now(),
    `${daily.emoji} ${daily.prompt} (ends in ${Math.round((daily.endsAt - Date.now()) / 3600000)}h)`);
  const again = await fetch(`${BASE}/api/daily`).then((r) => r.json());
  check("the challenge is stable within the day", again.prompt === daily.prompt && again.date === daily.date);

  const lobby = await fetch(`${BASE}/api/rooms/public`).then((r) => r.json());
  const dailyRoom = (lobby.rooms || []).find((r) => r.code === "DAILY");
  check("DAILY room is public + carries the challenge as its prompt",
    !!dailyRoom && typeof dailyRoom.prompt === "string" && dailyRoom.prompt.includes(daily.prompt),
    dailyRoom && dailyRoom.prompt);

  // A wall post FROM the DAILY room is stamped into today's gallery…
  const post = await fetch(`${BASE}/api/wall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "My challenge entry", tags: ["fun"], artist: "Testy", frames: [PNG], durationMs: 400, userKey: "dk_dailytest1", room: "DAILY" }),
  }).then((r) => r.json());
  check("wall post from the DAILY room is accepted", !!post.ok, JSON.stringify(post));

  const gallery = await fetch(`${BASE}/api/wall?challenge=${daily.date}&sort=new&limit=10`).then((r) => r.json());
  check("today's gallery lists the entry (challenge filter)",
    (gallery.posts || []).some((p) => p.id === post.id));
  const withCount = await fetch(`${BASE}/api/daily`).then((r) => r.json());
  check("/api/daily entries count reflects the post", withCount.entries === 1, `entries=${withCount.entries}`);

  // …and a post from a NORMAL room is not.
  const other = await fetch(`${BASE}/api/wall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Regular art", tags: [], artist: "Testy", frames: [PNG], durationMs: 400, userKey: "dk_dailytest2", room: "MAIN" }),
  }).then((r) => r.json());
  const gallery2 = await fetch(`${BASE}/api/wall?challenge=${daily.date}&limit=20`).then((r) => r.json());
  check("a post from a normal room stays out of the gallery",
    !!other.ok && !(gallery2.posts || []).some((p) => p.id === other.id));

  // ---- Browser: homepage card + streak ------------------------------------
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await sleep(2000);
  check("homepage renders the Today's Challenge card",
    await page.locator(".home-daily").isVisible().catch(() => false));
  const cardText = await page.locator(".home-daily").textContent().catch(() => "");
  check("card shows the prompt + a countdown", cardText.includes(daily.prompt) && /New challenge in/.test(cardText));
  check("card shows today's entry in the gallery strip",
    await page.locator(".home-daily-strip .home-wall-tile").count().then((n) => n >= 1).catch(() => false));

  // "Draw it now" → the DAILY room with the challenge as the prompt chip.
  await page.locator(".home-daily-go").click();
  await sleep(2500);
  check("Draw it now lands in /join/DAILY", page.url().includes("/join/DAILY"));

  // First real stroke of the day ticks the streak exactly once.
  const before = await page.evaluate(() => localStorage.getItem("drawesome:streak:v1"));
  const overlay = page.locator(".overlay-canvas");
  const box = await overlay.boundingBox();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(box.x + box.width * (0.4 + i * 0.02), box.y + box.height * (0.4 + i * 0.015));
    await sleep(30);
  }
  await page.mouse.up();
  await sleep(600);
  const after = JSON.parse(await page.evaluate(() => localStorage.getItem("drawesome:streak:v1")) || "null");
  check("first stroke of the day starts the streak", !before && !!after && after.count === 1, JSON.stringify(after));

  // A second stroke the same day must NOT double-count.
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.65);
  await page.mouse.up();
  await sleep(500);
  const still = JSON.parse(await page.evaluate(() => localStorage.getItem("drawesome:streak:v1")) || "null");
  check("second stroke the same day doesn't double-count", !!still && still.count === 1);

  // Yesterday's draw + today's stroke = a 2-day streak (and a 🔥 toast).
  const yest = new Date(Date.now() - 86400000);
  const yd = `${yest.getFullYear()}-${String(yest.getMonth() + 1).padStart(2, "0")}-${String(yest.getDate()).padStart(2, "0")}`;
  await page.evaluate((d) => localStorage.setItem("drawesome:streak:v1", JSON.stringify({ last: d, count: 1 })), yd);
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(2500);
  const box2 = await page.locator(".overlay-canvas").boundingBox();
  await page.mouse.move(box2.x + box2.width * 0.3, box2.y + box2.height * 0.3);
  await page.mouse.down();
  for (let i = 1; i <= 6; i += 1) {
    await page.mouse.move(box2.x + box2.width * (0.3 + i * 0.02), box2.y + box2.height * 0.3);
    await sleep(30);
  }
  await page.mouse.up();
  await sleep(600);
  const grown = JSON.parse(await page.evaluate(() => localStorage.getItem("drawesome:streak:v1")) || "null");
  check("drawing the day after extends the streak to 2", !!grown && grown.count === 2, JSON.stringify(grown));

  // The homepage now shows the 🔥 streak chip.
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await sleep(1800);
  check("homepage shows the 🔥 streak chip at 2+ days",
    await page.locator(".home-streak").isVisible().catch(() => false));

  const fatal = errors.filter((e) => !/favicon|manifest/i.test(e));
  check("zero page errors", fatal.length === 0, fatal.slice(0, 2).join(" | "));

  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
};

run().catch((e) => { console.error("harness error:", e); server.kill(); process.exit(1); });
