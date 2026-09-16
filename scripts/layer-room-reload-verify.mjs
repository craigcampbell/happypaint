// Does a ROOM drawing with LAYERS survive? Layer stacks are client-local (the
// wire op carries kind/strokeId/points/settings/frameId — never a layer), so a
// room history replay clears every layer and repaints the whole op stream onto
// layer 0. This drives a real browser against a scratch server to show what a
// reload (and an in-place resync) actually does to a 2-layer drawing.
//
// Usage: node scripts/layer-room-reload-verify.mjs
import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

const PORT = 8953;
const BASE = `http://localhost:${PORT}`;
const CODE = "LAYERCHK";
const ROOM = `/join/${CODE}`;
const ROOT = process.cwd();
const SCRATCH = path.join(os.tmpdir(), "hp-layer-room-verify");

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

// ---------------------------------------------------------------- page helpers
const layerRows = (page) => page.$$eval(".layer-panel .layer-row", (rows) =>
  rows.map((r) => ({
    name: r.querySelector(".layer-name")?.textContent?.trim() || "?",
    visible: !!r.querySelector(".layer-visibility.is-on"),
    active: r.classList.contains("is-active"),
  })));
// Every layer mutation is a server round trip; wait for the echo to reach the
// panel instead of reading it mid-flight.
const waitForRows = async (page, count, timeout = 3000) => {
  const start = Date.now();
  let rows = await layerRows(page);
  while (rows.length !== count && Date.now() - start < timeout) {
    await sleep(100);
    rows = await layerRows(page);
  }
  return rows;
};
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
const openGallery = (page) =>
  page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /gallery/i.test(x.textContent || ""));
    if (!b) return false;
    b.click();
    return true;
  });
const restoreDraftBtn = (page) =>
  page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /restore last draft/i.test(x.textContent || ""));
    if (!b) return false;
    b.click();
    return true;
  });

// Ink on the VISIBLE display canvas over a region given as fractions of the
// canvas box. The display canvas is screen-sized (dpr) and already composited,
// so this is literally "how much of what the artist sees is non-paper".
const regionInk = (page, fx0, fy0, fx1, fy1) =>
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
  }, [fx0, fy0, fx1, fy1]);

const LEFT = [0.06, 0.12, 0.44, 0.55];
const RIGHT = [0.56, 0.12, 0.94, 0.55];

const halves = async (page, tag) => {
  const l = await regionInk(page, ...LEFT);
  const r = await regionInk(page, ...RIGHT);
  note(`${tag}: ink left=${l} right=${r}`);
  return { l, r };
};

// Every draft record in IndexedDB, with each layer's non-transparent pixel count
// (decoded from its blob/dataURL) — i.e. what the LOCAL autosave would restore.
const draftSummary = (page) =>
  page.evaluate(async () => {
    const out = [];
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise((res, rej) => {
        const q = indexedDB.open(name);
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      for (const store of db.objectStoreNames) {
        const recs = await new Promise((res, rej) => {
          const q = db.transaction(store).objectStore(store).getAll();
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
        for (const rec of recs) {
          const v = rec && rec.layers === undefined && rec.value !== undefined ? rec.value : rec;
          if (!v || !Array.isArray(v.layers)) continue;
          const layers = [];
          for (const l of v.layers) {
            let src = l.image || null;
            if (!src && l.blob) src = URL.createObjectURL(l.blob);
            let inkPx = -1;
            if (src) {
              const img = await new Promise((res) => {
                const i = new Image();
                i.onload = () => res(i);
                i.onerror = () => res(null);
                i.src = src;
              });
              if (img) {
                const c = document.createElement("canvas");
                c.width = 200;
                c.height = 125;
                const cx = c.getContext("2d");
                cx.drawImage(img, 0, 0, 200, 125);
                const d = cx.getImageData(0, 0, 200, 125).data;
                inkPx = 0;
                for (let i = 3; i < d.length; i += 4) if (d[i] > 12) inkPx += 1;
              }
            }
            if (l.blob && src) URL.revokeObjectURL(src);
            layers.push({ name: l.name || "?", inkPx });
          }
          out.push({ key: `${name}/${store}`, savedAt: v.savedAt, layers });
        }
      }
      db.close();
    }
    return out;
  });

// ------------------------------------------------------------ room + watcher
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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));

  const openRoom = async () => {
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
  const stroke = async (box, fx, fy, tx, ty) => {
    await page.mouse.move(box.x + box.w * fx, box.y + box.h * fy);
    await page.mouse.down();
    for (let i = 1; i <= 14; i += 1) {
      await page.mouse.move(box.x + box.w * (fx + (tx - fx) * i / 14), box.y + box.h * (fy + (ty - fy) * i / 14));
      await sleep(16);
    }
    await page.mouse.up();
    await sleep(250);
  };

  // ---- 1. Two-layer drawing inside the room -------------------------------
  const box = await openRoom();
  const rows0 = await layerRows(page);
  check("R1 a room opens with exactly one layer", rows0.length === 1, JSON.stringify(rows0));
  const base = await halves(page, "baseline (empty canvas)");

  await stroke(box, 0.12, 0.34, 0.40, 0.34); // stroke A → layer 0 "Canvas"
  await addLayer(page);
  const rows1 = await waitForRows(page, 2);
  check("R2 adding a layer gives a 2-layer stack, new layer on top + active",
    rows1.length === 2 && rows1[0].active && rows1[1].name === "Canvas", JSON.stringify(rows1));
  await stroke(box, 0.60, 0.34, 0.88, 0.34); // stroke B → new top layer
  await sleep(600);

  const t1 = await halves(page, "after drawing on both layers");
  check("R3 both strokes are on screen locally",
    t1.l > base.l + 200 && t1.r > base.r + 200, `left ${base.l}→${t1.l}, right ${base.r}→${t1.r}`);

  // Which layer holds which stroke? Hide the BOTTOM row (Canvas) — stroke A only.
  await clickRowControl(page, 1, ".layer-visibility");
  const t2 = await halves(page, "bottom layer hidden");
  await clickRowControl(page, 1, ".layer-visibility"); // show again
  await sleep(400);
  check("R4 locally, the strokes really do live on separate layers (hiding the bottom one drops the left stroke only)",
    t2.l < base.l + 200 && t2.r > base.r + 200, `left ${t2.l} / right ${t2.r}`);

  // ---- 2. An in-place room history replay (moderation) --------------------
  await sleep(3200); // let the autosave tick land before the replay
  const draftsBefore = await draftSummary(page);
  const d1 = draftsBefore[0];
  check("R4b the autosaved draft holds BOTH layers with their own pixels before any replay",
    d1?.layers?.length === 2 && d1.layers.every((l) => l.inkPx > 20), JSON.stringify(d1?.layers));
  const adminKey = readFileSync(path.join(SCRATCH, ".admin-key"), "utf8").trim();
  const watcher = await connectWatcher(CODE, adminKey);
  await sleep(600);
  const hist = [...watcher.msgs].reverse().find((m) => m.type === "history");
  const opIds = (hist?.ops || []).map((op) => op.opId);
  check("R5 every op on the wire names the layer it was drawn on",
    opIds.length >= 2 && (hist?.ops || []).every((op) => typeof op.layerId === "string"),
    `ops=${opIds.length} fields=${JSON.stringify(Object.keys(hist?.ops?.[0] || {}))} layerId=${hist?.ops?.[0]?.layerId}`);
  watcher.send({ type: "mod_hide", opIds: [opIds[0]] }); // forces a history replay
  await sleep(2500);
  watcher.send({ type: "mod_restore", opIds: [opIds[0]] });
  await sleep(2500);

  const rowsAfterReplay = await layerRows(page);
  const t3 = await halves(page, "after the room replayed its history");
  check("R6 after a room history replay the layer count is unchanged, art intact",
    rowsAfterReplay.length === 2 && t3.l > base.l + 200 && t3.r > base.r + 200,
    JSON.stringify(rowsAfterReplay.map((r) => r.name)));
  await clickRowControl(page, 0, ".layer-visibility"); // hide TOP layer
  const t4 = await halves(page, "top layer hidden (post-replay)");
  await clickRowControl(page, 0, ".layer-visibility");
  await sleep(400);
  await clickRowControl(page, 1, ".layer-visibility"); // hide BOTTOM layer
  const t5 = await halves(page, "bottom layer hidden (post-replay)");
  await clickRowControl(page, 1, ".layer-visibility");
  await sleep(400);
  check("R7 …and every stroke is still on ITS layer: hiding the top drops the right stroke only, hiding the bottom the left only",
    t4.l > base.l + 200 && t4.r < 200 && t5.l < 200 && t5.r > base.r + 200,
    `top-hidden left=${t4.l} right=${t4.r} · bottom-hidden left=${t5.l} right=${t5.r}`);

  // ---- 3. What the local autosave now holds ------------------------------
  await sleep(3200);
  const draftsAfter = await draftSummary(page);
  const d2 = draftsAfter[0];
  check("R8 the autosaved draft keeps 2 layers, each with its own pixels",
    d2?.layers?.length === 2 && d2.layers.every((l) => l.inkPx > 20), JSON.stringify(d2?.layers));

  // ---- 4. A full reload of the room --------------------------------------
  await openRoom();
  await sleep(3500);
  const rowsReload = await layerRows(page);
  const r1 = await halves(page, "after a full reload");
  check("R9 a full reload rebuilds the room's own layer stack (not one flat layer)",
    rowsReload.length === 2, JSON.stringify(rowsReload));
  check("R10 the art is intact after the reload", r1.l > base.l + 200 && r1.r > base.r + 200,
    `left ${r1.l} / right ${r1.r}`);
  await clickRowControl(page, 0, ".layer-visibility"); // hide TOP layer
  const r2 = await halves(page, "top layer hidden (after reload)");
  await clickRowControl(page, 0, ".layer-visibility");
  await sleep(400);
  check("R10b …and it came back on the right layers (the top one holds only the right stroke)",
    r2.l > base.l + 200 && r2.r < 200, `top-hidden left=${r2.l} right=${r2.r}`);

  const draftsReload = await draftSummary(page);
  const d3 = draftsReload[0];
  note("draft right after the reload (before any new tick)", JSON.stringify(d3?.layers));

  // ---- 5. "Restore last draft" after a reload ------------------------------
  await openGallery(page);
  await sleep(300);
  const restored = await restoreDraftBtn(page);
  await sleep(1500);
  const rowsRestored = await layerRows(page);
  const t6 = await halves(page, "after Restore last draft");
  await clickRowControl(page, 0, ".layer-visibility"); // hide the top layer
  const t7 = await halves(page, "top layer hidden (restored draft)");
  await clickRowControl(page, 0, ".layer-visibility");
  await sleep(300);
  check("R11 Restore last draft hands back the same layers, each with its own art",
    restored && rowsRestored.length === 2 && t6.l > base.l + 200 && t6.r > base.r + 200
      && t7.l > base.l + 200 && t7.r < 200,
    `${JSON.stringify(rowsRestored.map((r) => r.name))} · top-hidden left=${t7.l} right=${t7.r}`);

  check("R12 no page errors during the run", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 200));

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
