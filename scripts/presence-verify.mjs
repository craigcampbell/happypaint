/* eslint-env browser, node */
// Presence check: boots a throwaway server (own DATA_DIR + admin key), sends
// page loads from two browsers and a bot, an admin API call, one painter socket
// (stroke + chat) and one mural spectator, then asserts /healthz and
// /api/admin/presence count exactly that (bots and staff excluded). Restarts
// the server to prove "today so far" survives, then logs into /admin at phone
// and desktop widths and screenshots every time window. Screenshots land in
// the scratch dir (PRESENCE_SHOTS) or /tmp/presence-verify.
import { chromium } from "playwright";
import WebSocket from "ws";
import { spawn } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = path.join(process.env.TEMP || "/tmp", "presence-verify-data");
const SHOTS = process.env.PRESENCE_SHOTS || path.join(process.env.TEMP || "/tmp", "presence-verify");
const PORT = 8951;
const BASE = `http://localhost:${PORT}`;
const KEY = "qa-admin-key-1234";
const ROOM = "PRESQA";
const UA_A = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
const UA_B = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const UA_PAINT = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36";
const UA_SPEC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";
const UA_ADMIN = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36 admin-console";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`); };

let server = null;
const boot = async () => {
  server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH, ADMIN_KEY: KEY, PB_URL: "", POCKETBASE_URL: "" }, stdio: "pipe" });
  server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
  for (let i = 0; i < 80; i += 1) { try { const r = await fetch(BASE + "/healthz"); if (r.ok) return; } catch { /* boot */ } await sleep(250); }
  throw new Error("server never came up");
};
const stop = async () => {
  if (!server) return;
  const done = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await Promise.race([done, sleep(8000)]);
  if (server.exitCode == null) server.kill("SIGKILL");
  server = null;
};

const get = (p, ua, headers = {}) => fetch(BASE + p, { headers: { "user-agent": ua, ...headers } });
const localMidnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const presence = async () => (await get(`/api/admin/presence?todayStart=${localMidnight()}`, UA_ADMIN, { "x-admin-key": KEY })).json();

const connect = (query, ua) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?${query}`, { headers: { "user-agent": ua } });
  const timer = setTimeout(() => reject(new Error(`socket ${query} never connected`)), 8000);
  ws.on("message", (raw) => {
    let data = null;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (data && data.type === "connected") { clearTimeout(timer); resolve(ws); }
  });
  ws.on("error", reject);
});

const run = async () => {
  await boot();

  // ---- Traffic that must be counted, and traffic that must not ------------
  await get("/", UA_A);
  await get("/wall", UA_A); // same device, second page: one visitor, two page loads
  await get("/api/rooms/public", UA_B); // a lobby poll from a second device, no page load
  await get("/", "curl/8.4.0"); // bot
  await get("/api/sheets", UA_ADMIN, { "x-admin-key": KEY }); // the admin console polling

  const painter = await connect(`room=${ROOM}`, UA_PAINT);
  painter.send(JSON.stringify({ type: "op", op: { kind: "draw", strokeId: "pq1", settings: { brush: "marker", size: 8 }, points: [{ x: 10, y: 10 }, { x: 40, y: 40 }], end: true } }));
  painter.send(JSON.stringify({ type: "chat", message: "presence check" }));
  const spectator = await connect("room=MAIN&spectate=1", UA_SPEC);
  await sleep(1200);

  // ---- /healthz (what the hp* monitors read) --------------------------------
  const health = await (await get("/healthz", "curl/8.4.0")).json();
  check("/healthz reports painting=1 watching=1", health.online?.painting === 1 && health.online?.watching === 1, JSON.stringify(health.online));
  check("/healthz sockets = painter + spectator", health.online?.sockets === 2, `sockets=${health.online?.sockets}`);
  check("/healthz visitors5m = 4 devices (no bot, no admin)", health.online?.visitors5m === 4, `visitors5m=${health.online?.visitors5m}`);

  // ---- /api/admin/presence ----------------------------------------------------
  const unauth = await get("/api/admin/presence", UA_B);
  check("presence endpoint is admin-gated", unauth.status === 401, `status ${unauth.status}`);
  let p = await presence();
  check("now: 1 painter (active), 1 spectator", p.now?.painters === 1 && p.now?.active === 1 && p.now?.spectators === 1, JSON.stringify(p.now));
  const w = p.windows?.m30 || {};
  check("30m: 4 visitors, 1 painted, 1 watched", w.visitors === 4 && w.painters === 1 && w.watchers === 1, `visitors=${w.visitors} painters=${w.painters} watchers=${w.watchers}`);
  check("30m: 2 page loads, 1 join, 1 stroke, 1 chat, 4 visits", w.views === 2 && w.joins === 1 && w.strokes === 1 && w.chats === 1 && w.arrivals === 4, `views=${w.views} joins=${w.joins} strokes=${w.strokes} chats=${w.chats} arrivals=${w.arrivals}`);
  check("30m: peak online = 2 (painter + spectator)", w.peak === 2, `peak=${w.peak}`);
  check("30m series has 30 one-minute bins", w.series?.rows?.length === 30 && w.series?.stepMs === 60000, `${w.series?.rows?.length} rows, step ${w.series?.stepMs}`);
  check("4h series re-bins to 5-minute bars", p.windows?.h4?.series?.stepMs === 300000 && p.windows.h4.series.rows.length === 48, `step ${p.windows?.h4?.series?.stepMs}, ${p.windows?.h4?.series?.rows?.length} rows`);
  check("today uses the admin's local midnight", p.windows?.today?.label === "local day" && p.windows.today.since === localMidnight(), `${p.windows?.today?.label} since=${p.windows?.today?.since}`);
  check("today matches the 30m totals this early", p.windows?.today?.views === 2 && p.windows.today.visitors === 4, `views=${p.windows?.today?.views} visitors=${p.windows?.today?.visitors}`);
  const utc = await (await get("/api/admin/presence", UA_ADMIN, { "x-admin-key": KEY })).json();
  check("today falls back to the UTC day without todayStart", utc.windows?.today?.label === "UTC day", utc.windows?.today?.label);

  // ---- Leaving: live drops, windows keep the history --------------------------
  painter.close();
  spectator.close();
  await sleep(800);
  p = await presence();
  check("after leaving: 0 painting, 0 watching", p.now?.painters === 0 && p.now?.spectators === 0, JSON.stringify(p.now));
  check("after leaving: 30m still shows 1 painted, 1 watched", p.windows?.m30?.painters === 1 && p.windows?.m30?.watchers === 1);

  // ---- Restart: today so far survives --------------------------------------
  await sleep(16000); // the presence store persists on a 15s debounce
  await stop();
  check("presence store written under DATA_DIR", existsSync(path.join(SCRATCH, ".presence.json")));
  await boot();
  p = await presence();
  check("after restart: today keeps 2 page loads, 4 visitors, 1 painted", p.windows?.today?.views === 2 && p.windows.today.visitors === 4 && p.windows.today.painters === 1, `views=${p.windows?.today?.views} visitors=${p.windows?.today?.visitors} painters=${p.windows?.today?.painters}`);

  // ---- UI: /admin Overview at phone + desktop widths -------------------------
  const browser = await chromium.launch({ headless: true });
  for (const [name, viewport] of [["phone", { width: 375, height: 812 }], ["desktop", { width: 1280, height: 900 }]]) {
    const ctx = await browser.newContext({ viewport, userAgent: UA_ADMIN, deviceScaleFactor: 2 });
    const admin = await ctx.newPage();
    await admin.goto(BASE + "/admin", { waitUntil: "domcontentloaded" });
    await admin.waitForSelector("input[type=password]", { timeout: 15000 });
    await admin.fill("input[type=password]", KEY);
    await admin.click("text=Unlock");
    await admin.waitForSelector(".admin-presence .metric", { timeout: 15000 });
    const text = await admin.evaluate(() => document.body.innerText);
    if (name === "phone") {
      check("overview opens on Who's on / Right now", /Who's on/.test(text) && /Painting now/.test(text) && /On the site/.test(text));
      check("Server health is its own section", /Server health/.test(text) && /Event-loop lag/.test(text));
      const order = ["Who's on", "Server health", "Reports", "Active rooms", "Daily history"].map((h) => text.indexOf(h));
      check("sections run Who's on → health → reports → rooms → daily history", order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), order.join(","));
      const wide = await admin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      check("no horizontal overflow at 375px", wide);
    }
    await admin.screenshot({ path: path.join(SHOTS, `admin-${name}-now.png`), fullPage: name === "phone" });
    for (const [label, slug] of [["Last 30 min", "30m"], ["Last 4 hours", "4h"], ["Today so far", "today"]]) {
      await admin.click(`.admin-window-tabs button:has-text("${label}")`);
      await sleep(300);
      const t = await admin.evaluate(() => document.body.innerText);
      if (name === "phone") check(`window "${label}" shows visitors/visits/painted tiles`, /Visitors/.test(t) && /Visits/.test(t) && /Painted/.test(t) && /Peak online/.test(t));
      if (name === "phone" && slug === "today") check("today note explains local midnight vs UTC table", /local midnight/.test(t) && /UTC days/.test(t));
      await admin.screenshot({ path: path.join(SHOTS, `admin-${name}-${slug}.png`), fullPage: false });
    }
    // Anonymous path still fine: the homepage renders for a plain visitor.
    if (name === "phone") {
      const visitor = await ctx.newPage();
      await visitor.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await visitor.waitForSelector("main, #root > *", { timeout: 15000 });
      check("anonymous homepage still renders", (await visitor.evaluate(() => document.body.innerText.length)) > 50);
    }
    await ctx.close();
  }
  await browser.close();
  // The admin's own browser (console polling + its homepage visit) is staff,
  // so the device count is still the four real visitors.
  p = await presence();
  check("staff device is excluded from visitor counts", p.windows?.today?.visitors === 4, `visitors=${p.windows?.today?.visitors}`);
};

run()
  .catch((err) => { console.error(err); results.push({ name: "run", ok: false }); })
  .finally(async () => {
    await stop();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed · screenshots in ${SHOTS}`);
    process.exit(failed.length ? 1 : 0);
  });
