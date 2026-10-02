import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Phase4 CLIENT module proof (no server integration claimed): animation
// checkpoint restore+tail (rasterizeOps checkpoint path), FLIPBOOK frame
// timing helpers, byte-budgeted bitmap LRU, freshMixState birth parity,
// post-nack tail-only detection, and the retained-tail local-op tolerance.
// Driven in a real browser against fixtures generated with the EXISTING
// renderer (replayFrameOnto + onMixState capture), the same interpreter the
// backend worker uses.
//
//   node scripts/room-loading-phase4-module-verify.mjs           # GREEN (work tree)
//   ROOT=<baseline> node scripts/room-loading-phase4-module-verify.mjs   # RED proof
const root = process.env.ROOT || fileURLToPath(new URL('../', import.meta.url));
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<title>Phase4 module test</title>'); return; }
  if (!/^\/src\/utils\/[A-Za-z0-9]+(?:\.js)?$/.test(url.pathname)) { res.writeHead(404).end(); return; }
  try { res.setHeader('Content-Type', 'text/javascript'); res.end(readFileSync(root + url.pathname.slice(1) + (url.pathname.endsWith('.js') ? '' : '.js'))); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(19135, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:19135');
  const result = await page.evaluate(async () => {
    const out = { checks: [], fail: (name, reason) => out.checks.push({ name, ok: false, reason }), pass: (name) => out.checks.push({ name, ok: true }) };
    let T, C, R, F, OP, L, M;
    try {
      T = await import('/src/utils/frameTiming.js');
      C = await import('/src/utils/checkpointClient.js');
      R = await import('/src/utils/frameRasters.js');
      F = await import('/src/utils/filmPlan.js');
      OP = await import('/src/utils/opReplay.js');
      L = await import('/src/utils/layers.js');
      M = await import('/src/utils/mixMap.js');
    } catch (err) {
      out.moduleMissing = String(err && err.message || err);
      return out;
    }
    for (const fn of ['normalizeFrameTiming', 'clampHoldWithTiming', 'holdStepsForTiming', 'holdStepIndexFor']) {
      if (typeof T[fn] !== 'function') { out.moduleMissing = `frameTiming.${fn} missing`; return out; }
    }
    for (const fn of ['freshMixState', 'checkpointTailOnlyFrame']) {
      if (typeof C[fn] !== 'function') { out.moduleMissing = `checkpointClient.${fn} missing`; return out; }
    }
    const W = L.CANVAS_WIDTH; const H = L.CANVAS_HEIGHT;
    globalThis.__CHECKPOINT_RENDERER_VERSION__ = 'cd'.repeat(32);
    const VER = 'cd'.repeat(32);

    // ---- frameTiming --------------------------------------------------------
    out.timingNormalize = (() => {
      const ok = T.normalizeFrameTiming({ minMs: 1000, maxMs: 3000, defaultMs: 1000 });
      const bad = [null, undefined, 'x', {}, { minMs: 1 }, { minMs: 3000, maxMs: 1000, defaultMs: 2000 }, { minMs: 'a', maxMs: 2, defaultMs: 2 }]
        .every((v) => T.normalizeFrameTiming(v) === null);
      return ok && ok.minMs === 1000 && ok.maxMs === 3000 && ok.defaultMs === 1000 && bad;
    })();
    out.timingClampDefault = T.normalizeFrameTiming({ minMs: 1000, maxMs: 3000, defaultMs: 400 })?.defaultMs === 1000;
    out.flipbookSteps = JSON.stringify(T.holdStepsForTiming({ minMs: 1000, maxMs: 3000, defaultMs: 1000 })) === JSON.stringify([1000, 1500, 2000, 3000]);
    out.privateStepsUnchanged = JSON.stringify(T.holdStepsForTiming(null)) === JSON.stringify(F.HOLD_STEPS);
    out.timingClamp = (() => {
      const ft = { minMs: 1000, maxMs: 3000, defaultMs: 1000 };
      return T.clampHoldWithTiming(40, ft) === 1000
        && T.clampHoldWithTiming(99000, ft) === 3000
        && T.clampHoldWithTiming(1500, ft) === 1500
        && T.clampHoldWithTiming('junk', ft) === 1000
        && T.clampHoldWithTiming(40, null) === 40
        && T.clampHoldWithTiming(99999, null) === 10000;
    })();
    out.timingEndpointsOnly = (() => {
      const steps = T.holdStepsForTiming({ minMs: 110, maxMs: 115, defaultMs: 110 }); // no existing step inside
      return steps.length === 2 && steps[0] === 110 && steps[1] === 115;
    })();
    out.timingIndex = (() => {
      const steps = [1000, 1500, 2000, 3000];
      return T.holdStepIndexFor(1600, steps) === 1 && T.holdStepIndexFor(2900, steps) === 3 && T.holdStepIndexFor(10, steps) === 0;
    })();

    // ---- freshMixState / birth parity ----------------------------------------
    out.freshMix = (() => {
      const state = C.freshMixState();
      const map = M.createMixMap(() => null, W, H);
      try { map.restoreState(state); } catch (err) { return `restore threw: ${err.message}`; }
      const birth = M.createMixMap(() => null, W, H).captureState();
      return state.version === 1 && state.width === birth.width && state.height === birth.height
        && state.data.length === birth.data.length && state.data.every((v) => v === 0)
        && JSON.stringify(state.dirty) === JSON.stringify(birth.dirty)
        && state.prefetched === null && map.sample(100, 100) === null;
    })();

    // ---- checkpointTailOnlyFrame ----------------------------------------------
    out.tailOnlyDetect = (() => {
      const cp = { frames: [{ frameId: 'f0', throughOpId: 4 }, { frameId: 'f1', throughOpId: 2 }, { frameId: 'f2', throughOpId: 0 }] };
      const full = [{ opId: 1, frameId: 'f0' }, { opId: 5, frameId: 'f0' }, { opId: 2, frameId: 'f1' }, { opId: 7, frameId: 'f1' }];
      const tailOnlyF1 = [{ opId: 1, frameId: 'f0' }, { opId: 5, frameId: 'f0' }, { opId: 3, frameId: 'f1' }];
      const noneForF0 = [{ opId: 9, frameId: 'f0' }];
      const untagged = [{ opId: 1 }, { opId: 6 }];
      return C.checkpointTailOnlyFrame(cp, full) === null
        && C.checkpointTailOnlyFrame(cp, tailOnlyF1) === 'f1'
        && C.checkpointTailOnlyFrame(cp, noneForF0) === 'f0'
        && C.checkpointTailOnlyFrame({ frames: [{ frameId: 'f0', throughOpId: 3 }] }, untagged, 'f0') === null
        && C.checkpointTailOnlyFrame(null, full) === null
        && C.checkpointTailOnlyFrame({ frames: [{ frameId: 'f0', throughOpId: 0 }] }, []) === null;
    })();

    // ---- bitmap LRU byte budget -------------------------------------------------
    out.lruBytes = (() => {
      const cache = R.createBitmapCache(100, 1000); // 1000 bytes
      const closed = [];
      const fake = (w, h) => ({ width: w, height: h, close() { closed.push(`${w}x${h}`); } });
      cache.set('a', fake(10, 10)); // 400B
      cache.set('b', fake(10, 10)); // 400B (800 total)
      cache.set('c', fake(10, 10)); // 400B -> over budget, evict 'a'
      const afterEvict = !cache.has('a') && cache.has('b') && cache.has('c') && cache.bytes === 800 && closed.length === 1;
      cache.get('b'); // bump b to most-recent
      cache.set('d', fake(5, 10)); // 200B -> total 1000, no eviction
      const noEvictAtCap = cache.has('b') && cache.has('c') && cache.has('d') && cache.bytes === 1000;
      cache.set('e', fake(10, 10)); // 400B -> 1400 over: evict oldest (c), 1000
      const secondEvict = !cache.has('c') && cache.has('b') && cache.has('d') && cache.has('e');
      cache.clear();
      const cleared = cache.bytes === 0 && !cache.has('b');
      return afterEvict && noEvictAtCap && secondEvict && cleared;
    })();
    out.lruCount = (() => {
      const cache = R.createBitmapCache(2, Number.POSITIVE_INFINITY);
      const fake = () => ({ width: 1, height: 1, close() {} });
      cache.set('a', fake()); cache.set('b', fake()); cache.set('c', fake());
      return !cache.has('a') && cache.has('b') && cache.has('c');
    })();

    // ---- animation checkpoint fixtures (2 frames, subset of a 3-frame scene) ----
    const pts = (x0, y0, x1, y1, n) => Array.from({ length: n }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / (n - 1), y: y0 + ((y1 - y0) * i) / (n - 1), pressure: 0.5 }));
    const layersMeta = [
      { id: 'layer-a', name: 'A', visible: true, opacity: 1 },
      { id: 'layer-b', name: 'B', visible: false, opacity: 0.6 }, // hidden with real pixels
    ];
    const layerIds = layersMeta.map((l) => l.id);
    const stroke = (id, settings, points, layerId) => {
      const half = Math.ceil(points.length / 2);
      return [
        { kind: 'draw', strokeId: id, settings, points: points.slice(0, half), layerId },
        { kind: 'draw', strokeId: id, points: points.slice(half), end: true, layerId },
      ];
    };
    // Frame f0: wet oil over marker on layer-a + marker on hidden layer-b.
    const opsF0 = [
      ...stroke('f0m1', { brush: 'marker', color: '#d42040', size: 60, opacity: 0.9, variation: 0.08, seed: 101 }, pts(200, 300, 900, 700, 30), 'layer-a'),
      ...stroke('f0o1', { brush: 'oil', color: '#2040c0', size: 90, opacity: 1, variation: 0.1, seed: 102, v: 2, wet: true }, pts(250, 400, 950, 800, 30), 'layer-a'),
      ...stroke('f0m2', { brush: 'marker', color: '#8020c0', size: 40, opacity: 1, variation: 0.02, seed: 103 }, pts(1600, 1400, 2400, 1800, 20), 'layer-b'),
      ...stroke('f0e1', { brush: 'eraser', size: 80, seed: 104 }, pts(300, 350, 700, 650, 20), 'layer-a'),
    ];
    // Frame f1: acrylic + eraser on layer-a.
    const opsF1 = [
      ...stroke('f1a1', { brush: 'acrylic', color: '#20a060', size: 50, opacity: 0.8, variation: 0.05, seed: 105, v: 2, wet: true }, pts(600, 300, 1400, 900, 30), 'layer-a'),
      ...stroke('f1e1', { brush: 'eraser', size: 70, seed: 106 }, pts(800, 400, 1200, 800, 20), 'layer-a'),
    ];
    let opId = 0;
    for (const op of opsF0) { op.frameId = 'f0'; op.opId = ++opId; }
    for (const op of opsF1) { op.frameId = 'f1'; op.opId = ++opId; }
    const SPLIT = 2; // complete-stroke boundary: first stroke of each frame is the prefix
    const prefixF0 = opsF0.slice(0, SPLIT); const tailF0 = opsF0.slice(SPLIT);
    const prefixF1 = opsF1.slice(0, SPLIT); const tailF1 = opsF1.slice(SPLIT);

    const rgbaOf = (canvas) => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const replayOntoLayers = async (list, bases, mixState) => {
      const canvases = bases || layerIds.map(() => L.createLayerCanvas(W, H));
      const contexts = canvases.map((c) => c.getContext('2d'));
      const targetFor = (op) => contexts[Math.max(0, layerIds.indexOf(op.layerId))];
      let captured = null;
      await OP.replayFrameOnto(canvases[0], list, W, H, targetFor, { preservePixels: !!bases, mixState, onMixState: (s) => { captured = s; } });
      return { canvases, mixState: captured };
    };
    const makeDescriptor = async (frameId, prefixOps, throughOpId) => {
      const prefix = await replayOntoLayers(prefixOps);
      const layers = [];
      for (let i = 0; i < prefix.canvases.length; i += 1) {
        const pngBase64 = prefix.canvases[i].toDataURL('image/png').split(',')[1];
        const pngBytes = C.base64ToBytes(pngBase64, 32 * 1024 * 1024);
        layers.push({
          id: layerIds[i], pngBase64,
          pngSha256: await C.sha256Hex(pngBytes),
          rgbaSha256: await C.sha256Hex(rgbaOf(prefix.canvases[i])),
        });
      }
      return {
        frameId, throughOpId,
        layersKey: (await import('/src/utils/checkpointFormat.js')).checkpointLayersKey(layersMeta),
        layers,
        mixState: {
          version: 1, width: prefix.mixState.width, height: prefix.mixState.height,
          pixelsBase64: C.bytesToBase64(new Uint8Array(prefix.mixState.data.buffer, 0, prefix.mixState.data.length)),
          dirty: prefix.mixState.dirty, prefetched: prefix.mixState.prefetched,
        },
      };
    };
    const descF0 = await makeDescriptor('f0', prefixF0, prefixF0[prefixF0.length - 1].opId);
    const descF1 = await makeDescriptor('f1', prefixF1, prefixF1[prefixF1.length - 1].opId);
    const framesMeta = [
      { id: 'f0', durationMs: 120, layers: layersMeta },
      { id: 'f1', durationMs: 120, layers: layersMeta },
      { id: 'f2', durationMs: 120, layers: layersMeta }, // NOT checkpointed (subset)
    ];

    // ---- subset envelope decode -------------------------------------------------
    {
      let decoded = null; let err = null;
      try {
        decoded = await C.decodeCheckpoint(
          { schemaVersion: 1, rendererVersion: VER, frames: [descF0, descF1] },
          { rendererVersion: VER, expectedFrames: framesMeta, tailOps: [...tailF0, ...tailF1] },
        );
      } catch (e) { err = e; }
      out.subsetDecode = !!decoded && decoded.frames.length === 2 && !err;
      if (decoded) {
        // Per-frame install + tail === full replay (the animation hydrate path).
        const parity = [];
        const blankHash = await C.sha256Hex(rgbaOf(L.createLayerCanvas(W, H)));
        let hiddenHasPixels = false;
        for (const [fullOps, tailOps, index] of [[opsF0, tailF0, 0], [opsF1, tailF1, 1]]) {
          const liveLayers = layersMeta.map((m) => ({ ...m, canvas: L.createLayerCanvas(W, H) }));
          C.installCheckpointLayers(decoded.frames[index], liveLayers);
          const contexts = liveLayers.map((l) => l.canvas.getContext('2d'));
          const targetFor = (op) => contexts[Math.max(0, layerIds.indexOf(op.layerId))];
          await OP.replayFrameOnto(liveLayers[0].canvas, tailOps, W, H, targetFor, { preservePixels: true, mixState: decoded.frames[index].mixState });
          const full = await replayOntoLayers(fullOps);
          const a = await C.sha256Hex(rgbaOf(liveLayers[0].canvas));
          const b = await C.sha256Hex(rgbaOf(full.canvases[0]));
          const hiddenA = await C.sha256Hex(rgbaOf(liveLayers[1].canvas));
          const hiddenB = await C.sha256Hex(rgbaOf(full.canvases[1]));
          parity.push(a === b && hiddenA === hiddenB);
          if (hiddenA !== blankHash) hiddenHasPixels = true; // f0's hidden layer carries its marker ink
        }
        out.subsetParity = parity.every(Boolean);
        out.hiddenIntact = hiddenHasPixels;
        C.releaseCheckpoint(decoded);
      } else {
        out.subsetParity = `decode error: ${err && err.reason} ${err && err.message}`;
        out.hiddenIntact = out.subsetParity;
      }
    }

    // ---- total byte budget ---------------------------------------------------------
    {
      let reason = null;
      try {
        await C.decodeCheckpoint(
          { schemaVersion: 1, rendererVersion: VER, frames: [descF0, descF1] },
          { rendererVersion: VER, expectedFrames: framesMeta, tailOps: [...tailF0, ...tailF1], limits: { maxTotalBytes: descF0.layers[0].pngBase64.length } },
        );
      } catch (e) { reason = e && e.reason; }
      out.totalBound = reason === 'bounds' ? true : `reason=${reason}`;
    }

    // ---- tailLocalOps tolerance (retained-tail path) --------------------------------
    {
      const localTail = [...tailF0, { kind: 'draw', strokeId: 'local1', settings: { brush: 'marker', color: '#000000', size: 20, seed: 1 }, points: pts(50, 50, 60, 60, 2), layerId: 'layer-a' }]; // no opId
      let strictReason = null;
      try {
        await C.decodeCheckpoint({ schemaVersion: 1, rendererVersion: VER, frames: [descF0] }, { rendererVersion: VER, expectedFrames: framesMeta, tailOps: localTail });
      } catch (e) { strictReason = e && e.reason; }
      let liveOk = false;
      try {
        const d = await C.decodeCheckpoint({ schemaVersion: 1, rendererVersion: VER, frames: [descF0] }, { rendererVersion: VER, expectedFrames: framesMeta, tailOps: localTail, tailLocalOps: true });
        liveOk = !!d; C.releaseCheckpoint(d);
      } catch { /* rejected */ }
      out.tailLocalOps = strictReason === 'tail' && liveOk;
    }

    // ---- rasterizeOps: checkpoint restore == full replay raster ---------------------
    out.rasterCheckpointParity = await (async () => {
      if (typeof R.rasterizeOps !== 'function') return 'rasterizeOps missing';
      const blobHash = async (blob) => C.sha256Hex(new Uint8Array(await blob.arrayBuffer()));
      try {
        // Same renderer version as the descriptors; rasters of IDENTICAL pixels
        // encode to identical bytes (same browser, same encoder settings).
        const fullA = await R.rasterizeOps(opsF0, layersMeta);
        const cpA = await R.rasterizeOps(tailF0, layersMeta, descF0, { rendererVersion: VER });
        const fullB = await R.rasterizeOps(opsF1, layersMeta);
        const cpB = await R.rasterizeOps(tailF1, layersMeta, descF1, { rendererVersion: VER });
        return (await blobHash(fullA)) === (await blobHash(cpA)) && (await blobHash(fullB)) === (await blobHash(cpB));
      } catch (err) {
        return `error: ${err && err.message || err}`;
      }
    })();

    // ---- rasterizeOps: corrupt descriptor rejects (no bare-tail raster) -------------
    out.rasterCheckpointCorrupt = await (async () => {
      const bad = JSON.parse(JSON.stringify(descF0));
      bad.layers[0].rgbaSha256 = '00'.repeat(32);
      try {
        await R.rasterizeOps(tailF0, layersMeta, bad, { rendererVersion: VER });
        return 'did not reject';
      } catch (err) {
        return err && err.name === 'CheckpointError' && err.reason === 'hash';
      }
    })();

    // ---- rasterizeOps: concurrent callers serialize on the shared world canvas -----
    out.rasterSerialized = await (async () => {
      try {
        const [a, b] = await Promise.all([R.rasterizeOps(opsF0, layersMeta), R.rasterizeOps(opsF1, layersMeta)]);
        return !!a && !!b;
      } catch { return false; }
    })();

    // ---- decode cancellation stays clean on the animation path ----------------------
    {
      let calls = 0; let reason = null;
      try {
        const d = await C.decodeCheckpoint(
          { schemaVersion: 1, rendererVersion: VER, frames: [descF0, descF1] },
          { rendererVersion: VER, expectedFrames: framesMeta, tailOps: [...tailF0, ...tailF1], isCancelled: () => { calls += 1; return calls > 3; } },
        );
        C.releaseCheckpoint(d);
      } catch (e) { reason = e && e.reason; }
      out.animCancel = reason === 'canceled';
    }
    return out;
  });

  const failures = [];
  const check = (name, cond, detail) => { if (cond) { console.log(`PASS ${name}`); } else { failures.push(name); console.log(`FAIL ${name}${detail ? `, ${detail}` : ''}`); } };
  assert.ok(!result.moduleMissing, `phase4 modules missing/incompatible: ${result.moduleMissing}`);

  check('frameTiming: validates wire shape', result.timingNormalize === true, JSON.stringify(result.timingNormalize));
  check('frameTiming: default clamps into bounds', result.timingClampDefault === true);
  check('frameTiming: FLIPBOOK steps are 1000/1500/2000/3000', result.flipbookSteps === true, JSON.stringify(result.flipbookSteps));
  check('frameTiming: private/local steps unchanged', result.privateStepsUnchanged === true);
  check('frameTiming: clamp honors bounds + defaults', result.timingClamp === true, JSON.stringify(result.timingClamp));
  check('frameTiming: sub-step range still offers endpoints', result.timingEndpointsOnly === true);
  check('frameTiming: nearest index within filtered steps', result.timingIndex === true);
  check('freshMixState: restore accepted, equals map birth state', result.freshMix === true, JSON.stringify(result.freshMix));
  check('tail-only detector: covered/refused/fallback/edge cases', result.tailOnlyDetect === true, JSON.stringify(result.tailOnlyDetect));
  check('bitmap LRU: byte budget evicts oldest + closes', result.lruBytes === true, JSON.stringify(result.lruBytes));
  check('bitmap LRU: count cap still enforced', result.lruCount === true);
  check('animation checkpoint: subset envelope decodes', result.subsetDecode === true, JSON.stringify(result.subsetDecode));
  check('animation checkpoint: per-frame install+tail byte-equals full replay (incl. hidden layer)', result.subsetParity === true, JSON.stringify(result.subsetParity));
  check('animation checkpoint: hidden layer keeps real pixels', result.hiddenIntact === true, JSON.stringify(result.hiddenIntact));
  check('decode: whole-envelope byte budget enforced', result.totalBound === true, JSON.stringify(result.totalBound));
  check('decode: retained tail tolerates local ops only with tailLocalOps', result.tailLocalOps === true, JSON.stringify(result.tailLocalOps));
  check('rasterizeOps: checkpoint+tail raster identical to full-replay raster', result.rasterCheckpointParity === true, JSON.stringify(result.rasterCheckpointParity));
  check('rasterizeOps: corrupt descriptor rejects with CheckpointError', result.rasterCheckpointCorrupt === true, JSON.stringify(result.rasterCheckpointCorrupt));
  check('rasterizeOps: concurrent callers serialize safely', result.rasterSerialized === true, JSON.stringify(result.rasterSerialized));
  check('decode: multi-frame cancellation rejects canceled', result.animCancel === true, JSON.stringify(result.animCancel));

  assert.equal(failures.length, 0, `${failures.length} failures: ${failures.join(', ')}`);
  console.log('ALL room-loading-phase4 module checks passed');
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
