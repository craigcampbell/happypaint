// Local-first cloud sync (RN / Expo). ACTIVE ONLY WHEN SIGNED IN.
//
// The on-device stores remain the source of truth and the app is fully usable
// offline / signed out. When a session exists we mirror the local data up to
// Supabase and merge remote rows down with last-write-wins by `updated_at`.
//
// SCOPE (this build): drawings (project_snapshots) + paint space (space_assets).
// DEFERRED (noted, not wired here): economy ledger, events, room replay, and
// the image/replay BINARY files (PNG previews, replay snapshots, GIF exports) —
// those belong in Storage buckets. We sync the JSON project SHAPE (layers/frames)
// into project_snapshots, never the image files. previewUri / sticker uris point
// at local file paths and are intentionally left out of the synced payload.
//
// Tables + keys (EXACT backend contract):
//   project_snapshots — UPSERT on (profile_id, client_id). client_id = the
//     device-local DrawingProject.id. Columns we set: profile_id, client_id,
//     title, layers (jsonb), frames (jsonb), frame_count, updated_at (ms epoch
//     from the local project, ISO), updated_device.
//   space_assets — UPSERT on (owner_profile_id, client_id). client_id = the
//     device-local SpaceAsset.id. Columns: owner_profile_id, kind, title,
//     payload (jsonb), client_id, updated_at, visibility, moderation_status,
//     brush_recipe.
//
// Everything is best-effort try/catch: a sync failure never blocks the UI,
// never throws into a caller, and never corrupts local data.

import { Platform } from "react-native";

import { getActiveProfileId, getSupabaseClient } from "./auth";
import { loadProjects, saveProject } from "./storage";
import { loadSpaceAssets, saveSpaceAssets } from "./paintSpace";
import type { DrawingProject, SpaceAsset } from "./types";

const SYNC_DEBOUNCE_MS = 1500;
const UPDATED_DEVICE = `expo/${Platform.OS}`;

// --- Status -----------------------------------------------------------------
export type SyncStatus =
  | "idle" // not signed in / sync inactive
  | "syncing"
  | "synced"
  | "offline"; // last attempt failed (likely no network) — local is safe

let status: SyncStatus = "idle";
let lastSyncedAt: number | null = null;
const statusListeners = new Set<(status: SyncStatus, lastSyncedAt: number | null) => void>();

function setStatus(next: SyncStatus) {
  status = next;
  if (next === "synced") {
    lastSyncedAt = Date.now();
  }
  for (const listener of statusListeners) {
    try {
      listener(status, lastSyncedAt);
    } catch {
      // ignore listener errors
    }
  }
}

export function getSyncStatus(): { status: SyncStatus; lastSyncedAt: number | null } {
  return { status, lastSyncedAt };
}

// Subscribe to sync status changes. Returns an unsubscribe fn. Fires once
// immediately with the current value so the UI can render without waiting.
export function onSyncStatusChange(
  listener: (status: SyncStatus, lastSyncedAt: number | null) => void
): () => void {
  statusListeners.add(listener);
  try {
    listener(status, lastSyncedAt);
  } catch {
    // ignore
  }
  return () => {
    statusListeners.delete(listener);
  };
}

// Human-readable one-liner for Settings. Pass an explicit status (e.g. from
// React state) or omit to read the current module status.
export function syncStatusLabel(forStatus: SyncStatus = status): string {
  switch (forStatus) {
    case "syncing":
      return "Syncing your work…";
    case "synced":
      return "Synced to the cloud.";
    case "offline":
      return "Saved on this device — will sync when you're back online.";
    case "idle":
    default:
      return "Cloud sync ready.";
  }
}

// --- Active state ------------------------------------------------------------
let active = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingProjects = false;
let pendingSpace = false;

function isActive(): boolean {
  return active && Boolean(getSupabaseClient()) && Boolean(getActiveProfileId());
}

// --- Row mappers -------------------------------------------------------------
function toSnapshotRow(profileId: string, project: DrawingProject) {
  // Active frame's layer stack as the canonical `layers` column (the backend
  // contract keeps both `layers` and `frames`); `frames` carries the full
  // animation model. Image/preview file uris are intentionally excluded.
  const activeFrame =
    project.frames.find((frame) => frame.id === project.activeFrameId) ?? project.frames[0];
  return {
    profile_id: profileId,
    client_id: project.id,
    title: project.title,
    layers: activeFrame?.layers ?? [],
    frames: project.frames,
    frame_count: project.frames.length,
    updated_at: new Date(project.updatedAt).toISOString(),
    updated_device: UPDATED_DEVICE
  };
}

function toSpaceRow(ownerProfileId: string, asset: SpaceAsset) {
  return {
    owner_profile_id: ownerProfileId,
    client_id: asset.id,
    kind: asset.kind,
    title: asset.title,
    payload: asset.payload,
    updated_at: new Date(asset.updatedAt).toISOString(),
    visibility: asset.visibility ?? "private",
    moderation_status: asset.moderation_status ?? "pending",
    brush_recipe: asset.brush_recipe ?? null
  };
}

// --- Push --------------------------------------------------------------------
async function pushProjects(profileId: string) {
  const client = getSupabaseClient();
  if (!client) {
    return;
  }
  const projects = await loadProjects();
  if (projects.length === 0) {
    return;
  }
  const rows = projects.map((project) => toSnapshotRow(profileId, project));
  const { error } = await client
    .from("project_snapshots")
    .upsert(rows, { onConflict: "profile_id,client_id" });
  if (error) {
    throw error;
  }
}

async function pushSpace(profileId: string) {
  const client = getSupabaseClient();
  if (!client) {
    return;
  }
  const assets = await loadSpaceAssets();
  if (assets.length === 0) {
    return;
  }
  const rows = assets.map((asset) => toSpaceRow(profileId, asset));
  const { error } = await client
    .from("space_assets")
    .upsert(rows, { onConflict: "owner_profile_id,client_id" });
  if (error) {
    throw error;
  }
}

// --- Pull (last-write-wins by updated_at) ------------------------------------
async function pullProjects(profileId: string) {
  const client = getSupabaseClient();
  if (!client) {
    return;
  }
  const { data, error } = await client
    .from("project_snapshots")
    .select("client_id,title,frames,updated_at")
    .eq("profile_id", profileId);
  if (error) {
    throw error;
  }
  if (!data || data.length === 0) {
    return;
  }

  const local = await loadProjects();
  const localById = new Map(local.map((project) => [project.id, project]));

  for (const row of data) {
    const remoteId = row.client_id as string;
    const remoteUpdated = Date.parse(row.updated_at as string);
    if (!remoteId || Number.isNaN(remoteUpdated)) {
      continue;
    }
    const existing = localById.get(remoteId);
    // LWW: skip if local copy is the same age or newer — never clobber newer
    // local edits.
    if (existing && existing.updatedAt >= remoteUpdated) {
      continue;
    }
    const frames = Array.isArray(row.frames) ? (row.frames as DrawingProject["frames"]) : [];
    if (frames.length === 0) {
      continue;
    }
    const merged: DrawingProject = {
      // Preserve local-only fields (preview/import uris, texture) when present;
      // those are device-local and not part of the synced payload.
      ...(existing ?? {
        id: remoteId,
        texture: "smooth",
        createdAt: remoteUpdated,
        activeFrameId: frames[0].id
      }),
      id: remoteId,
      title: (row.title as string) ?? existing?.title ?? "Untitled",
      frames,
      activeFrameId:
        existing && frames.some((frame) => frame.id === existing.activeFrameId)
          ? existing.activeFrameId
          : frames[0].id,
      updatedAt: remoteUpdated
    };
    await saveProject(merged);
  }
}

async function pullSpace(profileId: string) {
  const client = getSupabaseClient();
  if (!client) {
    return;
  }
  const { data, error } = await client
    .from("space_assets")
    .select("client_id,kind,title,payload,updated_at,visibility,moderation_status,brush_recipe")
    .eq("owner_profile_id", profileId);
  if (error) {
    throw error;
  }
  if (!data || data.length === 0) {
    return;
  }

  const local = await loadSpaceAssets();
  const localById = new Map(local.map((asset) => [asset.id, asset]));
  let changed = false;

  for (const row of data) {
    const remoteId = row.client_id as string;
    const remoteUpdated = Date.parse(row.updated_at as string);
    if (!remoteId || Number.isNaN(remoteUpdated)) {
      continue;
    }
    const existing = localById.get(remoteId);
    if (existing && existing.updatedAt >= remoteUpdated) {
      continue; // local newer/equal — keep it
    }
    const merged: SpaceAsset = {
      ...(existing ?? { createdAt: remoteUpdated }),
      id: remoteId,
      kind: row.kind as SpaceAsset["kind"],
      title: (row.title as string) ?? existing?.title ?? "Untitled",
      payload: row.payload as SpaceAsset["payload"],
      updatedAt: remoteUpdated,
      visibility: (row.visibility as SpaceAsset["visibility"]) ?? existing?.visibility,
      moderation_status:
        (row.moderation_status as SpaceAsset["moderation_status"]) ?? existing?.moderation_status,
      brush_recipe: (row.brush_recipe as SpaceAsset["brush_recipe"]) ?? existing?.brush_recipe
    };
    localById.set(remoteId, merged);
    changed = true;
  }

  if (changed) {
    await saveSpaceAssets(Array.from(localById.values()));
  }
}

// --- Orchestration -----------------------------------------------------------

// Full pull then push. Called on sign-in and on demand. Best-effort.
export async function syncNow(): Promise<void> {
  if (!isActive()) {
    return;
  }
  const profileId = getActiveProfileId();
  if (!profileId) {
    return;
  }
  setStatus("syncing");
  try {
    // Pull first (merge remote → local), then push the merged local set up.
    await pullProjects(profileId);
    await pullSpace(profileId);
    await pushProjects(profileId);
    await pushSpace(profileId);
    setStatus("synced");
  } catch {
    // Network / transient errors are expected offline; local data is safe.
    setStatus("offline");
  }
}

async function runPush() {
  if (!isActive()) {
    return;
  }
  const profileId = getActiveProfileId();
  if (!profileId) {
    return;
  }
  const doProjects = pendingProjects;
  const doSpace = pendingSpace;
  pendingProjects = false;
  pendingSpace = false;
  setStatus("syncing");
  try {
    if (doProjects) {
      await pushProjects(profileId);
    }
    if (doSpace) {
      await pushSpace(profileId);
    }
    setStatus("synced");
  } catch {
    setStatus("offline");
  }
}

function schedulePush() {
  if (!isActive()) {
    return;
  }
  if (pushTimer) {
    clearTimeout(pushTimer);
  }
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void runPush();
  }, SYNC_DEBOUNCE_MS);
}

// Debounced push hooks. Called from the local persistence chokepoints
// (storage.saveProject / paintSpace.saveSpaceAssets). No-op unless active.
export function notifyProjectsChanged(): void {
  if (!isActive()) {
    return;
  }
  pendingProjects = true;
  schedulePush();
}

export function notifySpaceChanged(): void {
  if (!isActive()) {
    return;
  }
  pendingSpace = true;
  schedulePush();
}

// Start sync on sign-in: enable hooks and run an initial pull+push.
export function startSync(): void {
  if (!getSupabaseClient() || !getActiveProfileId()) {
    return;
  }
  active = true;
  void syncNow();
}

// Stop sync on sign-out: disable hooks, drop pending work, reset status.
export function stopSync(): void {
  active = false;
  pendingProjects = false;
  pendingSpace = false;
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  setStatus("idle");
}
