// Local-first cloud sync, activates ONLY when signed in to a configured
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
// collection doesn't exist yet, sync simply stays paused, the app is unaffected.

import { getPocketBase, isCloudConfigured } from "./auth";
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
  paused: "Sync paused, offline",
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
    client_id: item.cloudClientId || item.id,
    title: item.name || "Drawesome",
    image: item.layer || "",
    texture_id: item.textureId ?? "",
    preview: item.preview ?? "",
    client_updated: item.updated_at || nowIso,
  };
}

function snapshotRowToGallery(row) {
  return {
    id: `cloud:${row.owner}:${row.client_id}`,
    cloudClientId: row.client_id,
    cloudOwner: row.owner,
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
    if (item?.id) byId.set(item.cloudClientId || item.id, item);
  }
  for (const remote of remoteList) {
    if (!remote?.id) continue;
    const key = remote.cloudClientId || remote.id;
    const local = byId.get(key);
    // Browser-only consent survives pull/merge, including a remote ID collision.
    if (local?.localOnly === true) continue;
    if (!local || localStamp(remote) > localStamp(local)) {
      byId.set(key, { ...local, ...remote, id: local?.id || remote.id });
    }
  }
  return Array.from(byId.values());
}

// Owner tags live in the existing gallery store, so account deletion's existing
// gallery wipe covers them. Never merge different owners solely by client id.
let activeSession = null;
let generation = 0;
let pushTimer = null;
let storageQueue = Promise.resolve();
const galleryListeners = new Set();

function notifyGallery() {
  for (const listener of galleryListeners) {
    try { listener(); } catch { /* observers cannot break persistence */ }
  }
}

export function onGalleryChange(listener) {
  galleryListeners.add(listener);
  return () => galleryListeners.delete(listener);
}

// Older sync versions wrote unlabelled cloud rows with updated_at. Ownership
// cannot safely be reconstructed: retain these bytes but quarantine them rather
// than assigning them to the next login. Ordinary anonymous saves use createdAt.
function ownerOf(item) {
  return item?.cloudOwner || (item?.updated_at && item?.localOnly !== true ? "legacy-unknown" : null);
}

export function getVisibleGallery(items, profileId = activeSession?.profileId || null) {
  return (Array.isArray(items) ? items : []).filter(item => {
    const owner = ownerOf(item);
    return !owner || owner === profileId;
  });
}

export async function readGallery() {
  return getVisibleGallery(await readGalleryLocal());
}

function serializeStorage(work) {
  const pending = storageQueue.then(work);
  storageQueue = pending.catch(() => {});
  return pending;
}

// App must use this instead of overwriting the raw shared gallery: hidden
// account partitions and legacy quarantine survive saves/deletes in another view.
// Capture the auth generation BEFORE any await, including anonymous writes.
export function persistGallery(items) {
  const epoch = generation;
  const profileId = activeSession?.profileId || null;
  return serializeStorage(async () => {
    if (epoch !== generation) return false;
    const all = await readGalleryLocal();
    if (epoch !== generation) return false;
    const hidden = all.filter(item => !getVisibleGallery([item], profileId).length);
    const visible = items.filter(item => getVisibleGallery([item], profileId).length).map(item => {
      const existing = all.find(row => row.id === item.id && ownerOf(row) === ownerOf(item));
      // Existing anonymous/local-only art stays device-only. New signed-in saves
      // are owned once, and editing a cloud item retains its original owner.
      return { ...item, ...(existing?.cloudOwner ? { cloudOwner: existing.cloudOwner } :
        !existing && profileId && item.localOnly !== true ? { cloudOwner: profileId } : {}) };
    });
    await writeGalleryLocal([...hidden, ...visible]);
    notifyGallery();
    return epoch === generation ? visible : false;
  });
}

function isCurrent(ctx) {
  return activeSession === ctx && ctx?.generation === generation && !ctx.controller.signal.aborted;
}

function requestOptions(ctx) {
  // Explicit immutable auth prevents the SDK from consulting its mutable authStore
  // after an await (or retry). Abort in-flight fetches on every auth generation.
  return { headers: { Authorization: ctx.token }, signal: ctx.controller.signal, requestKey: null };
}

async function clientFor(ctx) {
  if (!isCurrent(ctx)) return null;
  const pb = await getPocketBase();
  if (!isCurrent(ctx) || !pb || !pb.authStore.isValid ||
      pb.authStore.record?.id !== ctx.profileId || pb.authStore.token !== ctx.token) return null;
  return pb;
}

async function upsertSnapshot(pb, item, ctx, nowIso) {
  if (!isCurrent(ctx) || item?.localOnly === true || ownerOf(item) !== ctx.profileId) return;
  const data = galleryToFields(item, ctx.profileId, nowIso);
  const filter = `owner=${JSON.stringify(ctx.profileId)} && client_id=${JSON.stringify(item.cloudClientId || item.id)}`;
  let existing;
  try {
    existing = await pb.collection(COLLECTION).getFirstListItem(filter, requestOptions(ctx));
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
  if (!isCurrent(ctx)) return;
  if (existing && existing.owner !== ctx.profileId) throw new Error("snapshot_owner_mismatch");
  if (existing) await pb.collection(COLLECTION).update(existing.id, data, requestOptions(ctx));
  else await pb.collection(COLLECTION).create(data, requestOptions(ctx));
}

async function pushNow(ctx) {
  const pb = await clientFor(ctx);
  if (!pb) return;
  setStatus("syncing");
  let ok = true;
  try {
    const gallery = await readGalleryLocal();
    for (const item of gallery) {
      if (!isCurrent(ctx)) return;
      try { await upsertSnapshot(pb, item, ctx, new Date().toISOString()); }
      catch { ok = false; }
    }
  } catch { ok = false; }
  if (isCurrent(ctx)) setStatus(ok ? "synced" : "paused");
}

export function schedulePush() {
  const ctx = activeSession;
  if (!ctx) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushNow(ctx).catch(() => { if (isCurrent(ctx)) setStatus("paused"); });
  }, PUSH_DEBOUNCE_MS);
}

export async function pull(ctx = activeSession) {
  const pb = await clientFor(ctx);
  if (!pb) return false;
  setStatus("syncing");
  let ok = true;
  try {
    const rows = await pb.collection(COLLECTION).getFullList({
      ...requestOptions(ctx), filter: `owner=${JSON.stringify(ctx.profileId)}`,
    });
    if (!isCurrent(ctx)) return false;
    await serializeStorage(async () => {
      if (!isCurrent(ctx)) return;
      const all = await readGalleryLocal();
      if (!isCurrent(ctx)) return;
      const own = all.filter(item => ownerOf(item) === ctx.profileId);
      const other = all.filter(item => ownerOf(item) !== ctx.profileId);
      const remote = rows.filter(row => row.owner === ctx.profileId).map(snapshotRowToGallery);
      await writeGalleryLocal([...other, ...mergeByStamp(own, remote)]);
      if (isCurrent(ctx)) notifyGallery();
    });
  } catch { ok = false; }
  if (!isCurrent(ctx)) return false;
  setStatus(ok ? "synced" : "paused");
  return ok;
}

export async function startSync(session) {
  stopSync(); // invalidate pending starts, pulls, pushes and local store writes
  if (!isCloudConfigured || !session?.user?.id || !session.access_token) return;
  const ctx = {
    profileId: session.user.id, token: session.access_token,
    generation, controller: new AbortController(),
  };
  activeSession = ctx;
  notifyGallery();
  try {
    if (!await clientFor(ctx)) return;
    if (await pull(ctx)) await pushNow(ctx);
  } catch { if (isCurrent(ctx)) setStatus("paused"); }
}

export function stopSync() {
  generation += 1;
  activeSession?.controller.abort();
  activeSession = null;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = null;
  setStatus("signed-out");
  notifyGallery();
}

export function isSyncing() {
  return Boolean(activeSession);
}
