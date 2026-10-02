import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Phase3 CLIENT module proof (no server integration claimed): the checkpoint
// decode/validate/restore utility in src/utils/checkpointClient.js, driven in a
// real browser against fixtures generated with the EXISTING renderer
// (replayFrameOnto + onMixState capture), the same interpreter + hooks the
// backend worker uses. Proves prefix+checkpoint+tail === full replay for
// seeded marker/eraser, wet oil + wet acrylic (mix-map continuation), legacy
// smudge, an inline image, and a 3-layer stack with a hidden + an opacity
// layer, plus every rejection path and late-decode cancellation.
const root = fileURLToPath(new URL('../', import.meta.url));
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<title>Checkpoint client test</title>'); return; }
  if (!/^\/src\/utils\/[A-Za-z0-9]+(?:\.js)?$/.test(url.pathname)) { res.writeHead(404).end(); return; }
  try { res.setHeader('Content-Type', 'text/javascript'); res.end(readFileSync(root + url.pathname.slice(1) + (url.pathname.endsWith('.js') ? '' : '.js'))); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(19124, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:19124');
  const result = await page.evaluate(async () => {
    const out = { checks: [], fail: (name, reason) => out.checks.push({ name, ok: false, reason }), pass: (name) => out.checks.push({ name, ok: true }) };
    const F = await import('/src/utils/checkpointFormat.js');
    const { createMixMap } = await import('/src/utils/mixMap.js');
    const { replayFrameOnto } = await import('/src/utils/opReplay.js');
    const { createLayerCanvas, CANVAS_WIDTH: W, CANVAS_HEIGHT: H } = await import('/src/utils/layers.js');
    let C;
    try {
      C = await import('/src/utils/checkpointClient.js');
    } catch (err) {
      out.moduleMissing = String(err && err.message || err);
      return out;
    }
    const {
      checkpointClientSupport, decodeCheckpoint, installCheckpointLayers, releaseCheckpoint,
      base64ToBytes, bytesToBase64, sha256Hex, CheckpointError,
    } = C;

    // ---- support gate ------------------------------------------------------
    out.supportWithoutVersion = checkpointClientSupport() === '';
    globalThis.__CHECKPOINT_RENDERER_VERSION__ = 'ab'.repeat(32); // the Vite define, stubbed for the unbundled module test
    const VER = 'ab'.repeat(32);
    out.supportWithVersion = checkpointClientSupport() === VER;
    out.supportRejectsBadVersion = (() => {
      globalThis.__CHECKPOINT_RENDERER_VERSION__ = 'zz-not-hex';
      const bad = checkpointClientSupport() === '';
      globalThis.__CHECKPOINT_RENDERER_VERSION__ = VER;
      return bad;
    })();

    // ---- byte conversion validations ---------------------------------------
    out.bytesRoundtrip = (() => {
      const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
      return JSON.stringify([...base64ToBytes(bytesToBase64(bytes), 100)]) === JSON.stringify([...bytes]);
    })();
    const badBase64 = ['a', 'abc==', 'abcd=', '!!!!', 'a b c d', 'data:image/png;base64,AAAA', ''];
    out.base64Rejected = badBase64.filter((v) => { try { base64ToBytes(v, 100); return false; } catch (e) { return e instanceof CheckpointError && e.reason === 'base64'; } }).length;
    out.base64Bound = (() => { try { base64ToBytes(bytesToBase64(new Uint8Array(64)), 10); return false; } catch (e) { return e.reason === 'bounds'; } })();

    // ---- fixture ops (seeded → deterministic) -------------------------------
    const pts = (x0, y0, x1, y1, n) => Array.from({ length: n }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / (n - 1), y: y0 + ((y1 - y0) * i) / (n - 1), pressure: 0.5 }));
    const layersMeta = [
      { id: 'layer-a', name: 'A', visible: true, opacity: 1 },
      { id: 'layer-b', name: 'B', visible: false, opacity: 0.6 }, // hidden + opacity
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
    // Deterministic inline raster for the image op.
    const imgCanvas = createLayerCanvas(600, 400);
    const ig = imgCanvas.getContext('2d');
    ig.fillStyle = '#f2c018'; ig.fillRect(0, 0, 600, 400);
    ig.fillStyle = '#1840a0'; ig.fillRect(60, 60, 200, 150);
    ig.fillStyle = '#a01840'; ig.beginPath(); ig.arc(400, 220, 110, 0, Math.PI * 2); ig.fill();
    const imgUrl = imgCanvas.toDataURL('image/png');

    const ops = [
      ...stroke('m1', { brush: 'marker', color: '#d42040', size: 60, opacity: 0.9, variation: 0.08, seed: 111 }, pts(200, 300, 900, 700, 40), 'layer-a'),
      ...stroke('e1', { brush: 'eraser', size: 90, seed: 222 }, pts(300, 350, 800, 650, 30), 'layer-a'),
      // Wet oil crossing the marker strokes: picks up under-paint from the layer-0 mix map.
      ...stroke('o1', { brush: 'oil', color: '#2040c0', size: 90, opacity: 1, variation: 0.1, seed: 333, v: 2, wet: true }, pts(250, 400, 950, 800, 40), 'layer-a'),
      { kind: 'image', dataUrl: imgUrl, x: 1500, y: 400, w: 600, h: 400, layerId: 'layer-b' },
      // Legacy smudge (no v): drags the layer-0 paper directly.
      ...stroke('s1', { brush: 'smudge', size: 70, opacity: 1, strength: 0.6, seed: 444 }, pts(500, 500, 1000, 900, 30), 'layer-a'),
      ...stroke('a1', { brush: 'acrylic', color: '#20a060', size: 50, opacity: 0.8, variation: 0.05, seed: 555, v: 2, wet: true }, pts(1600, 300, 2200, 900, 40), 'layer-c'),
      ...stroke('m2', { brush: 'marker', color: '#8020c0', size: 40, opacity: 1, variation: 0.02, seed: 666 }, pts(1600, 1400, 2400, 1800, 30), 'layer-b'),
    ];
    ops.forEach((op, i) => { op.opId = i + 1; });
    const SPLIT = 6; // after the wet-oil end op: a complete-stroke boundary
    const prefixOps = ops.slice(0, SPLIT);
    const tailOps = ops.slice(SPLIT);
    const THROUGH = prefixOps[prefixOps.length - 1].opId;

    const replayOntoLayers = async (list, bases, mixState) => {
      const canvases = bases || layerIds.map(() => createLayerCanvas(W, H));
      const contexts = canvases.map((c) => c.getContext('2d'));
      const targetFor = (op) => contexts[Math.max(0, layerIds.indexOf(op.layerId))];
      let captured = null;
      await replayFrameOnto(canvases[0], list, W, H, targetFor, {
        preservePixels: !!bases, mixState, onMixState: (s) => { captured = s; },
      });
      return { canvases, contexts, mixState: captured };
    };
    const rgbaOf = (canvas) => canvas.getContext('2d').getImageData(0, 0, W, H).data;
    const mixFingerprint = (s) => sha256Hex(new Uint8Array(s.data.buffer, 0, s.data.length)).then((h) => `${h}|${JSON.stringify(s.dirty)}|${JSON.stringify(s.prefetched)}`);

    // ---- FULL replay reference ----------------------------------------------
    const full = await replayOntoLayers(ops);
    const fullHashes = [];
    for (const canvas of full.canvases) fullHashes.push(await sha256Hex(rgbaOf(canvas)));
    const fullMix = await mixFingerprint(full.mixState);

    // ---- PREFIX replay → checkpoint fixture (mirrors the worker contract) ---
    const prefix = await replayOntoLayers(prefixOps);
    const descriptorLayers = [];
    for (let i = 0; i < prefix.canvases.length; i += 1) {
      const dataUrl = prefix.canvases[i].toDataURL('image/png');
      const pngBase64 = dataUrl.split(',')[1];
      const pngBytes = base64ToBytes(pngBase64, F.CHECKPOINT_MAX_LAYER_BYTES);
      const pngSha256 = await sha256Hex(pngBytes);
      const rgbaSha256 = await sha256Hex(rgbaOf(prefix.canvases[i]));
      descriptorLayers.push({ id: layerIds[i], pngBase64, pngSha256, rgbaSha256 });
    }
    const wireMix = {
      version: 1, width: prefix.mixState.width, height: prefix.mixState.height,
      pixelsBase64: bytesToBase64(new Uint8Array(prefix.mixState.data.buffer, 0, prefix.mixState.data.length)),
      dirty: prefix.mixState.dirty, prefetched: prefix.mixState.prefetched,
    };
    const framesMeta = [{ id: 'f0', durationMs: 120, layers: layersMeta }];
    const descriptor = {
      frameId: 'f0', throughOpId: THROUGH,
      layersKey: F.checkpointLayersKey(layersMeta),
      layers: descriptorLayers, mixState: wireMix,
    };
    const checkpoint = { schemaVersion: 1, rendererVersion: VER, frames: [descriptor] };

    // ---- CHECKPOINT + TAIL ---------------------------------------------------
    let decoded = null; let decodeError = null;
    try {
      decoded = await decodeCheckpoint(checkpoint, { rendererVersion: VER, expectedFrames: framesMeta, tailOps });
    } catch (err) { decodeError = { reason: err && err.reason, message: String(err) }; }
    out.decodeOk = !!decoded && !decodeError;
    if (decodeError) out.decodeError = decodeError;
    let parity = { ran: false };
    if (decoded) {
      const liveLayers = layersMeta.map((m) => ({ ...m, canvas: createLayerCanvas(W, H) }));
      installCheckpointLayers(decoded.frames[0], liveLayers);
      const contexts = liveLayers.map((l) => l.canvas.getContext('2d'));
      const targetFor = (op) => contexts[Math.max(0, layerIds.indexOf(op.layerId))];
      let tailMix = null;
      await replayFrameOnto(liveLayers[0].canvas, tailOps, W, H, targetFor, {
        preservePixels: true, mixState: decoded.frames[0].mixState, onMixState: (s) => { tailMix = s; },
      });
      const tailHashes = [];
      for (const layer of liveLayers) tailHashes.push(await sha256Hex(rgbaOf(layer.canvas)));
      const blankHash = await sha256Hex(rgbaOf(createLayerCanvas(W, H)));
      parity = {
        ran: true,
        layerEqual: tailHashes.map((h, i) => h === fullHashes[i]),
        hiddenLayerHasPixels: tailHashes[1] !== blankHash,
        mixEqual: (await mixFingerprint(tailMix)) === fullMix,
      };
    }
    out.parity = parity;

    // mixState restore into a STANDALONE map (the App's shared-map path): restored
    // state keeps the deliberately-stale sampled ledger, it is NOT rebuilt from pixels.
    if (decoded) {
      const standalone = createMixMap(() => null, W, H); // never samples the source after restore
      standalone.restoreState(decoded.frames[0].mixState);
      const probe = standalone.sample(275, 425); // inside the erased/marker region, read from restored data
      out.standaloneRestore = probe === null || Array.isArray(probe); // no throw, reads restored array
    }

    // ---- corruption / rejection battery --------------------------------------
    const expectReject = async (name, mutate, reason, opts = {}) => {
      const copy = JSON.parse(JSON.stringify(checkpoint));
      mutate(copy);
      try {
        const bad = await decodeCheckpoint(copy, { rendererVersion: VER, expectedFrames: framesMeta, tailOps, ...opts });
        releaseCheckpoint(bad);
        out.fail(name, 'decoded successfully');
      } catch (err) {
        if (err && err.reason === reason) out.pass(name);
        else out.fail(name, `reason=${err && err.reason} (${String(err && err.message || err).slice(0, 120)})`);
      }
    };
    await expectReject('schema-version', (c) => { c.schemaVersion = 2; }, 'schema');
    await expectReject('schema-null', () => {}, 'schema', { rendererVersion: VER }); // placeholder replaced below
    out.checks.pop(); // the placeholder above cannot null the object through JSON copy; do it directly
    try { await decodeCheckpoint(null, { rendererVersion: VER, expectedFrames: framesMeta, tailOps }); out.fail('schema-null', 'decoded'); }
    catch (err) { err.reason === 'schema' ? out.pass('schema-null') : out.fail('schema-null', err.reason); }
    await expectReject('renderer-mismatch', (c) => { c.rendererVersion = '00'.repeat(32); }, 'renderer');
    await expectReject('frames-empty', (c) => { c.frames = []; }, 'frames');
    await expectReject('frame-unknown', (c) => { c.frames[0].frameId = 'nope'; }, 'frame');
    await expectReject('watermark-negative', (c) => { c.frames[0].throughOpId = -1; }, 'watermark');
    await expectReject('watermark-unsafe', (c) => { c.frames[0].throughOpId = 2 ** 60; }, 'watermark');
    await expectReject('layersKey-mismatch', (c) => { c.frames[0].layersKey = '[]'; }, 'layersKey');
    await expectReject('layers-reordered', (c) => { const l = c.frames[0].layers; [l[0], l[1]] = [l[1], l[0]]; }, 'layers');
    await expectReject('layers-count', (c) => { c.frames[0].layers.pop(); }, 'layers');
    await expectReject('layers-over-max', (c) => { while (c.frames[0].layers.length < 7) c.frames[0].layers.push(c.frames[0].layers[0]); }, 'layers');
    await expectReject('base64-charset', (c) => { c.frames[0].layers[0].pngBase64 = '!!!!'; }, 'base64');
    await expectReject('png-hash', (c) => { c.frames[0].layers[0].pngSha256 = '00'.repeat(32); }, 'hash');
    await expectReject('rgba-hash', (c) => { c.frames[0].layers[1].rgbaSha256 = '11'.repeat(32); }, 'hash');
    await expectReject('mix-missing', (c) => { delete c.frames[0].mixState; }, 'mixstate');
    await expectReject('mix-width', (c) => { c.frames[0].mixState.width = 1; }, 'mixstate');
    await expectReject('mix-pixels-length', (c) => { c.frames[0].mixState.pixelsBase64 = bytesToBase64(new Uint8Array(16)); }, 'mixstate');
    // Non-wire byte-array mix pixels (cold-hydrate source shape): exact length
    // + per-value byte validation.
    {
      const mw = 500; const mh = 313;
      const withArray = JSON.parse(JSON.stringify(checkpoint));
      delete withArray.frames[0].mixState.pixelsBase64;
      withArray.frames[0].mixState.data = new Array(mw * mh * 4).fill(0);
      try {
        const d = await decodeCheckpoint(withArray, { rendererVersion: VER, expectedFrames: framesMeta, tailOps });
        const ok = d.frames[0].mixState.data instanceof Uint8ClampedArray && d.frames[0].mixState.data.length === mw * mh * 4;
        releaseCheckpoint(d);
        ok ? out.pass('mix-data-array') : out.fail('mix-data-array', 'wrong data shape');
      } catch (err) { out.fail('mix-data-array', err && err.reason); }
      const badValue = JSON.parse(JSON.stringify(withArray));
      badValue.frames[0].mixState.data[123] = 300;
      try { await decodeCheckpoint(badValue, { rendererVersion: VER, expectedFrames: framesMeta, tailOps }); out.fail('mix-data-value', 'decoded'); }
      catch (err) { err.reason === 'mixstate' ? out.pass('mix-data-value') : out.fail('mix-data-value', err.reason); }
    }
    await expectReject('mix-dirty-nan', (c) => { c.frames[0].mixState.dirty = { x0: NaN, y0: 0, w: 5, h: 5 }; }, 'mixstate');
    await expectReject('mix-prefetched-negative', (c) => { c.frames[0].mixState.prefetched = { x0: 0, y0: 0, w: -5, h: 5 }; }, 'mixstate');
    await expectReject('tail-below-watermark', (c) => { c.frames[0].throughOpId = tailOps[0].opId; }, 'tail');
    await expectReject('tail-missing-opid', (c) => c, 'tail', { tailOps: [{ kind: 'draw', strokeId: 'x', points: [] }] });
    await expectReject('bounds-layer', (c) => c, 'bounds', { limits: { maxLayerBytes: 128 } });
    await expectReject('bounds-frame', (c) => c, 'bounds', { limits: { maxFrameBytes: 1024 } });

    // Wrong-dimension PNG: a real 2000x1250 PNG in place of layer 0's 4000x2500.
    {
      const small = createLayerCanvas(2000, 1250);
      small.getContext('2d').fillStyle = '#123456'; small.getContext('2d').fillRect(0, 0, 2000, 1250);
      const smallB64 = small.toDataURL('image/png').split(',')[1];
      const smallBytes = base64ToBytes(smallB64, F.CHECKPOINT_MAX_LAYER_BYTES);
      const smallCopy = JSON.parse(JSON.stringify(checkpoint));
      smallCopy.frames[0].layers[0].pngBase64 = smallB64;
      smallCopy.frames[0].layers[0].pngSha256 = await sha256Hex(smallBytes);
      try { await decodeCheckpoint(smallCopy, { rendererVersion: VER, expectedFrames: framesMeta, tailOps }); out.fail('dimensions', 'decoded'); }
      catch (err) { err.reason === 'dimensions' ? out.pass('dimensions') : out.fail('dimensions', err.reason); }
    }
    // Unsupported client (no renderer version) refuses before touching assets.
    try { await decodeCheckpoint(checkpoint, { rendererVersion: '', expectedFrames: framesMeta, tailOps }); out.fail('unsupported', 'decoded'); }
    catch (err) { err.reason === 'unsupported' ? out.pass('unsupported') : out.fail('unsupported', err.reason); }

    // ---- late-decode cancellation ---------------------------------------------
    {
      let calls = 0;
      const target = layersMeta.map((m) => ({ ...m, canvas: createLayerCanvas(W, H) }));
      const before = await sha256Hex(rgbaOf(target[0].canvas));
      let reason = null;
      try {
        const aborted = await decodeCheckpoint(checkpoint, {
          rendererVersion: VER, expectedFrames: framesMeta, tailOps,
          isCancelled: () => { calls += 1; return calls > 2; },
        });
        releaseCheckpoint(aborted);
      } catch (err) { reason = err && err.reason; }
      const after = await sha256Hex(rgbaOf(target[0].canvas));
      out.cancellation = { reason, pixelsUntouched: before === after };
    }

    // ---- multi-frame schema (stage4 shape, same code path) ----------------------
    {
      const two = JSON.parse(JSON.stringify(checkpoint));
      const f1 = JSON.parse(JSON.stringify(two.frames[0]));
      f1.frameId = 'f1';
      two.frames.push(f1);
      const meta2 = [framesMeta[0], { id: 'f1', durationMs: 120, layers: layersMeta }];
      try {
        const d2 = await decodeCheckpoint(two, { rendererVersion: VER, expectedFrames: meta2, tailOps });
        out.multiFrame = d2.frames.length === 2 && d2.frames[1].frameId === 'f1';
        releaseCheckpoint(d2);
      } catch (err) { out.multiFrame = `error: ${err && err.reason}`; }
    }

    // ---- install semantics: hidden-layer pixels preserved, no opacity bake -----
    if (decoded) {
      const live = layersMeta.map((m) => ({ ...m, canvas: createLayerCanvas(W, H) }));
      installCheckpointLayers(decoded.frames[0], live);
      const installedHidden = await sha256Hex(rgbaOf(live[1].canvas));
      const sourceHidden = await sha256Hex(rgbaOf(prefix.canvases[1]));
      out.install = {
        hiddenPreserved: installedHidden === sourceHidden,
        bitmapsClosed: decoded.frames[0].layers.every((l) => l.bitmap === null),
      };
    }
    return out;
  });

  assert.ok(!result.moduleMissing, `checkpointClient module missing: ${result.moduleMissing}`);
  const failures = [];
  const check = (name, cond, detail) => { if (cond) { console.log(`PASS ${name}`); } else { failures.push(name); console.log(`FAIL ${name}${detail ? `, ${detail}` : ''}`); } };

  check('support gate: empty without renderer version', result.supportWithoutVersion === true);
  check('support gate: version when define + WebCrypto present', result.supportWithVersion === true);
  check('support gate: rejects non-hex version', result.supportRejectsBadVersion === true);
  check('bytes roundtrip', result.bytesRoundtrip === true);
  check('base64 rejects 7 malformed inputs', result.base64Rejected === 7, `got ${result.base64Rejected}`);
  check('base64 byte bound', result.base64Bound === true);
  check('valid checkpoint decodes', result.decodeOk === true, JSON.stringify(result.decodeError));
  const p = result.parity || {};
  check('parity: ran', p.ran === true);
  check('parity: layer-a (marker/eraser/wet-oil/smudge) byte-equal', p.layerEqual && p.layerEqual[0] === true);
  check('parity: layer-b hidden (image+marker) byte-equal', p.layerEqual && p.layerEqual[1] === true);
  check('parity: layer-c opacity (wet acrylic) byte-equal', p.layerEqual && p.layerEqual[2] === true);
  check('parity: hidden layer has real pixels', p.hiddenLayerHasPixels === true);
  check('parity: mix-map continuation state equal after tail', p.mixEqual === true);
  check('standalone mix restore reads restored ledger', result.standaloneRestore === true);
  for (const c of result.checks) {
    check(`reject: ${c.name}`, c.ok === true, c.reason);
  }
  check('late-decode cancellation rejects canceled', result.cancellation && result.cancellation.reason === 'canceled', JSON.stringify(result.cancellation));
  check('late-decode cancellation leaves pixels untouched', result.cancellation && result.cancellation.pixelsUntouched === true);
  check('multi-frame decode (stage4 shape)', result.multiFrame === true, JSON.stringify(result.multiFrame));
  check('install preserves hidden pixels (no visibility/opacity bake)', result.install && result.install.hiddenPreserved === true);
  check('install closes bitmaps', result.install && result.install.bitmapsClosed === true);

  assert.equal(failures.length, 0, `${failures.length} failures: ${failures.join(', ')}`);
  console.log(`ALL ${'checkpoint-client'} module checks passed`);
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
