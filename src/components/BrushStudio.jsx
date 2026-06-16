// Brush Studio Lite — create + apply community-style brush recipes.
//
// Adjust base brush + size/opacity/variation + glow/textured flags, see a live
// preview stroke on a small canvas, then save the recipe as a `space_assets`
// entry of kind `brush` in the Paint Space locker (StudioApp owns persistence).
// Saved brushes show as cards (name, preview, tags). Apply a recipe to the
// current brush. Publishing/moderation/packs are a SEPARATE later agent.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_RECIPE,
  RECIPE_BASE_BRUSHES,
  normalizeRecipe,
  renderRecipePreview,
} from "../utils/brushStudio";

const PREVIEW_W = 220;
const PREVIEW_H = 90;
const CARD_W = 96;
const CARD_H = 48;

// A small live-preview canvas that re-renders whenever the recipe/color change.
function RecipePreview({ recipe, color, width = PREVIEW_W, height = PREVIEW_H, className = "brush-preview" }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    renderRecipePreview(canvas.getContext("2d"), recipe, { color, width, height });
  }, [recipe, color, width, height]);
  return <canvas ref={canvasRef} width={width} height={height} className={className} aria-hidden="true" />;
}

function SavedBrushCard({ asset, color, onApply }) {
  const recipe = asset.brush_recipe || asset.payload?.brush_recipe || DEFAULT_RECIPE;
  const tags = asset.payload?.tags || [];
  return (
    <article className="pack-card brush-studio-card">
      <RecipePreview recipe={recipe} color={color} width={CARD_W} height={CARD_H} className="brush-preview brush-card-preview" />
      <h3 title={asset.title}>{asset.title}</h3>
      {tags.length > 0 ? <p className="brush-card-tags">{tags.join(" · ")}</p> : null}
      <button type="button" className="full-width" onClick={() => onApply(asset)}>
        Apply
      </button>
    </article>
  );
}

export default function BrushStudio({
  color = "#7c3aed",
  savedBrushes = [],
  initialRecipe,
  onClose,
  onSaveRecipe,
  onApplyRecipe,
}) {
  const [recipe, setRecipe] = useState(() => normalizeRecipe(initialRecipe || DEFAULT_RECIPE));
  const [name, setName] = useState("My Brush");
  const [tagsText, setTagsText] = useState("");

  const update = (patch) => setRecipe((current) => normalizeRecipe({ ...current, ...patch }));

  const tags = useMemo(
    () =>
      tagsText
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 5),
    [tagsText],
  );

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="studio-modal brush-studio-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="brush-studio-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title-row">
          <h2 id="brush-studio-title">Brush Studio</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="ps-subtitle">Craft a brush recipe, preview it live, and save it to your Paint Space.</p>

        <div className="brush-studio-preview-stage">
          <RecipePreview recipe={recipe} color={color} />
        </div>

        <div className="brush-studio-controls">
          <label className="color-picker">
            <span>Base brush</span>
            <select value={recipe.baseBrush} onChange={(event) => update({ baseBrush: event.target.value })}>
              {RECIPE_BASE_BRUSHES.map((brush) => (
                <option key={brush.id} value={brush.id}>
                  {brush.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Size</span>
            <input
              type="range"
              min="2"
              max="120"
              value={recipe.size}
              onChange={(event) => update({ size: Number(event.target.value) })}
            />
            <output>{recipe.size}</output>
          </label>

          <label>
            <span>Opacity</span>
            <input
              type="range"
              min="5"
              max="100"
              value={Math.round(recipe.opacity * 100)}
              onChange={(event) => update({ opacity: Number(event.target.value) / 100 })}
            />
            <output>{Math.round(recipe.opacity * 100)}%</output>
          </label>

          <label>
            <span>Variation</span>
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round(recipe.variation * 100)}
              onChange={(event) => update({ variation: Number(event.target.value) / 100 })}
            />
            <output>{Math.round(recipe.variation * 100)}%</output>
          </label>

          <label className="color-picker">
            <span>Glow</span>
            <input type="checkbox" checked={recipe.glow} onChange={(event) => update({ glow: event.target.checked })} />
          </label>

          <label className="color-picker">
            <span>Textured</span>
            <input
              type="checkbox"
              checked={recipe.textured}
              onChange={(event) => update({ textured: event.target.checked })}
            />
          </label>
        </div>

        <div className="brush-studio-save">
          <label className="color-picker">
            <span>Name</span>
            <input type="text" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="color-picker">
            <span>Tags</span>
            <input
              type="text"
              value={tagsText}
              placeholder="comma, separated"
              onChange={(event) => setTagsText(event.target.value)}
            />
          </label>
          <div className="brush-studio-save-actions">
            <button type="button" onClick={() => onApplyRecipe?.(recipe)} title="Use this brush now">
              Apply to brush
            </button>
            <button
              type="button"
              className="primary-action"
              onClick={() => onSaveRecipe?.(recipe, { name: name.trim() || "My Brush", tags })}
              title="Save this recipe to your Paint Space"
            >
              Save to Paint Space
            </button>
          </div>
        </div>

        {savedBrushes.length > 0 ? (
          <div className="ps-group">
            <h3>Saved brushes</h3>
            <div className="ps-grid brush-studio-grid">
              {savedBrushes.map((asset) => (
                <SavedBrushCard key={asset.id} asset={asset} color={color} onApply={onApplyRecipe ? (a) => onApplyRecipe(a.brush_recipe || a.payload?.brush_recipe) : () => {}} />
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
