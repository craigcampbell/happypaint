/* eslint-env browser, node */
// Admin visibility check: boots a throwaway server (own DATA_DIR + admin key),
// seeds room ADMQA with strokes from a real browser member and a chat line
// from a raw socket, waits for the thumbnail sweep, then logs into /admin and
// checks the overview (traffic, room card with thumbnail + trends) and the
// Chat log tab — through the UI and the API. Screenshots land in the scratch dir.
import { chromium } from "playwright";
import WebSocket from "ws";
import { spawn } from "child_process";
import { mkdirSync, rmSync } from "fs";
import path from "path";

const ROOT = "C:/Users/Craig Campbell/Projects/happypaint";
const SCRATCH = path.join(process.env.TEMP || "/tmp", "admin-verify-data");
const SHOTS = path.join(process.env.TEMP || "/tmp", "admin-verify");
const PORT = 8942;
const BASE = `http://localhost:${PORT}`;
const KEY = "qa-admin-key-1234";
const ROOM = "ADMQA";
const CHAT_LINE = "hello from the audit test";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
const server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH, ADMIN_KEY: KEY }, stdio: "pipe" });
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };

const run = async () => {
  for (let i = 0; i < 80; i += 1) { try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch { /* boot */ } await sleep(250); }
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36" });

  // A visitor lands on the homepage, then paints in ADMQA.
  const painter = await ctx.newPage();
  await painter.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await painter.goto(BASE + "/join/" + ROOM, { waitUntil: "domcontentloaded" });
  await painter.waitForSelector(".overlay-canvas", { timeout: 15000 });
  await sleep(2800);
  for (const [x0, y0, x1, y1] of [[300, 200, 700, 500], [300, 500, 700, 200], [200, 350, 800, 360]]) {
    await painter.mouse.move(x0, y0);
    await painter.mouse.down();
    for (let i = 1; i <= 12; i += 1) { await painter.mouse.move(x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * i) / 12); await sleep(14); }
    await painter.mouse.up();
    await sleep(200);
  }

  // A second member chats over a raw socket (the studio's own chat payload).
  const chatter = new WebSocket(`ws://localhost:${PORT}/ws?room=${ROOM}`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket never connected")), 8000);
    chatter.on("message", (raw) => {
      let data = null;
      try { data = JSON.parse(raw.toString()); } catch { return; }
      if (data && data.type === "connected") { clearTimeout(timer); resolve(); }
    });
    chatter.on("error", reject);
  });
  chatter.send(JSON.stringify({ type: "chat", message: CHAT_LINE }));
  await sleep(800);

  // The sweep runs every 15s and rotates members; the raw socket can not bake, so allow two sweeps.
  await sleep(40000);

  // ---- API checks ---------------------------------------------------------
  const api = async (p) => { const r = await painter.request.get(BASE + p, { headers: { "x-admin-key": KEY } }); return { status: r.status(), type: r.headers()["content-type"] || "", body: r.ok() && /json/.test(r.headers()["content-type"] || "") ? await r.json() : null, bytes: r.ok() ? (await r.body()).length : 0 }; };
  const roomsRes = await api("/api/admin/rooms");
  const room = roomsRes.body?.rooms?.find((r) => r.id === ROOM);
  check("rooms list carries ADMQA with a thumbAt stamp", !!room && room.thumbAt > 0, room ? `thumbAt=${room.thumbAt} chats=${room.chats}` : "no room");
  const thumb = await api(`/api/admin/rooms/${ROOM}/thumb`);
  check("thumbnail endpoint serves a JPEG", thumb.status === 200 && /image\/jpeg/.test(thumb.type) && thumb.bytes > 500, `${thumb.status} ${thumb.type} ${thumb.bytes} bytes`);
  const feed = await api("/api/admin/chat?limit=50");
  const line = feed.body?.chat?.find((c) => c.message === CHAT_LINE);
  check("cross-room chat feed has the message with its room", !!line && line.room === ROOM, line ? `${line.room} ${line.name}: ${line.message}` : JSON.stringify(feed.body).slice(0, 120));
  const filtered = await api(`/api/admin/chat?limit=50&room=ZZZZ`);
  check("room filter excludes other rooms", Array.isArray(filtered.body?.chat) && filtered.body.chat.length === 0, `${filtered.body?.chat?.length} lines`);
  const searched = await api(`/api/admin/chat?limit=50&q=audit`);
  check("text search finds it", searched.body?.chat?.some((c) => c.message === CHAT_LINE), `${searched.body?.chat?.length} lines`);
  const analytics = await api("/api/admin/analytics");
  const roomSeries = analytics.body?.series?.rooms?.[ROOM] || [];
  const joins = roomSeries.reduce((n, r) => n + (r[1] || 0), 0);
  const strokes = roomSeries.reduce((n, r) => n + (r[2] || 0), 0);
  const chats = roomSeries.reduce((n, r) => n + (r[3] || 0), 0);
  check("per-room hourly series counts joins / strokes / chats", joins >= 2 && strokes >= 3 && chats >= 1, `joins=${joins} strokes=${strokes} chats=${chats}`);
  const today = analytics.body?.traffic?.[0];
  check("server-side traffic counted the visitor's page loads", !!today && today.views >= 2 && today.uniques >= 1, today ? `${today.day}: views=${today.views} uniques=${today.uniques} routes=${JSON.stringify(today.routes)}` : "no traffic");

  // ---- UI checks ----------------------------------------------------------
  const admin = await ctx.newPage();
  await admin.goto(BASE + "/admin", { waitUntil: "domcontentloaded" });
  await admin.waitForSelector("input[type=password]", { timeout: 15000 });
  await admin.fill("input[type=password]", KEY);
  await admin.click("text=Unlock");
  await admin.waitForSelector(".admin-portal", { timeout: 15000 });
  await sleep(5500);
  const overviewText = await admin.evaluate(() => document.body.innerText);
  check("overview shows the Traffic section", /Traffic/.test(overviewText) && /Page loads/.test(overviewText));
  check("overview lists room ADMQA with chats", new RegExp(`Room ${ROOM}`).test(overviewText) && /1 chats/.test(overviewText));
  const thumbOk = await admin.evaluate(() => { const img = document.querySelector("img.admin-room-thumb"); return img ? { w: img.naturalWidth, h: img.naturalHeight } : null; });
  check("room card renders the thumbnail image", !!thumbOk && thumbOk.w > 0, JSON.stringify(thumbOk));
  const bars = await admin.evaluate(() => document.querySelectorAll(".admin-room .admin-trend rect").length);
  check("room card draws trend bars", bars >= 48 * 3, `${bars} bars`);
  await admin.screenshot({ path: path.join(SHOTS, "admin-overview.png"), fullPage: true });
  await admin.click("text=Chat log");
  await sleep(5000);
  const chatText = await admin.evaluate(() => document.body.innerText);
  check("Chat log tab shows the message and its room", chatText.includes(CHAT_LINE) && new RegExp(ROOM).test(chatText));
  await admin.screenshot({ path: path.join(SHOTS, "admin-chat.png"), fullPage: true });

  chatter.close();
  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed\nscreenshots: ${SHOTS}`);
  process.exit(failed ? 1 : 0);
};
run().catch((e) => { console.error(e); server.kill(); process.exit(2); });
