// In-app account deletion + local data wipe (App Review REQUIREMENT).
//
// docs/social-backend.md §"Store Review Notes": "Add in-app account deletion
// before release." and §monetization: account deletion must NEVER be monetized
// or gated. This flow is free, always available, and reachable from the account
// UI without an account or any purchase.
//
// On confirm we:
//   1. Record an account_deletion_requests-shaped row locally (status
//      'requested', requested_at, scheduled_purge_at = now + grace window). If
//      Supabase auth is configured we ALSO file it server-side (best-effort).
//   2. WIPE every local store the app uses (IndexedDB + localStorage): draft,
//      gallery, paint space, economy, AI consent + generations, replay
//      snapshots, brush packs + moderation queues, event/social state.
//   3. Sign out (if signed in). The caller shows confirmation.
//
// Local-only by default (no live backend). Everything here is sync-ready.

import { idbDelete, idbDeleteKV, isIdbAvailable } from "./idb";
import { isCloudConfigured, getSession, getPocketBase, signOut } from "./auth";

// Mirror of account_deletion_requests, persisted locally so the UI can show the
// pending request + scheduled purge even with no backend.
export const DELETION_REQUEST_STORAGE_KEY = "happypaint:account-deletion:v1";

// Grace window before a hard purge would run server-side (the local wipe is
// immediate; this models the schema's scheduled_purge_at).
const PURGE_GRACE_DAYS = 30;

// Every localStorage key the app writes. Kept in one place so the wipe is total.
const LOCAL_STORAGE_KEYS = [
  "happypaint:draft:v3",
  "happypaint:gallery:v2",
  "happypaint:studio-pass:v1",
  "happypaint:paintspace:v1",
  "happypaint:economy:v1",
  "happypaint:ai-consent:v1",
  "happypaint:ai-generations:v1",
  "happypaint:ai-moderation-actions:v1",
  "happypaint:brush-packs:v1",
  "happypaint:asset-moderation-queue:v1",
  "happypaint:asset-moderation-actions:v1",
  "happypaint:asset-uses:v1",
  "happypaint:event-profile:v1",
  "happypaint:event-votes:v1",
  "happypaint:social-profile:v1",
  "happypaint:social-sessions:v1",
  "happypaint:welcomed:v1",
];

// IndexedDB "drafts" store key (autosaved draft layer Blobs).
const IDB_DRAFT_KEY = "draft:v4";
// IndexedDB "kv" store keys (gallery, paint space, economy, AI consent, replay).
const IDB_KV_KEYS = [
  "gallery:v2",
  "paintspace:v1",
  "economy:v1",
  "ai-consent:v1",
  "replay:v1:current",
];

function readDeletionRequest() {
  try {
    const raw = window.localStorage.getItem(DELETION_REQUEST_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function getDeletionRequest() {
  return readDeletionRequest();
}

// Build + persist the local account_deletion_requests mirror.
function recordDeletionRequest() {
  const requestedAt = new Date();
  const purgeAt = new Date(requestedAt.getTime() + PURGE_GRACE_DAYS * 24 * 60 * 60 * 1000);
  const request = {
    id:
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `del-${Date.now()}`,
    profile_id: "local-me",
    status: "requested",
    requested_at: requestedAt.toISOString(),
    scheduled_purge_at: purgeAt.toISOString(),
    completed_at: null,
    note: "In-app deletion requested by the account owner.",
  };
  try {
    // Write BEFORE the wipe; the wipe clears app data keys but not this record,
    // so the user keeps proof their request was filed.
    window.localStorage.setItem(DELETION_REQUEST_STORAGE_KEY, JSON.stringify(request));
  } catch {
    // Non-fatal: deletion still proceeds even if we can't persist the receipt.
  }
  return request;
}

// Best-effort server-side filing when auth is configured. Never throws; the
// local wipe is the source of truth on this device.
async function fileServerDeletion(request) {
  if (!isCloudConfigured) {
    return { filed: false, reason: "local-only" };
  }
  try {
    const session = await getSession();
    if (!session) {
      return { filed: false, reason: "signed-out" };
    }
    const pb = await getPocketBase();
    if (!pb || !pb.authStore.isValid) {
      return { filed: false, reason: "no-client" };
    }
    // PocketBase: a user may delete their OWN record (collection delete rule
    // `@request.auth.id = id`), which immediately and permanently removes the
    // account and cascade-deletes their owned rows (gallery snapshots). This is
    // a true hard delete, not a scheduled request. Best-effort — the local wipe
    // is the source of truth on this device regardless of result.
    const id = pb.authStore.record?.id;
    if (id) {
      await pb.collection("users").delete(id);
    }
    return { filed: true, reason: "deleted", server_request: request ?? null };
  } catch (error) {
    return { filed: false, reason: error?.message || "error" };
  }
}

// Clear every local store. Best-effort per key so one failure can't abort the
// rest — App Review requires deletion to be reliable.
export async function wipeLocalData() {
  const cleared = [];

  for (const key of LOCAL_STORAGE_KEYS) {
    try {
      window.localStorage.removeItem(key);
      cleared.push(`localStorage:${key}`);
    } catch {
      // keep going
    }
  }

  if (isIdbAvailable()) {
    try {
      await idbDelete(IDB_DRAFT_KEY);
      cleared.push(`idb:draft:${IDB_DRAFT_KEY}`);
    } catch {
      // keep going
    }
    for (const key of IDB_KV_KEYS) {
      try {
        await idbDeleteKV(key);
        cleared.push(`idb:kv:${key}`);
      } catch {
        // keep going
      }
    }
  }

  return cleared;
}

// Full deletion flow: file the request (local mirror + best-effort backend),
// wipe all local data, sign out. Returns a summary for the confirmation UI.
export async function deleteAccountAndData() {
  const request = recordDeletionRequest();
  const server = await fileServerDeletion(request);
  const cleared = await wipeLocalData();
  let signedOut = false;
  try {
    await signOut();
    signedOut = true;
  } catch {
    signedOut = false;
  }
  return { request, server, cleared, signedOut };
}
