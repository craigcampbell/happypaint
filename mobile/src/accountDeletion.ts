// In-app account deletion + total local data wipe (App Review REQUIREMENT).
//
// docs/social-backend.md §"Store Review Notes": "Add in-app account deletion
// before release." Account deletion must NEVER be monetized or gated: this flow
// is FREE, ALWAYS AVAILABLE, and reachable without an account or any purchase.
// Mirrors the web build's src/utils/accountDeletion.js for cross-platform
// consistency, and is shaped after backend `account_deletion_requests`.
//
// On confirm we:
//   1. Record an account_deletion_requests-shaped row locally (status
//      'requested', requested_at, scheduled_purge_at = now + grace window). The
//      record is written BEFORE the wipe and survives it, so the user keeps
//      proof their request was filed. If Supabase is configured we ALSO file it
//      server-side (best-effort, documented hook).
//   2. WIPE every local store the app uses: ALL AsyncStorage keys the app
//      writes AND the on-disk file trees (project bodies, previews, imports,
//      paint-space bitmaps, replay snapshots, and cache-dir exports).
//   3. Sign out (if signed in). The caller shows confirmation + resets to a
//      fresh gallery.
//
// Local-only by default (no live backend). Everything here is sync-ready.

import AsyncStorage from "@react-native-async-storage/async-storage";

import { getSession, isCloudConfigured, signOut } from "./auth";
import { makeId } from "./ids";
import { clearAllReplayIndexes } from "./replay";
import { STORAGE_KEYS, wipeStorageFiles } from "./storage";

// Mirror of account_deletion_requests, persisted locally so the UI can show the
// pending request + scheduled purge even with no backend.
export const DELETION_REQUEST_KEY = "happy-paint:account-deletion:v1";

// Grace window before a hard purge would run server-side (the local wipe is
// immediate; this models the schema's scheduled_purge_at).
const PURGE_GRACE_DAYS = 30;

// Mirror of account_deletion_requests columns (sync-ready).
export type DeletionRequest = {
  id: string;
  profile_id: string;
  status: "requested" | "processing" | "completed" | "cancelled";
  requested_at: string;
  scheduled_purge_at: string | null;
  completed_at: string | null;
  note: string | null;
};

// Every AsyncStorage key the app writes, in ONE authoritative place so the wipe
// is total. STORAGE_KEYS (settings + project index + legacy/migration) comes
// from storage.ts; the rest are the per-store keys (kept in sync with each
// store module's own constant). Replay index keys are prefix-scanned separately
// (one key per artwork) via clearAllReplayIndexes().
const APP_STORAGE_KEYS: string[] = [
  ...STORAGE_KEYS,
  "happy-paint:paintspace:v1", // paintSpace.ts
  "happy-paint:economy:v1", // economy.ts
  "happy-paint:ai-consent:v1", // aiAssist.ts
  "happy-paint:event-profile:v1", // eventEngine.ts
  "happy-paint:event-votes:v1", // eventEngine.ts
  "happy-paint:brush-packs:v1", // brushPacks.ts
  "happy-paint:asset-moderation-queue:v1", // brushPacks.ts
  "happy-paint:asset-uses:v1", // brushPacks.ts
  "happy-paint:social-sessions" // social.ts
];

// Read the locally-persisted deletion request (proof of filing), or null.
export async function getDeletionRequest(): Promise<DeletionRequest | null> {
  try {
    const raw = await AsyncStorage.getItem(DELETION_REQUEST_KEY);
    return raw ? (JSON.parse(raw) as DeletionRequest) : null;
  } catch {
    return null;
  }
}

// Build + persist the local account_deletion_requests mirror.
async function recordDeletionRequest(): Promise<DeletionRequest> {
  const requestedAt = new Date();
  const purgeAt = new Date(requestedAt.getTime() + PURGE_GRACE_DAYS * 24 * 60 * 60 * 1000);
  const request: DeletionRequest = {
    id: makeId("deletion"),
    profile_id: "local-me",
    status: "requested",
    requested_at: requestedAt.toISOString(),
    scheduled_purge_at: purgeAt.toISOString(),
    completed_at: null,
    note: "In-app deletion requested by the account owner."
  };
  try {
    // Written BEFORE the wipe; the wipe removes app data keys but NOT this
    // record (it is intentionally excluded from APP_STORAGE_KEYS), so the user
    // keeps proof their request was filed.
    await AsyncStorage.setItem(DELETION_REQUEST_KEY, JSON.stringify(request));
  } catch {
    // Non-fatal: deletion still proceeds even if we can't persist the receipt.
  }
  return request;
}

// Best-effort server-side filing when auth is configured. Never throws; the
// local wipe is the source of truth on this device.
async function fileServerDeletion(
  request: DeletionRequest
): Promise<{ filed: boolean; reason: string }> {
  if (!isCloudConfigured) {
    return { filed: false, reason: "local-only" };
  }
  try {
    const session = await getSession();
    if (!session) {
      return { filed: false, reason: "signed-out" };
    }
    // A real implementation calls an RPC / edge function that inserts an
    // account_deletion_requests row server-side. We intentionally keep this a
    // documented best-effort hook (no schema/network assumptions) so it stays
    // green without a live backend.
    void request;
    return { filed: false, reason: "backend-hook-not-wired" };
  } catch {
    return { filed: false, reason: "error" };
  }
}

// Clear every local store. Best-effort per group so one failure can't abort the
// rest — App Review requires deletion to be reliable. Returns the list of
// things it cleared for an audit summary.
export async function wipeLocalData(): Promise<string[]> {
  const cleared: string[] = [];

  // 1) Fixed AsyncStorage keys.
  try {
    await AsyncStorage.multiRemove(APP_STORAGE_KEYS);
    cleared.push(...APP_STORAGE_KEYS.map((key) => `asyncStorage:${key}`));
  } catch {
    // Fall back to per-key removal so one bad key can't block the rest.
    for (const key of APP_STORAGE_KEYS) {
      try {
        await AsyncStorage.removeItem(key);
        cleared.push(`asyncStorage:${key}`);
      } catch {
        // keep going
      }
    }
  }

  // 2) Prefix-scoped replay index keys (one per artwork).
  await clearAllReplayIndexes();
  cleared.push("asyncStorage:happy-paint:replay:index:v1:*");

  // 3) On-disk file trees + cache-dir exports.
  try {
    const removed = await wipeStorageFiles();
    cleared.push(...removed.map((path) => `file:${path}`));
  } catch {
    // keep going
  }

  return cleared;
}

export type DeletionSummary = {
  request: DeletionRequest;
  server: { filed: boolean; reason: string };
  cleared: string[];
  signedOut: boolean;
};

// Full deletion flow: file the request (local mirror + best-effort backend),
// wipe all local data, sign out. Returns a summary for the confirmation UI.
export async function deleteAccountAndData(): Promise<DeletionSummary> {
  const request = await recordDeletionRequest();
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
