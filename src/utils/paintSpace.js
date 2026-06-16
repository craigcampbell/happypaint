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

import { idbGetKV, idbSetKV, isIdbAvailable } from "./idb";

// Legacy localStorage key (pre-IndexedDB). Still read once for migration and
// used as the fallback store when IndexedDB is unavailable (private mode).
export const PAINT_SPACE_STORAGE_KEY = "happypaint:paintspace:v1";
// Key for the locker array inside the IndexedDB "kv" store.
export const PAINT_SPACE_IDB_KEY = "paintspace:v1";

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

// Read the locker from localStorage (legacy / IndexedDB-unavailable fallback).
// Returns null when the key is absent (so callers can distinguish "no data" from
// "empty locker" during migration), or [] on parse error.
function readPaintSpaceLocal() {
  try {
    const value = window.localStorage.getItem(PAINT_SPACE_STORAGE_KEY);
    if (value == null) {
      return null;
    }
    const parsed = JSON.parse(value);
    const assets = parsed?.space_assets;
    return Array.isArray(assets) ? assets : [];
  } catch {
    return [];
  }
}

// Write the locker to localStorage. Throws on QuotaExceededError so the caller
// can surface an honest status instead of silently dropping image data.
function writePaintSpaceLocal(assets) {
  window.localStorage.setItem(
    PAINT_SPACE_STORAGE_KEY,
    JSON.stringify({ version: 1, space_assets: assets }),
  );
}

// Async load: IndexedDB first, then migrate a legacy localStorage locker forward
// into IndexedDB (and clear the legacy key to free quota) so existing users keep
// their assets. Falls back to localStorage when IndexedDB is unavailable.
// Never throws — load failures resolve to [] (worst case: an empty locker UI).
export async function loadPaintSpace() {
  if (isIdbAvailable()) {
    try {
      const stored = await idbGetKV(PAINT_SPACE_IDB_KEY);
      if (Array.isArray(stored)) {
        return stored;
      }
      // No IndexedDB record yet — migrate a legacy localStorage locker forward.
      const legacy = readPaintSpaceLocal();
      if (Array.isArray(legacy) && legacy.length > 0) {
        await idbSetKV(PAINT_SPACE_IDB_KEY, legacy);
        try {
          window.localStorage.removeItem(PAINT_SPACE_STORAGE_KEY);
        } catch {
          // Non-fatal: leaving the legacy key just costs a little quota.
        }
        return legacy;
      }
      return [];
    } catch {
      // IndexedDB read/migration failed — fall back to whatever localStorage has.
      const legacy = readPaintSpaceLocal();
      return Array.isArray(legacy) ? legacy : [];
    }
  }
  const legacy = readPaintSpaceLocal();
  return Array.isArray(legacy) ? legacy : [];
}

// Async persist. Writes to IndexedDB when available, else localStorage. Rejects
// on failure (quota, structured-clone, IndexedDB error) so the caller surfaces a
// real "couldn't save" status rather than pretending success.
export async function savePaintSpace(assets) {
  if (isIdbAvailable()) {
    await idbSetKV(PAINT_SPACE_IDB_KEY, assets);
    return;
  }
  writePaintSpaceLocal(assets);
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
