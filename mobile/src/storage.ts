import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";

import { createDefaultLayers, DEFAULT_FRAME_DURATION_MS, strokesToItems } from "./constants";
import type { DrawingProject, Frame, Layer, LayerItem, ProjectIndexEntry } from "./types";

// Legacy single-key store (every project serialized into one JSON blob). Read
// once on boot to migrate into the per-project layout, then removed.
const LEGACY_PROJECTS_KEY = "happy-paint:projects";
// Lightweight gallery index (ids + title + updatedAt + previewUri only).
const PROJECTS_INDEX_KEY = "happy-paint:projects:index:v2";
// Flag set once the legacy blob has been migrated so we don't re-run it.
const MIGRATION_FLAG_KEY = "happy-paint:projects:migrated:v2";
const SETTINGS_KEY = "happy-paint:settings";
const DOCUMENT_ROOT = `${FileSystem.documentDirectory ?? ""}happy-paint`;
// Each project body lives in its own file (no CursorWindow / blob-size limit).
const PROJECTS_DIR = `${DOCUMENT_ROOT}/projects`;

export async function ensureStorageReady() {
  const info = await FileSystem.getInfoAsync(DOCUMENT_ROOT);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(DOCUMENT_ROOT, { intermediates: true });
  }
  const projectsInfo = await FileSystem.getInfoAsync(PROJECTS_DIR);
  if (!projectsInfo.exists) {
    await FileSystem.makeDirectoryAsync(PROJECTS_DIR, { intermediates: true });
  }
}

export function previewPath(projectId: string) {
  return `${DOCUMENT_ROOT}/preview-${projectId}.png`;
}

export function exportPath(projectId: string) {
  return `${FileSystem.cacheDirectory ?? DOCUMENT_ROOT}/happy-paint-${projectId}.png`;
}

export function loopExportPath(projectId: string, extension: "gif" | "png") {
  return `${FileSystem.cacheDirectory ?? DOCUMENT_ROOT}/happy-paint-loop-${projectId}.${extension}`;
}

// Persistent path for a saved Paint Space asset thumbnail/sticker bitmap.
export function spaceAssetPath(assetId: string, suffix = "png") {
  return `${DOCUMENT_ROOT}/space-${assetId}.${suffix}`;
}

function projectBodyPath(projectId: string) {
  return `${PROJECTS_DIR}/project-${projectId}.json`;
}

function makeFrameId() {
  return `frame-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function frameFromLayers(layers: Layer[], activeLayerId?: string): Frame {
  const resolvedActive =
    activeLayerId && layers.some((layer) => layer.id === activeLayerId) ? activeLayerId : layers[0].id;
  return {
    id: makeFrameId(),
    durationMs: DEFAULT_FRAME_DURATION_MS,
    layers,
    activeLayerId: resolvedActive
  };
}

// Backward-compat migration across three generations of the project model:
//  - pre-layer:  top-level `strokes` array only.
//  - pre-frame:  top-level `layers` / `activeLayerId` (Layer Lite).
//  - current:    `frames` (each frame wraps its own layer stack).
// Either legacy shape folds into a single frame. Legacy top-level layers/strokes
// are stripped from the persisted output but remain readable on the input type.
export function migrateProject(project: DrawingProject): DrawingProject {
  const { strokes: _strokes, layers: legacyLayers, activeLayerId: legacyActive, ...rest } = project;

  // Already frame-based: just validate the active frame pointer.
  if (Array.isArray(project.frames) && project.frames.length > 0) {
    const frames = project.frames.map((frame) => {
      const layers = Array.isArray(frame.layers) && frame.layers.length > 0 ? frame.layers : createDefaultLayers();
      const activeLayerId =
        frame.activeLayerId && layers.some((layer) => layer.id === frame.activeLayerId)
          ? frame.activeLayerId
          : layers[0].id;
      return { ...frame, layers, activeLayerId };
    });
    const activeFrameId =
      project.activeFrameId && frames.some((frame) => frame.id === project.activeFrameId)
        ? project.activeFrameId
        : frames[0].id;
    return { ...rest, frames, activeFrameId };
  }

  // Pre-frame Layer Lite project: wrap its layer stack in one frame.
  if (Array.isArray(legacyLayers) && legacyLayers.length > 0) {
    const frame = frameFromLayers(legacyLayers, legacyActive);
    return { ...rest, frames: [frame], activeFrameId: frame.id };
  }

  // Pre-layer project: wrap its flat strokes into the bottom default layer.
  const layers = createDefaultLayers();
  layers[0] = { ...layers[0], items: strokesToItems(project.strokes ?? []) };
  const frame = frameFromLayers(layers);
  return { ...rest, frames: [frame], activeFrameId: frame.id };
}

// --- Serialization size control --------------------------------------------
// Round stroke point / spray dot coordinates so the persisted JSON is smaller.
// Two decimals is well below sub-pixel visibility on a phone canvas and roughly
// halves the byte count of a dense stroke. Returns a serialization-only copy;
// the in-memory project keeps full precision.
function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function quantizeItem(item: LayerItem): LayerItem {
  if (item.kind === "stroke") {
    const { stroke } = item;
    return {
      ...item,
      stroke: {
        ...stroke,
        points: stroke.points.map((point) => ({
          x: round2(point.x),
          y: round2(point.y),
          size: round2(point.size)
        })),
        sprayDots: stroke.sprayDots
          ? stroke.sprayDots.map((dot) => ({ x: round2(dot.x), y: round2(dot.y), radius: round2(dot.radius) }))
          : stroke.sprayDots
      }
    };
  }
  return item;
}

function quantizeProject(project: DrawingProject): DrawingProject {
  return {
    ...project,
    frames: project.frames.map((frame) => ({
      ...frame,
      layers: frame.layers.map((layer) => ({ ...layer, items: layer.items.map(quantizeItem) }))
    }))
  };
}

function toIndexEntry(project: DrawingProject): ProjectIndexEntry {
  return {
    id: project.id,
    title: project.title,
    updatedAt: project.updatedAt,
    createdAt: project.createdAt,
    previewUri: project.previewUri
  };
}

async function readIndex(): Promise<ProjectIndexEntry[]> {
  const raw = await AsyncStorage.getItem(PROJECTS_INDEX_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as ProjectIndexEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    // Surface but do NOT wipe: the index is rebuildable from project files, and
    // returning [] here would hide existing artwork. Keep the raw key intact.
    console.warn("[happy-paint] Failed to parse project index; preserving raw data.", error);
    return [];
  }
}

async function writeIndex(entries: ProjectIndexEntry[]) {
  const sorted = [...entries].sort((a, b) => b.updatedAt - a.updatedAt);
  await AsyncStorage.setItem(PROJECTS_INDEX_KEY, JSON.stringify(sorted));
}

async function readProjectBody(id: string): Promise<DrawingProject | null> {
  const path = projectBodyPath(id);
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) {
    return null;
  }
  const raw = await FileSystem.readAsStringAsync(path, { encoding: FileSystem.EncodingType.UTF8 });
  // A parse failure here is real data loss territory; throw so the caller can
  // skip this one project without discarding the rest of the gallery, and the
  // raw file is left on disk for recovery rather than overwritten.
  return migrateProject(JSON.parse(raw) as DrawingProject);
}

async function writeProjectBody(project: DrawingProject) {
  await ensureStorageReady();
  await FileSystem.writeAsStringAsync(projectBodyPath(project.id), JSON.stringify(quantizeProject(project)), {
    encoding: FileSystem.EncodingType.UTF8
  });
}

// One-time migration of the legacy single-key blob into per-project files.
async function migrateLegacyIfNeeded() {
  const done = await AsyncStorage.getItem(MIGRATION_FLAG_KEY);
  if (done) {
    return;
  }
  const raw = await AsyncStorage.getItem(LEGACY_PROJECTS_KEY);
  if (raw) {
    try {
      const legacy = JSON.parse(raw) as DrawingProject[];
      if (Array.isArray(legacy)) {
        const entries: ProjectIndexEntry[] = [];
        for (const stored of legacy) {
          const project = migrateProject(stored);
          await writeProjectBody(project);
          entries.push(toIndexEntry(project));
        }
        // Merge with any index that may already exist (defensive).
        const existing = await readIndex();
        const merged = new Map<string, ProjectIndexEntry>();
        for (const entry of [...existing, ...entries]) {
          merged.set(entry.id, entry);
        }
        await writeIndex(Array.from(merged.values()));
      }
      // Keep the legacy key on disk (do NOT delete) so a failed/partial
      // migration can be retried and original data is never destroyed.
    } catch (error) {
      // Don't set the flag: leave the raw legacy data intact and retry next boot.
      console.warn("[happy-paint] Legacy project migration failed; will retry on next launch.", error);
      return;
    }
  }
  await AsyncStorage.setItem(MIGRATION_FLAG_KEY, "1");
}

export async function loadProjects(): Promise<DrawingProject[]> {
  await ensureStorageReady();
  await migrateLegacyIfNeeded();

  const index = await readIndex();
  const projects: DrawingProject[] = [];
  for (const entry of index) {
    try {
      const project = await readProjectBody(entry.id);
      if (project) {
        // Trust the freshly-read body, but fall back to the index preview if the
        // body predates a preview write.
        projects.push({ ...project, previewUri: project.previewUri ?? entry.previewUri });
      }
    } catch (error) {
      // A single unreadable project must NOT wipe the gallery. Skip it, keep its
      // file on disk for recovery, and surface the failure.
      console.warn(`[happy-paint] Could not read project ${entry.id}; skipping (data preserved).`, error);
    }
  }
  return projects.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Persist a full set of projects (used when the caller already holds the whole
// list, e.g. App's persistProject). Writes each body to its own file and the
// lightweight index in one shot.
export async function saveProjects(projects: DrawingProject[]) {
  await ensureStorageReady();
  for (const project of projects) {
    await writeProjectBody(project);
  }
  await writeIndex(projects.map(toIndexEntry));
}

// Persist a single project body + update its index entry. Cheaper than rewriting
// every project, so this is the per-stroke / debounced path.
export async function saveProject(project: DrawingProject) {
  await writeProjectBody(project);
  const index = await readIndex();
  const next = [toIndexEntry(project), ...index.filter((entry) => entry.id !== project.id)];
  await writeIndex(next);
}

export async function upsertProject(project: DrawingProject) {
  await saveProject(project);
  return loadProjects();
}

export async function deleteProject(projectId: string) {
  const index = await readIndex();
  await writeIndex(index.filter((entry) => entry.id !== projectId));

  const body = projectBodyPath(projectId);
  const bodyInfo = await FileSystem.getInfoAsync(body);
  if (bodyInfo.exists) {
    await FileSystem.deleteAsync(body, { idempotent: true });
  }

  const preview = previewPath(projectId);
  const info = await FileSystem.getInfoAsync(preview);
  if (info.exists) {
    await FileSystem.deleteAsync(preview, { idempotent: true });
  }
}

export async function writePng(uri: string, base64: string) {
  await ensureStorageReady();
  await FileSystem.writeAsStringAsync(uri, base64, {
    encoding: FileSystem.EncodingType.Base64
  });
}

// Write a small UTF-8 text sidecar (e.g. the sprite-sheet durations JSON).
export async function writeText(uri: string, text: string) {
  await ensureStorageReady();
  await FileSystem.writeAsStringAsync(uri, text, {
    encoding: FileSystem.EncodingType.UTF8
  });
}

export async function copyImportAsync(uri: string, projectId: string) {
  await ensureStorageReady();
  const extension = uri.split(".").pop()?.split("?")[0] ?? "jpg";
  const destination = `${DOCUMENT_ROOT}/import-${projectId}.${extension}`;
  await FileSystem.copyAsync({ from: uri, to: destination });
  return destination;
}

export async function loadStoredSettings<T>(fallback: T): Promise<T> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  if (!raw) {
    return fallback;
  }

  try {
    return { ...fallback, ...JSON.parse(raw) } as T;
  } catch {
    return fallback;
  }
}

export async function saveStoredSettings(settings: unknown) {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
