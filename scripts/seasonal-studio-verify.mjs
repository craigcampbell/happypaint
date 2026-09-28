// Seasonal STUDIO ink-only UX verification (studio owner).
/* global window, document */
//
// Runs against the REAL seasonal backend (server/inktober.js is live): the
// INKTOBER room handshake carries inkOnly:true + event, prompt updates ride
// seasonal_prompt, and the server enforces ink/pencil ops at ingest (a v3
// inline dab must describe the declared brush's native dab). These checks
// drive the real studio in a browser and prove the CLIENT honours the room:
//
//   1. Brush rail shows exactly Brushed ink / Pencil / Eraser (+ a hint).
//   2. Non-brush tools, image import, trace-a-photo, coloring sheets, draft
//      restore and replay "Remix" are all closed off (no divergent-art paths).
//   3. Hotkey bypasses can't escape: Backspace -> eraser, "b" -> an INK-ROOM
//      brush (never the pre-join marker), and a stroke drawn right after the
//      hotkey round-trip is ACCEPTED by the server's ink validation (received
//      by a second raw WS client with a native v3 inline dab).
//   4. Eraser strokes pass server validation (eraser stays permitted).
//   5. seasonal_prompt consumption: an injected seasonal_prompt frame updates
//      the prompt chip live.
//   6. Drawing anonymity: relayed op frames carry only the server's anonymous
//      userId — no token/email/userKey/name leaks.
//   7. Regression: a normal public room (DOODLE) keeps the full brush list.
//
// Stack: server.js on 8953 (scratch DATA_DIR), Vite dev on 8952. No prod.
import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, rmSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRATCH = "/home/craig/.hermes/cache/scratch/seasonal-studio-verify";
const VITE_PORT = 8952;
const API_PORT = 8953;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const WS_URL = `ws://127.0.0.1:${API_PORT}/ws`;

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });

const procs = [];
const spawnBg = (argv, env) => {
  const p = spawn(process.execPath, argv, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "pipe" });
  p.stderr.on("data", (d) => process.stderr.write(`[${path.basename(argv[0])}] ` + d));
  procs.push(p);
  return p;
};
spawnBg(["server.js"], { PORT: String(API_PORT), DATA_DIR: path.join(SCRATCH, "data") });
spawnBg(["node_modules/vite/bin/vite.js", "--port", String(VITE_PORT), "--strictPort", "--host", "127.0.0.1"], {
  VITE_WS_URL: `ws://127.0.0.1:${API_PORT}/ws`,
});
const killAll = () => { for (const p of procs) { try { p.kill(); } catch { /* */ } } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function waitHttp(url, tries = 160) {
  for (let i = 0; i < tries; i += 1) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* boot */ }
    await sleep(250);
  }
  return false;
}

// Raw second client: shakes hands, collects op frames for the room.
function watchRoom(room) {
  const frames = [];
  const ws = new WebSocket(`${WS_URL}?room=${encodeURIComponent(room)}`);
  ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: null })));
  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    frames.push(data);
  });
  return {
    frames,
    ops: () => frames.filter((f) => f.type === "op").map((f) => f.op),
    send: (obj) => ws.send(JSON.stringify(obj)),
    close: () => { try { ws.close(); } catch { /* */ } },
  };
}

async function gotoStudio(page, room) {
  await page.goto(`${BASE}/join/${room}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".overlay-canvas", { state: "visible", timeout: 60000 });
  await sleep(2500);
  const okCurtain = page.locator("button.load-ok");
  if (await okCurtain.waitFor({ state: "visible", timeout: 8000 }).then(() => true).catch(() => false)) {
    await okCurtain.click();
  }
  await page.locator(".modal-backdrop").first().waitFor({ state: "detached", timeout: 8000 }).catch(() => null);
  await sleep(300);
}

async function drawStroke(page, fx, fy) {
  const overlay = page.locator(".overlay-canvas");
  const box = await overlay.boundingBox();
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) {
    await page.mouse.move(box.x + box.width * (fx + i * 0.02), box.y + box.height * (fy + i * 0.015));
    await sleep(25);
  }
  await page.mouse.up();
  await sleep(400);
}

// Brush rail chip names in render order.
const brushChipNames = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".tool-section .brush-grid .brush-chip .chip-name")]
      .map((el) => el.textContent.trim())
      .filter(Boolean),
  );

const activeBrushName = (page) =>
  page.evaluate(() => document.querySelector('.tool-section .brush-grid .brush-chip[aria-pressed="true"] .chip-name')?.textContent.trim() || null);

const INK_ROOM_BRUSHES = ["Brushed ink", "Pencil", "Eraser"];

const run = async () => {
  if (!(await waitHttp(`http://127.0.0.1:${API_PORT}/healthz`))) throw new Error("server.js did not boot");
  if (!(await waitHttp(`${BASE}/join/INKTOBER`))) throw new Error("vite did not boot");
  // Warm the transform/dep-optimize pipeline (avoids a mid-session reload).
  for (const url of ["/", "/src/main.jsx", "/src/App.jsx"]) {
    try { await fetch(`${BASE}${url}`); } catch { /* best effort */ }
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: "chrome" });
  } catch {
    browser = await chromium.launch({ headless: true });
  }
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  // ---- 1+2: ink-only rail & closed-off bypass UI -------------------------
  const watcher = watchRoom("INKTOBER");
  await gotoStudio(page, "INKTOBER");
  await sleep(1200); // handshake + rail settle

  const chips = await brushChipNames(page);
  check(
    "INKTOBER brush rail is exactly Brushed ink / Pencil / Eraser",
    chips.length === 3 && INK_ROOM_BRUSHES.every((b) => chips.includes(b)),
    JSON.stringify(chips),
  );
  const hintVisible = await page.evaluate(() => /ink|pencil/i.test(document.querySelector(".ink-only-note")?.textContent || ""));
  check("ink-only room explains itself (hint note)", hintVisible);
  const toolSectionVisible = await page.evaluate(() => {
    const headings = [...document.querySelectorAll(".tool-section h2")].map((h) => h.textContent.trim());
    return headings.includes("Tool");
  });
  check("non-brush tool section is not offered", !toolSectionVisible);

  // The studio dropdown (desktop) must not offer image import in this room.
  const toggle = page.locator(".desktop-studio-toggle");
  if (await toggle.isVisible().catch(() => false)) {
    const open = await page.evaluate(() => document.querySelector(".topbar")?.className.includes("is-open"));
    if (!open) { await toggle.click(); await sleep(320); }
  }
  const gifImportVisible = await page.locator('button:has-text("🖼 GIF"):visible').count();
  check("GIF/image import button is hidden in the ink room", gifImportVisible === 0, `${gifImportVisible} visible`);

  // Gallery modal: draft restore is a divergent-art path — closed here.
  await page.locator('button:has-text("🖼️ Gallery"):visible').first().click();
  await sleep(600);
  const restoreVisible = await page.locator('button:has-text("Restore last draft"):visible').count();
  check("Restore-last-draft is hidden in the ink room", restoreVisible === 0, `${restoreVisible} visible`);
  await page.locator('.confirm-overlay[aria-labelledby="myart-title"] button[aria-label="Close"]').click();
  await sleep(350);
  // close the dropdown again for the canvas
  if (await page.evaluate(() => document.querySelector(".topbar")?.className.includes("is-open"))) {
    await toggle.click(); await sleep(250);
  }

  // Trace-a-photo + coloring sheets are server-blocked in this room; the
  // client must not offer them either.
  const traceVisible = await page.locator('button:has-text("Trace a photo"):visible').count();
  check("Trace-a-photo is hidden in the ink room", traceVisible === 0, `${traceVisible} visible`);
  const sheetVisible = await page.locator('button:has-text("coloring sheet"):visible').count();
  check("coloring-sheet browse is hidden in the ink room", sheetVisible === 0, `${sheetVisible} visible`);

  // ---- 3: hotkey bypass + server-accepted ink strokes --------------------
  const initialBrush = await activeBrushName(page);
  check("ink room starts on an ink-room brush", INK_ROOM_BRUSHES.slice(0, 2).includes(initialBrush), String(initialBrush));

  await page.keyboard.press("Backspace");
  await sleep(300);
  const afterBackspace = await activeBrushName(page);
  check("Backspace selects the eraser (allowed)", afterBackspace === "Eraser", String(afterBackspace));

  await page.keyboard.press("b");
  await sleep(300);
  const afterB = await activeBrushName(page);
  check("\"b\" hotkey returns to ink/pencil (never the pre-join marker)", ["Brushed ink", "Pencil"].includes(afterB), String(afterB));

  // A stroke right after the hotkey round-trip must be ACCEPTED by the
  // server's ink validation: the second client receives it with a native v3
  // inline dab describing the declared brush.
  const opsBefore = watcher.ops().length;
  await drawStroke(page, 0.4, 0.4);
  await sleep(1200);
  const newOps = watcher.ops().slice(opsBefore);
  const drawOps = newOps.filter((op) => op && op.kind === "draw");
  const settingOps = drawOps.filter((op) => op.settings);
  const brushes = [...new Set(settingOps.map((op) => op.settings.brush))];
  check(
    "stroke after hotkey round-trip reached the room (server accepted it)",
    drawOps.length > 0 && settingOps.length > 0,
    `${drawOps.length} draw ops, brushes=${JSON.stringify(brushes)}`,
  );
  check(
    "relayed stroke uses ink/pencil only",
    brushes.length > 0 && brushes.every((b) => b === "ink" || b === "pencil"),
    JSON.stringify(brushes),
  );
  // Contract dab rule (server/inktober.js): an inline v3 dab that describes
  // the DECLARED brush's native shape is legitimate and must pass; a forged
  // non-native dab is refused. Prove both against the live boundary: one raw
  // client SENDS, a second raw client OBSERVES (a sender never gets its own
  // ops echoed back).
  const sender = watchRoom("INKTOBER");
  const observer = watchRoom("INKTOBER");
  await sleep(1000); // let both joins land
  const nativeCount = observer.ops().length;
  sender.send({ type: "op", op: { kind: "draw", strokeId: "native-dab-1", settings: { brush: "pencil", color: "#111", size: 4, v: 3, dab: { shape: "graphite" } }, points: [{ x: 0.5, y: 0.5 }, { x: 0.55, y: 0.55 }], end: true } });
  sender.send({ type: "op", op: { kind: "draw", strokeId: "forged-dab-1", settings: { brush: "ink", color: "#111", size: 4, v: 3, dab: { shape: "calligraphy" } }, points: [{ x: 0.6, y: 0.6 }, { x: 0.65, y: 0.65 }], end: true } });
  await sleep(1500);
  const boundaryOps = observer.ops().slice(nativeCount);
  const relayedStrokes = boundaryOps.map((op) => op && op.strokeId);
  sender.close();
  observer.close();
  check(
    "native inline v3 dab passes the room boundary (not blanket-rejected)",
    relayedStrokes.includes("native-dab-1"),
    JSON.stringify(relayedStrokes),
  );
  check(
    "forged non-native dab is refused at the boundary",
    !relayedStrokes.includes("forged-dab-1"),
    JSON.stringify(relayedStrokes),
  );

  // ---- 4: eraser strokes pass --------------------------------------------
  await page.keyboard.press("Backspace");
  await sleep(250);
  const opsBeforeErase = watcher.ops().length;
  await drawStroke(page, 0.42, 0.42);
  await sleep(1200);
  const eraseOps = watcher.ops().slice(opsBeforeErase).filter((op) => op && op.kind === "draw" && op.settings);
  const eraseBrushes = [...new Set(eraseOps.map((op) => op.settings.brush))];
  check("eraser strokes are accepted by the room", eraseBrushes.length > 0 && eraseBrushes.every((b) => b === "eraser"), JSON.stringify(eraseBrushes));
  await page.keyboard.press("b");
  await sleep(250);

  // ---- 6: drawing anonymity ----------------------------------------------
  const opJson = JSON.stringify(drawOps);
  const identityLeak = /token|userKey|email|@example|displayName/i.test(opJson);
  check("relayed op frames carry no identity beyond the anonymous userId", !identityLeak && drawOps.every((op) => typeof op.userId === "string"), identityLeak ? "LEAK in op payload" : `userId=${drawOps[0]?.userId}`);

  // ---- replay modal: remix closed, seasonal theming offered ---------------
  await page.locator('button[title*="Watch it draw"]:visible').first().click();
  await page.waitForSelector(".replay-actions", { state: "visible", timeout: 15000 }).catch(() => null);
  const remixCount = await page.locator('button:has-text("Remix from here"):visible').count();
  check("replay Remix-from-here is closed in the ink room", remixCount === 0, `${remixCount} visible`);
  const seasonalLine = await page.locator(".replay-seasonal").textContent().catch(() => "");
  check("replay offers the Inktober prompt + optional export border", /Inktober prompt/i.test(seasonalLine || ""), (seasonalLine || "").trim().slice(0, 90));
  await page.locator(".replay-modal .modal-title-row button").click();
  await sleep(300);

  // ---- 5: seasonal_prompt live consumption --------------------------------
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx2.addInitScript(() => {
    const RealWS = window.WebSocket;
    window.WebSocket = class extends RealWS {
      constructor(url, protocols) {
        super(url, protocols);
        // Per-socket flag: the app may open more than one socket (main +
        // watcher) — inject the seasonal_prompt push on whichever socket(s)
        // receive the room's connected frame.
        this.__seasonalInjected = false;
        this.addEventListener("message", (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data && data.type === "connected" && !this.__seasonalInjected) {
              this.__seasonalInjected = true;
              setTimeout(() => {
                this.dispatchEvent(new MessageEvent("message", {
                  data: JSON.stringify({
                    type: "seasonal_prompt",
                    prompt: "TestPromptXYZ",
                    event: { phase: "active", day: 5, prompt: "TestPromptXYZ" },
                  }),
                }));
              }, 400);
            }
          } catch { /* binary history frames */ }
        });
      }
    };
  });
  const page2 = await ctx2.newPage();
  page2.on("pageerror", (e) => errors.push(String(e)));
  await gotoStudio(page2, "INKTOBER");
  await page2.waitForFunction(
    () => (document.querySelector(".room-prompt-chip")?.textContent || "").includes("TestPromptXYZ"),
    null,
    { timeout: 15000 },
  ).catch(() => null);
  const chipText = await page2.locator(".room-prompt-chip").textContent().catch(() => "");
  check("seasonal_prompt message updates the live prompt chip", (chipText || "").includes("TestPromptXYZ"), (chipText || "").trim().slice(0, 80));
  await ctx2.close();

  // ---- 7: regression — a normal room keeps everything ---------------------
  const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page3 = await ctx3.newPage();
  page3.on("pageerror", (e) => errors.push(String(e)));
  await gotoStudio(page3, "DOODLE");
  await sleep(1000);
  const doodleChips = await brushChipNames(page3);
  check("normal room keeps the full brush list", doodleChips.length > 3 && doodleChips.includes("Marker"), JSON.stringify(doodleChips.slice(0, 6)));
  const doodleHint = await page3.evaluate(() => !!document.querySelector(".ink-only-note"));
  check("normal room shows no ink-only note", !doodleHint);
  await ctx3.close();

  watcher.close();
  const fatal = errors.filter((e) => !/favicon|manifest|ResizeObserver|Download the React DevTools|ERR_FILE_NOT_FOUND|status of 404/i.test(e));
  check("zero page errors", fatal.length === 0, fatal.slice(0, 2).join(" | "));

  await ctx.close();
  await browser.close();
  killAll();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log("failed:", failed.map((f) => f.name).join(" | ")); }
  process.exit(failed.length ? 1 : 0);
};

run().catch((e) => { console.error("harness error:", e); killAll(); process.exit(1); });
