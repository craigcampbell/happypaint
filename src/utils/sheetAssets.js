// Coloring-sheet asset URLs.
//
// /coloring-sheets/{full,thumbs}/* is served with `immutable, max-age=7d` and
// public/sw.js caches same-origin GETs cache-first, so an unchanged URL keeps
// handing the OLD artwork back to returning visitors even after the files on
// disk are replaced. Every sheet URL therefore carries SHEET_ASSET_VERSION -
// bump it whenever the artwork itself is regenerated (watermark swap, re-render,
// re-export) so the CDN and every service worker see a brand-new object.

export const SHEET_ASSET_VERSION = "2";

export function sheetFullUrl(id) {
  return `/coloring-sheets/full/${encodeURIComponent(id)}.png?v=${SHEET_ASSET_VERSION}`;
}

export function sheetThumbUrl(id) {
  return `/coloring-sheets/thumbs/${encodeURIComponent(id)}.webp?v=${SHEET_ASSET_VERSION}`;
}
