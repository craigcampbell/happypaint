// Community Brush Packs — publish (submit-for-review) + browse + get.
//
// MOCK / LOCAL ONLY (no backend, no network), but shaped to mirror the schema:
//   - asset_packs            (id, owner_profile_id, title, visibility, version,
//                             status: draft → pending → approved → rejected)
//                            check: visibility public/featured requires status approved
//   - asset_pack_items       (pack_id, asset_id, position) — pack membership
//   - asset_moderation_queue (id, target_kind 'pack', target_id, submitted_by,
//                             status 'pending', submitted_at) — review queue entry
//   - asset_uses             (id, asset_id, used_by_profile_id, context, source_id)
//                             recorded when a browsed pack is "Got" into the locker
//   - space_assets           (kind 'brush' etc., brush_recipe, remix_permission,
//                             visibility) — the assets inside a pack
//
// User-facing scope ONLY: publish (submit) + browse approved + get. Admin-side
// review/approval of submitted packs is a SEPARATE later agent. We seed a few
// already-approved packs so browse is never empty, and persist the user's own
// submitted packs + queue entries locally so the flow is observable end-to-end.

import { createAsset, makeId } from "./paintSpace";

export const PACKS_STORAGE_KEY = "happypaint:brush-packs:v1";
export const QUEUE_STORAGE_KEY = "happypaint:asset-moderation-queue:v1";
export const USES_STORAGE_KEY = "happypaint:asset-uses:v1";
// Append-only staff audit log of pack/asset review decisions (mirrors
// moderation_actions: actor, action_type, target_table, target_id, note, created_at).
export const MOD_ACTIONS_STORAGE_KEY = "happypaint:asset-moderation-actions:v1";

// Visibility options offered when publishing (mirrors space_visibility minus
// 'featured', which is admin-assigned). Public requires review before it goes live.
export const PACK_VISIBILITY_OPTIONS = [
  { id: "private", label: "Private", note: "Only you. Stays in your locker." },
  { id: "friends", label: "Friends only", note: "Friends can get it. Light review." },
  { id: "public", label: "Public", note: "Anyone can get it. Requires review before it goes live." },
];

// Remix permission shown per asset / pack (mirrors asset_remix_permission).
export const REMIX_PERMISSIONS = [
  { id: "none", label: "No remixing" },
  { id: "friends", label: "Friends can remix" },
  { id: "public", label: "Anyone can remix" },
];

export function remixLabel(permission) {
  return REMIX_PERMISSIONS.find((item) => item.id === permission)?.label || "No remixing";
}

// ---- Curated seed packs (already approved + public) so browse works ----
// Each item is a sync-ready space_assets-shaped brush with a brush_recipe.
function seedBrush({ id, title, tags, recipe, remix = "public" }) {
  return {
    id,
    kind: "brush",
    title,
    payload: { brush_recipe: recipe, tags },
    brush_recipe: recipe,
    thumbnail: "",
    remix_permission: remix,
    visibility: "public",
    moderation_status: "approved",
    age_rating: "teen",
  };
}

const SEED_PACKS = [
  {
    id: "pack-neon-arcade",
    owner_profile_id: "seed-creator-aria",
    authorSpace: "Aria's Space",
    title: "Neon Arcade Brushes",
    description: "Glowy, high-energy brushes for arcade-style art.",
    tags: ["Glow", "Neon", "Challenge"],
    visibility: "public",
    version: 1,
    status: "approved",
    remix_permission: "public",
    accent: "#a855f7",
    items: [
      seedBrush({
        id: "seed-brush-neon-glow",
        title: "Neon Glow",
        tags: ["Glow", "Neon"],
        recipe: { baseBrush: "glow", size: 30, opacity: 0.9, variation: 0.15, glow: true, textured: false },
      }),
      seedBrush({
        id: "seed-brush-arcade-marker",
        title: "Arcade Marker",
        tags: ["Bold", "Neon"],
        recipe: { baseBrush: "marker", size: 36, opacity: 0.95, variation: 0.05, glow: false, textured: false },
      }),
    ],
  },
  {
    id: "pack-cozy-sketch",
    owner_profile_id: "seed-creator-milo",
    authorSpace: "Milo's Space",
    title: "Cozy Sketch Kit",
    description: "Soft pencils and textured strokes for calm, cozy drawings.",
    tags: ["Cozy", "Coloring", "Study break"],
    visibility: "public",
    version: 1,
    status: "approved",
    remix_permission: "friends",
    accent: "#f59e0b",
    items: [
      seedBrush({
        id: "seed-brush-soft-pencil",
        title: "Soft Pencil",
        tags: ["Cozy", "Sketch"],
        recipe: { baseBrush: "pencil", size: 14, opacity: 0.7, variation: 0.25, glow: false, textured: true },
        remix: "friends",
      }),
      seedBrush({
        id: "seed-brush-cozy-paint",
        title: "Cozy Paint",
        tags: ["Cozy", "Coloring"],
        recipe: { baseBrush: "paint", size: 42, opacity: 0.8, variation: 0.2, glow: false, textured: true },
        remix: "friends",
      }),
    ],
  },
  {
    id: "pack-anime-inkers",
    owner_profile_id: "seed-creator-rae",
    authorSpace: "Rae's Space",
    title: "Anime Inkers",
    description: "Clean inking brushes for line art and loops.",
    tags: ["Anime", "GIF frames", "Bold"],
    visibility: "public",
    version: 1,
    status: "approved",
    remix_permission: "public",
    accent: "#0ea5e9",
    items: [
      seedBrush({
        id: "seed-brush-clean-ink",
        title: "Clean Ink",
        tags: ["Anime", "Line"],
        recipe: { baseBrush: "marker", size: 10, opacity: 1, variation: 0, glow: false, textured: false },
      }),
    ],
  },
];

function readStore(key) {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Non-fatal: publishing still reflects in-memory for the session.
  }
}

// All locally-published packs (the user's own submissions, any status).
export function readPublishedPacks() {
  return readStore(PACKS_STORAGE_KEY);
}

// The browse surface: APPROVED + public packs only (seed packs + any locally
// published pack that has been approved). Admin approval is a separate agent, so
// freshly submitted packs stay 'pending' and do NOT appear here yet.
export function getBrowsablePacks() {
  const local = readPublishedPacks().filter(
    (pack) => pack.status === "approved" && pack.visibility === "public",
  );
  return [...SEED_PACKS, ...local];
}

// The asset_moderation_queue entries (review queue). Surfaced so the publish flow
// can confirm a submission was queued.
export function readModerationQueue() {
  return readStore(QUEUE_STORAGE_KEY);
}

// asset_uses log (where a browsed asset was added/used).
export function readAssetUses() {
  return readStore(USES_STORAGE_KEY);
}

// ---- Admin moderation (review side) ----------------------------------------
// These mirror the staff Admin Console flow: a reviewer works the
// asset_moderation_queue, approving / rejecting / requesting changes on each
// submission. Decisions update the queue entry (status, reviewer, reason,
// reviewed_at) AND the underlying pack (status + visibility) so an approved
// public pack actually shows up in getBrowsablePacks(), and write an immutable
// moderation_actions-shaped audit row. Local-only; sync-ready shapes.

// A seed pending pack so the admin review queue is demonstrable even before any
// local user has published one. Stored on first read so a real decision on it
// persists. Shaped exactly like a published pack (asset_packs + items).
const SEED_PENDING_PACK = {
  id: "pack-pending-pixel-pop",
  owner_profile_id: "seed-creator-juno",
  authorSpace: "Juno's Space",
  title: "Pixel Pop Brushes",
  description: "Crunchy pixel and dot brushes for retro pixel art.",
  tags: ["Pixel", "Retro", "Bold"],
  visibility: "public",
  version: 1,
  status: "pending",
  remix_permission: "public",
  accent: "#ec4899",
  items: [
    seedBrush({
      id: "seed-brush-pixel-dot",
      title: "Pixel Dot",
      tags: ["Pixel", "Retro"],
      recipe: { baseBrush: "marker", size: 8, opacity: 1, variation: 0, glow: false, textured: false },
    }),
  ],
  created_at: "2026-06-14T18:00:00.000Z",
  updated_at: "2026-06-14T18:00:00.000Z",
};

// Ensure the seed pending pack + its queue entry exist once, so the admin queue
// is never empty on a fresh device. Idempotent (keyed by the seed ids).
function ensureSeededReviewQueue() {
  const packs = readPublishedPacks();
  const queue = readModerationQueue();
  const hasPack = packs.some((pack) => pack.id === SEED_PENDING_PACK.id);
  const hasEntry = queue.some((entry) => entry.target_id === SEED_PENDING_PACK.id);
  if (hasPack && hasEntry) {
    return;
  }
  if (!hasPack) {
    writeStore(PACKS_STORAGE_KEY, [SEED_PENDING_PACK, ...packs]);
  }
  if (!hasEntry) {
    const entry = {
      id: makeId("modq"),
      target_kind: "pack",
      target_id: SEED_PENDING_PACK.id,
      submitted_by: SEED_PENDING_PACK.owner_profile_id,
      status: "pending",
      reviewer_profile_id: null,
      reason: null,
      submitted_at: SEED_PENDING_PACK.created_at,
      reviewed_at: null,
    };
    writeStore(QUEUE_STORAGE_KEY, [entry, ...queue]);
  }
}

// The pending review queue, enriched with the pack each entry targets so the
// console can show submitter + name + preview + tags. Seeds a demo item once so
// the queue is observable end-to-end. Returns newest-first.
export function getPendingPackReviews() {
  ensureSeededReviewQueue();
  const queue = readModerationQueue().filter((entry) => entry.status === "pending");
  const packs = readPublishedPacks();
  return queue.map((entry) => ({
    ...entry,
    pack: packs.find((pack) => pack.id === entry.target_id) || null,
  }));
}

export function readModerationActions() {
  return readStore(MOD_ACTIONS_STORAGE_KEY);
}

function appendModerationAction({ action_type, target_id, target_kind, note }) {
  const action = {
    id: makeId("modact"),
    // moderation_actions has no asset-target enum yet, so we record the kind in
    // a sync-ready shape: target_table names the asset table by kind.
    actor_profile_id: "staff-local",
    action_type,
    target_table: target_kind === "pack" ? "asset_packs" : "space_assets",
    target_id,
    note: note || null,
    created_at: new Date().toISOString(),
  };
  writeStore(MOD_ACTIONS_STORAGE_KEY, [action, ...readModerationActions()]);
  return action;
}

// Review a submission. `decision` is 'approved' | 'rejected' | 'needs_changes'.
// Updates the queue entry + the targeted pack, and writes a moderation_actions
// audit row. Approval of a public pack sets visibility public + status approved
// so getBrowsablePacks() surfaces it; reject/needs_changes pull it from browse.
// Returns the updated queue entry (or null if not found).
export function reviewPackSubmission(queueEntryId, decision, reason = "") {
  const queue = readModerationQueue();
  const entry = queue.find((item) => item.id === queueEntryId);
  if (!entry) {
    return null;
  }
  const reviewedAt = new Date().toISOString();
  const nextEntry = {
    ...entry,
    status: decision,
    reviewer_profile_id: "staff-local",
    reason: reason || null,
    reviewed_at: reviewedAt,
  };
  writeStore(
    QUEUE_STORAGE_KEY,
    queue.map((item) => (item.id === queueEntryId ? nextEntry : item)),
  );

  // Reflect the decision on the underlying pack so browse updates.
  const packs = readPublishedPacks();
  const nextPacks = packs.map((pack) => {
    if (pack.id !== entry.target_id) {
      return pack;
    }
    if (decision === "approved") {
      // schema check: public/featured visibility requires status approved — now it is.
      return { ...pack, status: "approved", updated_at: reviewedAt };
    }
    if (decision === "rejected") {
      return { ...pack, status: "rejected", visibility: "private", updated_at: reviewedAt };
    }
    // needs_changes: bounce back to draft so it leaves browse + the owner can resubmit.
    return { ...pack, status: "needs_changes", visibility: "private", updated_at: reviewedAt };
  });
  writeStore(PACKS_STORAGE_KEY, nextPacks);

  const actionType =
    decision === "approved"
      ? "approve_asset"
      : decision === "rejected"
        ? "reject_asset"
        : "request_asset_changes";
  appendModerationAction({
    action_type: actionType,
    target_id: entry.target_id,
    target_kind: entry.target_kind,
    note: reason,
  });

  return nextEntry;
}

// Publish a pack from a set of locker assets. Builds an asset_packs row + its
// asset_pack_items, and — when visibility needs review (public, or friends) —
// an asset_moderation_queue entry. Public/friends submissions are set to
// 'pending'; private packs are stored as 'draft' (no review needed).
//
// Returns { pack, queued } so the caller can message the user honestly.
export function publishPack({
  title,
  assets,
  visibility = "public",
  remix_permission = "none",
  ownerProfileId = "local-me",
}) {
  const needsReview = visibility === "public" || visibility === "friends";
  // schema check: public/featured visibility requires status approved. Since we
  // can't approve here, a not-yet-approved public pack is stored as pending and
  // is NOT browsable until the admin agent approves it.
  const status = needsReview ? "pending" : "draft";

  const packId = makeId("pack");
  const items = assets.map((asset, index) => ({
    pack_id: packId,
    asset_id: asset.id,
    position: index,
    // keep a denormalized copy of the asset so browse/get works locally
    asset,
    created_at: new Date().toISOString(),
  }));

  const pack = {
    id: packId,
    owner_profile_id: ownerProfileId,
    authorSpace: "Your Space",
    title: title || "My Brush Pack",
    description: "",
    tags: Array.from(new Set(assets.flatMap((asset) => asset.payload?.tags || []))).slice(0, 6),
    visibility,
    version: 1,
    status,
    remix_permission,
    accent: "#22c55e",
    items,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const packs = readPublishedPacks();
  writeStore(PACKS_STORAGE_KEY, [pack, ...packs]);

  let queued = false;
  if (needsReview) {
    const entry = {
      id: makeId("modq"),
      target_kind: "pack",
      target_id: packId,
      submitted_by: ownerProfileId,
      status: "pending",
      reviewer_profile_id: null,
      reason: null,
      submitted_at: new Date().toISOString(),
      reviewed_at: null,
    };
    writeStore(QUEUE_STORAGE_KEY, [entry, ...readModerationQueue()]);
    queued = true;
  }

  return { pack, queued };
}

// Build new locker assets from a pack's brushes (fresh local ids so the user owns
// their copies), and record an asset_uses row per copied asset (context 'remix'
// since "Get" copies a community asset into the user's space). Returns the new
// assets to add to the locker.
export function getPackAssets(pack, { usedByProfileId = "local-me" } = {}) {
  const sourceItems = pack.items || [];
  const newAssets = [];
  const uses = readAssetUses();

  for (const item of sourceItems) {
    const source = item.asset || item;
    if (source.kind !== "brush") {
      // MVP "Add to my brushes" copies brush assets; other kinds skipped for now.
      continue;
    }
    const recipe = source.brush_recipe || source.payload?.brush_recipe;
    const asset = createAsset({
      kind: "brush",
      title: source.title,
      payload: { brush_recipe: recipe, tags: source.payload?.tags || [] },
      brush_recipe: recipe,
      visibility: "private",
      moderation_status: "approved",
      remix_permission: source.remix_permission || "none",
      from_pack_id: pack.id,
    });
    newAssets.push(asset);
    uses.unshift({
      id: makeId("use"),
      asset_id: source.id,
      used_by_profile_id: usedByProfileId,
      context: "remix",
      source_id: pack.id,
      created_at: new Date().toISOString(),
    });
  }

  writeStore(USES_STORAGE_KEY, uses);
  return newAssets;
}
