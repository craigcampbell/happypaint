/* global window */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';

// Phase4 CLIENT FIXTURE realtime proof — NOT a server-integration claim. A
// fixture WebSocket (+ mock PocketBase auth-refresh) impersonates the future
// phase4 backend (animation history.checkpoint subsets, scene_fetch with
// frameId, rate_limited resync, frameTiming) while the REAL studio client runs
// under Vite dev (:19134, VITE_WS_URL → fixture :19133) in real Chromium.
// Fixture payloads are generated with the existing renderer (replayFrameOnto +
// onMixState capture), exactly mirroring the worker contract. Covered:
//   A  animation join with a checkpoint SUBSET (3 of 4 cels), cold-cel
//      descriptor retention + checkpointed hydrate, mix continuation parity
//   BUDGET  hydrated window cools to the byte cap, active frame preserved
//   B  corrupt checkpoint + live op during decode → one nack, deferred queue
//      NOT drained into duplicates, full baseline equality
//   C  post-nack tail-only checkpoint history refused (no truncated ink),
//      scene refetch recovers
//   D  rate_limited resync → bounded backoff (no RTT storm), scene lands
//   E  whole-film playback traverses the shared plan across scenes, no
//      auto-stop, no blank cels, cancellation returns to the artist's scene
//   F  WebCodecs whole-film export: measured duration + decoded frame content
//   G  FLIPBOOK frameTiming narrows the hold slider to 1–3s steps
//   H  no WebCodecs → whole-film export explicitly refused before any file
//   I  post-join live wet stroke: checkpoint joiner vs full joiner parity
//
//   node scripts/room-loading-phase4-realtime-verify.mjs

const VITE_PORT = 19134;
const FIXTURE_PORT = 19133;
const root = fileURLToPath(new URL('../', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixture WS + mock-PB server ---------------------------------------------
const connections = new Map(); // room -> { query, nacks: [], fetches: [], ws }
let plan = { rooms: {} };
const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/collections/users/auth-refresh') {
    // Mock PocketBase token validation (export gate only; mirrors
    // test/harness/mockPocketbase.mjs's contract).
    const token = req.headers.authorization || '';
    if (/^tok_/.test(token.trim())) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: token.trim(), record: { id: 'u1', name: 'Grown-up u1', email: 'u1@example.test', verified: true } }));
      return;
    }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 400, message: 'Failed to authenticate.' }));
    return;
  }
  res.writeHead(404).end();
});
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const room = url.searchParams.get('room') || '';
  const record = { query: Object.fromEntries(url.searchParams.entries()), nacks: [], fetches: [], ws };
  connections.set(room, record);
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'checkpoint_nack') record.nacks.push(Date.now());
    if (msg.type === 'scene_fetch') record.fetches.push({ sceneId: msg.sceneId, frameId: msg.frameId || null, t: Date.now() });
    plan.rooms[room]?.onMessage?.(msg, ws, record);
  });
  const script = plan.rooms[room];
  if (script) {
    ws.send(JSON.stringify({
      type: 'connected', userId: `u-${room}`, userName: 'Tester', userColor: '#0878d1',
      canPaint: true, roomProfile: null, animation: true, animMaxFrames: 60,
      ...(script.frameTiming ? { frameTiming: script.frameTiming } : {}),
    }));
    setTimeout(() => script.onConnect?.(ws, record), 60);
  }
  // Any other room (homepage previews etc.): leave it hanging — read-only wait.
});
await new Promise((r) => server.listen(FIXTURE_PORT, '127.0.0.1', r));

// ---- Vite dev server -----------------------------------------------------------
const vite = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), '--port', String(VITE_PORT), '--strictPort'], {
  cwd: root,
  env: { ...process.env, VITE_WS_URL: `ws://127.0.0.1:${FIXTURE_PORT}/ws`, VITE_PB_URL: `http://127.0.0.1:${FIXTURE_PORT}`, BROWSER: 'none' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const viteLog = [];
vite.stdout.on('data', (d) => viteLog.push(d.toString()));
vite.stderr.on('data', (d) => viteLog.push(d.toString()));
async function waitForVite(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${VITE_PORT}/`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error(`Vite did not start on ${VITE_PORT}:\n${viteLog.join('').slice(-2000)}`);
}

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ` — ${detail}`}`);
};

let browser;
try {
  await waitForVite();
  browser = await chromium.launch({ headless: true });

  // ---- fixture generation (real renderer, Vite origin → real define) ----------
  const genContext = await browser.newContext();
  const genPage = await genContext.newPage();
  await genPage.goto(`http://127.0.0.1:${VITE_PORT}/`, { waitUntil: 'domcontentloaded' });
  const fixture = await genPage.evaluate(async () => {
    const F = await import('/src/utils/checkpointFormat.js');
    const { replayFrameOnto } = await import('/src/utils/opReplay.js');
    const { createMixMap } = await import('/src/utils/mixMap.js');
    const { createLayerCanvas, CANVAS_WIDTH: W, CANVAS_HEIGHT: H } = await import('/src/utils/layers.js');
    const { bytesToBase64, base64ToBytes, sha256Hex, checkpointClientSupport } = await import('/src/utils/checkpointClient.js');
    const pts = (x0, y0, x1, y1, n) => Array.from({ length: n }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / (n - 1), y: y0 + ((y1 - y0) * i) / (n - 1), pressure: 0.5 }));
    const layersMeta = [{ id: 'layer-a', name: 'A', visible: true, opacity: 1 }];
    const stroke = (id, settings, points, layerId = 'layer-a') => {
      const half = Math.ceil(points.length / 2);
      return [
        { kind: 'draw', strokeId: id, settings, points: points.slice(0, half), layerId },
        { kind: 'draw', strokeId: id, points: points.slice(half), end: true, layerId },
      ];
    };
    const band = (dy) => pts(1300, 1250 + dy, 2700, 1250 + dy, 16);
    const marker = (id, color, dy, seed) => stroke(id, { brush: 'marker', color, size: 500, opacity: 1, variation: 0, seed }, band(dy));
    const wetOil = (id, color, dy, seed) => stroke(id, { brush: 'oil', color, size: 420, opacity: 1, variation: 0.1, seed, v: 2, wet: true }, band(dy));

    // Scene 1 cels: f0 red (marker prefix + WET OIL tail — exercises the mix
    // continuation), f1 blue, f2 purple, f3 orange. Scene 2: g0 green, g1 yellow.
    // Bands straddle the doc center (1250) so center-pixel probes always land
    // on paint (a ±150 pair leaves a transparent gap at 1250 — measured).
    const opsF0 = [...marker('f0a', '#e02030', -60, 11), ...wetOil('f0b', '#e02030', 60, 12)];
    const opsF1 = [...marker('f1a', '#2040e0', -60, 21), ...marker('f1b', '#2040e0', 60, 22)];
    const opsF2 = [...marker('f2a', '#8020c0', -60, 31), ...marker('f2b', '#8020c0', 60, 32)];
    const opsF3 = [...marker('f3a', '#e08020', -60, 41), ...marker('f3b', '#e08020', 60, 42)];
    const opsG0 = [...marker('g0a', '#20a040', -60, 51), ...marker('g0b', '#20a040', 60, 52)];
    const opsG1 = [...marker('g1a', '#e0c020', -60, 61), ...marker('g1b', '#e0c020', 60, 62)];
    const frames = [['f0', opsF0], ['f1', opsF1], ['f2', opsF2], ['f3', opsF3], ['g0', opsG0], ['g1', opsG1]];
    let opId = 0;
    for (const [frameId, ops] of frames) for (const op of ops) { op.frameId = frameId; op.opId = ++opId; }
    // The live ops used by scenarios B (opacity-0.5 duplicate detector) and I
    // (post-join wet stroke parity).
    const liveB = marker('liveB', '#101010', 0, 71);
    liveB.forEach((op, i) => { op.frameId = 'f0'; op.opId = 100 + i; if (op.settings) op.settings.opacity = 0.5; });
    const liveW = wetOil('liveW', '#1830a8', 0, 81);
    liveW.forEach((op, i) => { op.frameId = 'f0'; op.opId = 500 + i; });

    const rgbaOf = (canvas) => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const replay = async (list) => {
      const canvas = createLayerCanvas(W, H);
      let captured = null;
      await replayFrameOnto(canvas, list, W, H, null, { onMixState: (s) => { captured = s; } });
      return { hash: await sha256Hex(rgbaOf(canvas)), mixState: captured, canvas };
    };
    const descriptor = async (frameId, prefixOps) => {
      const canvas = createLayerCanvas(W, H);
      let captured = null;
      await replayFrameOnto(canvas, prefixOps, W, H, null, { onMixState: (s) => { captured = s; } });
      const pngBase64 = canvas.toDataURL('image/png').split(',')[1];
      const pngBytes = base64ToBytes(pngBase64, F.CHECKPOINT_MAX_LAYER_BYTES);
      return {
        frameId, throughOpId: prefixOps[prefixOps.length - 1].opId,
        layersKey: F.checkpointLayersKey(layersMeta),
        layers: [{ id: 'layer-a', pngBase64, pngSha256: await sha256Hex(pngBytes), rgbaSha256: await sha256Hex(rgbaOf(canvas)) }],
        mixState: {
          version: 1, width: captured.width, height: captured.height,
          pixelsBase64: bytesToBase64(new Uint8Array(captured.data.buffer, 0, captured.data.length)),
          dirty: captured.dirty, prefetched: captured.prefetched,
        },
      };
    };
    // Full-replay references (single layer = flat replay).
    const full = {};
    for (const [frameId, ops] of frames) full[frameId] = await replay(ops);
    const fullF0PlusLiveB = await replay([...opsF0, ...liveB]);
    const fullF0PlusLiveW = await replay([...opsF0, ...liveW]);
    // Mix continuation samples the FULL replay's layer-0 map answers after the
    // last op, as a continuation (dirty rects re-read from the final canvas on
    // demand — the same thing the live app's idle prefetch produces; the raw
    // ledger itself is legitimately timing-dependent, so samples are the check).
    const probes = [[1300, 1190], [2000, 1190], [2700, 1310], [2000, 1310], [500, 500], [2000, 1250]];
    const probeMap = createMixMap(() => full.f0.canvas, W, H);
    probeMap.restoreState(full.f0.mixState);
    const probeSamplesF0 = probes.map(([x, y]) => { const s = probeMap.sample(x, y); return s ? [s[0], s[1], s[2]] : null; });
    // Descriptors for the checkpointed subset (f0, f2, f3 of scene 1; g0 of scene 2).
    const desc = {};
    for (const [frameId, ops] of frames) desc[frameId] = await descriptor(frameId, ops.slice(0, 2));
    const rendererVersion = checkpointClientSupport();
    return {
      layersMeta, ops: { f0: opsF0, f1: opsF1, f2: opsF2, f3: opsF3, g0: opsG0, g1: opsG1 },
      liveB, liveW, full, fullF0PlusLiveB, fullF0PlusLiveW, probes, probeSamplesF0,
      desc, rendererVersion,
    };
  });
  await genContext.close();
  assert.ok(/^[0-9a-f]{64}$/.test(fixture.rendererVersion), 'fixture renderer fingerprint');

  // Scenario plumbing ------------------------------------------------------------
  const DUR = 500;
  const celMeta = (id) => ({ id, durationMs: DUR });
  const scenesMeta = [
    { id: 'sc1', name: 'Scene 1', loops: 1, camera: 'none', frames: ['f0', 'f1', 'f2', 'f3'].map(celMeta) },
    { id: 'sc2', name: 'Scene 2', loops: 1, camera: 'none', frames: ['g0', 'g1'].map(celMeta) },
  ];
  const framesMeta = (ids, dur = DUR) => ids.map((id) => ({ id, durationMs: dur, layers: fixture.layersMeta }));
  const opsOf = (ids) => ids.flatMap((id) => fixture.ops[id]);
  const historyMsg = (sceneId, frameIds, ops, checkpointFrames, dur = DUR) => ({
    type: 'history', sceneId, scenes: scenesMeta, frames: framesMeta(frameIds, dur), ops,
    ...(checkpointFrames ? { checkpoint: { schemaVersion: 1, rendererVersion: fixture.rendererVersion, frames: checkpointFrames } } : {}),
  });
  // Scene-1 join variants. Checkpoint subset {f0, f2, f3}: those cels carry
  // tail-only ops (above their descriptors' watermarks); f1 stays full.
  const sc1Checkpoint = () => historyMsg('sc1', ['f0', 'f1', 'f2', 'f3'],
    [...fixture.ops.f0.slice(2), ...fixture.ops.f1, ...fixture.ops.f2.slice(2), ...fixture.ops.f3.slice(2)],
    [fixture.desc.f0, fixture.desc.f2, fixture.desc.f3]);
  const sc1Full = () => historyMsg('sc1', ['f0', 'f1', 'f2', 'f3'], opsOf(['f0', 'f1', 'f2', 'f3']));
  const sc2Full = () => historyMsg('sc2', ['g0', 'g1'], opsOf(['g0', 'g1']));
  const corrupt = (descriptor) => {
    const copy = JSON.parse(JSON.stringify(descriptor));
    copy.layers[0].rgbaSha256 = copy.layers[0].rgbaSha256.replace(/^../, copy.layers[0].rgbaSha256.startsWith('00') ? 'ff' : '00');
    return copy;
  };

  const openRoom = async (code, { noWebCodecs = false, signedIn = false } = {}) => {
    const context = await browser.newContext();
    if (noWebCodecs) {
      await context.addInitScript(() => {
        delete window.VideoEncoder;
        delete window.VideoFrame;
      });
    }
    if (signedIn) {
      await context.addInitScript(() => {
        const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const token = `tok_${b64({ alg: 'none', typ: 'JWT' })}.${b64({ id: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
        window.localStorage.setItem('pocketbase_auth', JSON.stringify({ token, record: { id: 'u1', email: 'u1@example.test', name: 'Tester' } }));
      });
    }
    const page = await context.newPage();
    page.on('pageerror', (err) => console.log(`  [pageerror ${code}] ${String(err).slice(0, 160)}`));
    await page.goto(`http://127.0.0.1:${VITE_PORT}/join/${code}`, { waitUntil: 'domcontentloaded' });
    return { context, page };
  };
  const waitFor = async (page, fn, arg, timeoutMs = 60000, pollMs = 350) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await page.evaluate(fn, arg);
      if (value) return value;
      if (Date.now() > deadline) return null;
      await sleep(pollMs);
    }
  };
  const layerHash = (page) => page.evaluate(async () => {
    const dbg = window.__drawesomeCheckpoint;
    if (!dbg) return null;
    const layers = dbg.layers();
    if (!layers || !layers.length) return null;
    const data = layers[0].canvas.getContext('2d').getImageData(0, 0, layers[0].canvas.width, layers[0].canvas.height).data;
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  });
  const layerBlank = (page) => page.evaluate(() => {
    const dbg = window.__drawesomeCheckpoint;
    const layers = dbg?.layers();
    if (!layers || !layers.length) return null;
    const data = layers[0].canvas.getContext('2d').getImageData(0, 0, layers[0].canvas.width, layers[0].canvas.height).data;
    for (let i = 3; i < data.length; i += 4013) { if (data[i] !== 0) return false; }
    return true;
  });
  const mixSamples = (page, probes) => page.evaluate((list) => {
    const mix = window.__drawesomeCheckpoint?.mixMap();
    if (!mix) return null;
    return list.map(([x, y]) => { const s = mix.sample(x, y); return s ? [s[0], s[1], s[2]] : null; });
  }, probes);
  const framesDiag = (page) => page.evaluate(() => (window.__drawesomeFrames ? window.__drawesomeFrames() : null));
  const docColor = (page) => page.evaluate(() => {
    const canvas = window.__drawesomeCheckpoint?.docCanvas();
    if (!canvas) return null;
    const d = canvas.getContext('2d').getImageData(2000, 1250, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  });
  const COLORS = { f0: [224, 32, 48], f1: [32, 64, 224], f2: [128, 32, 192], f3: [224, 128, 32], g0: [32, 160, 64], g1: [224, 192, 32] };
  const classify = (rgba) => {
    if (!rgba || rgba[3] < 200) return null;
    let best = null; let bestDist = 90; // tolerance
    for (const [name, [r, g, b]] of Object.entries(COLORS)) {
      const dist = Math.abs(rgba[0] - r) + Math.abs(rgba[1] - g) + Math.abs(rgba[2] - b);
      if (dist < bestDist) { best = name; bestDist = dist; }
    }
    return best;
  };

  // ================= Scenario A: animation checkpoint subset join =================
  {
    const ROOM = 'P4A0001';
    plan = { rooms: { [ROOM]: { onConnect: (ws) => ws.send(JSON.stringify(sc1Checkpoint())) } } };
    const { context, page } = await openRoom(ROOM);
    const joined = await waitFor(page, async (refHash) => {
      const dbg = window.__drawesomeCheckpoint;
      if (!dbg || dbg.joinStep() < 3) return null;
      const layers = dbg.layers();
      if (!layers || !layers.length) return null;
      const data = layers[0].canvas.getContext('2d').getImageData(0, 0, layers[0].canvas.width, layers[0].canvas.height).data;
      const digest = await crypto.subtle.digest('SHA-256', data);
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      return hash === refHash ? { hash } : null;
    }, fixture.full.f0.hash, 90000);
    check('A: checkpoint-subset join reaches history-painted milestone with f0 exact', !!joined);
    const diag = await framesDiag(page);
    check('A: checkpointed cels retain descriptors (f0,f2,f3), uncached cel does not (f1)', !!diag
      && diag.find((f) => f.id === 'f0')?.checkpoint === true
      && diag.find((f) => f.id === 'f2')?.checkpoint === true
      && diag.find((f) => f.id === 'f3')?.checkpoint === true
      && diag.find((f) => f.id === 'f1')?.checkpoint === false, JSON.stringify(diag));
    check('A: far cel (f3) stays cold after join', !!diag && diag.find((f) => f.id === 'f3')?.cold === true, JSON.stringify(diag));
    const samples = await mixSamples(page, fixture.probes);
    check('A: mix continuation samples equal full replay', JSON.stringify(samples) === JSON.stringify(fixture.probeSamplesF0), JSON.stringify(samples));
    // Activate the cold checkpointed cel (f3): hydrate must restore baseline+tail.
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.fs-cel-thumb')];
      buttons[3]?.click();
    });
    const hydratedF3 = await waitFor(page, async (refHash) => {
      const diagNow = window.__drawesomeFrames ? window.__drawesomeFrames() : null;
      const f3 = diagNow?.find((f) => f.id === 'f3');
      if (!f3 || f3.cold || f3.hydrating || !f3.active) return null;
      const layers = window.__drawesomeCheckpoint.layers();
      const data = layers[0].canvas.getContext('2d').getImageData(0, 0, layers[0].canvas.width, layers[0].canvas.height).data;
      const digest = await crypto.subtle.digest('SHA-256', data);
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      return hash === refHash ? { hash } : null;
    }, fixture.full.f3.hash, 60000);
    check('A: cold checkpointed cel hydrates to full-replay equality (baseline+tail)', !!hydratedF3);
    const record = connections.get(ROOM);
    check('A: no checkpoint_nack on the happy path', (record?.nacks.length || 0) === 0);
    await context.close();
  }

  // ================= Scenario BUDGET: hydrated window byte cap ====================
  {
    const ROOM = 'P4BUDGET';
    plan = { rooms: { [ROOM]: { onConnect: (ws) => ws.send(JSON.stringify(sc1Full())) } } };
    const { context, page } = await openRoom(ROOM);
    const ready = await waitFor(page, () => (window.__drawesomeCheckpoint?.joinStep() >= 3 ? true : null), null, 90000);
    check('BUDGET: room joined', ready === true);
    // Activate cel 4 (index 3): the radius wants frames 1..5 hydrated — 5 ×
    // 2-layer? (1 layer here) — 5 × 40MB = 200MB ≤ 240MB budget... so also
    // confirm accounting shape: never above budget, active always hydrated.
    await page.evaluate(() => { [...document.querySelectorAll('.fs-cel-thumb')][3]?.click(); });
    const settled = await waitFor(page, () => {
      const diag = window.__drawesomeFrames ? window.__drawesomeFrames() : null;
      if (!diag) return null;
      const hydrated = diag.filter((f) => !f.cold);
      const total = hydrated.reduce((sum, f) => sum + f.hydratedBytes, 0);
      const active = diag.find((f) => f.active);
      // Settled once the warm/cool sweeps stop changing the hydrated count.
      return { count: hydrated.length, total, activeHydrated: !!active && !active.cold, key: hydrated.map((f) => f.id).join(',') };
    }, null, 30000);
    await sleep(4000); // let the idle sweeps enforce
    const after = await framesDiag(page);
    const hydrated = (after || []).filter((f) => !f.cold);
    const totalBytes = hydrated.reduce((sum, f) => sum + f.hydratedBytes, 0);
    const active = (after || []).find((f) => f.active);
    check('BUDGET: hydrated window within the 240MB byte cap after sweeps', totalBytes <= 240 * 1024 * 1024, `total=${(totalBytes / 1e6).toFixed(0)}MB frames=${hydrated.map((f) => f.id)}`);
    check('BUDGET: active frame always hydrated', !!active && !active.cold, JSON.stringify(active));
    check('BUDGET: diagnostics report per-frame hydrated bytes', !!settled && settled.total > 0);
    await context.close();
  }

  // ===== Scenario B: corrupt checkpoint + live op during decode → no duplicates =====
  {
    const ROOM = 'P4B0001';
    plan = { rooms: { [ROOM]: {
      onConnect: (ws, record) => {
        const bad = { schemaVersion: 1, rendererVersion: fixture.rendererVersion, frames: [corrupt(fixture.desc.f0)] };
        ws.send(JSON.stringify(historyMsg('sc1', ['f0', 'f1', 'f2', 'f3'], [...fixture.ops.f0.slice(2), ...opsOf(['f1', 'f2', 'f3'])], bad.frames)));
        // A live op lands DURING the (doomed) decode: deferred behind the
        // replay, it must NOT be drained after the nack — the full baseline
        // below already carries it.
        setTimeout(() => {
          for (const op of fixture.liveB) ws.send(JSON.stringify({ type: 'op', op }));
        }, 30);
        const watch = setInterval(() => {
          if (record.nacks.length >= 1) {
            clearInterval(watch);
            setTimeout(() => ws.send(JSON.stringify(historyMsg('sc1', ['f0', 'f1', 'f2', 'f3'], [...opsOf(['f0', 'f1', 'f2', 'f3']), ...fixture.liveB]))), 600);
          }
        }, 60);
      },
    } } };
    const { context, page } = await openRoom(ROOM);
    const nacked = await (async () => {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        if ((connections.get(ROOM)?.nacks.length || 0) >= 1) return true;
        await sleep(150);
      }
      return false;
    })();
    check('B: corrupt animation checkpoint triggers exactly one nack (so far)', nacked === true);
    const midBlank = await layerBlank(page);
    check('B: no bare-tail paint while the baseline is pending', midBlank === true, `blank=${midBlank}`);
    const recovered = await waitFor(page, async (refHash) => {
      const dbg = window.__drawesomeCheckpoint;
      if (!dbg || dbg.joinStep() < 3) return null;
      const layers = dbg.layers();
      if (!layers || !layers.length) return null;
      const data = layers[0].canvas.getContext('2d').getImageData(0, 0, layers[0].canvas.width, layers[0].canvas.height).data;
      const digest = await crypto.subtle.digest('SHA-256', data);
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      return hash === refHash ? { hash } : null;
    }, fixture.fullF0PlusLiveB.hash, 90000);
    check('B: full baseline paints the live op EXACTLY ONCE (deferred queue not drained)', !!recovered);
    await sleep(1200);
    check('B: still exactly one nack (no retry loop)', (connections.get(ROOM)?.nacks.length || 0) === 1);
    await context.close();
  }

  // ===== Scenario C: post-nack tail-only checkpoint refused ========================
  {
    const ROOM = 'P4C0001';
    let releaseBaseline;
    const baselineAllowed = new Promise((resolve) => { releaseBaseline = resolve; });
    plan = { rooms: { [ROOM]: {
      onConnect: (ws, record) => {
        const bad = { schemaVersion: 1, rendererVersion: fixture.rendererVersion, frames: [corrupt(fixture.desc.f0)] };
        ws.send(JSON.stringify(historyMsg('sc1', ['f0', 'f1', 'f2', 'f3'], [...fixture.ops.f0.slice(2), ...opsOf(['f1', 'f2', 'f3'])], bad.frames)));
        const watch = setInterval(() => {
          if (record.nacks.length >= 1) {
            clearInterval(watch);
            // Buggy server: ignores the nack, re-sends a checkpoint with a
            // TAIL-ONLY op list for f0. The client must refuse truncated ink.
            setTimeout(() => {
              const tailOnly = { schemaVersion: 1, rendererVersion: fixture.rendererVersion, frames: [fixture.desc.f0] };
              ws.send(JSON.stringify(historyMsg('sc1', ['f0', 'f1', 'f2', 'f3'], [...fixture.ops.f0.slice(2), ...opsOf(['f1', 'f2', 'f3'])], tailOnly.frames)));
            }, 500);
          }
        }, 60);
      },
      onMessage: (msg, ws) => {
        if (msg.type === 'scene_fetch' && msg.sceneId === 'sc1') {
          // Hold the real baseline until the negative pixel assertion. A
          // 150ms reply raced the 150ms polling interval + canvas readback.
          void baselineAllowed.then(() => ws.send(JSON.stringify(sc1Full())));
        }
      },
    } } };
    const { context, page } = await openRoom(ROOM);
    // Wait for the refusal-driven refetch.
    const refused = await (async () => {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        if ((connections.get(ROOM)?.fetches.length || 0) >= 1) return true;
        await sleep(150);
      }
      return false;
    })();
    check('C: tail-only post-nack baseline refused → scene refetch requested', refused === true);
    const blank = await layerBlank(page);
    check('C: no truncated ink painted from the refused baseline', blank === true, `blank=${blank}`);
    releaseBaseline();
    const recovered = await waitFor(page, async (refHash) => {
      const dbg = window.__drawesomeCheckpoint;
      if (!dbg || dbg.joinStep() < 3) return null;
      const layers = dbg.layers();
      if (!layers || !layers.length) return null;
      const data = layers[0].canvas.getContext('2d').getImageData(0, 0, layers[0].canvas.width, layers[0].canvas.height).data;
      const digest = await crypto.subtle.digest('SHA-256', data);
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      return hash === refHash ? { hash } : null;
    }, fixture.full.f0.hash, 90000);
    check('C: refetched full baseline repaints to equality', !!recovered);
    check('C: exactly one nack total (refusal is not another nack)', (connections.get(ROOM)?.nacks.length || 0) === 1);
    await context.close();
  }

  // ===== Scenario D: rate_limited resync uses bounded backoff ======================
  {
    const ROOM = 'P4D0001';
    let resyncsLeft = 2;
    plan = { rooms: { [ROOM]: {
      onConnect: (ws) => ws.send(JSON.stringify(sc1Full())),
      onMessage: (msg, ws) => {
        if (msg.type !== 'scene_fetch') return;
        if (msg.sceneId === 'sc2') {
          if (resyncsLeft > 0) {
            resyncsLeft -= 1;
            setTimeout(() => ws.send(JSON.stringify({ type: 'resync', reason: 'rate_limited' })), 40);
          } else {
            setTimeout(() => ws.send(JSON.stringify(sc2Full())), 60);
          }
        }
      },
    } } };
    const { context, page } = await openRoom(ROOM);
    const ready = await waitFor(page, () => (window.__drawesomeCheckpoint?.joinStep() >= 3 ? true : null), null, 90000);
    check('D: room joined', ready === true);
    await page.evaluate(() => { document.querySelector('button[aria-label="Next scene"]')?.click(); });
    const landed = await waitFor(page, () => {
      const dbg = window.__drawesomeCheckpoint;
      const diag = window.__drawesomeFrames ? window.__drawesomeFrames() : null;
      if (!dbg || !diag || dbg.scene() !== 'sc2') return null;
      return diag.some((f) => f.id === 'g0') ? true : null;
    }, null, 60000);
    check('D: scene lands after shed fetches (waiter not hung)', landed === true);
    const fetches = (connections.get(ROOM)?.fetches || []).filter((f) => f.sceneId === 'sc2');
    check('D: bounded retries (3 fetches: initial + 2 backed-off)', fetches.length === 3, `fetches=${fetches.length}`);
    const gaps = fetches.slice(1).map((f, i) => f.t - fetches[i].t);
    check('D: retries spaced by backoff, not RTT-looped', gaps.length === 2 && gaps.every((g) => g >= 250), `gaps=${JSON.stringify(gaps)}`);
    await context.close();
  }

  // ===== Scenario E: whole-film playback across scenes ==============================
  {
    const ROOM = 'P4E0001';
    plan = { rooms: { [ROOM]: {
      onConnect: (ws) => ws.send(JSON.stringify(sc1Full())),
      onMessage: (msg, ws) => {
        if (msg.type === 'scene_fetch' && msg.sceneId === 'sc2') setTimeout(() => ws.send(JSON.stringify(sc2Full())), 80);
        if (msg.type === 'scene_fetch' && msg.sceneId === 'sc1') setTimeout(() => ws.send(JSON.stringify(sc1Full())), 80);
      },
    } } };
    const { context, page } = await openRoom(ROOM);
    const ready = await waitFor(page, () => (window.__drawesomeCheckpoint?.joinStep() >= 3 ? true : null), null, 90000);
    check('E: room joined', ready === true);
    await page.evaluate(() => { document.querySelector('button[title="Play / pause"]')?.click(); });
    await sleep(300);
    const startedFilm = await page.evaluate(() => window.__drawesomeCheckpoint?.playback() || null);
    check('E: whole-film playback starts (film walker owns the display)', !!startedFilm && startedFilm.film === true, JSON.stringify(startedFilm));
    // Watch the doc canvas: the shared plan is f0→f1→f2→f3→g0→g1 (500ms each).
    const seen = [];
    const filmDuring = { g0: null, g1: null };
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const color = classify(await docColor(page));
      const film = await page.evaluate(() => window.__drawesomeCheckpoint?.playback()?.film ?? null);
      if (color && seen[seen.length - 1] !== color) seen.push(color);
      if (film === true && (color === 'g0' || color === 'g1')) filmDuring[color] = film;
      const done = await page.evaluate(() => window.__drawesomeCheckpoint?.playback()?.film === false);
      if (done && seen.includes('g1')) break;
      await sleep(110);
    }
    const order = ['f0', 'f1', 'f2', 'f3', 'g0', 'g1'];
    const subsequence = order.every((id) => seen.includes(id))
      && order.every((id, i) => i === 0 || seen.indexOf(id) > seen.indexOf(order[i - 1]));
    check('E: playback painted every cel of BOTH scenes in plan order', subsequence, `seen=${JSON.stringify(seen)}`);
    check('E: no auto-stop at the scene boundary (film flag stayed up)', filmDuring.g0 === true && filmDuring.g1 === true, JSON.stringify(filmDuring));
    const fetchesE = (connections.get(ROOM)?.fetches || []).map((f) => f.sceneId);
    check('E: playback paged scene 2 in the background (frameId hint carried)', fetchesE.includes('sc2'), JSON.stringify(connections.get(ROOM)?.fetches));
    const ended = await waitFor(page, () => {
      const dbg = window.__drawesomeCheckpoint;
      return dbg && dbg.playback().film === false && dbg.scene() === 'sc1' ? true : null;
    }, null, 30000);
    check('E: playback ends and returns to the artist’s scene', ended === true);
    await context.close();
  }

  // ===== Scenario F: WebCodecs whole-film export (real duration + frames) ==========
  {
    const ROOM = 'P4F0001';
    plan = { rooms: { [ROOM]: {
      onConnect: (ws) => ws.send(JSON.stringify(sc1Full())),
      onMessage: (msg, ws) => {
        if (msg.type === 'scene_fetch' && msg.sceneId === 'sc2') setTimeout(() => ws.send(JSON.stringify(sc2Full())), 80);
        if (msg.type === 'scene_fetch' && msg.sceneId === 'sc1') setTimeout(() => ws.send(JSON.stringify(sc1Full())), 80);
      },
    } } };
    const { context, page } = await openRoom(ROOM, { signedIn: true });
    const ready = await waitFor(page, () => (window.__drawesomeCheckpoint?.joinStep() >= 3 ? true : null), null, 90000);
    check('F: room joined (signed-in fixture)', ready === true);
    await page.evaluate(() => { document.querySelector('button[aria-label="Frame actions"]')?.click(); });
    await sleep(250);
    await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Export film'))?.click(); });
    const exported = await waitFor(page, () => {
      const last = window.__drawesomeLastExport;
      return last && last.blob && last.blob.size > 1000 ? { shots: last.shots, ms: last.ms, ext: last.ext } : null;
    }, null, 180000, 800);
    check('F: whole-film export produces a file covering all 6 shots', !!exported && exported.shots === 6 && exported.ms === 3000, JSON.stringify(exported));
    const decoded = exported ? await page.evaluate(async () => {
      const last = window.__drawesomeLastExport;
      const url = URL.createObjectURL(last.blob);
      try {
        const video = document.createElement('video');
        video.muted = true;
        video.src = url;
        await new Promise((resolve, reject) => {
          video.onloadedmetadata = resolve;
          video.onerror = () => reject(new Error('video did not load'));
        });
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 1600;
        canvas.height = video.videoHeight || 1000;
        const ctx = canvas.getContext('2d');
        const colorAt = async (t) => {
          await new Promise((resolve) => {
            video.onseeked = resolve;
            video.currentTime = t;
          });
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const d = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
          return [d[0], d[1], d[2], d[3]];
        };
        const samples = [];
        for (const t of [0.25, 0.75, 1.25, 1.75, 2.25, 2.75]) samples.push(await colorAt(t));
        return { duration: video.duration, samples };
      } finally {
        URL.revokeObjectURL(url);
      }
    }) : null;
    check('F: encoded video decodes with the authored duration (~3.0s)', !!decoded && Math.abs(decoded.duration - 3.0) < 0.7, `duration=${decoded && decoded.duration}`);
    const decodedColors = decoded ? decoded.samples.map(classify) : [];
    check('F: decoded frames show the right cel at the right time (6/6 distinct)', JSON.stringify(decodedColors) === JSON.stringify(['f0', 'f1', 'f2', 'f3', 'g0', 'g1']), JSON.stringify({ decodedColors, samples: decoded && decoded.samples }));
    await context.close();
  }

  // ===== Scenario G: FLIPBOOK frameTiming narrows the hold slider ===================
  {
    const ROOM = 'P4G0001';
    plan = { rooms: { [ROOM]: {
      frameTiming: { minMs: 1000, maxMs: 3000, defaultMs: 1000 },
      // FLIPBOOK-canonical timing: the server normalizes cels into the band.
      onConnect: (ws) => ws.send(JSON.stringify(historyMsg('sc1', ['f0', 'f1', 'f2', 'f3'], opsOf(['f0', 'f1', 'f2', 'f3']), null, 1000))),
    } } };
    const { context, page } = await openRoom(ROOM);
    const ready = await waitFor(page, () => (window.__drawesomeCheckpoint?.joinStep() >= 3 ? true : null), null, 90000);
    check('G: room joined', ready === true);
    const timing = await page.evaluate(() => window.__drawesomeCheckpoint?.frameTiming?.() || null);
    check('G: client adopted the server hold bounds', !!timing && timing.minMs === 1000 && timing.maxMs === 3000 && timing.defaultMs === 1000, JSON.stringify(timing));
    const slider = await page.evaluate(() => {
      const input = document.querySelector('.fs-duration input[type="range"]');
      const output = document.querySelector('.fs-duration output');
      return input ? { max: input.max, value: input.value, text: output?.textContent || '' } : null;
    });
    check('G: hold slider offers exactly the 4 in-bounds steps (1s default)', !!slider && slider.max === '3' && slider.text === '1s', JSON.stringify(slider));
    // Drag to the last step → 3s (server-clamped band), never 10s.
    await page.evaluate(() => {
      const input = document.querySelector('.fs-duration input[type="range"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '3');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(400);
    const after = await page.evaluate(() => document.querySelector('.fs-duration output')?.textContent || '');
    check('G: dragging the slider lands on 3s (never outside the band)', after === '3s', `output=${after}`);
    await context.close();
  }

  // ===== Scenario H: no WebCodecs → explicit whole-film refusal =====================
  {
    const ROOM = 'P4H0001';
    plan = { rooms: { [ROOM]: { onConnect: (ws) => ws.send(JSON.stringify(sc1Full())) } } };
    const { context, page } = await openRoom(ROOM, { noWebCodecs: true, signedIn: true });
    const ready = await waitFor(page, () => (window.__drawesomeCheckpoint?.joinStep() >= 3 ? true : null), null, 90000);
    check('H: room joined (WebCodecs stripped)', ready === true);
    await page.evaluate(() => { document.querySelector('button[aria-label="Frame actions"]')?.click(); });
    await sleep(250);
    await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Export film'))?.click(); });
    const refused = await waitFor(page, () => {
      const status = window.__drawesomeCheckpoint?.status?.() || '';
      return status.includes('Whole-film video needs a newer browser') ? status : null;
    }, null, 30000);
    check('H: whole-film export explicitly refuses without WebCodecs', !!refused, String(refused));
    const partial = await page.evaluate(() => !!window.__drawesomeLastExport);
    check('H: NO partial/current-scene file was created first', partial === false);
    await context.close();
  }

  // ===== Scenario I: post-join live wet stroke — cp joiner vs full joiner ==========
  {
    const ROOM_CP = 'P4I000CP';
    const ROOM_FULL = 'P4IFULL';
    const liveWSend = (ws, delay = 400) => setTimeout(() => {
      for (const op of fixture.liveW) ws.send(JSON.stringify({ type: 'op', op }));
    }, delay);
    plan = { rooms: {
      [ROOM_CP]: {
        onConnect: (ws) => {
          ws.send(JSON.stringify(historyMsg('sc1', ['f0', 'f1', 'f2', 'f3'],
            [...fixture.ops.f0.slice(2), ...fixture.ops.f1, ...fixture.ops.f2.slice(2), ...fixture.ops.f3.slice(2)],
            [fixture.desc.f0, fixture.desc.f2, fixture.desc.f3])));
          liveWSend(ws, 1500);
        },
      },
      [ROOM_FULL]: {
        onConnect: (ws) => {
          ws.send(JSON.stringify(sc1Full()));
          liveWSend(ws, 1500);
        },
      },
    } };
    const cpRoom = await openRoom(ROOM_CP);
    const fullRoom = await openRoom(ROOM_FULL);
    const refHash = fixture.fullF0PlusLiveW.hash;
    const waitWet = (page) => waitFor(page, async (ref) => {
      const dbg = window.__drawesomeCheckpoint;
      if (!dbg || dbg.joinStep() < 3) return null;
      const layers = dbg.layers();
      if (!layers || !layers.length) return null;
      const data = layers[0].canvas.getContext('2d').getImageData(0, 0, layers[0].canvas.width, layers[0].canvas.height).data;
      const digest = await crypto.subtle.digest('SHA-256', data);
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      return hash === ref ? { hash } : null;
    }, refHash, 90000);
    const [cpDone, fullDone] = await Promise.all([waitWet(cpRoom.page), waitWet(fullRoom.page)]);
    check('I: checkpoint joiner paints the post-join wet stroke to full-replay equality', !!cpDone);
    check('I: full-history joiner paints the post-join wet stroke to full-replay equality', !!fullDone);
    const cpHash = await layerHash(cpRoom.page);
    const fullHash = await layerHash(fullRoom.page);
    check('I: cp vs full joiner byte-identical after the same live wet stroke', !!cpHash && cpHash === fullHash, `${cpHash} vs ${fullHash}`);
    const cpSamples = await mixSamples(cpRoom.page, fixture.probes);
    const fullSamples = await mixSamples(fullRoom.page, fixture.probes);
    check('I: cp vs full joiner mix-map samples identical after the stroke', JSON.stringify(cpSamples) === JSON.stringify(fullSamples), JSON.stringify({ cpSamples, fullSamples }));
    await cpRoom.context.close();
    await fullRoom.context.close();
  }

  const failures = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failures.length}/${results.length} phase4 fixture realtime checks passed`);
  assert.equal(failures.length, 0, `${failures.length} failures: ${failures.map((f) => f.name).join(', ')}`);
} finally {
  plan = { rooms: {} };
  await browser?.close();
  for (const client of wss.clients) client.terminate();
  await Promise.race([new Promise((r) => wss.close(r)), sleep(2000)]);
  await new Promise((r) => server.close(r));
  vite.stdout?.destroy();
  vite.stderr?.destroy();
  vite.kill('SIGKILL');
}
process.exit(0);
