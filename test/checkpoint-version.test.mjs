import assert from 'node:assert/strict';
import test from 'node:test';
import { checkpointRendererVersion, CHECKPOINT_RENDERER_FILES } from '../server/checkpointVersion.js';
import { checkpointLayersKey } from '../src/utils/checkpointFormat.js';

test('checkpoint layer key tracks only ordered render state', () => {
  const a = [{ id: 'L0', visible: true, opacity: 1, name: 'A', locked: false }];
  assert.equal(checkpointLayersKey(a), checkpointLayersKey([{ ...a[0], name: 'B', locked: true }]));
  assert.notEqual(checkpointLayersKey(a), checkpointLayersKey([{ ...a[0], opacity: 0.5 }]));
});

test('checkpoint renderer fingerprint is a stable, source-derived SHA256', () => {
  const a = checkpointRendererVersion();
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(checkpointRendererVersion(), a);
  assert(CHECKPOINT_RENDERER_FILES.includes('src/utils/mixMap.js'));
  assert(CHECKPOINT_RENDERER_FILES.includes('src/utils/opReplay.js'));
  assert(CHECKPOINT_RENDERER_FILES.includes('src/utils/brushes.js'));
});
