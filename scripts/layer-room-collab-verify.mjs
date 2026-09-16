// What a room does to a layered drawing when somebody ELSE is involved, and
// whether a room history replay reproduces the drawing 1:1.
//
//  C1  a joiner mid-session gets ONE layer and every stroke on it
//  C2  a joiner's stroke lands on layer 0 of a layered artist's canvas — i.e.
//      their help arrives UNDER the artist's upper-layer work (invisible)
//  C3  a replay is not 1:1: an eraser stroke the artist aimed at layer 0 (with
//      an upper layer covering the hole, so nothing visibly changed) is replayed
//      in op order onto layer 0 and eats the upper layer's ink too
//
// Usage: node scripts/layer-room-collab-verify.mjs
import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

const PORT = 8955;
const BASE = `http://localhost:${PORT}`;
const CODE = "LAYERCOL";
const ROOM = `/join/${CODE}`;
const ROOT = process.cwd();
const SCRATCH = path.join(os.tmpdir(), "hp-layer-collab-verify");

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH },
  stdio: "pipe",
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (n, ok, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`);
  if (!ok) fails += 1;
};
const note = (n, d = "") => console.log(`      ${n}${d ? " — " + d : ""}`);

// Regions as fractions of the canvas box (screen space).
const R = [0.08, 0.30, 0.42, 0.37]; // the erase / 1:1 region
const U = [0.58, 0.30, 0.92, 0.37]; // the artist's upper-layer block
const V = [0.10, 0.62, 0.40, 0.69]; // clean ground for the collaborator's stroke
const ROW_Y = 0.335;
const ROW_Y_V = 0.655;

const layerRows = (page) => page.$$eval(".layer-panel .layer-row", (rows) =>
  rows.map((r) => ({
    name: r.querySelector(".layer-name")?.textContent?.trim() || "?",
    visible: !!r.querySelector(".layer-visibility.is-on"),
    active: r.classList.contains("is-active"),
  })));
const clickRowControl = (page, index, sel) =>
  page.evaluate(([i, s]) => {
    const row = document.querySelectorAll(".layer-panel .layer-row")[i];
    const el = row && row.querySelector(s);
    if (!el) return false;
    el.click();
    return true;
  }, [index, sel]);
const addLayer = (page) =>
  page.evaluate(() => {
    const b = document.querySelector('.layer-panel button[aria-label="Add layer"]');
    if (!b) return false;
    b.click();
    return true;
  });
const chooseEraser = (page) =>
  page.evaluate(() => {
    const chip = [...document.querySelectorAll(".brush-chip")].find((c) =>
      /eraser/i.test(c.querySelector(".chip-name")?.textContent || ""));
    if (!chip) return false;
    chip.click();
    return true;
  });
const chooseTool = (page, name) =>
  page.evaluate((n) => {
    const chip = [...document.querySelectorAll(".brush-chip")].find((c) =>
      (c.querySelector(".chip-name")?.textContent || "").trim() === n);
    if (!chip) return false;
    chip.click();
    return true;
  }, name);
const setFillShape = (page, on) =>
  page.evaluate((want) => {
    const label = [...document.querySelectorAll("label")].find((l) => /fill shape/i.test(l.textContent || ""));
    const box = label && label.querySelector('input[type="checkbox"]');
    if (!box) return false;
    if (box.checked !== want) box.click();
    return true;
  }, on);
const regionInk = (page, region) =>
  page.evaluate(([a, b, c, d]) => {
    const el = document.querySelector(".display-canvas");
    if (!el) return -1;
    const r = el.getBoundingClientRect();
    const ctx = el.getContext("2d");
    const x = Math.max(0, Math.round(r.width * a * el.width / r.width));
    const y = Math.max(0, Math.round(r.height * b * el.height / r.height));
    const w = Math.min(el.width - x, Math.round(r.width * (c - a) * el.width / r.width));
    const h = Math.min(el.height - y, Math.round(r.height * (d - b) * el.height / r.height));
    if (w < 1 || h < 1) return -1;
    const data = ctx.getImageData(x, y, w, h).data;
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) ink += 1;
    }
    return ink;
  }, region);

function connectWatcher(room, key) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${room}&modwatch=1`);
    const msgs = [];
    ws.on("message", (raw) => {
      try { msgs.push(JSON.parse(raw.toString())); } catch { /* binary */ }
    });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "mod_auth", key }));
      setTimeout(() => resolve({ ws, msgs, send: (o) => ws.send(JSON.stringify(o)) }), 500);
    });
  });
}

const run = async () => {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`${BASE}/healthz`); if (r.ok) break; } catch { /* booting */ }
    await sleep(250);
  }

  const browser = await chromium.launch();
  const pageErrors = [];

  const openRoom = async (page) => {
    await page.goto(BASE + ROOM, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".overlay-canvas", { timeout: 20000 });
    for (let i = 0; i < 60; i += 1) {
      const curtain = await page.$(".load-curtain");
      if (!curtain) break;
      const ok = await page.$(".load-ok");
      if (ok && i > 20) await ok.click().catch(() => {});
      await sleep(250);
    }
    await sleep(1200);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".welcome-modal button")].find((x) => /go|start|got it|draw|ok/i.test(x.textContent || ""));
      if (b) b.click();
    });
    await sleep(400);
    return page.evaluate(() => {
      const r = document.querySelector(".overlay-canvas").getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
  };
  const stroke = async (page, box, fx, fy, tx, ty) => {
    await page.mouse.move(box.x + box.w * fx, box.y + box.h * fy);
    await page.mouse.down();
    for (let i = 1; i <= 16; i += 1) {
      await page.mouse.move(box.x + box.w * (fx + (tx - fx) * i / 16), box.y + box.h * (fy + (ty - fy) * i / 16));
      await sleep(16);
    }
    await page.mouse.up();
    await sleep(300);
  };

  // ---- Artist A -----------------------------------------------------------
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const A = await ctxA.newPage();
  A.on("pageerror", (e) => pageErrors.push("A: " + e.message));
  const boxA = await openRoom(A);
  const inkR0 = await regionInk(A, R);
  const inkU0 = await regionInk(A, U);
  note("A baseline", `R=${inkR0} U=${inkU0}`);

  // Layer 0 stroke in R, then layer 2 gets a stroke in R and a solid block of
  // ink (a filled rectangle) over U — so anything the joiner paints in U on
  // layer 0 is completely covered on the artist's canvas.
  await stroke(A, boxA, R[0], ROW_Y, R[2], ROW_Y);
  await addLayer(A);
  await stroke(A, boxA, R[0], ROW_Y, R[2], ROW_Y);
  await chooseTool(A, "Rectangle");
  await setFillShape(A, true);
  await A.mouse.move(boxA.x + boxA.w * U[0], boxA.y + boxA.h * 0.235);
  await A.mouse.down();
  for (let i = 1; i <= 12; i += 1) {
    await A.mouse.move(
      boxA.x + boxA.w * (U[0] + (U[2] - U[0]) * i / 12),
      boxA.y + boxA.h * (0.235 + (0.44 - 0.235) * i / 12),
    );
    await sleep(20);
  }
  await A.mouse.up();
  await sleep(500);
  await chooseTool(A, "Brush");
  await sleep(500);
  const rowsA = await layerRows(A);
  const inkRAfterLayer2 = await regionInk(A, R);
  const inkUBlock = await regionInk(A, U);
  check("C0 the artist's 2-layer stack is intact locally, with a block of ink on the upper one",
    rowsA.length === 2 && rowsA[0].active && inkUBlock > 5000,
    `${JSON.stringify(rowsA.map((r) => r.name))} U-block=${inkUBlock}`);

  // ---- A joiner mid-session ----------------------------------------------
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const B = await ctxB.newPage();
  B.on("pageerror", (e) => pageErrors.push("B: " + e.message));
  const boxB = await openRoom(B);
  await sleep(600);
  const rowsB = await layerRows(B);
  const inkRB = await regionInk(B, R);
  check("C1 a joiner mid-session gets the artist's own stack, art on the right layers",
    rowsB.length === 2 && rowsB[0].name === rowsA[0].name && rowsB[1].name === rowsA[1].name && inkRB > 300,
    `A=${JSON.stringify(rowsA.map((r) => r.name))} B=${JSON.stringify(rowsB.map((r) => r.name))} ink(R)=${inkRB}`);

  // ---- The joiner's stroke, seen by the layered artist --------------------
  // A fresh joiner's active layer is the TOP of the shared stack, so their ink
  // lands where the artist's own work is — visible immediately, on the SAME
  // layer, not buried under it.
  const inkV0 = await regionInk(A, V);
  await stroke(B, boxB, V[0], ROW_Y_V, V[2], ROW_Y_V);
  await sleep(900);
  let inkVAfterHelp = await regionInk(A, V);
  // A dropped pointer-down (canvas still settling on a fresh join) shouldn't be
  // read as "collaboration is broken" — give the stroke a couple of tries.
  for (let attempt = 0; attempt < 3 && inkVAfterHelp <= inkV0 + 200; attempt += 1) {
    await stroke(B, boxB, V[0], ROW_Y_V, V[2], ROW_Y_V);
    await sleep(900);
    inkVAfterHelp = await regionInk(A, V);
  }
  const inkVB = await regionInk(B, V);
  check("C2 the joiner's stroke shows up on the artist's canvas right away",
    inkVAfterHelp > inkV0 + 200, `A: V ink ${inkV0} → ${inkVAfterHelp} · B's own V ink=${inkVB}`);
  await stroke(B, boxB, U[0], ROW_Y, U[2], ROW_Y);
  await sleep(900);
  const inkUAfterHelp = await regionInk(A, U);
  check("C2b …and drawing over the artist's own work lands on the same layer (not hidden underneath)",
    Math.abs(inkUAfterHelp - inkUBlock) < 500, `U ink ${inkUBlock} → ${inkUAfterHelp}`);
  await clickRowControl(A, 0, ".layer-visibility"); // hide A's TOP layer
  await sleep(500);
  const inkUHiddenTop = await regionInk(A, U);
  const inkVHiddenTop = await regionInk(A, V);
  await clickRowControl(A, 0, ".layer-visibility");
  await sleep(400);
  check("C2c hiding that one layer takes BOTH the artist's block and the joiner's strokes with it",
    inkUHiddenTop < 200 && inkVHiddenTop < 200,
    `top-hidden U=${inkUHiddenTop} V=${inkVHiddenTop}`);

  // ---- Not-1:1: erase under an upper layer -------------------------------
  // Go back to layer 0 (the "Canvas" row) and erase through R. Locally the hole
  // is hidden by the upper layer, so the artist sees nothing change.
  const eraser = await chooseEraser(A);
  await clickRowControl(A, 1, ".layer-name"); // select the bottom layer
  await sleep(300);
  await stroke(A, boxA, R[0], ROW_Y, R[2], ROW_Y);
  await stroke(A, boxA, R[0], ROW_Y, R[2], ROW_Y);
  await sleep(500);
  const inkRBeforeReplay = await regionInk(A, R);
  check("C3 the artist's erase under the upper layer changed nothing on screen",
    eraser && Math.abs(inkRBeforeReplay - inkRAfterLayer2) < 120,
    `R ink ${inkRAfterLayer2} → ${inkRBeforeReplay}`);

  // Force a plain room history replay: hide one op, then put it back. The final
  // rebuild replays the FULL op stream — whatever the artist now sees is what
  // the room hands every client that loads this drawing.
  const adminKey = readFileSync(path.join(SCRATCH, ".admin-key"), "utf8").trim();
  const watcher = await connectWatcher(CODE, adminKey);
  await sleep(700);
  const hist = [...watcher.msgs].reverse().find((m) => m.type === "history");
  const opIds = (hist?.ops || []).map((op) => op.opId);
  check("C4 every op on the wire names its layer",
    opIds.length >= 5 && (hist?.ops || []).every((op) => typeof op.layerId === "string"),
    `ops=${opIds.length} layerIds=${JSON.stringify([...new Set((hist?.ops || []).map((o) => o.layerId))])}`);
  watcher.send({ type: "mod_hide", opIds: [opIds[0]] });
  await sleep(2500);
  watcher.send({ type: "mod_restore", opIds: [opIds[0]] });
  await sleep(3000);

  const inkRReloaded = await regionInk(A, R);
  check("C5 the replay is 1:1: the erase stays on ITS layer, so the upper layer's ink survives",
    Math.abs(inkRReloaded - inkRBeforeReplay) < 300,
    `R ink ${inkRBeforeReplay} → ${inkRReloaded} after the room rebuilt the drawing`);

  const rowsAfter = await layerRows(A);
  const inkUAfter = await regionInk(A, U);
  const inkVAfterReplay = await regionInk(A, V); // did the joiner's stroke survive a rebuild?
  await clickRowControl(A, 0, ".layer-visibility"); // hide the top layer again
  await sleep(500);
  const inkUAfterHide = await regionInk(A, U);
  await clickRowControl(A, 0, ".layer-visibility");
  await sleep(400);
  check("C6 after the rebuild the 2 layers are still 2 layers, art where it belongs",
    rowsAfter.length === 2 && inkUAfter > 5000 && inkUAfterHide < 200,
    JSON.stringify(rowsAfter.map((r) => r.name)));
  note("post-replay", `R=${inkRReloaded} U=${inkUAfter} V=${inkVAfterReplay} top-hidden=${inkUAfterHide}`);

  check("C7 no page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 200));

  watcher.ws.close();
  await browser.close();
  server.kill();
  console.log(fails ? `\n${fails} FAIL` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
};

run().catch((e) => {
  console.error(e);
  server.kill();
  process.exit(1);
});
