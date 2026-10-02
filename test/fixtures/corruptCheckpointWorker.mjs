/* eslint-env node */
// FIXTURE, deliberately CORRUPT checkpoint renderer for the phase-3
// corrupt-response integration test (test/checkpoint-server.integration.mjs).
// Not the real worker: it speaks the IPC protocol (ready/result) but returns
// frames that fail the service's decode/hash validation. Selected via
// CORRUPT_MODE: 'hash' (honest PNG, lying pngSha256) or 'mix' (honest hashes,
// wrong mix dimensions). Used ONLY through the CHECKPOINT_WORKER_ENTRY test
// seam; production always runs server/checkpointRenderer.mjs.
import { createHash } from 'node:crypto';

// A real 2x2 PNG so the magic/base64 checks pass and the HASH is the lie.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8DwnwEKmBgQAAA9+AED0yx0AAAAAABJRU5ErkJggg==';
const honestSha = createHash('sha256').update(Buffer.from(PNG_B64, 'base64')).digest('hex');
const mode = process.env.CORRUPT_MODE || 'hash';

process.on('message', (msg) => {
  if (!msg || msg.type !== 'render') return;
  const layerId = msg.job.layers[0].id;
  const frame = {
    frameId: msg.job.frameId,
    throughOpId: msg.job.throughOpId,
    layersKey: JSON.stringify(msg.job.layers.map((l) => [l.id, l.visible !== false, l.opacity ?? 1])),
    layers: [{
      id: layerId,
      pngBase64: PNG_B64,
      pngSha256: mode === 'hash' ? '0'.repeat(64) : honestSha, // the lie
      rgbaSha256: '1'.repeat(64),
    }],
    mixState: {
      version: 1,
      width: mode === 'mix' ? 999 : 500, // wrong mirror dims in 'mix' mode
      height: 313,
      pixelsBase64: Buffer.alloc(500 * 313 * 4).toString('base64'),
      dirty: null,
      prefetched: null,
    },
  };
  process.send({ type: 'result', jobId: msg.jobId, frame });
});
process.send({ type: 'ready' });
