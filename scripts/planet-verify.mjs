// Planet verify: isolated server on a scratch DATA_DIR + Playwright + raw WS.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import WebSocket from "ws";

const ROOT = process.cwd();
const PORT = 8961;
const SCRATCH = mkdtempSync(join(tmpdir(), "planet-"));
// Seed some analytics so the map has paint on it.
mkdirSync(SCRATCH, { recursive: true });
const results = [];
const check = (name, ok, extra = "") => { results.push([name, !!ok]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH, HOST: "127.0.0.1" }, stdio: "pipe" });
let slog = ""; server.stdout.on("data", (d) => { slog += d; }); server.stderr.on("data", (d) => { slog += d; });
const API = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(API + "/healthz")).ok) break; } catch { /* boot */ } await sleep(250); }

try {
  // ---- API
  const planet = await (await fetch(API + "/api/planet")).json();
  check("/api/planet shape", ["updatedAt", "strokes", "sessions", "countries", "flags", "live", "milestones", "disclaimer"].every((k) => k in planet));
  check("/api/planet lists 250+ flag codes", Array.isArray(planet.flags) && planet.flags.length >= 250 && planet.flags.includes("US") && planet.flags.includes("MX"), String(planet.flags.length));
  const jar = await (await fetch(API + "/api/paintjar")).json();
  check("/api/paintjar still serves its old contract", ["strokes", "sessions", "countries", "paperEquivalent", "disclaimer"].every((k) => k in jar));
  const png = await fetch(API + "/flags-lineart/MX.png");
  check("flag line-art served from dist", png.ok && (png.headers.get("content-type") || "").includes("png"));
  const shell = await (await fetch(API + "/planet", { headers: { Accept: "text/html" } })).text();
  check("/planet SEO title", /Painted Planet/.test(shell));
  const joinShell = await (await fetch(API + "/join/FLAGBR", { headers: { Accept: "text/html" } })).text();
  check("/join/FLAGBR unfurls as the Brazil flag room", /Color the Brazil flag/.test(joinShell));
  const pub = await (await fetch(API + "/api/rooms/public")).json();
  check("no flag rooms listed before anyone visits", !pub.rooms.some((r) => /^FLAG/.test(r.code)));

  // ---- WS: join FLAGMX as a guest, sheet must be pinned; set_sheet refused
  const frames = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=FLAGMX`);
  ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: null, userKey: "dev:planetverify" })));
  ws.on("message", (m) => { try { frames.push(JSON.parse(String(m))); } catch { /* binary history frame */ } });
  await sleep(1200);
  const connected = frames.find((f) => f.type === "connected");
  check("guest joins FLAGMX", !!connected, connected && connected.roomTitle);
  check("flag room title + prompt", connected && /Mexico flag/.test(connected.roomTitle || "") && /flag of Mexico/.test(connected.prompt || ""), connected && `${connected.roomTitle} | ${connected.prompt}`);
  check("flag room is moderated kid_safe", connected && connected.moderated === true && connected.audience === "kid_safe");
  const sheet = frames.filter((f) => f.type === "sheet").pop();
  check("sheet pinned to flag:MX on join", sheet && sheet.sheetId === "flag:MX", sheet && sheet.sheetId);
  ws.send(JSON.stringify({ type: "set_sheet", sheetId: "lib:1st-birthday-balloon-cake-coloring-page" }));
  ws.send(JSON.stringify({ type: "set_sheet", sheetId: null }));
  await sleep(600);
  const later = frames.filter((f) => f.type === "sheet").slice(1);
  check("set_sheet refused in a flag room (no sheet frame after join)", later.length === 0, JSON.stringify(later));
  const pub2 = await (await fetch(API + "/api/rooms/public")).json();
  const mx = pub2.rooms.find((r) => r.code === "FLAGMX");
  check("FLAGMX now listed in the lobby with flag + sheet", mx && mx.flag === "MX" && mx.sheetId === "flag:MX" && mx.users === 1, JSON.stringify(mx));
  const planet2 = await (await fetch(API + "/api/planet")).json();
  check("/api/planet live shows 1 painting MX", planet2.live && planet2.live.MX && planet2.live.MX.painting === 1, JSON.stringify(planet2.live));
  check("non-flag FLAGZZ is not a flag room", (await (await fetch(API + "/join/FLAGZZ", { headers: { Accept: "text/html" } })).text()).includes("invited to draw"));
  ws.close();

  // ---- Browser
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(API + "/planet", { waitUntil: "domcontentloaded" });
  await page.locator("main.planet-main h1").waitFor({ timeout: 15000 });
  await page.locator(".planet-map").waitFor({ timeout: 15000 });
  // the transparent hit layer must sit EXACTLY over the painting, or clicks land on the wrong country
  await page.waitForFunction(() => document.querySelector("img.planet-art") || document.querySelector("svg.planet-art"), null, { timeout: 15000 });
  const align = await page.evaluate(() => {
    const art = (document.querySelector("img.planet-art") || document.querySelector("svg.planet-art")).getBoundingClientRect();
    const hit = document.querySelector("svg.planet-map").getBoundingClientRect();
    return { dx: Math.abs(art.x - hit.x), dy: Math.abs(art.y - hit.y), dw: Math.abs(art.width - hit.width), dh: Math.abs(art.height - hit.height) };
  });
  check("hit layer is pixel-aligned with the painting", Object.values(align).every((n) => n < 1.5), JSON.stringify(align));
  await page.waitForFunction(() => !!document.querySelector("img.planet-art"), null, { timeout: 15000 }).catch(() => {});
  check("painting is baked to a bitmap (filters run once)", (await page.locator("img.planet-art").count()) === 1);
  const nCountries = await page.locator("path.planet-country").count();
  check("map renders 170+ country paths", nCountries >= 170, String(nCountries));
  const clickable = await page.locator("path.planet-country.is-clickable").count();
  check("most countries are clickable (have a flag)", clickable >= 160, String(clickable));
  // hover Brazil
  const br = page.locator('path.planet-country[aria-label^="Brazil"]');
  await br.hover();
  await sleep(150);
  const card = await page.locator(".planet-card").innerText().catch(() => "");
  check("hover card names the country", /Brazil/.test(card), card.replace(/\s+/g, " "));
  check("hover card explains the click", /color the Brazil flag/i.test(card));
  const sceneOn = await page.locator(".scene-layer.is-on").count();
  const sceneOff = await page.locator(".scene-layer.is-off").count();
  check("scene has locked + unlocked layers (0 strokes → sky only)", sceneOn === 1 && sceneOff >= 10, `${sceneOn} on / ${sceneOff} off`);
  const meter = await page.locator(".scene-meter").innerText();
  check("scene meter says what's next", /Next up/.test(meter), meter.replace(/\s+/g, " ").slice(0, 90));
  const text = (await page.locator("main.planet-main").innerText()).replace(/\s+/g, " ");
  check("page labels equivalents as illustrative, not measured", /illustrative/i.test(text) && /not a measured saving/i.test(text));
  await page.screenshot({ path: join(SCRATCH, "planet.png"), fullPage: true });
  // /paintjar alias
  await page.goto(API + "/paintjar", { waitUntil: "domcontentloaded" });
  await page.locator("main.planet-main h1").waitFor({ timeout: 15000 });
  check("/paintjar still lands on the planet", true);
  // click Mexico → the studio opens on FLAGMX with the flag as the sheet
  await page.goto(API + "/planet", { waitUntil: "domcontentloaded" });
  await page.locator('path.planet-country[aria-label^="Mexico"]').waitFor();
  await page.locator('path.planet-country[aria-label^="Mexico"]').click();
  await page.waitForURL(/\/join\/FLAGMX/, { timeout: 15000 });
  check("clicking Mexico navigates to /join/FLAGMX", /FLAGMX/.test(page.url()));
  await sleep(4000);
  const studioText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  check("studio shows the pinned-flag notice", /flag room from the Painted Planet/.test(studioText));
  check("studio hides Remove / Browse sheets in a flag room", !/Browse 6,000\+ coloring sheets/.test(studioText));
  const flagImgLoaded = await page.evaluate(() => new Promise((res) => { const i = new Image(); i.onload = () => res(i.naturalWidth); i.onerror = () => res(0); i.src = "/flags-lineart/MX.png"; }));
  check("flag line-art loads in the browser", flagImgLoaded === 1920, String(flagImgLoaded));
  await page.screenshot({ path: join(SCRATCH, "flagroom.png") });
  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 200));
  await browser.close();
} catch (e) {
  check("suite threw", false, String(e && e.stack || e).slice(0, 400));
} finally {
  server.kill();
}
const fails = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - fails}/${results.length} passed. screenshots in ${SCRATCH}`);
if (fails) { console.log("--- server log tail ---\n" + slog.slice(-1500)); }
process.exit(fails ? 1 : 0);
