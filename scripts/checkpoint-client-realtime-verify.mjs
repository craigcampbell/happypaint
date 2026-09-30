/* global window */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { checkpointRendererVersion } from '../server/checkpointVersion.js';

// FIXTURE realtime proof — phase3 CLIENT only, NOT a server-integration claim.
// A fixture WebSocket impersonates the future backend checkpoint sender
// (history.checkpoint + tail ops, full baseline on checkpoint_nack) while the
// REAL studio client runs under Vite dev (:19123, VITE_WS_URL → fixture :19124)
// in real Chromium. Fixture payloads are generated with the existing renderer
// (replayFrameOnto + onMixState), exactly mirroring the worker contract. What
// this proves: the client advertises cp only with a verifiable fingerprint,
// restores a checkpoint baseline + tail to byte-equality with a full replay,
// and on corruption refuses pixels, sends ONE checkpoint_nack, keeps the join
// curtain up, and recovers from the full baseline without infinite retry.
//
//   node scripts/checkpoint-client-realtime-verify.mjs

const VITE_PORT = 19123;
const WS_PORT = 19124;
const root = fileURLToPath(new URL('../', import.meta.url));
const EXPECTED_FP = checkpointRendererVersion();
assert.match(EXPECTED_FP, /^[0-9a-f]{64}$/);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixture WS server -------------------------------------------------------
// Scripted by `plan`: { history(ws) } runs after the handshake. Records the
// join query + any checkpoint_nack frames per room code.
const connections = new Map(); // room -> { query, nacks: [] , ws }
let plan = null;
const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const room = url.searchParams.get('room') || '';
  const record = { query: Object.fromEntries(url.searchParams.entries()), nacks: [], ws, historySent: [] };
  connections.set(room, record);
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg && msg.type === 'checkpoint_nack') record.nacks.push(Date.now());
  });
  if (plan && plan.rooms && plan.rooms[room]) {
    const script = plan.rooms[room];
    ws.send(JSON.stringify({
      type: 'connected', userId: `u-${room}`, userName: 'Tester', userColor: '#0878d1',
      canPaint: true, roomProfile: null, animation: false,
    }));
    record.historySent.push('connected');
    setTimeout(() => script(ws, record), 50);
  }
  // Any other room (homepage previews etc.): leave it hanging — read-only wait.
});

// ---- Vite dev server ---------------------------------------------------------
// Spawn vite's bin DIRECTLY (not via npx — the wrapper makes the dev server a
// grandchild that survives a kill and holds our stdio pipes open).
const vite = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), '--port', String(VITE_PORT), '--strictPort'], {
  cwd: root,
  env: { ...process.env, VITE_WS_URL: `ws://127.0.0.1:${WS_PORT}/ws`, BROWSER: 'none' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const viteLog = [];
vite.stdout.on('data', (d) => viteLog.push(d.toString()));
vite.stderr.on('data', (d) => viteLog.push(d.toString()));

async function waitForVite(timeoutMs = 60000) {
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

  // ---- fixture generation (real renderer, Vite origin → real define) --------
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
    const layersMeta = [
      { id: 'layer-a', name: 'A', visible: true, opacity: 1 },
      { id: 'layer-b', name: 'B', visible: false, opacity: 0.6 },
      { id: 'layer-c', name: 'C', visible: true, opacity: 0.5 },
    ];
    const layerIds = layersMeta.map((l) => l.id);
    const stroke = (id, settings, points, layerId) => {
      const half = Math.ceil(points.length / 2);
      return [
        { kind: 'draw', strokeId: id, settings, points: points.slice(0, half), layerId },
        { kind: 'draw', strokeId: id, points: points.slice(half), end: true, layerId },
      ];
    };
    const imgCanvas = createLayerCanvas(600, 400);
    const ig = imgCanvas.getContext('2d');
    ig.fillStyle = '#f2c018'; ig.fillRect(0, 0, 600, 400);
    ig.fillStyle = '#1840a0'; ig.fillRect(60, 60, 200, 150);
    ig.fillStyle = '#a01840'; ig.beginPath(); ig.arc(400, 220, 110, 0, Math.PI * 2); ig.fill();
    const imgUrl = imgCanvas.toDataURL('image/png');
    const ops = [
      ...stroke('m1', { brush: 'marker', color: '#d42040', size: 60, opacity: 0.9, variation: 0.08, seed: 111 }, pts(200, 300, 900, 700, 40), 'layer-a'),
      ...stroke('e1', { brush: 'eraser', size: 90, seed: 222 }, pts(300, 350, 800, 650, 30), 'layer-a'),
      ...stroke('o1', { brush: 'oil', color: '#2040c0', size: 90, opacity: 1, variation: 0.1, seed: 333, v: 2, wet: true }, pts(250, 400, 950, 800, 40), 'layer-a'),
      { kind: 'image', dataUrl: imgUrl, x: 1500, y: 400, w: 600, h: 400, layerId: 'layer-b' },
      ...stroke('s1', { brush: 'smudge', size: 70, opacity: 1, strength: 0.6, seed: 444 }, pts(500, 500, 1000, 900, 30), 'layer-a'),
      ...stroke('a1', { brush: 'acrylic', color: '#20a060', size: 50, opacity: 0.8, variation: 0.05, seed: 555, v: 2, wet: true }, pts(1600, 300, 2200, 900, 40), 'layer-c'),
      ...stroke('m2', { brush: 'marker', color: '#8020c0', size: 40, opacity: 1, variation: 0.02, seed: 666 }, pts(1600, 1400, 2400, 1800, 30), 'layer-b'),
    ];
    ops.forEach((op, i) => { op.opId = i + 1; });
    const SPLIT = 6;
    const prefixOps = ops.slice(0, SPLIT);
    const tailOps = ops.slice(SPLIT);
    const THROUGH = prefixOps[prefixOps.length - 1].opId;
    const replayOntoLayers = async (list, bases, mixState) => {
      const canvases = bases || layerIds.map(() => createLayerCanvas(W, H));
      const contexts = canvases.map((c) => c.getContext('2d'));
      const targetFor = (op) => contexts[Math.max(0, layerIds.indexOf(op.layerId))];
      let captured = null;
      await replayFrameOnto(canvases[0], list, W, H, targetFor, { preservePixels: !!bases, mixState, onMixState: (s) => { captured = s; } });
      return { canvases, contexts, mixState: captured };
    };
    const rgbaOf = (canvas) => canvas.getContext('2d').getImageData(0, 0, W, H).data;
    // FULL replay reference (per-layer hashes + continuation mix samples).
    const full = await replayOntoLayers(ops);
    const fullHashes = [];
    for (const canvas of full.canvases) fullHashes.push(await sha256Hex(rgbaOf(canvas)));
    // What the full replay's layer-0 mix map answers AFTER the last op, as a
    // continuation (dirty rects re-read from the layer-0 canvas on demand) —
    // the ledger itself (dirty/prefetched) is legitimately timing-dependent in
    // the live app, so the wire equality check is on SAMPLES, not the ledger.
    const probes = [[275, 425], [500, 550], [700, 600], [900, 700], [300, 500], [600, 850], [100, 100], [2000, 2000], [1700, 350], [2100, 850], [550, 520], [800, 760]];
    const fullMap = createMixMap(() => full.canvases[0], W, H);
    fullMap.restoreState(full.mixState);
    const probeSamples = probes.map(([x, y]) => { const s = fullMap.sample(x, y); return s ? [s[0], s[1], s[2]] : null; });
    // PREFIX replay → checkpoint descriptor (mirrors the worker contract).
    const prefix = await replayOntoLayers(prefixOps);
    const descriptorLayers = [];
    for (let i = 0; i < prefix.canvases.length; i += 1) {
      const pngBase64 = prefix.canvases[i].toDataURL('image/png').split(',')[1];
      const pngBytes = base64ToBytes(pngBase64, F.CHECKPOINT_MAX_LAYER_BYTES);
      descriptorLayers.push({
        id: layerIds[i], pngBase64,
        pngSha256: await sha256Hex(pngBytes),
        rgbaSha256: await sha256Hex(rgbaOf(prefix.canvases[i])),
      });
    }
    const descriptor = {
      frameId: 'f0', throughOpId: THROUGH,
      layersKey: F.checkpointLayersKey(layersMeta),
      layers: descriptorLayers,
      mixState: {
        version: 1, width: prefix.mixState.width, height: prefix.mixState.height,
        pixelsBase64: bytesToBase64(new Uint8Array(prefix.mixState.data.buffer, 0, prefix.mixState.data.length)),
        dirty: prefix.mixState.dirty, prefetched: prefix.mixState.prefetched,
      },
    };
    const rendererVersion = checkpointClientSupport();
    return {
      ops, tailOps, fullHashes, probes, probeSamples, rendererVersion,
      framesMeta: [{ id: 'f0', durationMs: 120, layers: layersMeta }],
      checkpoint: { schemaVersion: 1, rendererVersion, frames: [descriptor] },
    };
  });
  await genContext.close();

  check('fixture: Vite define fingerprint matches server helper', fixture.rendererVersion === EXPECTED_FP, `${fixture.rendererVersion} vs ${EXPECTED_FP}`);

  // Helpers for the room pages.
  const openRoom = async (code) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', () => {});
    await page.goto(`http://127.0.0.1:${VITE_PORT}/join/${code}`, { waitUntil: 'domcontentloaded' });
    return { context, page };
  };
  const waitFor = async (page, fn, arg, timeoutMs = 90000, pollMs = 400) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await page.evaluate(fn, arg);
      if (value) return value;
      if (Date.now() > deadline) return null;
      await sleep(pollMs);
    }
  };
  const readLayers = (page) => page.evaluate(async ({ fullHashes, probes }) => {
    const dbg = window.__drawesomeCheckpoint;
    if (!dbg) return null;
    const layers = dbg.layers();
    if (!layers || layers.length < 3) return null;
    const out = { joinStep: dbg.joinStep(), hashes: [], samples: null };
    for (const layer of layers.slice(0, 3)) {
      const data = layer.canvas.getContext('2d').getImageData(0, 0, layer.canvas.width, layer.canvas.height).data;
      const digest = await crypto.subtle.digest('SHA-256', data);
      out.hashes.push([...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''));
    }
    const mix = dbg.mixMap();
    if (mix) {
      out.samples = probes.map(([x, y]) => { const s = mix.sample(x, y); return s ? [s[0], s[1], s[2]] : null; });
    }
    out.match = out.hashes.map((h, i) => h === fullHashes[i]);
    return out;
  }, { fullHashes: fixture.fullHashes, probes: fixture.probes });

  // ================= Scenario A: valid checkpoint join =================
  {
    const ROOM = 'CPCASE1';
    plan = { rooms: { [ROOM]: (ws) => ws.send(JSON.stringify({
      type: 'history', ops: fixture.tailOps, frames: fixture.framesMeta, checkpoint: fixture.checkpoint,
    })) } };
    const { context, page } = await openRoom(ROOM);
    const final = await waitFor(page, async (fullHashes) => {
      const dbg = window.__drawesomeCheckpoint;
      if (!dbg || dbg.joinStep() < 3) return null;
      const layers = dbg.layers();
      if (!layers || layers.length < 3) return null;
      const hashes = [];
      for (const layer of layers.slice(0, 3)) {
        const data = layer.canvas.getContext('2d').getImageData(0, 0, layer.canvas.width, layer.canvas.height).data;
        const digest = await crypto.subtle.digest('SHA-256', data);
        hashes.push([...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''));
      }
      // Image ops land async — wait until the hidden layer matches too.
      if (!hashes.every((h, i) => h === fullHashes[i])) return null;
      return { joinStep: dbg.joinStep(), hashes };
    }, fixture.fullHashes, 120000);
    check('A: checkpoint join reaches history-painted milestone', !!final && final.joinStep >= 3);
    check('A: per-layer pixels byte-equal to full replay', !!final && final.hashes.every((h, i) => h === fixture.fullHashes[i]), JSON.stringify(final && final.hashes));
    const mixState = await readLayers(page);
    check('A: mix-map continuation samples equal full replay', !!mixState && JSON.stringify(mixState.samples) === JSON.stringify(fixture.probeSamples), JSON.stringify(mixState && mixState.samples));
    const record = connections.get(ROOM);
    check('A: client advertised cp=<renderer fingerprint>', record?.query.cp === EXPECTED_FP, JSON.stringify(record?.query));
    check('A: client advertised gz=1', record?.query.gz === '1');
    check('A: no checkpoint_nack on the happy path', (record?.nacks.length || 0) === 0);
    await context.close();
  }

  // ============ Scenario B: corrupt checkpoint → nack → baseline ============
  {
    const ROOM = 'CPCASE2';
    const corrupt = JSON.parse(JSON.stringify(fixture.checkpoint));
    corrupt.frames[0].layers[0].rgbaSha256 = corrupt.frames[0].layers[0].rgbaSha256.replace(/^../, corrupt.frames[0].layers[0].rgbaSha256.startsWith('00') ? 'ff' : '00');
    let stage = 'corrupt';
    plan = { rooms: { [ROOM]: (ws, record) => {
      if (stage === 'corrupt') {
        ws.send(JSON.stringify({ type: 'history', ops: fixture.tailOps, frames: fixture.framesMeta, checkpoint: corrupt }));
        // After the nack: full baseline (delayed so the harness can observe
        // the refuse-to-paint window), then a buggy-server checkpoint retry.
        const watch = setInterval(() => {
          if (record.nacks.length >= 1 && stage === 'corrupt') {
            stage = 'baseline';
            setTimeout(() => {
              ws.send(JSON.stringify({ type: 'history', ops: fixture.ops, frames: fixture.framesMeta }));
              setTimeout(() => {
                stage = 'retry';
                // A post-nack checkpoint must be ignored (full ops ride along),
                // and must NOT trigger a second nack (no infinite retry).
                ws.send(JSON.stringify({ type: 'history', ops: fixture.ops, frames: fixture.framesMeta, checkpoint: fixture.checkpoint }));
                clearInterval(watch);
              }, 1500);
            }, 2000);
          }
        }, 100);
      }
    } } };
    const { context, page } = await openRoom(ROOM);
    // Wait for the nack to arrive at the fixture.
    const nacked = await (async () => {
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const record = connections.get(ROOM);
        if (record && record.nacks.length >= 1) return true;
        await sleep(200);
      }
      return false;
    })();
    check('B: corrupt checkpoint triggers checkpoint_nack', nacked === true);
    // At nack time the curtain must still be up and NO tail paint may have landed.
    const mid = await readLayers(page);
    check('B: join curtain NOT released on corrupt checkpoint', !!mid && mid.joinStep < 3, `joinStep=${mid && mid.joinStep}`);
    const blankProbe = await page.evaluate(() => {
      const dbg = window.__drawesomeCheckpoint;
      if (!dbg) return null;
      const layers = dbg.layers();
      if (!layers || !layers.length) return null;
      const data = layers[0].canvas.getContext('2d').getImageData(0, 0, layers[0].canvas.width, layers[0].canvas.height).data;
      for (let i = 3; i < data.length; i += 4013) { if (data[i] !== 0) return false; } // sampled alpha
      return true;
    });
    check('B: no tail-only paint over an empty canvas', blankProbe === true, `probe=${blankProbe}`);
    // Recovery: the full baseline replay lands and matches the reference.
    const recovered = await waitFor(page, async (fullHashes) => {
      const dbg = window.__drawesomeCheckpoint;
      if (!dbg || dbg.joinStep() < 3) return null;
      const layers = dbg.layers();
      if (!layers || layers.length < 3) return null;
      const hashes = [];
      for (const layer of layers.slice(0, 3)) {
        const data = layer.canvas.getContext('2d').getImageData(0, 0, layer.canvas.width, layer.canvas.height).data;
        const digest = await crypto.subtle.digest('SHA-256', data);
        hashes.push([...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''));
      }
      if (!hashes.every((h, i) => h === fullHashes[i])) return null;
      return { joinStep: dbg.joinStep() };
    }, fixture.fullHashes, 120000);
    check('B: full baseline after nack repaints to full-replay equality', !!recovered && recovered.joinStep >= 3);
    // The post-nack checkpoint retry settles without a second nack.
    await sleep(2500);
    const record = connections.get(ROOM);
    check('B: no infinite checkpoint retry (exactly one nack)', (record?.nacks.length || 0) === 1, `nacks=${record?.nacks.length}`);
    const settled = await readLayers(page);
    check('B: post-nack checkpoint ignored, pixels still full-replay equal', !!settled && settled.match.every(Boolean), JSON.stringify(settled && settled.match));
    const recordB = connections.get(ROOM);
    check('B: client advertised cp on this connection too', recordB?.query.cp === EXPECTED_FP);
    await context.close();
  }

  const failures = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failures.length}/${results.length} fixture realtime checks passed`);
  assert.equal(failures.length, 0, `${failures.length} failures: ${failures.map((f) => f.name).join(', ')}`);
} finally {
  plan = null;
  await browser?.close();
  for (const client of wss.clients) client.terminate();
  await Promise.race([new Promise((r) => wss.close(r)), sleep(2000)]);
  vite.stdout?.destroy();
  vite.stderr?.destroy();
  vite.kill('SIGKILL');
}
// Playwright's driver pipes can hold the event loop open after the browser is
// gone; the suite's work is done and verified above, so exit deterministically.
process.exit(0);
