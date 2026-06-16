// Community Brush Packs — publish (submit-for-review) + browse + get.
//
// MOCK / LOCAL ONLY (no backend, no network), shaped to mirror the schema (and
// the web build's src/utils/brushPacks.js for cross-platform consistency):
//   - asset_packs            (id, owner_profile_id, title, visibility, version,
//                             status: draft -> pending -> approved -> rejected)
//                            check: visibility public/featured requires status approved
//   - asset_pack_items       (pack_id, asset_id, position) — pack membership
//   - asset_moderation_queue (id, target_kind 'pack', target_id, submitted_by,
//                             status 'pending', submitted_at) — review queue entry
//   - asset_uses             (id, asset_id, used_by_profile_id, context, source_id)
//                             recorded when a browsed pack is "Got" into the locker
//   - space_assets           (kind 'brush', brush_recipe, remix_permission,
//                             visibility) — the assets inside a pack
//
// User-facing scope ONLY: publish (submit) + browse approved + get. Admin-side
// review/approval of submitted packs is a SEPARATE later agent. We seed a few
// already-approved packs so browse is never empty, and persist the user's own
// submitted packs + queue entries locally so the flow is observable end-to-end.

import AsyncStorage from "@react-native-async-storage/async-storage";

import { normalizeRecipe } from "./brushStudio";
import { makeId } from "./ids";
import { makeSpaceAssetId, upsertSpaceAsset } from "./paintSpace";
import type { BrushRecipe, RemixPermission, SpaceAsset, SpaceVisibility } from "./types";

const PACKS_STORAGE_KEY = "happy-paint:brush-packs:v1";
const QUEUE_STORAGE_KEY = "happy-paint:asset-moderation-queue:v1";
const USES_STORAGE_KEY = "happy-paint:asset-uses:v1";

// Visibility offered when publishing (mirrors space_visibility minus 'featured',
// which is admin-assigned). Public requires review before it goes live.
export type PackPublishVisibility = "private" | "friends" | "public";

export const PACK_VISIBILITY_OPTIONS: Array<{ id: PackPublishVisibility; label: string; note: string }> = [
  { id: "private", label: "Private", note: "Only you. Stays in your locker." },
  { id: "friends", label: "Friends only", note: "Friends can get it. Light review." },
  { id: "public", label: "Public", note: "Anyone can get it. Requires review before it goes live." }
];

// Remix permission shown per asset / pack (mirrors asset_remix_permission).
export const REMIX_PERMISSIONS: Array<{ id: RemixPermission; label: string }> = [
  { id: "none", label: "No remixing" },
  { id: "friends", label: "Friends can remix" },
  { id: "public", label: "Anyone can remix" }
];

export function remixLabel(permission: RemixPermission | undefined): string {
  return REMIX_PERMISSIONS.find((item) => item.id === permission)?.label ?? "No remixing";
}

// ---- Types (mirror asset_packs / asset_pack_items / queue / uses) ----
export type PackItem = {
  pack_id: string;
  asset_id: string;
  position: number;
  // Denormalized copy of the asset so browse/get works locally without joins.
  asset: SpaceAsset;
  created_at: string;
};

export type AssetPackStatus = "draft" | "pending" | "approved" | "rejected";

export type AssetPack = {
  id: string;
  owner_profile_id: string;
  authorSpace: string;
  title: string;
  description: string;
  tags: string[];
  visibility: SpaceVisibility;
  version: number;
  status: AssetPackStatus;
  remix_permission: RemixPermission;
  accent: string;
  items: PackItem[];
  created_at: string;
  updated_at: string;
};

export type ModerationQueueEntry = {
  id: string;
  target_kind: "pack";
  target_id: string;
  submitted_by: string;
  status: "pending" | "approved" | "rejected" | "needs_changes";
  reviewer_profile_id: string | null;
  reason: string | null;
  submitted_at: string;
  reviewed_at: string | null;
};

export type AssetUse = {
  id: string;
  asset_id: string;
  used_by_profile_id: string;
  context: "canvas" | "room" | "export" | "remix";
  source_id: string;
  created_at: string;
};

// ---- Curated seed packs (already approved + public) so browse works ----
function seedBrush(input: {
  id: string;
  title: string;
  tags: string[];
  recipe: BrushRecipe;
  remix?: RemixPermission;
}): SpaceAsset {
  const remix = input.remix ?? "public";
  const nowMs = Date.now();
  return {
    id: input.id,
    kind: "brush",
    title: input.title,
    payload: { brush_recipe: input.recipe, tags: input.tags },
    brush_recipe: input.recipe,
    createdAt: nowMs,
    updatedAt: nowMs,
    remix_permission: remix,
    visibility: "public",
    moderation_status: "approved"
  };
}

function seedItems(packId: string, assets: SpaceAsset[]): PackItem[] {
  const created = new Date().toISOString();
  return assets.map((asset, index) => ({
    pack_id: packId,
    asset_id: asset.id,
    position: index,
    asset,
    created_at: created
  }));
}

function makeSeedPack(input: {
  id: string;
  owner: string;
  authorSpace: string;
  title: string;
  description: string;
  tags: string[];
  remix: RemixPermission;
  accent: string;
  assets: SpaceAsset[];
}): AssetPack {
  const created = new Date().toISOString();
  return {
    id: input.id,
    owner_profile_id: input.owner,
    authorSpace: input.authorSpace,
    title: input.title,
    description: input.description,
    tags: input.tags,
    visibility: "public",
    version: 1,
    status: "approved",
    remix_permission: input.remix,
    accent: input.accent,
    items: seedItems(input.id, input.assets),
    created_at: created,
    updated_at: created
  };
}

const SEED_PACKS: AssetPack[] = [
  makeSeedPack({
    id: "pack-neon-arcade",
    owner: "seed-creator-aria",
    authorSpace: "Aria's Space",
    title: "Neon Arcade Brushes",
    description: "Glowy, high-energy brushes for arcade-style art.",
    tags: ["Glow", "Neon", "Challenge"],
    remix: "public",
    accent: "#a855f7",
    assets: [
      seedBrush({
        id: "seed-brush-neon-glow",
        title: "Neon Glow",
        tags: ["Glow", "Neon"],
        recipe: { baseBrush: "glow", size: 30, opacity: 0.9, variation: 0.15, glow: true, spray: false }
      }),
      seedBrush({
        id: "seed-brush-arcade-marker",
        title: "Arcade Marker",
        tags: ["Bold", "Neon"],
        recipe: { baseBrush: "marker", size: 36, opacity: 0.95, variation: 0.05, glow: false, spray: false }
      })
    ]
  }),
  makeSeedPack({
    id: "pack-cozy-sketch",
    owner: "seed-creator-milo",
    authorSpace: "Milo's Space",
    title: "Cozy Sketch Kit",
    description: "Soft pencils and painterly strokes for calm, cozy drawings.",
    tags: ["Cozy", "Coloring", "Study break"],
    remix: "friends",
    accent: "#f59e0b",
    assets: [
      seedBrush({
        id: "seed-brush-soft-pencil",
        title: "Soft Pencil",
        tags: ["Cozy", "Sketch"],
        recipe: { baseBrush: "pencil", size: 14, opacity: 0.7, variation: 0.25, glow: false, spray: false },
        remix: "friends"
      }),
      seedBrush({
        id: "seed-brush-cozy-paint",
        title: "Cozy Paint",
        tags: ["Cozy", "Coloring"],
        recipe: { baseBrush: "paint", size: 42, opacity: 0.8, variation: 0.2, glow: false, spray: false },
        remix: "friends"
      })
    ]
  }),
  makeSeedPack({
    id: "pack-anime-inkers",
    owner: "seed-creator-rae",
    authorSpace: "Rae's Space",
    title: "Anime Inkers",
    description: "Clean inking brushes for line art and loops.",
    tags: ["Anime", "GIF frames", "Bold"],
    remix: "public",
    accent: "#0ea5e9",
    assets: [
      seedBrush({
        id: "seed-brush-clean-ink",
        title: "Clean Ink",
        tags: ["Anime", "Line"],
        recipe: { baseBrush: "marker", size: 10, opacity: 1, variation: 0, glow: false, spray: false }
      }),
      seedBrush({
        id: "seed-brush-spray-fx",
        title: "FX Spray",
        tags: ["Anime", "Effect"],
        recipe: { baseBrush: "spray", size: 48, opacity: 0.6, variation: 0.35, glow: false, spray: true }
      })
    ]
  })
];

async function readStore<T>(key: string): Promise<T[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function writeStore<T>(key: string, value: T[]): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Non-fatal: publishing still reflects in-memory for the session.
  }
}

// All locally-published packs (the user's own submissions, any status).
export async function readPublishedPacks(): Promise<AssetPack[]> {
  return readStore<AssetPack>(PACKS_STORAGE_KEY);
}

// The browse surface: APPROVED + public packs only (seed packs + any locally
// published pack already approved). Admin approval is a separate agent, so freshly
// submitted packs stay 'pending' and do NOT appear here yet.
export async function getBrowsablePacks(): Promise<AssetPack[]> {
  const local = (await readPublishedPacks()).filter(
    (pack) => pack.status === "approved" && pack.visibility === "public"
  );
  return [...SEED_PACKS, ...local];
}

// The asset_moderation_queue entries (review queue). Surfaced so the publish flow
// can confirm a submission was queued.
export async function readModerationQueue(): Promise<ModerationQueueEntry[]> {
  return readStore<ModerationQueueEntry>(QUEUE_STORAGE_KEY);
}

// asset_uses log (where a browsed asset was added/used).
export async function readAssetUses(): Promise<AssetUse[]> {
  return readStore<AssetUse>(USES_STORAGE_KEY);
}

export type PublishResult = { pack: AssetPack; queued: boolean };

// Publish a pack from a set of locker assets. Builds an asset_packs row + its
// asset_pack_items, and — when visibility needs review (public or friends) — an
// asset_moderation_queue entry. Public/friends submissions are 'pending'; private
// packs are stored as 'draft' (no review needed).
export async function publishPack(input: {
  title: string;
  assets: SpaceAsset[];
  visibility?: PackPublishVisibility;
  remix_permission?: RemixPermission;
  ownerProfileId?: string;
}): Promise<PublishResult> {
  const visibility = input.visibility ?? "public";
  const remix_permission = input.remix_permission ?? "none";
  const ownerProfileId = input.ownerProfileId ?? "local-me";
  const needsReview = visibility === "public" || visibility === "friends";
  // schema check: public/featured visibility requires status approved. Since we
  // can't approve here, a not-yet-approved public pack is stored as pending and
  // is NOT browsable until the admin agent approves it.
  const status: AssetPackStatus = needsReview ? "pending" : "draft";

  const packId = makeId("pack");
  const created = new Date().toISOString();
  const items: PackItem[] = input.assets.map((asset, index) => ({
    pack_id: packId,
    asset_id: asset.id,
    position: index,
    asset,
    created_at: created
  }));

  const tags = Array.from(
    new Set(input.assets.flatMap((asset) => (asset.payload as { tags?: string[] } | undefined)?.tags ?? []))
  ).slice(0, 6);

  const pack: AssetPack = {
    id: packId,
    owner_profile_id: ownerProfileId,
    authorSpace: "Your Space",
    title: input.title || "My Brush Pack",
    description: "",
    tags,
    visibility,
    version: 1,
    status,
    remix_permission,
    accent: "#22c55e",
    items,
    created_at: created,
    updated_at: created
  };

  const packs = await readPublishedPacks();
  await writeStore(PACKS_STORAGE_KEY, [pack, ...packs]);

  let queued = false;
  if (needsReview) {
    const entry: ModerationQueueEntry = {
      id: makeId("modq"),
      target_kind: "pack",
      target_id: packId,
      submitted_by: ownerProfileId,
      status: "pending",
      reviewer_profile_id: null,
      reason: null,
      submitted_at: created,
      reviewed_at: null
    };
    await writeStore(QUEUE_STORAGE_KEY, [entry, ...(await readModerationQueue())]);
    queued = true;
  }

  return { pack, queued };
}

export type GetPackResult = { added: number };

// Copy a pack's brushes into the locker (fresh local ids so the user owns their
// copies), recording an asset_uses row per copied asset (context 'remix' since
// "Get" copies a community asset into the user's space). Returns how many added.
export async function getPackAssets(
  pack: AssetPack,
  options: { usedByProfileId?: string } = {}
): Promise<GetPackResult> {
  const usedByProfileId = options.usedByProfileId ?? "local-me";
  const uses = await readAssetUses();
  let added = 0;

  for (const item of pack.items) {
    const source = item.asset;
    if (source.kind !== "brush") {
      // MVP "Add to my brushes" copies brush assets; other kinds skipped for now.
      continue;
    }
    const sourceRecipe = source.brush_recipe ?? (source.payload as { brush_recipe?: BrushRecipe } | undefined)?.brush_recipe;
    const recipe = normalizeRecipe(sourceRecipe ?? {});
    const tags = (source.payload as { tags?: string[] } | undefined)?.tags ?? [];
    const nowMs = Date.now();
    const asset: SpaceAsset = {
      id: makeSpaceAssetId(),
      kind: "brush",
      title: source.title,
      payload: { brush_recipe: recipe, tags },
      brush_recipe: recipe,
      createdAt: nowMs,
      updatedAt: nowMs,
      visibility: "private",
      moderation_status: "approved",
      remix_permission: source.remix_permission ?? "none",
      from_pack_id: pack.id
    };
    await upsertSpaceAsset(asset);
    added += 1;
    uses.unshift({
      id: makeId("use"),
      asset_id: source.id,
      used_by_profile_id: usedByProfileId,
      context: "remix",
      source_id: pack.id,
      created_at: new Date().toISOString()
    });
  }

  await writeStore(USES_STORAGE_KEY, uses);
  return { added };
}
