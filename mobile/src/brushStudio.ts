// Brush Studio Lite — create + apply brush "recipes" (mirrors src/utils/brushStudio.js).
//
// A brush recipe is a small, adjustable parameter set built on top of an
// existing base brush (marker/pencil/paint/spray/glow). The recipe is saved to
// the Paint Space locker as a `space_assets` entry of kind `brush` (reusing
// paintSpace.ts), with the typed params stored under both `payload.brush_recipe`
// and the top-level `brush_recipe` field to mirror the backend
// `space_assets.brush_recipe` column, plus `visibility` + `moderation_status`
// so the (separate, later) publish/moderation pipeline can build on it.
//
// This module is pure: recipe shape, defaults, normalization, and the
// translation between a recipe and the studio's BrushSettings (apply). The live
// Skia preview stroke lives in BrushStudioScreen (it needs Skia nodes).
//
// Publishing / moderation / packs are handled by a SEPARATE later agent. Here we
// only create + save-to-locker + apply.

import type { BrushId, BrushRecipe, BrushSettings, SpaceAsset } from "./types";

// Base brushes a recipe can build on (ids from constants.BRUSHES, sans eraser).
export const RECIPE_BASE_BRUSHES: Array<{ id: BrushId; label: string }> = [
  { id: "marker", label: "Marker" },
  { id: "pencil", label: "Pencil" },
  { id: "paint", label: "Paint" },
  { id: "spray", label: "Spray" },
  { id: "glow", label: "Glow" }
];

export const DEFAULT_RECIPE: BrushRecipe = {
  baseBrush: "marker",
  size: 28,
  opacity: 0.85,
  variation: 0.1,
  glow: false,
  spray: false
};

function clampSize(value: number): number {
  return Math.min(120, Math.max(2, Math.round(value)));
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// Normalize/clamp an arbitrary partial recipe into a complete, valid recipe.
export function normalizeRecipe(recipe: Partial<BrushRecipe> = {}): BrushRecipe {
  const baseBrush = RECIPE_BASE_BRUSHES.some((brush) => brush.id === recipe.baseBrush)
    ? (recipe.baseBrush as BrushId)
    : DEFAULT_RECIPE.baseBrush;
  return {
    baseBrush,
    size: clampSize(recipe.size ?? DEFAULT_RECIPE.size),
    opacity: Math.min(1, Math.max(0.05, recipe.opacity ?? DEFAULT_RECIPE.opacity)),
    variation: clampUnit(recipe.variation ?? DEFAULT_RECIPE.variation),
    glow: Boolean(recipe.glow),
    spray: Boolean(recipe.spray)
  };
}

// Translate a recipe into a partial BrushSettings patch (brush/size/opacity/
// variation + tool:"brush"). `glow` maps onto the existing glow base brush
// (which already has the halo logic); `spray` maps onto the spray base brush.
// glow takes precedence over spray when both are set.
export function recipeToBrushSettings(recipe: BrushRecipe): Partial<BrushSettings> {
  const normalized = normalizeRecipe(recipe);
  const brush: BrushId = normalized.glow ? "glow" : normalized.spray ? "spray" : normalized.baseBrush;
  return {
    brush,
    tool: "brush",
    size: normalized.size,
    opacity: normalized.opacity,
    variation: normalized.variation
  };
}

// Read the recipe out of a saved brush asset (typed slot first, then payload).
export function recipeFromAsset(asset: SpaceAsset): BrushRecipe {
  const fromTyped = asset.brush_recipe;
  const fromPayload = (asset.payload as { brush_recipe?: BrushRecipe } | undefined)?.brush_recipe;
  return normalizeRecipe(fromTyped ?? fromPayload ?? DEFAULT_RECIPE);
}

// Build the sync-ready space_assets fields for a brush recipe. Stores the typed
// recipe under both `payload.brush_recipe` and the top-level `brush_recipe` to
// mirror the schema's typed column, plus `visibility`/`moderation_status` so the
// (separate) publish/moderation pipeline can build on it.
export function buildBrushAssetFields(
  recipe: BrushRecipe,
  options: { tags?: string[] } = {}
): Pick<SpaceAsset, "payload" | "brush_recipe" | "visibility" | "moderation_status"> {
  const normalized = normalizeRecipe(recipe);
  return {
    payload: { brush_recipe: normalized, tags: options.tags ?? [] },
    brush_recipe: normalized,
    visibility: "private",
    moderation_status: "pending"
  };
}
