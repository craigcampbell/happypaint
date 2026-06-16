// Paint Space — the user's reusable personal asset locker (Bet #1 MVP).
//
// Persisted client-side to localStorage. The asset shape mirrors the backend
// `space_assets` table (id, kind, title, payload, thumbnail, createdAt) so it
// is sync-ready later, but this MVP is local-only: no networking, publishing,
// or moderation.
//
// Asset kinds supported in the studio:
//   - sticker   : payload { image } (transparent PNG data URL) -> stamp onto layer
//   - template  : payload { image, textureId } -> load as artwork base
//   - palette   : payload { colors: string[] } -> load swatch colors
//   - loop      : payload { frames: [{ image, durationMs }] } -> load frames

export const PAINT_SPACE_STORAGE_KEY = "happypaint:paintspace:v1";

export const ASSET_KINDS = [
  { id: "sticker", label: "Stickers" },
  { id: "template", label: "Templates" },
  { id: "palette", label: "Palettes" },
  { id: "loop", label: "Loops" },
];

let idSeed = 0;

// Guarded id helper. crypto.randomUUID matches the backend uuid shape when
// available, but it throws in non-secure contexts (plain HTTP) and isn't
// present on older engines — fall back to a collision-resistant local id so we
// never throw (W16). Shared by every call site that previously used
// crypto.randomUUID unguarded.
export function makeId(prefix = "id") {
  idSeed += 1;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // Non-secure context: fall through to the local id.
    }
  }
  return `${prefix}-${Date.now().toString(36)}-${idSeed}`;
}

function nextAssetId() {
  return makeId("asset");
}

export function readPaintSpace() {
  try {
    const value = window.localStorage.getItem(PAINT_SPACE_STORAGE_KEY);
    const parsed = value ? JSON.parse(value) : null;
    const assets = parsed?.space_assets;
    return Array.isArray(assets) ? assets : [];
  } catch {
    return [];
  }
}

export function writePaintSpace(assets) {
  try {
    window.localStorage.setItem(
      PAINT_SPACE_STORAGE_KEY,
      JSON.stringify({ version: 1, space_assets: assets }),
    );
  } catch {
    // Locker can fill local storage with image data; keep running if a save is skipped.
  }
}

// Build a sync-ready asset record. payload/thumbnail shape mirrors space_assets.
export function createAsset({ kind, title, payload, thumbnail = "" }) {
  return {
    id: nextAssetId(),
    kind,
    title: title || defaultTitleFor(kind),
    payload: payload || {},
    thumbnail,
    createdAt: new Date().toISOString(),
  };
}

function defaultTitleFor(kind) {
  const map = { sticker: "Sticker", template: "Template", palette: "Palette", loop: "Loop" };
  return map[kind] || "Asset";
}

export function addAsset(assets, asset) {
  return [asset, ...assets];
}

export function removeAsset(assets, id) {
  return assets.filter((asset) => asset.id !== id);
}

export function renameAsset(assets, id, title) {
  return assets.map((asset) => (asset.id === id ? { ...asset, title } : asset));
}

export function groupByKind(assets) {
  const groups = {};
  for (const kind of ASSET_KINDS) {
    groups[kind.id] = [];
  }
  for (const asset of assets) {
    if (!groups[asset.kind]) {
      groups[asset.kind] = [];
    }
    groups[asset.kind].push(asset);
  }
  return groups;
}
