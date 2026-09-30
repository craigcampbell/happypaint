import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const CHECKPOINT_RENDERER_FILES = Object.freeze([
  'src/utils/checkpointFormat.js',
  'src/utils/checkpointClient.js',
  'src/utils/frameRasters.js',
  'src/utils/brushes.js',
  'src/utils/brushSprites.js',
  'src/utils/strokeBuffer.js',
  'src/utils/mixMap.js',
  'src/utils/pigment.js',
  'src/utils/layers.js',
  'src/utils/opReplay.js',
  'src/utils/symmetry.js',
  'src/utils/shapes.js',
  'src/utils/safeImage.js',
]);

// Deliberately throws if required renderer source is absent: callers disable
// checkpoints rather than issue a version that hides an incomplete deployment.
export function checkpointRendererVersion(root = ROOT) {
  const hash = createHash('sha256');
  hash.update('drawesome-trusted-checkpoint-v1\0');
  for (const file of CHECKPOINT_RENDERER_FILES) {
    hash.update(file).update('\0').update(readFileSync(resolve(root, file))).update('\0');
  }
  return hash.digest('hex');
}
