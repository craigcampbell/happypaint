// Ops arrive from other people. Two of their fields end up in `new Image().src`
// on every member's machine — an image op's `dataUrl` and a stamp brush's
// `stampDataUrl` — so whatever they hold, the browser loads.
//
// If that were ever an http(s) URL, every current and future joiner would fetch
// a stranger's server (handing over a child's IP address), and drawing the
// cross-origin result would taint the shared canvas for good: every later save,
// snapshot and Wall pin throws SecurityError until the room is cleared.
//
// The server refuses such ops at the relay (rasterDataUrlOk in server.js). This
// is the second fence, for history written before that check existed and for
// any self-hosted server that lacks it: only an inline raster is ever loaded.
const INLINE_RASTER_RE = /^data:image\/(?:png|jpe?g|gif|webp);base64,/i;

export function isInlineRaster(url) {
  return typeof url === "string" && INLINE_RASTER_RE.test(url);
}

// An <img> for replaying a remote op. Returns null for anything that is not an
// inline raster — callers skip the op. `crossOrigin` is belt-and-braces: a data:
// URL ignores it, and anything that somehow is not one can no longer taint.
export function remoteOpImage(url) {
  if (!isInlineRaster(url)) return null;
  const image = new Image();
  image.crossOrigin = "anonymous";
  return image;
}
