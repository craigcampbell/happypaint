// Seasonal replay-share + export-gate verification (studio owner).
/* global window, document, navigator */
//
// Replay share (Android/Instagram fix):
//   - "Share my timelapse" hands the OS share sheet a video/mp4 (H.264) file
//     when WebCodecs H.264 is available, else an explicit finished-frame PNG.
//     NEVER an image/gif (Instagram flattens GIFs to their near-blank first
//     frame, see scratch replay-instagram-repro).
//   - The shared artifact is decoded for real (mp4 -> <video> seek to the
//     final frames, png -> Image) and must contain the artwork (non-white).
//   - Optional Inktober border lands on EXPORT pixels only (source snapshots
//     byte-identical; the live canvas is untouched).
//   - AbortSignal cancels (pre-aborted + mid-encode); shareFile() maps
//     canShare=false -> "unsupported", NotAllowedError -> "needs-gesture"
//     (parked prepared share + a fresh "tap to share"), AbortError -> "aborted".
//   - "Save GIF" keeps working as a separate explicit download.
//
// Export account gate (product UX gate, not DRM):
//   G1 guest + cloud configured: share/GIF export blocked, sign-in UX opens,
//      nothing downloads/shares. Drawing itself is untouched.
//   G2 signed in: everything works (full share decode matrix + GIF download).
//   G3 prepared share is INVALIDATED by signing out before the ready tap.
//   G4 expired stored session behaves as a guest.
//   G5 cloud-unconfigured deployment: export explains "accounts aren't
//      available", does NOT silently bypass, drawing + replay still work.
//   G6 static coverage: every export entry point in App.jsx calls gateExport.
//
// Stack: mock PocketBase on 8954, server.js on 8953 (PB_URL=mock, scratch
// DATA_DIR), Vite dev on 8952 (VITE_PB_URL=mock) + a second Vite on 8955 with
// NO VITE_PB_URL (cloud-unconfigured scenario). No prod, no build artifacts.
import { chromium } from "playwright";
import { spawn } from "child_process";
import { createServer } from "http";
import { mkdirSync, rmSync, statSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRATCH = "/home/craig/.hermes/cache/scratch/seasonal-replay-verify";
const VITE_PORT = 8952;
const API_PORT = 8953;
const PB_PORT = 8954;
const VITE_LOCAL_PORT = 8955; // cloud-UNCONFIGURED instance
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const LOCAL_BASE = `http://127.0.0.1:${VITE_LOCAL_PORT}`;

const PB_RECORD = { id: "tester1", email: "tester@example.com", name: "Test Artist", verified: true, collectionId: "_pb_users_auth_", collectionName: "users" };
const b64u = (obj) => Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj)).toString("base64url");
const makeJwt = (exp) => `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ id: PB_RECORD.id, type: "auth", collectionId: PB_RECORD.collectionId, exp })}.${b64u("sig")}`;
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
};

// ---- mock PocketBase -------------------------------------------------------
const mockPb = createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "*",
    });
    res.end(JSON.stringify(body));
  };
  if (req.method === "OPTIONS") return send(204, {});
  if (req.method === "POST" && req.url === "/api/collections/users/auth-refresh") {
    return send(200, { token: makeJwt(FUTURE), record: PB_RECORD });
  }
  if (req.method === "GET" && req.url.startsWith("/api/collections/users/auth-methods")) {
    return send(200, { password: { enabled: true }, oauth2: { providers: [] } });
  }
  if (req.method === "GET" && req.url === "/api/health") return send(200, { code: 200, message: "mock pb" });
  // Collection list pulls (gallery sync etc.): empty page, not an error.
  if (req.method === "GET" && /^\/api\/collections\/[^/]+\/records/.test(req.url)) {
    return send(200, { page: 1, perPage: 1000, totalItems: 0, totalPages: 0, items: [] });
  }
  return send(404, { code: 404, message: "mock pb: not found", data: {} });
});
await new Promise((resolve) => mockPb.listen(PB_PORT, "127.0.0.1", resolve));

const procs = [];
const spawnBg = (argv, env) => {
  const p = spawn(process.execPath, argv, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "pipe" });
  p.stderr.on("data", (d) => process.stderr.write(`[${path.basename(argv[0])}] ` + d));
  procs.push(p);
  return p;
};
spawnBg(["server.js"], { PORT: String(API_PORT), DATA_DIR: path.join(SCRATCH, "data"), PB_URL: `http://127.0.0.1:${PB_PORT}` });
spawnBg(["node_modules/vite/bin/vite.js", "--port", String(VITE_PORT), "--strictPort", "--host", "127.0.0.1"], {
  VITE_WS_URL: `ws://127.0.0.1:${API_PORT}/ws`,
  VITE_PB_URL: `http://127.0.0.1:${PB_PORT}`,
});
spawnBg(["node_modules/vite/bin/vite.js", "--port", String(VITE_LOCAL_PORT), "--strictPort", "--host", "127.0.0.1"], {
  VITE_WS_URL: `ws://127.0.0.1:${API_PORT}/ws`,
  VITE_PB_URL: "", // cloud UNCONFIGURED
});
const killAll = () => {
  for (const p of procs) { try { p.kill(); } catch { /* */ } }
  try { mockPb.close(); } catch { /* */ }
};

async function waitHttp(url, tries = 160) {
  for (let i = 0; i < tries; i += 1) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* boot */ }
    await sleep(250);
  }
  return false;
}

// In-page helpers (eval'd via addInitScript).
const pageHelpers = `
  window.__makeSnap = async (ink) => {
    const c = document.createElement("canvas");
    c.width = 480; c.height = 360;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 480, 360);
    if (ink) {
      ctx.strokeStyle = "#221a30"; ctx.lineWidth = 10; ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(60, 80 + ink * 20);
      ctx.bezierCurveTo(180, 240, 320, 40 + ink * 30, 430, 300);
      ctx.stroke();
    }
    return await new Promise((r) => c.toBlob(r, "image/png"));
  };
  window.__makeSeries = async () => {
    const snaps = [];
    for (let k = 0; k < 4; k += 1) snaps.push({ blob: await window.__makeSnap(k) });
    return snaps;
  };
  window.__nonWhiteStats = (data) => {
    let nonWhite = 0;
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (lum < 235) nonWhite += 1;
    }
    return { nonWhite, total: data.length / 4 };
  };
  window.__pngStats = async (bytes) => {
    const blob = new Blob([bytes], { type: "image/png" });
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url;
      });
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      return { width: img.width, height: img.height, stats: window.__nonWhiteStats(data), corner: [data[0], data[1], data[2]] };
    } finally { URL.revokeObjectURL(url); }
  };
  window.__mp4LastFrameStats = async (bytes) => {
    const blob = new Blob([bytes], { type: "video/mp4" });
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true; video.preload = "auto"; video.src = url;
    try {
      await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = () => rej(new Error("mp4 metadata load failed")); });
      await new Promise((res, rej) => { video.onseeked = res; video.onerror = () => rej(new Error("mp4 seek failed")); video.currentTime = Math.max(0, video.duration - 0.05); });
      const c = document.createElement("canvas");
      c.width = video.videoWidth; c.height = video.videoHeight;
      const ctx = c.getContext("2d"); ctx.drawImage(video, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      return { duration: video.duration, width: video.videoWidth, height: video.videoHeight, stats: window.__nonWhiteStats(data), corner: [data[0], data[1], data[2]] };
    } finally { URL.revokeObjectURL(url); }
  };
  window.__bytesToB64 = (bytes) => {
    let bin = ""; const u8 = new Uint8Array(bytes);
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  window.__exportGateVerdict = async () => {
    const mod = await import("/src/utils/exportGate.js");
    return await mod.checkExportAllowed();
  };
`;

function seedAuthInitScript(token) {
  return `(function(){try{window.localStorage.setItem("pocketbase_auth", JSON.stringify({ token: ${JSON.stringify(token)}, record: ${JSON.stringify(PB_RECORD)} }));}catch(e){}})();`;
}

async function newStudioPage(browser, { token = null, shareBehavior = "capture" } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(({ helpersSrc, seedSrc, behavior }) => {
    if (seedSrc) eval(seedSrc); // eslint-disable-line no-eval
    window.__shares = [];
    if (behavior === "capture") {
      navigator.canShare = (data) => !!(data && data.files && data.files.length);
      navigator.share = async (data) => { window.__shares.push(data); };
    } else if (behavior === "needs-gesture") {
      navigator.canShare = () => true;
      navigator.share = async () => { throw new DOMException("Must be handling a user gesture to perform a share request.", "NotAllowedError"); };
    }
    eval(helpersSrc); // eslint-disable-line no-eval
  }, { helpersSrc: pageHelpers, seedSrc: token ? seedAuthInitScript(token) : "", behavior: shareBehavior });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  return { ctx, page, errors };
}

async function dismissCurtain(page) {
  const okCurtain = page.locator("button.load-ok");
  if (await okCurtain.waitFor({ state: "visible", timeout: 8000 }).then(() => true).catch(() => false)) {
    await okCurtain.click();
  }
  await page.locator(".modal-backdrop").first().waitFor({ state: "detached", timeout: 8000 }).catch(() => null);
}

async function gotoStudio(page, room, base = BASE) {
  await page.goto(`${base}/join/${room}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".overlay-canvas", { state: "visible", timeout: 60000 });
  await sleep(2500);
  // The join curtain either offers an OK button or auto-dismisses; wait out
  // whichever happens so its backdrop never intercepts later clicks. A Vite
  // dep-optimize full-reload re-runs the whole join (and the curtain), so do
  // a second pass after letting that settle.
  await dismissCurtain(page);
  await sleep(2500);
  await dismissCurtain(page);
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

async function openReplay(page) {
  await dismissCurtain(page); // a late join-curtain reload must never eat this click
  const toggle = page.locator(".desktop-studio-toggle");
  if (await toggle.isVisible().catch(() => false)) {
    const open = await page.evaluate(() => document.querySelector(".topbar")?.className.includes("is-open"));
    if (!open) {
      try {
        await toggle.click({ timeout: 8000 });
      } catch (err) {
        const dump = await page.evaluate(() => [...document.querySelectorAll(".modal-backdrop")].map((b) => (b.innerHTML || "").slice(0, 500)));
        console.log("DEBUG intercepted backdrops:", JSON.stringify(dump));
        throw err;
      }
      await sleep(320);
    }
  }
  await page.locator('button[title*="Watch it draw"]:visible').first().click();
  await page.waitForSelector(".replay-actions", { state: "visible", timeout: 15000 }).catch(() => null);
}

const closeAccountModal = async (page) => {
  const btn = page.locator(".account-modal .modal-title-row button");
  if (await btn.isVisible().catch(() => false)) { await btn.click(); await sleep(250); }
};

const run = async () => {
  if (!(await waitHttp(`http://127.0.0.1:${API_PORT}/healthz`))) throw new Error("server.js did not boot");
  if (!(await waitHttp(`${BASE}/join/SPACE`))) throw new Error("vite did not boot");
  if (!(await waitHttp(`${LOCAL_BASE}/join/PETS`))) throw new Error("local-only vite did not boot");

  // Warm Vite's transform/dep-optimize pipeline so the first browser hit
  // doesn't trigger a mid-session dependency full-reload.
  for (const base of [BASE, LOCAL_BASE]) {
    for (const url of ["/", "/src/main.jsx", "/src/App.jsx", "/src/utils/replayShare.js", "/src/utils/exportGate.js", "/src/utils/auth.js"]) {
      try { await fetch(`${base}${url}`); } catch { /* best effort */ }
    }
  }

  let browser;
  let browserLabel = "playwright-chromium (no H.264 -> PNG fallback path)";
  try {
    browser = await chromium.launch({ headless: true, channel: "chrome" });
    browserLabel = "google-chrome (H.264 -> MP4 path)";
  } catch {
    browser = await chromium.launch({ headless: true });
  }
  console.log(`browser: ${browserLabel}`);

  // ===================== G1: guest, cloud configured =====================
  {
    const { ctx, page } = await newStudioPage(browser, {});
    await gotoStudio(page, "MAIN");
    await drawStroke(page, 0.4, 0.4);
    await drawStroke(page, 0.5, 0.5);
    await openReplay(page);
    check("G1 replay player opens for a guest (drawing/viewing ungated)", await page.locator(".replay-actions").isVisible().catch(() => false));

    await page.locator(".replay-actions .replay-share").click();
    await sleep(1500);
    const shareCalls = await page.evaluate(() => window.__shares.length);
    check("G1 guest share is blocked (no OS share call)", shareCalls === 0, `${shareCalls} calls`);
    check("G1 guest share opens the sign-in UX", await page.locator(".account-modal").isVisible().catch(() => false));
    const status1 = await page.locator(".status-line").textContent().catch(() => "");
    check("G1 guest share explains sign-in", /sign in/i.test(status1 || ""), (status1 || "").trim());
    await closeAccountModal(page);

    const noDownload = page.waitForEvent("download", { timeout: 3000 }).catch(() => null);
    await page.locator(".replay-actions button", { hasText: "Save GIF" }).click();
    const dl = await noDownload;
    check("G1 guest GIF export blocked (no download)", dl === null, dl ? "DOWNLOADED!" : "no download");
    const verdict = await page.evaluate(() => window.__exportGateVerdict());
    check("G1 exportGate verdict for guest is sign-in", verdict && verdict.ok === false && verdict.reason === "sign-in", JSON.stringify(verdict));
    await ctx.close();
  }

  // ===================== G4: expired stored session =====================
  {
    const { ctx, page } = await newStudioPage(browser, { token: makeJwt(PAST) });
    await gotoStudio(page, "DOODLE");
    const verdict = await page.evaluate(() => window.__exportGateVerdict());
    check("G4 expired stored session gates as a guest", verdict && verdict.ok === false && verdict.reason === "sign-in", JSON.stringify(verdict));
    await ctx.close();
  }

  // ===================== G2: signed in, full share matrix =====================
  {
    const { ctx, page, errors } = await newStudioPage(browser, { token: makeJwt(FUTURE) });
    await gotoStudio(page, "SPACE");
    const verdict = await page.evaluate(() => window.__exportGateVerdict());
    check("G2 exportGate verdict when signed in is ok", verdict && verdict.ok === true && !!verdict.session, JSON.stringify(verdict));

    await drawStroke(page, 0.35, 0.35);
    await drawStroke(page, 0.45, 0.5);
    await drawStroke(page, 0.55, 0.4);
    await sleep(600);

    const canvasCornerBefore = await page.evaluate(() => {
      const c = document.querySelector(".display-canvas");
      const d = c.getContext("2d").getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    });

    await openReplay(page);
    check("G2 replay player opens with snapshots", await page.locator(".replay-actions").isVisible().catch(() => false));

    // Share → captured navigator.share payload must be MP4 or PNG, never GIF.
    await page.locator(".replay-actions .replay-share").click();
    await page.waitForFunction(() => window.__shares.length >= 1, null, { timeout: 90000 });
    const shared = await page.evaluate(async () => {
      const data = window.__shares[window.__shares.length - 1];
      const file = data.files[0];
      const buf = await file.arrayBuffer();
      return { name: file.name, type: file.type, size: buf.byteLength, b64: window.__bytesToB64(buf) };
    });
    const headBytes = Buffer.from(shared.b64.slice(0, 96), "base64");
    const looksGif = headBytes.slice(0, 4).toString("latin1") === "GIF8";
    check("G2 shared file is never image/gif", shared.type !== "image/gif" && !looksGif, `${shared.name} (${shared.type}, ${shared.size}B)`);
    check("G2 shared file is video/mp4 or finished-frame image/png", shared.type === "video/mp4" || shared.type === "image/png", shared.type);

    const fullBytes = Buffer.from(shared.b64, "base64");
    writeFileSync(path.join(SCRATCH, shared.name), fullBytes);
    if (shared.type === "video/mp4") {
      const brand = fullBytes.slice(4, 8).toString("latin1");
      check("G2 mp4 has an ftyp box (real MP4 container)", brand === "ftyp", `brand=${brand}`);
      const decoded = await page.evaluate(async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return window.__mp4LastFrameStats(bytes);
      }, shared.b64);
      check(
        "G2 decoded MP4 final frame is non-white (artwork survives)",
        decoded.stats.nonWhite > 400,
        `${decoded.width}x${decoded.height}, ${decoded.stats.nonWhite}/${decoded.stats.total} non-white px, ${decoded.duration.toFixed(2)}s`,
      );
    } else {
      const decoded = await page.evaluate(async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return window.__pngStats(bytes);
      }, shared.b64);
      check(
        "G2 decoded PNG (finished frame) is non-white",
        decoded.stats.nonWhite > 400,
        `${decoded.width}x${decoded.height}, ${decoded.stats.nonWhite}/${decoded.stats.total} non-white px`,
      );
    }

    const canvasCornerAfter = await page.evaluate(() => {
      const c = document.querySelector(".display-canvas");
      const d = c.getContext("2d").getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    });
    check("G2 studio canvas untouched by export (no baked border)", JSON.stringify(canvasCornerAfter) === JSON.stringify(canvasCornerBefore), `corner ${canvasCornerBefore} -> ${canvasCornerAfter}`);

    // Save GIF regression (signed in): unchanged, still a real GIF download.
    const gifDl = page.waitForEvent("download", { timeout: 60000 }).catch(() => null);
    await page.locator(".replay-actions button", { hasText: "Save GIF" }).click();
    const gif = await gifDl;
    let gifOk = false; let gifDetail = "no download";
    if (gif) {
      const f = path.join(SCRATCH, gif.suggestedFilename());
      await gif.saveAs(f);
      gifOk = readFileSync(f).slice(0, 4).toString("latin1") === "GIF8" && statSync(f).size > 100;
      gifDetail = `${gif.suggestedFilename()} (${statSync(f).size}B)`;
    }
    check("G2 Save GIF still downloads a real GIF (kept feature)", gifOk, gifDetail);

    // ---------- replayShare module contracts ----------
    const moduleInfo = await page.evaluate(async () => {
      const mod = await import("/src/utils/replayShare.js");
      const out = { api: Object.keys(mod).sort() };
      out.mp4Supported = await mod.supportsMp4Share(480, 360);
      return out;
    });
    console.log(`module exports: ${moduleInfo.api.join(", ")}`);
    console.log(`WebCodecs H.264 MP4 supported in this browser: ${moduleInfo.mp4Supported}`);
    check("replayShare exposes the share contract", ["buildReplayShareAsset", "buildFinishedPng", "shareFile", "supportsMp4Share"].every((k) => moduleInfo.api.includes(k)), moduleInfo.api.join(","));

    const b1 = await page.evaluate(async () => {
      const mod = await import("/src/utils/replayShare.js");
      const snapshots = await window.__makeSeries();
      const asset = await mod.buildReplayShareAsset({ snapshots, width: 480, height: 360 });
      const bytes = new Uint8Array(await asset.blob.arrayBuffer());
      return { kind: asset.kind, mime: asset.blob.type, ext: asset.ext, size: bytes.length, b64: window.__bytesToB64(bytes) };
    });
    check("buildReplayShareAsset never returns GIF", b1.kind !== "gif" && b1.mime !== "image/gif", `${b1.kind}/${b1.mime}`);
    if (moduleInfo.mp4Supported) {
      check("buildReplayShareAsset returns MP4 when H.264 is supported", b1.kind === "mp4" && b1.ext === "mp4", b1.kind);
      const dec = await page.evaluate(async (b64) => window.__mp4LastFrameStats(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))), b1.b64);
      check("module MP4 decodes; final frame non-white", dec.stats.nonWhite > 400, `${dec.stats.nonWhite}/${dec.stats.total} px`);
    } else {
      check("buildReplayShareAsset falls back to finished-frame PNG", b1.kind === "png" && b1.ext === "png", b1.kind);
      const dec = await page.evaluate(async (b64) => window.__pngStats(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))), b1.b64);
      check("module PNG decodes; finished frame non-white", dec.stats.nonWhite > 400, `${dec.stats.nonWhite}/${dec.stats.total} px`);
    }

    const b2 = await page.evaluate(async () => {
      const mod = await import("/src/utils/replayShare.js");
      const snapshots = await window.__makeSeries();
      const before = [];
      for (const s of snapshots) before.push(window.__bytesToB64(await s.blob.arrayBuffer()));
      const themed = await mod.buildFinishedPng({ snapshots, width: 480, height: 360, themed: true, prompt: "Map", eventLabel: "Inktober 2026 · Day 5" });
      const plain = await mod.buildFinishedPng({ snapshots, width: 480, height: 360 });
      const after = [];
      for (const s of snapshots) after.push(window.__bytesToB64(await s.blob.arrayBuffer()));
      const themedBytes = new Uint8Array(await themed.arrayBuffer());
      const plainBytes = new Uint8Array(await plain.arrayBuffer());
      const themedStats = await window.__pngStats(themedBytes);
      const plainStats = await window.__pngStats(plainBytes);
      return {
        sourcesUnchanged: JSON.stringify(before) === JSON.stringify(after),
        themedCorner: themedStats.corner,
        plainCorner: plainStats.corner,
        themedMime: themed.type,
      };
    });
    const lum = (c) => c && 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    check("themed export draws an Inktober border on the export pixels", lum(b2.themedCorner) < 120, `corner=${b2.themedCorner}`);
    check("plain export has no border (paper corner)", lum(b2.plainCorner) > 200, `corner=${b2.plainCorner}`);
    check("themed export leaves source snapshots byte-identical (never baked into stored art)", b2.sourcesUnchanged);
    check("finished PNG helper returns image/png", b2.themedMime === "image/png", b2.themedMime);

    const b3a = await page.evaluate(async () => {
      const mod = await import("/src/utils/replayShare.js");
      const snapshots = await window.__makeSeries();
      const controller = new AbortController();
      controller.abort();
      try {
        await mod.buildReplayShareAsset({ snapshots, width: 480, height: 360, signal: controller.signal });
        return { rejected: false };
      } catch (err) {
        return { rejected: true, name: err?.name };
      }
    });
    check("pre-aborted signal cancels the build (AbortError)", b3a.rejected && b3a.name === "AbortError", JSON.stringify(b3a));
    const b3b = await page.evaluate(async () => {
      const mod = await import("/src/utils/replayShare.js");
      const snapshots = [];
      for (let k = 0; k < 30; k += 1) snapshots.push({ blob: await window.__makeSnap(k % 4) });
      const controller = new AbortController();
      let progresses = 0;
      try {
        await mod.buildReplayShareAsset({
          snapshots, width: 480, height: 360, signal: controller.signal,
          onProgress: () => { progresses += 1; controller.abort(); },
        });
        return { rejected: false, progresses };
      } catch (err) {
        return { rejected: true, name: err?.name, progresses };
      }
    });
    check("mid-encode abort cancels (AbortError after progress)", b3b.rejected && b3b.name === "AbortError" && b3b.progresses >= 1, JSON.stringify(b3b));

    const b4 = await page.evaluate(async () => {
      const mod = await import("/src/utils/replayShare.js");
      const file = new File([new Blob(["x"], { type: "video/mp4" })], "t.mp4", { type: "video/mp4" });
      const realCanShare = navigator.canShare; const realShare = navigator.share;
      const runOne = async (canShareImpl, shareImpl) => {
        navigator.canShare = canShareImpl; navigator.share = shareImpl;
        try { return await mod.shareFile(file, { files: [file] }); } finally { navigator.canShare = realCanShare; navigator.share = realShare; }
      };
      const unsupported = await runOne(() => false, async () => "unreachable");
      const needsGesture = await runOne(() => true, async () => { throw new DOMException("Must be handling a user gesture", "NotAllowedError"); });
      const aborted = await runOne(() => true, async () => { throw new DOMException("Share canceled", "AbortError"); });
      const shared = await runOne(() => true, async () => undefined);
      const noApi = await runOne(undefined, undefined);
      return { unsupported, needsGesture, aborted, shared, noApi };
    });
    check("shareFile maps canShare=false -> 'unsupported'", b4.unsupported === "unsupported", b4.unsupported);
    check("shareFile maps missing share API -> 'unsupported'", b4.noApi === "unsupported", b4.noApi);
    check("shareFile maps NotAllowedError (lost user activation) -> 'needs-gesture'", b4.needsGesture === "needs-gesture", b4.needsGesture);
    check("shareFile maps user dismissal -> 'aborted'", b4.aborted === "aborted", b4.aborted);
    check("shareFile maps success -> 'shared'", b4.shared === "shared", b4.shared);

    const fatal = errors.filter((e) => !/favicon|manifest|ResizeObserver|Download the React DevTools|ERR_FILE_NOT_FOUND/i.test(e));
    check("zero page errors (signed-in scenario)", fatal.length === 0, fatal.slice(0, 2).join(" | "));
    await ctx.close();
  }

  // ============ G3: prepared share invalidated by signing out ============
  {
    const { ctx, page } = await newStudioPage(browser, { token: makeJwt(FUTURE), shareBehavior: "needs-gesture" });
    await gotoStudio(page, "OCEAN");
    await drawStroke(page, 0.4, 0.4);
    await drawStroke(page, 0.5, 0.45);
    await openReplay(page);
    await page.locator(".replay-actions .replay-share").click();
    // navigator.share throws NotAllowedError (gesture lost during encode) ->
    // the player must offer a separate ready tap.
    await page.waitForFunction(
      () => /Tap to share/.test(document.querySelector(".replay-actions .replay-share")?.textContent || ""),
      null,
      { timeout: 90000 },
    );
    check("G3 lost-activation share parks a 'Tap to share' ready button", true);

    // Sign out (the SDK path the AccountPanel uses), then try the ready tap.
    await page.evaluate(async () => {
      const auth = await import("/src/utils/auth.js");
      await auth.signOut();
    });
    await sleep(500);
    await page.locator(".replay-actions .replay-share").click();
    await sleep(1500);
    const shareCalls = await page.evaluate(() => window.__shares.length);
    check("G3 prepared share after sign-out never reaches the OS", shareCalls === 0, `${shareCalls} calls`);
    check("G3 prepared share after sign-out re-opens the sign-in UX", await page.locator(".account-modal").isVisible().catch(() => false));
    const reverted = await page.evaluate(() => /Share my timelapse/.test(document.querySelector(".replay-actions .replay-share")?.textContent || ""));
    check("G3 prepared share is invalidated (button reverts to prepare)", reverted);
    await ctx.close();
  }

  // ============ G5: cloud-unconfigured deployment ============
  {
    const { ctx, page, errors } = await newStudioPage(browser, {});
    await gotoStudio(page, "PETS", LOCAL_BASE);
    await drawStroke(page, 0.4, 0.4);
    await sleep(400);
    await openReplay(page);
    check("G5 anonymous drawing + replay still work without cloud", await page.locator(".replay-actions").isVisible().catch(() => false));
    const verdict = await page.evaluate(() => window.__exportGateVerdict());
    check("G5 exportGate verdict is local-only", verdict && verdict.ok === false && verdict.reason === "local-only", JSON.stringify(verdict));
    const noDownload = page.waitForEvent("download", { timeout: 3000 }).catch(() => null);
    await page.locator(".replay-actions button", { hasText: "Save GIF" }).click();
    const dl = await noDownload;
    check("G5 export does NOT silently bypass (no download)", dl === null, dl ? "DOWNLOADED!" : "no download");
    const status = await page.locator(".status-line").textContent().catch(() => "");
    check("G5 export explains sign-in is unavailable", /aren't available on this server/i.test(status || ""), (status || "").trim());
    check("G5 no pointless sign-in panel without cloud", !(await page.locator(".account-modal").isVisible().catch(() => false)));
    const fatal = (errors || []).filter((e) => !/favicon|manifest|ResizeObserver|Download the React DevTools|ERR_FILE_NOT_FOUND/i.test(e));
    check("zero page errors (local-only scenario)", fatal.length === 0, fatal.slice(0, 2).join(" | "));
    await ctx.close();
  }

  // ============ G6: static gate coverage over every export entry point ============
  {
    const src = readFileSync(path.join(ROOT, "src/App.jsx"), "utf8");
    const entryPoints = [
      "exportPng",
      "exportTransparentPng",
      "exportGif",
      "exportVideo",
      "exportStorybook",
      "exportProduction",
      "exportTimelapse",
      "shareTimelapse",
      "sharePreparedTimelapse",
    ];
    for (const name of entryPoints) {
      const start = src.indexOf(`const ${name} = useCallback`);
      // The gate is always at the TOP of the handler, a fixed window avoids
      // any body parsing.
      const body = start === -1 ? "" : src.slice(start, start + 1500);
      check(`G6 ${name} runs the account gate`, start !== -1 && body.includes("gateExport"), start === -1 ? "NOT FOUND" : "");
    }
    // Local-only paths that must stay UNGATED:
    for (const name of ["saveDraft", "restoreDraft", "saveTimelapseToSpace", "saveToGallery"]) {
      const start = src.indexOf(`const ${name} = useCallback`);
      const end = start === -1 ? -1 : src.indexOf("const ", start + 30);
      const body = start === -1 ? "" : src.slice(start, end === -1 ? start + 3000 : end);
      check(`G6 ${name} stays ungated (local save/recovery)`, start !== -1 && !body.includes("gateExport"), start === -1 ? "NOT FOUND" : "");
    }
  }

  await browser.close();
  killAll();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log("failed:", failed.map((f) => f.name).join(" | ")); }
  process.exit(failed.length ? 1 : 0);
};

run().catch((e) => { console.error("harness error:", e); killAll(); process.exit(1); });
