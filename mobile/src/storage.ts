import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";

import type { DrawingProject } from "./types";

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

export async function loadProjects(): Promise<DrawingProject[]> {
  const raw = await AsyncStorage.getItem(PROJECTS_KEY);
  if (!raw) {
    return [];
  }

  try {
    const projects = JSON.parse(raw) as DrawingProject[];
    return projects.sort((a, b) => b.updatedAt - a.updatedAt);
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
