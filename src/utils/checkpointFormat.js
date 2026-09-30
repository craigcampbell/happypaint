// Versioned trusted-checkpoint envelope. This is acceleration data, never a
// replacement for the retained authoritative operation history.
export const CHECKPOINT_SCHEMA_VERSION = 1;
export const CHECKPOINT_WIDTH = 4000;
export const CHECKPOINT_HEIGHT = 2500;
export const CHECKPOINT_MAX_LAYER_BYTES = 16 * 1024 * 1024;
export const CHECKPOINT_MAX_FRAME_BYTES = 48 * 1024 * 1024;
export const CHECKPOINT_MAX_LAYERS = 6;

export function checkpointLayersKey(layers) {
  return JSON.stringify((layers || []).map(({ id, visible, opacity }) => [id, visible !== false, opacity]));
}

// A stale bundle must not adopt pixels baked with different replay code.
// Plain-module verification pages have no Vite define and deliberately opt out.
export function clientCheckpointVersion() {
  // eslint-disable-next-line no-undef
  return typeof __CHECKPOINT_RENDERER_VERSION__ === 'string' ? __CHECKPOINT_RENDERER_VERSION__ : '';
}
