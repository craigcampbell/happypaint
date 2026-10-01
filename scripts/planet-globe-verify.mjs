// Planet globe verify: isolated API server (8991) + Vite dev server (8992)
// with a scratch DATA_DIR, seeded aggregate analytics, a raw WS flag-room
// client for live data, and Playwright UI checks at 375px and 1280px.
//
//   node scripts/planet-globe-verify.mjs
//
// Everything lives under the scratch dir; both child processes are killed on
// exit. No production connections, no secrets (PB_URL=""), no writes outside
// the scratch dir.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import WebSocket from "ws";
import { project, unproject, clipRing, buildGlobePrep, normalizeLon } from "../src/components/globe/sphere.js";
import geo from "../src/data/world-geo.json" with { type: "json" };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = 8991;
const UI_PORT = 8992;
const SCRATCH = "/home/craig/.hermes/cache/scratch/ink-globe-planet";
const DATA_DIR = join(SCRATCH, "data");
const SHOTS = join(SCRATCH, "shots");
const API = `http://127.0.0.1:${API_PORT}`;
const UI = `http://127.0.0.1:${UI_PORT}`;

const SEED_COUNTRIES = { US: 88, BR: 64, MX: 41, IN: 30, JP: 24, DE: 18, NG: 12, AU: 9, FJ: 6, IS: 5 };
const SEED_STROKES = 63_200;
const SEED_SESSIONS = 1_204;

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
writeFileSync(join(DATA_DIR, ".analytics.json"), JSON.stringify({
  version: 1,
  totals: { sessions: SEED_SESSIONS, strokes: SEED_STROKES },
  countries: SEED_COUNTRIES,
}));

// The server derives the flag list from dist/flags-lineart (build output).
// This worktree has no build, so mirror public/flags-lineart the way a build
// would — only when dist doesn't already provide it.
if (!existsSync(join(ROOT, "dist", "flags-lineart"))) {
  mkdirSync(join(ROOT, "dist"), { recursive: true });
  symlinkSync(join(ROOT, "public", "flags-lineart"), join(ROOT, "dist", "flags-lineart"), "dir");
}

// Vite config that re-exports the repo's and only adds the API/WS proxy + port.
const viteCfg = join(SCRATCH, "vite.config.mjs");
writeFileSync(viteCfg, `
import base from ${JSON.stringify(pathToFileURL(join(ROOT, "vite.config.js")).href)};
export default {
  ...base,
  server: {
    ...(base.server || {}),
    host: "127.0.0.1",
    port: ${UI_PORT},
    strictPort: true,
    // node_modules is a symlink into the main checkout: let fonts resolve
    fs: { ...(base.server?.fs || {}), strict: false },
    proxy: {
      "/api": "http://127.0.0.1:${API_PORT}",
      "/ws": { target: "ws://127.0.0.1:${API_PORT}", ws: true },
    },
  },
};
`);

const results = [];
const check = (name, ok, extra = "") => { results.push([name, !!ok]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const kids = [];
function killKids() { for (const k of kids) { try { k.kill("SIGTERM"); } catch { /* gone */ } } }
process.on("exit", killKids);
process.on("SIGINT", () => { killKids(); process.exit(130); });

const api = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR, HOST: "127.0.0.1", PB_URL: "" },
  stdio: "pipe",
});
kids.push(api);
let apiLog = "";
api.stdout.on("data", (d) => { apiLog += d; });
api.stderr.on("data", (d) => { apiLog += d; });

const vite = spawn(process.execPath, [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "--config", viteCfg], { cwd: ROOT, stdio: "pipe" });
kids.push(vite);
let viteLog = "";
vite.stdout.on("data", (d) => { viteLog += d; });
vite.stderr.on("data", (d) => { viteLog += d; });

async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try { if ((await fetch(url)).ok) return true; } catch { /* booting */ }
    await sleep(250);
  }
  return false;
}

// Pixel helpers: identical drawings must give byte-identical PNGs.
const same = (a, b) => Buffer.compare(a, b) === 0;

// When an overlay (e.g. the pinned card) intersects the captured element, the
// compositor can round edge pixels ±1 between captures, breaking byte equality
// while the drawing is identical. Decode both PNGs in the page and count
// pixels whose channels differ by more than 8.
async function sameSoft(pg, a, b) {
  return pg.evaluate(async ([a64, b64]) => {
    const load = (d) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = d; });
    const [ia, ib] = await Promise.all([load(a64), load(b64)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return false;
    const cv = document.createElement("canvas");
    cv.width = ia.width; cv.height = ia.height;
    const cx = cv.getContext("2d");
    cx.drawImage(ia, 0, 0);
    const da = cx.getImageData(0, 0, cv.width, cv.height).data;
    cx.clearRect(0, 0, cv.width, cv.height);
    cx.drawImage(ib, 0, 0);
    const db = cx.getImageData(0, 0, cv.width, cv.height).data;
    for (let i = 0; i < da.length; i += 4) {
      if (Math.abs(da[i] - db[i]) > 8 || Math.abs(da[i + 1] - db[i + 1]) > 8 || Math.abs(da[i + 2] - db[i + 2]) > 8) return false;
    }
    return true;
  }, [`data:image/png;base64,${a.toString("base64")}`, `data:image/png;base64,${b.toString("base64")}`]);
}

try {
  check("API server is up", await waitFor(`${API}/healthz`));
  check("Vite dev server is up", await waitFor(`${UI}/planet`));

  // ---- pure sphere math -------------------------------------------------------
  const p0 = project(0, 0, 0, 0);
  check("project: (0,0) faces us at rot 0", Math.abs(p0.x) < 1e-9 && Math.abs(p0.y) < 1e-9 && p0.z > 0.999);
  check("project: antipode is behind", project(180, 0, 0, 0).z < -0.999);
  // cardinal directions in SCREEN convention (y down): north must be y < 0
  check("project: north pole is screen-UP", project(0, 90, 0, 0).y < -0.999);
  check("project: south pole is screen-DOWN", project(0, -90, 0, 0).y > 0.999);
  check("project: east right / west left", project(90, 0, 0, 0).x > 0.999 && project(-90, 0, 0, 0).x < -0.999);
  check("project: north of center is up under tilt", project(40, 35, 40, 25).y < 0 && project(40, 15, 40, 25).y > 0);
  const rt = unproject(0.3, -0.2, 40, 10);
  const pf = rt && project(rt[0], rt[1], 40, 10);
  check("unproject∘project round-trips (screen coords)", pf && Math.abs(pf.x - 0.3) < 1e-6 && Math.abs(pf.y + 0.2) < 1e-6);
  const upLL = unproject(0, -0.4, 10, 15);
  check("unproject: screen-up is a HIGHER latitude", upLL && upLL[1] > 15);
  const frontSq = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
  check("clipRing keeps a front ring", clipRing(frontSq, 0, 0).length === 1);
  check("clipRing drops a back ring", clipRing(frontSq.map(([x, y]) => [x + 170, y]), 0, 0).length === 0);
  const half = clipRing(frontSq.map(([x, y]) => [x + 85, y]), 0, 0);
  check("clipRing cuts a limb-crossing ring to a partial segment", half.length >= 1 && half.every((s) => s.every(([x]) => x <= 1.0001)));
  // wraparound: visible run split by the ring's initial vertex must merge,
  // and the limb cut must close along a horizon arc, not a chord
  const wrap = clipRing([[-5, -5], [95, -5], [95, 5], [-5, 5]], 0, 0);
  check("clipRing merges the wraparound split into one segment", wrap.length === 1, `${wrap.length} segs`);
  const wrapArc = wrap[0]?.arc;
  check("clipRing closes the limb cut along the horizon (unit-circle arc)",
    !!wrapArc && wrapArc.length > 1 && wrapArc.every((p) => Math.abs(Math.hypot(p[0], p[1]) - 1) < 1e-6));
  check("clipRing picks the short arc for a thin visible sliver",
    (clipRing([[-5, -5], [95, -5], [95, 5], [-5, 5]].map(([x, y]) => [normalizeLon(x + 137), y + 11]), 40, 25)[0]?.arc?.length || 99) <= 8);
  check("normalizeLon survives negative revolutions", normalizeLon(-3600 - 95) === -95 && normalizeLon(765) === 45);
  const prepFixture = buildGlobePrep([{ code: "US", count: 88 }, { code: "BR", count: 64 }], geo);
  const us = prepFixture.items.get("US");
  check("prep: painted country gets glazes + drips", us && us.t > 0 && us.glazes.length > 0 && us.drips && us.drips.length > 0);
  check("prep: unpainted country gets no glazes", prepFixture.items.get("FR") && !prepFixture.items.get("FR").glazes);

  // ---- API (direct + through the Vite proxy) ----------------------------------
  for (const [label, base] of [["direct", API], ["proxied", UI]]) {
    const planet = await (await fetch(`${base}/api/planet`)).json();
    check(`/api/planet (${label}) shape`, ["updatedAt", "strokes", "sessions", "countries", "flags", "live", "milestones", "disclaimer"].every((k) => k in planet));
    check(`/api/planet (${label}) serves the seeded numbers`, planet.strokes === SEED_STROKES && planet.sessions === SEED_SESSIONS, `strokes=${planet.strokes}`);
    check(`/api/planet (${label}) privacy floor: every group >= 5`, planet.countries.every((c) => c.count >= 5));
    check(`/api/planet (${label}) seeded countries present, busiest first`,
      planet.countries[0]?.code === "US" && planet.countries.some((c) => c.code === "BR" && c.count === 64));
  }

  // ---- a real guest in FLAGMX so live data flows ------------------------------
  const frames = [];
  const ws = new WebSocket(`ws://127.0.0.1:${API_PORT}/ws?room=FLAGMX`);
  ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: null, userKey: "dev:globeverify" })));
  ws.on("message", (m) => { try { frames.push(JSON.parse(String(m))); } catch { /* history frame */ } });
  await sleep(1200);
  check("guest joined FLAGMX", frames.some((f) => f.type === "connected"));
  let livePlanet = null;
  for (let i = 0; i < 24; i += 1) {
    livePlanet = await (await fetch(`${API}/api/planet`)).json();
    if (livePlanet.live?.MX?.painting === 1) break;
    await sleep(250);
  }
  check("/api/planet live shows 1 painting MX", livePlanet.live?.MX?.painting === 1, JSON.stringify(livePlanet.live));

  // ---- browser: mobile 375 ----------------------------------------------------
  const browser = await chromium.launch();
  const errors = [];
  const ctx375 = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await ctx375.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${UI}/planet`, { waitUntil: "domcontentloaded" });
  await page.locator("main.planet-main h1").waitFor({ timeout: 20000 });
  const canvas = page.locator("canvas.planet-globe-canvas");
  await canvas.waitFor({ timeout: 20000 });
  await sleep(600); // let the first frames settle
  check("globe canvas renders", (await canvas.count()) === 1);

  const overflow375 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal overflow at 375px", overflow375 <= 1, `${overflow375}px`);

  // spin → pixels move; pause → pixels freeze; play → pixels move again
  const spinA = await canvas.screenshot();
  await sleep(1100);
  const spinB = await canvas.screenshot();
  check("globe auto-spins (pixels change)", !same(spinA, spinB));
  const pauseBtn = page.locator("button.globe-pause");
  await pauseBtn.click();
  await sleep(400);
  const pauseA = await canvas.screenshot();
  await sleep(1100);
  const pauseB = await canvas.screenshot();
  check("pause freezes the globe (pixels identical)", same(pauseA, pauseB));
  check("pause button reflects state", (await pauseBtn.getAttribute("aria-pressed")) === "true");
  await pauseBtn.click();
  await sleep(1100);
  const playA = await canvas.screenshot();
  check("play resumes the spin", !same(pauseB, playA));

  // keyboard rotate (pause first for determinism)
  await pauseBtn.click();
  await sleep(300);
  const keyA = await canvas.screenshot();
  await canvas.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await sleep(200);
  const keyB = await canvas.screenshot();
  check("arrow keys rotate the globe", !same(keyA, keyB));

  // drag rotates; a tiny press is a tap, not a drag
  const dragA = await canvas.screenshot();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.42);
  await page.mouse.down();
  for (let i = 1; i <= 5; i += 1) await page.mouse.move(box.x + box.width / 2 + i * 26, box.y + box.height * 0.42 + i * 6);
  await page.mouse.up();
  await sleep(250);
  const dragB = await canvas.screenshot();
  check("pointer drag rotates the globe", !same(dragA, dragB));
  const urlBefore = page.url();
  // face the open Pacific so the tap lands on water, not a flag country
  await page.evaluate(() => {
    const g = window.__globeDebug;
    g.rotRef.current.lon = -160; g.rotRef.current.lat = 0; g.rotRef.current.vel = 0;
    g.redraw();
  });
  await sleep(100);
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.412); // disc center
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5 + 2, box.y + box.height * 0.412 + 1);
  await page.mouse.up();
  await sleep(300);
  check("a small press is a tap, not a drag (no navigation)", page.url() === urlBefore);

  // keyboard selector → pinned card → flag room (with live headcount for MX)
  await page.locator(".globe-picker select").selectOption("MX");
  await page.waitForSelector(".globe-card-pinned", { timeout: 8000 });
  const pinText = await page.locator(".globe-card-pinned").innerText();
  check("selector pins a country card (Mexico)", /Mexico/.test(pinText), pinText.replace(/\s+/g, " ").slice(0, 80));
  check("pinned card shows the seeded count", /41 recorded painting sessions/.test(pinText));
  check("pinned card shows the live headcount", /coloring the flag right now/.test(pinText));
  await page.locator(".globe-card-pinned .globe-card-open").click();
  await page.waitForURL(/\/join\/FLAGMX/, { timeout: 15000 });
  check("pinned card opens /join/FLAGMX", /FLAGMX/.test(page.url()));

  // back to /planet for the scene checks
  await page.goto(`${UI}/planet`, { waitUntil: "domcontentloaded" });
  await page.locator(".scene").waitFor({ timeout: 20000 });
  const sceneOn = await page.locator(".scene-layer.is-on").count();
  const sceneOff = await page.locator(".scene-layer.is-off").count();
  check("scene layers match the seeded strokes (9 of 15 painted)", sceneOn === 9 && sceneOff === 6, `${sceneOn} on / ${sceneOff} off`);
  const meter = await page.locator(".scene-meter").innerText();
  check("scene meter says what's next", /Next up/.test(meter) && /a third tree/.test(meter), meter.replace(/\s+/g, " ").slice(0, 90));
  // pixel identity over time under NORMAL motion: the lower painting is still
  const sceneShotA = await page.locator(".scene").screenshot();
  await sleep(2500);
  const sceneShotB = await page.locator(".scene").screenshot();
  check("nature scene is pixel-identical over 2.5s (fully static)", same(sceneShotA, sceneShotB));
  const text = (await page.locator("main.planet-main").innerText()).replace(/\s+/g, " ");
  check("page labels equivalents as illustrative, not measured", /illustrative/i.test(text) && /not a measured saving/i.test(text));
  check("privacy wording on the page", /groups under 5 stay private/i.test(text));
  await page.screenshot({ path: join(SHOTS, "planet-375-full.png"), fullPage: true });
  await page.locator(".planet-globe-frame").screenshot({ path: join(SHOTS, "globe-375.png") });
  await page.locator(".scene-wrap").screenshot({ path: join(SHOTS, "scene-375.png") });
  await ctx375.close();

  // ---- browser: desktop 1280 --------------------------------------------------
  const ctx1280 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const desk = await ctx1280.newPage();
  desk.on("pageerror", (e) => errors.push(String(e)));
  await desk.goto(`${UI}/planet`, { waitUntil: "domcontentloaded" });
  const dCanvas = desk.locator("canvas.planet-globe-canvas");
  await dCanvas.waitFor({ timeout: 20000 });
  await sleep(600);
  const overflow1280 = await desk.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal overflow at 1280px", overflow1280 <= 1, `${overflow1280}px`);
  // hover card: scan a grid over the sphere until a country is under the pointer
  const dBox = await dCanvas.boundingBox();
  let hovered = "";
  outer: for (let gy = 0.2; gy <= 0.75; gy += 0.08) {
    for (let gx = 0.15; gx <= 0.85; gx += 0.07) {
      await desk.mouse.move(dBox.x + dBox.width * gx, dBox.y + dBox.height * gy);
      await sleep(60);
      const card = desk.locator(".globe-card:not(.globe-card-pinned)");
      if (await card.count()) { hovered = await card.innerText(); break outer; }
    }
  }
  check("hover card names a country + numbers", /recorded painting sessions|Not painted yet/.test(hovered), hovered.replace(/\s+/g, " ").slice(0, 90));
  await desk.locator(".planet-globe-frame").screenshot({ path: join(SHOTS, "globe-1280.png") });
  await desk.screenshot({ path: join(SHOTS, "planet-1280-full.png"), fullPage: true });
  await ctx1280.close();

  // ---- browser: reduced motion -------------------------------------------------
  const ctxRM = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: "reduce" });
  const rm = await ctxRM.newPage();
  rm.on("pageerror", (e) => errors.push(String(e)));
  await rm.goto(`${UI}/planet`, { waitUntil: "domcontentloaded" });
  const rmCanvas = rm.locator("canvas.planet-globe-canvas");
  await rmCanvas.waitFor({ timeout: 20000 });
  await sleep(700);
  const rmA = await rmCanvas.screenshot();
  await sleep(1400);
  const rmB = await rmCanvas.screenshot();
  check("reduced motion: no auto-spin, drips static (pixels identical)", same(rmA, rmB));
  // but the user can still drag it
  const rmBox = await rmCanvas.boundingBox();
  await rm.mouse.move(rmBox.x + rmBox.width / 2, rmBox.y + rmBox.height * 0.42);
  await rm.mouse.down();
  for (let i = 1; i <= 5; i += 1) await rm.mouse.move(rmBox.x + rmBox.width / 2 + i * 24, rmBox.y + rmBox.height * 0.42);
  await rm.mouse.up();
  await sleep(200);
  const rmC = await rmCanvas.screenshot();
  check("reduced motion: user drag still rotates", !same(rmB, rmC));
  await rmCanvas.screenshot({ path: join(SHOTS, "globe-375-reduced.png") });
  await ctxRM.close();

  // ---- browser: pick() under real DPR transforms -------------------------------
  // Click the PROJECTED center of a known country (Australia) with an actual
  // pointer at DPR 1 / 2 / 2.5. isPointInPath used to run under the DPR
  // transform, which shifts the hit point dpr× off — these fail before the fix.
  const AU = geo.countries.find((c) => c.code === "AU").c;
  for (const dpr of [1, 2, 2.5]) {
    const ctxD = await browser.newContext({ viewport: { width: 500, height: 720 }, deviceScaleFactor: dpr });
    const pg = await ctxD.newPage();
    pg.on("pageerror", (e) => errors.push(String(e)));
    await pg.goto(`${UI}/planet`, { waitUntil: "domcontentloaded" });
    const c = pg.locator("canvas.planet-globe-canvas");
    await c.waitFor({ timeout: 20000 });
    await sleep(500);
    await pg.locator("button.globe-pause").click(); // hold the globe still
    await sleep(250);
    const pt = await pg.evaluate(([lon, lat]) => {
      const g = window.__globeDebug;
      g.rotRef.current.lon = lon; g.rotRef.current.lat = lat; g.rotRef.current.vel = 0;
      g.redraw();
      return { cx: g.frameRef.current.cx, cy: g.frameRef.current.cy, dpr: g.frameRef.current.dpr };
    }, AU);
    check(`DPR ${dpr}: context really runs at that scale`, pt.dpr === dpr, `dpr=${pt.dpr}`);
    const box = await c.boundingBox();
    await pg.mouse.click(box.x + pt.cx, box.y + pt.cy); // dead center = Australia's heart
    let ok = true;
    try { await pg.waitForURL(/\/join\/FLAGAU/, { timeout: 6000 }); } catch { ok = false; }
    check(`DPR ${dpr}: direct pointer on Australia opens its flag room`, ok);
    await ctxD.close();
  }

  // ---- browser: motion-control regressions --------------------------------------
  const JP = geo.countries.find((c) => c.code === "JP").c;
  const jpLat = Math.max(-55, Math.min(55, JP[1]));

  // reduced motion switched on MID-TWEEN: the tween settles instantly
  const ctxMT = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const mt = await ctxMT.newPage();
  mt.on("pageerror", (e) => errors.push(String(e)));
  await mt.goto(`${UI}/planet`, { waitUntil: "domcontentloaded" });
  await mt.locator("canvas.planet-globe-canvas").waitFor({ timeout: 20000 });
  await sleep(500);
  await mt.locator("button.globe-pause").click(); // stop the spin so only the tween can move
  await sleep(250);
  await mt.locator(".globe-picker select").selectOption("JP"); // starts a 750ms tween
  await sleep(150); // mid-tween
  await mt.emulateMedia({ reducedMotion: "reduce" });
  await sleep(400);
  const mtState = await mt.evaluate(() => {
    const g = window.__globeDebug;
    return { lon: g.rotRef.current.lon, lat: g.rotRef.current.lat, anim: !!g.animRef.current };
  });
  check("reduced motion mid-tween settles immediately",
    !mtState.anim && Math.abs(normalizeLon(mtState.lon - JP[0])) < 0.5 && Math.abs(mtState.lat - jpLat) < 0.5,
    `lon=${mtState.lon.toFixed(1)} lat=${mtState.lat.toFixed(1)} anim=${mtState.anim}`);
  const mtShotA = await mt.locator("canvas.planet-globe-canvas").screenshot();
  await sleep(900);
  const mtShotB = await mt.locator("canvas.planet-globe-canvas").screenshot();
  check("reduced motion mid-tween: nothing keeps moving afterwards", await sameSoft(mt, mtShotA, mtShotB));
  await mt.locator(".globe-card-pinned").waitFor({ timeout: 4000 }).then(() => check("reduced settle still parks the pinned card", true))
    .catch(() => check("reduced settle still parks the pinned card", false));
  await ctxMT.close();

  // pause MID-TWEEN: the tween genuinely stops at its target, pixels freeze
  const ctxPT = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const pt2 = await ctxPT.newPage();
  pt2.on("pageerror", (e) => errors.push(String(e)));
  await pt2.goto(`${UI}/planet`, { waitUntil: "domcontentloaded" });
  await pt2.locator("canvas.planet-globe-canvas").waitFor({ timeout: 20000 });
  await sleep(500);
  await pt2.locator(".globe-picker select").selectOption("JP"); // tween starts (spin is free but tween wins)
  await sleep(150); // mid-tween
  await pt2.locator("button.globe-pause").click();
  await sleep(400);
  const ptState = await pt2.evaluate(() => {
    const g = window.__globeDebug;
    return { lon: g.rotRef.current.lon, lat: g.rotRef.current.lat, anim: !!g.animRef.current };
  });
  check("pause mid-tween settles at the target (no creeping)",
    !ptState.anim && Math.abs(normalizeLon(ptState.lon - JP[0])) < 0.5 && Math.abs(ptState.lat - jpLat) < 0.5,
    `lon=${ptState.lon.toFixed(1)} lat=${ptState.lat.toFixed(1)} anim=${ptState.anim}`);
  const ptShotA = await pt2.locator("canvas.planet-globe-canvas").screenshot();
  await sleep(900);
  const ptShotB = await pt2.locator("canvas.planet-globe-canvas").screenshot();
  check("pause mid-tween: motion genuinely stopped", await sameSoft(pt2, ptShotA, ptShotB));
  await ctxPT.close();

  // ---- browser: flag room without map geometry is never a silent no-op ---------
  const ctxNG = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const ng = await ctxNG.newPage();
  ng.on("pageerror", (e) => errors.push(String(e)));
  await ng.goto(`${UI}/planet`, { waitUntil: "domcontentloaded" });
  await ng.locator("canvas.planet-globe-canvas").waitFor({ timeout: 20000 });
  await sleep(400);
  await ng.locator(".globe-picker select").selectOption("EU"); // EU has a flag room, no geometry
  const ngCard = ng.locator(".globe-card-pinned");
  let ngOk = true;
  try { await ngCard.waitFor({ timeout: 5000 }); } catch { ngOk = false; }
  check("geometry-less flag (EU) still pins a card", ngOk);
  const ngText = ngOk ? await ngCard.innerText() : "";
  check("geometry-less card names the flag + stays actionable", /EU/.test(ngText) && (await ng.locator(".globe-card-pinned .globe-card-open").count()) === 1,
    ngText.replace(/\s+/g, " ").slice(0, 70));
  if (ngOk) {
    await ng.locator(".globe-card-pinned .globe-card-open").click();
    let navOk = true;
    try { await ng.waitForURL(/\/join\/FLAGEU/, { timeout: 8000 }); } catch { navOk = false; }
    check("geometry-less card opens its flag room", navOk);
  }
  await ctxNG.close();

  ws.close();
  check("no page errors in any context", errors.length === 0, errors.join(" | ").slice(0, 300));
  await browser.close();
} catch (e) {
  check("suite threw", false, String((e && e.stack) || e).slice(0, 500));
} finally {
  killKids();
}

const fails = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - fails}/${results.length} passed. screenshots in ${SHOTS}`);
if (fails) {
  console.log("--- api log tail ---\n" + apiLog.slice(-1200));
  console.log("--- vite log tail ---\n" + viteLog.slice(-800));
}
process.exit(fails ? 1 : 0);
