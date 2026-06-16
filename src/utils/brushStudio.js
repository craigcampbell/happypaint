// Brush Studio Lite — create + apply community-style brush "recipes".
//
// A brush recipe is a small, adjustable parameter set built on top of an
// existing base brush (marker/pencil/paint/spray/glow/eraser). The recipe is
// saved to the Paint Space locker as a `space_assets` entry of kind `brush`
// (reusing paintSpace.js), with the typed params stored under both `payload`
// and `brush_recipe` to mirror the backend `space_assets.brush_recipe` column.
//
// This module owns the recipe shape, defaults, a deterministic preview-stroke
// renderer (so the panel can show a live swatch on a small canvas), and the
// translation between a recipe and the studio's brush settings (apply).
//
// Publishing / moderation / packs are handled by a SEPARATE later agent. Here we
// only create + save-to-locker + apply, but we store a sync-ready shape incl.
// `visibility` and `moderation_status` so publish can build on it.

import { drawBrushSegment } from "./brushes";

// Base brushes a recipe can build on (must be ids in brushes.js brushCatalog).
export const RECIPE_BASE_BRUSHES = [
  { id: "marker", name: "Marker" },
  { id: "pencil", name: "Pencil" },
  { id: "paint", name: "Paint" },
  { id: "spray", name: "Spray" },
  { id: "glow", name: "Glow" },
];

export const DEFAULT_RECIPE = {
  baseBrush: "marker",
  size: 28,
  opacity: 0.85,
  variation: 0.1,
  glow: false, // adds a soft halo around the stroke
  textured: false, // adds subtle size jitter for a hand-made feel
};

// Normalize/clamp an arbitrary partial recipe into a complete, valid recipe.
export function normalizeRecipe(recipe = {}) {
  const baseBrush = RECIPE_BASE_BRUSHES.some((brush) => brush.id === recipe.baseBrush)
    ? recipe.baseBrush
    : DEFAULT_RECIPE.baseBrush;
  return {
    baseBrush,
    size: Math.min(120, Math.max(2, Math.round(recipe.size ?? DEFAULT_RECIPE.size))),
    opacity: Math.min(1, Math.max(0.05, recipe.opacity ?? DEFAULT_RECIPE.opacity)),
    variation: Math.min(1, Math.max(0, recipe.variation ?? DEFAULT_RECIPE.variation)),
    glow: Boolean(recipe.glow),
    textured: Boolean(recipe.textured),
  };
}

// Translate a recipe into the studio's live brush settings object (the same
// shape settingsRef.current uses for drawBrushSegment). `glow` maps onto the
// existing glow base brush (which already has the halo logic), so applying a
// glow recipe selects the glow brush; otherwise the recipe's base brush is used.
export function recipeToBrushSettings(recipe, { color }) {
  const normalized = normalizeRecipe(recipe);
  const brush = normalized.glow ? "glow" : normalized.baseBrush;
  // `textured` nudges variation up a touch for a hand-made look.
  const variation = normalized.textured
    ? Math.min(1, normalized.variation + 0.12)
    : normalized.variation;
  return {
    brush,
    color: color || "#111827",
    size: normalized.size,
    opacity: normalized.opacity,
    variation,
  };
}

// Build a list of points tracing a smooth S-curve across a preview canvas, used
// to render a representative preview stroke.
function previewPath(width, height) {
  const points = [];
  const steps = 36;
  const margin = Math.min(width, height) * 0.16;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = margin + t * (width - margin * 2);
    const y = height / 2 + Math.sin(t * Math.PI * 2) * (height * 0.22);
    points.push({ x, y, pressure: 0.4 + Math.sin(t * Math.PI) * 0.5 });
  }
  return points;
}

// Render a live preview stroke of a recipe onto a 2D context (clears first).
// Reuses drawBrushSegment so the preview matches the real brush exactly.
export function renderRecipePreview(context, recipe, { color = "#7c3aed", width, height } = {}) {
  const w = width || context.canvas.width;
  const h = height || context.canvas.height;
  context.clearRect(0, 0, w, h);
  const settings = recipeToBrushSettings(recipe, { color });
  const path = previewPath(w, h);
  for (let i = 1; i < path.length; i += 1) {
    drawBrushSegment(context, path[i - 1], path[i], settings);
  }
  // Reset any lingering shadow from a glow stroke so the next paint is clean.
  context.shadowBlur = 0;
}

// Build the sync-ready space_assets payload for a brush recipe. We store the
// typed recipe under both `payload.brush_recipe` and a top-level `brush_recipe`
// to mirror the schema's typed column, plus `visibility`/`moderation_status` so
// the (separate) publish/moderation pipeline can build on it.
export function buildBrushAssetFields(recipe, { tags = [] } = {}) {
  const normalized = normalizeRecipe(recipe);
  return {
    payload: {
      brush_recipe: normalized,
      tags,
    },
    brush_recipe: normalized,
    visibility: "private",
    moderation_status: "pending",
  };
}
