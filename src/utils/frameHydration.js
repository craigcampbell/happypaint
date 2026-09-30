// Admission policy, not after-the-fact eviction: an idle window must select
// the same frames whether neighbors are currently cold or warm, or it thrashes.
export function frameCanvasBytes(frame) {
  if (frame?.layers?.length) {
    return frame.layers.reduce((sum, layer) => sum + (layer.canvas?.width || 4000) * (layer.canvas?.height || 2500) * 4, 0);
  }
  return Math.max(1, frame?.layerMeta?.length || 0) * 4000 * 2500 * 4;
}

export function releaseUnselectedFrames(frames, selected) {
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (!frame.layers || selected.has(index)) continue;
    // Shared animation content remains in frame.ops + frame.checkpoint. A
    // raster is derived, so don't encode a full canvas merely to free it.
    frame.hydrateGen = (frame.hydrateGen || 0) + 1;
    frame.hydrating = null;
    frame.layers = null;
    frame.activeLayerId = null;
  }
}

export function hydrationWindow(frames, active, budgetBytes, radius = 2) {
  const selected = new Set();
  if (!frames[active]) return selected;
  selected.add(active);
  let bytes = frameCanvasBytes(frames[active]);
  for (let distance = 1; distance <= radius; distance += 1) {
    for (const index of [active - distance, active + distance]) {
      if (!frames[index]) continue;
      const cost = frameCanvasBytes(frames[index]);
      if (bytes + cost > budgetBytes) continue;
      selected.add(index);
      bytes += cost;
    }
  }
  return selected;
}
