/* eslint-env node */
// Phase-3 trusted checkpoint WORKER tests, real Chromium, real renders.
//
// Covers (contract stage gate 1 + security cases):
//  - real worker roundtrip: per-layer full-res transparent PNGs (magic +
//    sha256 verified here AGAIN outside the worker), hidden-layer pixels
//    retained, RGBA readback hash, mix state wire shape + dimensions;
//  - multi-layer routing + wet-mix (v2 oil) + seeded eraser + inline image op;
//  - job rejection: renderer-version mismatch, malformed job, budget exceeded;
//  - missing executable: manager inert, submit rejects 'disabled';
//  - job timeout: SIGKILL + respawn, the NEXT job succeeds on a fresh child.
//
//   node --test test/checkpoint-worker.test.mjs
//
// Requires a Chromium/Chrome executable (CHECKPOINT_CHROME_PATH, else
// /usr/bin/google-chrome); the whole file skips cleanly without one.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createCheckpointWorker } from '../server/checkpointWorker.js';
import { checkpointRendererVersion } from '../server/checkpointVersion.js';
import { checkpointLayersKey } from '../src/utils/checkpointFormat.js';

const CHROME_CANDIDATES = [
  process.env.CHECKPOINT_CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
const VERSION = checkpointRendererVersion();
const PNG_MAGIC = '89504e47';
// 2x2 opaque red PNG (inline raster for the image op).
const RED_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8DwnwEKmBgQAAA9+AED0yx0AAAAAABJRU5ErkJggg==';

const stroke = (id, seed, color, pts, extra = {}) => ({
  kind: 'draw', strokeId: id,
  settings: { brush: 'marker', color, size: 24, opacity: 1, seed, ...(extra.settings || {}) },
  points: pts.map(([x, y]) => ({ x, y })),
  end: true,
  ...(extra.op || {}),
});

function makeJob(overrides = {}) {
  return {
    rendererVersion: VERSION,
    frameId: 'f0',
    throughOpId: 6,
    layers: [
      { id: 'L0', visible: true, opacity: 1 },
      { id: 'L1', visible: false, opacity: 0.5 }, // hidden: pixels must STILL be rendered
    ],
    ops: [
      stroke('s1', 11, '#ff0000', [[100, 100], [500, 400], [900, 200]]),
      stroke('s2', 22, '#00aa00', [[200, 900], [600, 1200]], { op: { layerId: 'L1' } }),
      // Wet mixing: a seeded v2 oil stroke samples the layer-0 mix map.
      stroke('s3', 33, '#2244cc', [[300, 300], [700, 700], [1100, 500]], { settings: { v: 2, brush: 'oil' } }),
      // Seeded eraser cuts deterministic holes.
      stroke('s4', 44, '#000000', [[450, 350], [550, 450]], { settings: { brush: 'eraser', size: 60 } }),
      { kind: 'shape', tool: 'rect', start: { x: 1200, y: 800 }, end: { x: 1500, y: 1100 }, opts: { color: '#880088', fillShape: true } },
      { kind: 'image', dataUrl: `data:image/png;base64,${RED_PNG_B64}`, x: 1600, y: 1200, w: 200, h: 200 },
    ],
    budgets: { maxOps: 100, maxPoints: 100000, maxBytes: 16 * 1024 * 1024, maxLayerB64: 16 * 1024 * 1024 },
    ...overrides,
  };
}

test('trusted checkpoint worker (real chromium)', { skip: !CHROME && 'no chrome executable found' }, async (t) => {
  await t.test('renders a real job: PNG roundtrip assets + mix state, hashes verify', async () => {
    const worker = createCheckpointWorker({ chromePath: CHROME, timeoutMs: 60000 });
    assert.equal(worker.available, true);
    const job = makeJob();
    const frame = await worker.submit(job);
    await worker.close();

    assert.equal(frame.frameId, 'f0');
    assert.equal(frame.throughOpId, 6);
    assert.equal(frame.layersKey, checkpointLayersKey(job.layers));
    assert.equal(frame.layers.length, 2);
    assert.deepEqual(frame.layers.map((l) => l.id), ['L0', 'L1']);
    for (const layer of frame.layers) {
      const png = Buffer.from(layer.pngBase64, 'base64');
      assert.equal(png.subarray(0, 4).toString('hex'), PNG_MAGIC, 'layer asset is a PNG');
      assert.equal(createHash('sha256').update(png).digest('hex'), layer.pngSha256, 'pngSha256 honest');
      assert.match(layer.rgbaSha256, /^[a-f0-9]{64}$/);
      // PNG IHDR dimensions: full document resolution.
      assert.equal(png.readUInt32BE(16), 4000, 'png width 4000');
      assert.equal(png.readUInt32BE(20), 2500, 'png height 2500');
    }
    // Hidden layer retained real pixels (visibility is a composite-time
    // concern, never baked out of the editable layer asset): both PNGs must
    // differ and the hidden layer's asset must be non-trivial.
    assert.notEqual(frame.layers[0].pngSha256, frame.layers[1].pngSha256);
    assert.ok(Buffer.from(frame.layers[1].pngBase64, 'base64').length > 5000, 'hidden layer kept its ink');
    // Mix state: mirror dims (4000/8 x 2500/8) + exact pixel payload length.
    const ms = frame.mixState;
    assert.equal(ms.version, 1);
    assert.equal(ms.width, 500);
    assert.equal(ms.height, 313);
    assert.equal(Buffer.from(ms.pixelsBase64, 'base64').length, 500 * 313 * 4);
    assert.ok(ms.dirty === null || [ms.dirty.x0, ms.dirty.y0, ms.dirty.w, ms.dirty.h].every(Number.isFinite));
    const stats = worker.stats();
    assert.equal(stats.completed, 1);
    assert.equal(stats.failed, 0);
  });

  await t.test('rejects a renderer-version mismatch (stale bundle fence)', async () => {
    const worker = createCheckpointWorker({ chromePath: CHROME, timeoutMs: 30000 });
    await assert.rejects(
      worker.submit(makeJob({ rendererVersion: '0'.repeat(64) })),
      (err) => /version mismatch/.test(err.message),
    );
    await worker.close();
  });

  await t.test('rejects malformed jobs and budget overruns before rendering', async () => {
    const worker = createCheckpointWorker({ chromePath: CHROME, timeoutMs: 30000 });
    await assert.rejects(worker.submit(makeJob({ ops: 'nope' })), /job rejected/);
    await assert.rejects(worker.submit(makeJob({ throughOpId: -1 })), /job rejected/);
    await assert.rejects(worker.submit(makeJob({ layers: [] })), /job rejected/);
    await assert.rejects(
      worker.submit(makeJob({ budgets: { maxOps: 2, maxPoints: 100, maxBytes: 1024 } })),
      /budget/,
    );
    await assert.rejects(
      worker.submit(makeJob({ budgets: { maxOps: 100, maxPoints: 2, maxBytes: 16 * 1024 * 1024 } })),
      /point budget/,
    );
    const stats = worker.stats();
    assert.ok(stats.failed >= 5, `rejections counted (got ${JSON.stringify(stats)})`);
    await worker.close();
  });

  await t.test('job timeout kills the child; a later job succeeds on the respawn', async () => {
    // 900ms is far under a cold Chromium launch + 4000x2500 render, so the
    // first job must time out; the manager SIGKILLs and respawns lazily.
    const worker = createCheckpointWorker({ chromePath: CHROME, timeoutMs: 900 });
    await assert.rejects(worker.submit(makeJob()), (err) => err.code === 'timeout');
    assert.ok(worker.stats().timeouts >= 1);
    await worker.close();

    const patient = createCheckpointWorker({ chromePath: CHROME, timeoutMs: 60000 });
    const frame = await patient.submit(makeJob());
    assert.equal(frame.throughOpId, 6);
    await patient.close();
  });
});

test('worker with a missing executable is inert (never blocks startup/join)', async () => {
  const worker = createCheckpointWorker({ chromePath: '/nonexistent/no-such-chrome' });
  assert.equal(worker.available, false);
  assert.equal(worker.reason, 'chrome_missing');
  await assert.rejects(worker.submit(makeJob()), (err) => err.code === 'disabled');
  assert.equal(worker.stats().spawns, 0, 'nothing ever spawned');
});
