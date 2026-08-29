// Module cache for stored-image dataURLs fetched via /api/sheets/:id
// (trace_/pp_/cd_ ids). LRU-capped: chat doodles feed this for a whole SPA
// session, and 60 entries comfortably covers everything on screen (an 80-line
// chat log shows far fewer images) without letting memory grow unbounded.
const CACHE_MAX = 60;
const cache = new Map();

export function getPageImage(id) {
  const hit = cache.get(id);
  if (hit !== undefined) {
    // Refresh recency (Map iteration order is insertion order).
    cache.delete(id);
    cache.set(id, hit);
  }
  return hit;
}

export function setPageImage(id, dataUrl) {
  cache.delete(id);
  cache.set(id, dataUrl);
  while (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value); // oldest
  }
}

// Admin takedown propagation: drop the image so an already-rendered bubble
// can't resurrect it from cache.
export function evictPageImage(id) {
  cache.delete(id);
}
