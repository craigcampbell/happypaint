// Local-first cloud sync — activates ONLY when signed in to a configured
// Supabase project. The local IndexedDB / localStorage stores remain the source
// of truth: the app works fully offline and signed out, and sync is a best-effort
// mirror layered on top.
//
// SCOPE (intentionally narrow for now):
//   - Drawings / gallery pieces  -> `project_snapshots`  (UPSERT on (profile_id, client_id))
//   - Paint Space locker assets  -> `space_assets`       (UPSERT on (owner_profile_id, client_id))
// Economy / events / replay / brush packs sync is DEFERRED (not synced here).
//
// MERGE STRATEGY: last-write-wins by `updated_at`. On pull we only overwrite a
// local record when the server copy is strictly newer; we never clobber a newer
// local edit. Local rows missing an `updated_at` fall back to `createdAt`.
//
// RESILIENCE: every network op is wrapped in try/catch and is best-effort. A
// failure never throws to the UI and never blocks offline use; it just flips the
// status to "paused" so the AccountPanel can surface it.

import { getSupabaseClient, getProfileId } from "./auth";
import { idbGetKV, idbSetKV, isIdbAvailable } from "./idb";
import { PAINT_SPACE_IDB_KEY, PAINT_SPACE_STORAGE_KEY } from "./paintSpace";

const GALLERY_IDB_KEY = "gallery:v2";
const GALLERY_LS_KEY = "happypaint:gallery:v2";

// Debounce window for change-driven pushes so a burst of edits coalesces.
const PUSH_DEBOUNCE_MS = 1500;

// A stable-ish identifier for the device a write came from (audit only).
function deviceLabel() {
  try {
    return (navigator.userAgent || "web").slice(0, 120);
  } catch {
    return "web";
  }
}

// ---- Sync status (observable) ----
// One of: "signed-out" (sign in to sync), "synced", "paused" (offline / error),
// "syncing". Subscribers (e.g. AccountPanel) get the latest value immediately.
const STATUS_LABELS = {
  "signed-out": "Sign in to sync",
  synced: "Synced",
  syncing: "Syncing…",
  paused: "Sync paused — offline",
};

let currentStatus = "signed-out";
const statusListeners = new Set();

function setStatus(status) {
  currentStatus = status;
  for (const listener of statusListeners) {
    try {
      listener(status, STATUS_LABELS[status] || status);
    } catch {
      // a bad listener can't break sync
    }
  }
}

export function getSyncStatus() {
  return { status: currentStatus, label: STATUS_LABELS[currentStatus] || currentStatus };
}

export function onSyncStatus(listener) {
  statusListeners.add(listener);
  try {
    listener(currentStatus, STATUS_LABELS[currentStatus] || currentStatus);
  } catch {
    // ignore
  }
  return () => statusListeners.delete(listener);
}

// ---- Local store access (read/write the same stores App.jsx uses) ----

async function readGalleryLocal() {
  if (isIdbAvailable()) {
    try {
      const stored = await idbGetKV(GALLERY_IDB_KEY);
      if (Array.isArray(stored)) {
        return stored;
      }
    } catch {
      // fall through to localStorage
    }
  }
  try {
    const raw = window.localStorage.getItem(GALLERY_LS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeGalleryLocal(items) {
  if (isIdbAvailable()) {
    await idbSetKV(GALLERY_IDB_KEY, items);
    return;
  }
  window.localStorage.setItem(GALLERY_LS_KEY, JSON.stringify(items));
}

async function readPaintSpaceLocal() {
  if (isIdbAvailable()) {
    try {
      const stored = await idbGetKV(PAINT_SPACE_IDB_KEY);
      if (Array.isArray(stored)) {
        return stored;
      }
    } catch {
      // fall through to localStorage
    }
  }
  try {
    const raw = window.localStorage.getItem(PAINT_SPACE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const assets = parsed?.space_assets;
    return Array.isArray(assets) ? assets : [];
  } catch {
    return [];
  }
}

async function writePaintSpaceLocal(assets) {
  if (isIdbAvailable()) {
    await idbSetKV(PAINT_SPACE_IDB_KEY, assets);
    return;
  }
  window.localStorage.setItem(
    PAINT_SPACE_STORAGE_KEY,
    JSON.stringify({ version: 1, space_assets: assets }),
  );
}

// ---- Timestamp helpers (last-write-wins) ----

function localStamp(record) {
  // Prefer an explicit updated_at; fall back to createdAt; else 0 (oldest).
  // Works for both local records and server rows mapped to the local shape
  // (snapshotToGallery / spaceRowToAsset both carry `updated_at`).
  const value = record?.updated_at || record?.updatedAt || record?.createdAt;
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

// ---- Row <-> local mappers ----

// Gallery piece -> project_snapshots row. A gallery item is a single flattened
// layer; we store it as one entry in `layers` and keep `frames` empty.
function galleryToSnapshot(item, profileId, nowIso) {
  return {
    profile_id: profileId,
    client_id: item.id,
    title: item.name || "Happy Paint",
    layers: [{ image: item.layer, textureId: item.textureId ?? null, preview: item.preview ?? null }],
    frames: [],
    frame_count: 1,
    updated_at: item.updated_at || nowIso,
    updated_device: deviceLabel(),
  };
}

function snapshotToGallery(row) {
  const layer = Array.isArray(row.layers) ? row.layers[0] : null;
  return {
    id: row.client_id,
    name: row.title || "Happy Paint",
    layer: layer?.image || "",
    textureId: layer?.textureId ?? null,
    preview: layer?.preview || layer?.image || "",
    createdAt: row.created_at || row.updated_at || new Date().toISOString(),
    updated_at: row.updated_at,
  };
}

// Paint Space asset -> space_assets row.
function assetToSpaceRow(asset, profileId, nowIso) {
  return {
    owner_profile_id: profileId,
    client_id: asset.id,
    kind: asset.kind,
    title: asset.title || "Asset",
    payload: asset.payload || {},
    visibility: asset.visibility || "private",
    moderation_status: asset.moderation_status || "approved",
    brush_recipe: asset.brush_recipe ?? null,
    updated_at: asset.updated_at || nowIso,
  };
}

function spaceRowToAsset(row) {
  return {
    id: row.client_id,
    kind: row.kind,
    title: row.title || "Asset",
    payload: row.payload || {},
    thumbnail: row.payload?.thumbnail || "",
    createdAt: row.created_at || row.updated_at || new Date().toISOString(),
    updated_at: row.updated_at,
    visibility: row.visibility,
    moderation_status: row.moderation_status,
    ...(row.brush_recipe ? { brush_recipe: row.brush_recipe } : {}),
  };
}

// ---- Generic last-write-wins merge ----
// Returns the merged array keyed by `id`, taking whichever side is newer.
function mergeByStamp(localList, remoteList) {
  const byId = new Map();
  for (const item of localList) {
    if (item?.id) {
      byId.set(item.id, item);
    }
  }
  for (const remote of remoteList) {
    if (!remote?.id) {
      continue;
    }
    const local = byId.get(remote.id);
    if (!local || localStamp(remote) > localStamp(local)) {
      byId.set(remote.id, remote);
    }
    // else: local is newer-or-equal — keep it (don't clobber a newer local edit).
  }
  return Array.from(byId.values());
}

// ---- Push (debounced) ----

let pushTimer = null;
let activeProfileId = null;

// Upsert all local gallery + paint-space records to the server. Best-effort.
async function pushNow() {
  const client = getSupabaseClient();
  if (!client || !activeProfileId) {
    return;
  }
  setStatus("syncing");
  const nowIso = new Date().toISOString();
  let ok = true;

  try {
    const gallery = await readGalleryLocal();
    if (gallery.length > 0) {
      const rows = gallery.map((item) => galleryToSnapshot(item, activeProfileId, nowIso));
      const { error } = await client
        .from("project_snapshots")
        .upsert(rows, { onConflict: "profile_id,client_id" });
      if (error) {
        ok = false;
      }
    }
  } catch {
    ok = false;
  }

  try {
    const assets = await readPaintSpaceLocal();
    if (assets.length > 0) {
      const rows = assets.map((asset) => assetToSpaceRow(asset, activeProfileId, nowIso));
      const { error } = await client
        .from("space_assets")
        .upsert(rows, { onConflict: "owner_profile_id,client_id" });
      if (error) {
        ok = false;
      }
    }
  } catch {
    ok = false;
  }

  setStatus(ok ? "synced" : "paused");
}

// Schedule a debounced push. Call this from the same places local saves happen
// (gallery save, paint-space persist) — it no-ops when signed out.
export function schedulePush() {
  if (!activeProfileId) {
    return;
  }
  if (pushTimer) {
    clearTimeout(pushTimer);
  }
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushNow().catch(() => setStatus("paused"));
  }, PUSH_DEBOUNCE_MS);
}

// ---- Pull (on sign-in / on demand) ----
// Fetch the user's rows and merge into local stores with last-write-wins.
// Returns true when local stores were (potentially) updated so callers can
// refresh their in-memory state.
export async function pull() {
  const client = getSupabaseClient();
  if (!client || !activeProfileId) {
    return false;
  }
  setStatus("syncing");
  let ok = true;

  try {
    const { data, error } = await client
      .from("project_snapshots")
      .select("*")
      .eq("profile_id", activeProfileId);
    if (error) {
      ok = false;
    } else if (Array.isArray(data)) {
      const local = await readGalleryLocal();
      const merged = mergeByStamp(local, data.map(snapshotToGallery));
      await writeGalleryLocal(merged);
    }
  } catch {
    ok = false;
  }

  try {
    const { data, error } = await client
      .from("space_assets")
      .select("*")
      .eq("owner_profile_id", activeProfileId);
    if (error) {
      ok = false;
    } else if (Array.isArray(data)) {
      const local = await readPaintSpaceLocal();
      const merged = mergeByStamp(local, data.map(spaceRowToAsset));
      await writePaintSpaceLocal(merged);
    }
  } catch {
    ok = false;
  }

  setStatus(ok ? "synced" : "paused");
  return ok;
}

// ---- Lifecycle: start on sign-in, stop on sign-out ----

// Begin syncing for a signed-in session. Resolves the profile id, pulls remote
// state (merge), then pushes local state. Best-effort; never throws.
export async function startSync(session) {
  try {
    if (!session) {
      stopSync();
      return;
    }
    const profileId = session.user?.id || (await getProfileId());
    if (!profileId) {
      stopSync();
      return;
    }
    activeProfileId = profileId;
    setStatus("syncing");
    // Pull first so we don't immediately re-push stale local rows over newer
    // server rows; then push local-only / newer-local rows up.
    await pull();
    await pushNow();
  } catch {
    setStatus("paused");
  }
}

// Stop syncing (sign-out). Clears the active profile + any pending push.
export function stopSync() {
  activeProfileId = null;
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  setStatus("signed-out");
}

export function isSyncing() {
  return Boolean(activeProfileId);
}
