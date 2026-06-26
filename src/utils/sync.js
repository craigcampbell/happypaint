// Local-first cloud sync — activates ONLY when signed in to a configured
// PocketBase instance. The local IndexedDB / localStorage stays the source of
// truth: the app works fully offline and signed out, and sync is a best-effort
// mirror layered on top.
//
// SCOPE (first pass): gallery drawings <-> a PocketBase `snapshots` collection,
// UPSERTed per item keyed by (owner, client_id). Paint Space / economy sync is
// deferred. MERGE: last-write-wins by `client_updated` (fallback createdAt).
//
// RESILIENCE: every network op is wrapped in try/catch and is best-effort. A
// failure never throws to the UI and never blocks offline use; it just flips the
// status to "paused" so the AccountPanel can surface it. If the `snapshots`
// collection doesn't exist yet, sync simply stays paused — the app is unaffected.

import { getPocketBase, getProfileId } from "./auth";
import { idbGetKV, idbSetKV, isIdbAvailable } from "./idb";

const GALLERY_IDB_KEY = "gallery:v2";
const GALLERY_LS_KEY = "happypaint:gallery:v2";
const COLLECTION = "snapshots";

// Debounce window for change-driven pushes so a burst of edits coalesces.
const PUSH_DEBOUNCE_MS = 1500;

// ---- Sync status (observable) ----
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

// ---- Local gallery store access (same store App.jsx uses) ----

async function readGalleryLocal() {
  if (isIdbAvailable()) {
    try {
      const stored = await idbGetKV(GALLERY_IDB_KEY);
      if (Array.isArray(stored)) return stored;
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

// ---- Timestamp helpers (last-write-wins) ----

function localStamp(record) {
  const value = record?.updated_at || record?.updatedAt || record?.createdAt;
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

// ---- Row <-> local mappers ----
// Note: `created`/`updated` are PocketBase system fields, so our own timestamp
// is stored as `client_updated` to avoid the name collision.

function galleryToFields(item, profileId, nowIso) {
  return {
    owner: profileId,
    client_id: item.id,
    title: item.name || "Drawesome",
    image: item.layer || "",
    texture_id: item.textureId ?? "",
    preview: item.preview ?? "",
    client_updated: item.updated_at || nowIso,
  };
}

function snapshotRowToGallery(row) {
  return {
    id: row.client_id,
    name: row.title || "Drawesome",
    layer: row.image || "",
    textureId: row.texture_id || null,
    preview: row.preview || row.image || "",
    createdAt: row.created || row.client_updated || new Date().toISOString(),
    updated_at: row.client_updated,
  };
}

// ---- Generic last-write-wins merge ----
function mergeByStamp(localList, remoteList) {
  const byId = new Map();
  for (const item of localList) {
    if (item?.id) byId.set(item.id, item);
  }
  for (const remote of remoteList) {
    if (!remote?.id) continue;
    const local = byId.get(remote.id);
    if (!local || localStamp(remote) > localStamp(local)) {
      byId.set(remote.id, remote);
    }
  }
  return Array.from(byId.values());
}

// ---- PocketBase upsert (no native upsert; find-then-create/update) ----

async function upsertSnapshot(pb, item, profileId, nowIso) {
  const data = galleryToFields(item, profileId, nowIso);
  let existing = null;
  try {
    existing = await pb
      .collection(COLLECTION)
      .getFirstListItem(`owner="${profileId}" && client_id="${item.id}"`);
  } catch (error) {
    if (error?.status && error.status !== 404) throw error; // a real failure
    existing = null; // 404 = doesn't exist yet
  }
  if (existing) await pb.collection(COLLECTION).update(existing.id, data);
  else await pb.collection(COLLECTION).create(data);
}

// ---- Push (debounced) ----

let pushTimer = null;
let activeProfileId = null;

async function pushNow() {
  const pb = await getPocketBase();
  if (!pb || !activeProfileId) return;
  setStatus("syncing");
  const nowIso = new Date().toISOString();
  let ok = true;
  try {
    const gallery = await readGalleryLocal();
    for (const item of gallery) {
      try {
        await upsertSnapshot(pb, item, activeProfileId, nowIso);
      } catch {
        ok = false;
      }
    }
  } catch {
    ok = false;
  }
  setStatus(ok ? "synced" : "paused");
}

// Schedule a debounced push from the same places local saves happen.
export function schedulePush() {
  if (!activeProfileId) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushNow().catch(() => setStatus("paused"));
  }, PUSH_DEBOUNCE_MS);
}

// ---- Pull (on sign-in / on demand) ----
export async function pull() {
  const pb = await getPocketBase();
  if (!pb || !activeProfileId) return false;
  setStatus("syncing");
  let ok = true;
  try {
    const rows = await pb.collection(COLLECTION).getFullList({ filter: `owner="${activeProfileId}"` });
    const local = await readGalleryLocal();
    const merged = mergeByStamp(local, rows.map(snapshotRowToGallery));
    await writeGalleryLocal(merged);
  } catch {
    ok = false;
  }
  setStatus(ok ? "synced" : "paused");
  return ok;
}

// ---- Lifecycle ----

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
    await pull(); // pull first so we don't re-push stale rows over newer server ones
    await pushNow();
  } catch {
    setStatus("paused");
  }
}

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
