import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";

import { createDefaultLayers, DEFAULT_FRAME_DURATION_MS, strokesToItems } from "./constants";
import type { DrawingProject, Frame, Layer } from "./types";

const PROJECTS_KEY = "happy-paint:projects";
const SETTINGS_KEY = "happy-paint:settings";
const DOCUMENT_ROOT = `${FileSystem.documentDirectory ?? ""}happy-paint`;

export async function ensureStorageReady() {
  const info = await FileSystem.getInfoAsync(DOCUMENT_ROOT);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(DOCUMENT_ROOT, { intermediates: true });
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

export async function loadProjects(): Promise<DrawingProject[]> {
  const raw = await AsyncStorage.getItem(PROJECTS_KEY);
  if (!raw) {
    return [];
  }

  try {
    const projects = JSON.parse(raw) as DrawingProject[];
    return projects.map(migrateProject).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function saveProjects(projects: DrawingProject[]) {
  await AsyncStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
}

export async function upsertProject(project: DrawingProject) {
  const projects = await loadProjects();
  const next = [project, ...projects.filter((item) => item.id !== project.id)];
  await saveProjects(next);
  return next;
}

export async function deleteProject(projectId: string) {
  const projects = await loadProjects();
  await saveProjects(projects.filter((item) => item.id !== projectId));

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
