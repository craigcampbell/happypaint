import AsyncStorage from "@react-native-async-storage/async-storage";

import type { SpaceAsset } from "./types";

// Local Paint Space locker. Mirrors the backend `space_assets` shape (id, kind,
// title, payload, thumbnail, createdAt) so it is sync-ready, but is fully local
// (no networking). Following the conventions in storage.ts.
const PAINT_SPACE_KEY = "happy-paint:paintspace:v1";

export async function loadSpaceAssets(): Promise<SpaceAsset[]> {
  const raw = await AsyncStorage.getItem(PAINT_SPACE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const assets = JSON.parse(raw) as SpaceAsset[];
    if (!Array.isArray(assets)) {
      return [];
    }
    return assets.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function saveSpaceAssets(assets: SpaceAsset[]) {
  await AsyncStorage.setItem(PAINT_SPACE_KEY, JSON.stringify(assets));
}

export async function upsertSpaceAsset(asset: SpaceAsset): Promise<SpaceAsset[]> {
  const assets = await loadSpaceAssets();
  const next = [asset, ...assets.filter((item) => item.id !== asset.id)].sort(
    (a, b) => b.createdAt - a.createdAt
  );
  await saveSpaceAssets(next);
  return next;
}

export async function deleteSpaceAsset(assetId: string): Promise<SpaceAsset[]> {
  const assets = await loadSpaceAssets();
  const next = assets.filter((item) => item.id !== assetId);
  await saveSpaceAssets(next);
  return next;
}

export async function renameSpaceAsset(assetId: string, title: string): Promise<SpaceAsset[]> {
  const assets = await loadSpaceAssets();
  const next = assets.map((item) =>
    item.id === assetId ? { ...item, title, updatedAt: Date.now() } : item
  );
  await saveSpaceAssets(next);
  return next;
}

export function makeSpaceAssetId() {
  return `asset-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
