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
import { extractAbrBrushTips } from "../utils/abrImport";

const PREVIEW_W = 220;
const PREVIEW_H = 90;
const CARD_W = 96;
const CARD_H = 48;
const TIP_IMPORT_SIZES = [192, 160, 128, 96];
const TIP_IMPORT_MAX_CHARS = 96_000;

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

async function fileToTipDataUrl(file) {
  const src = await readFileAsDataUrl(file);
  const image = await loadImage(src);
  for (const size of TIP_IMPORT_SIZES) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, size, size);
    const scale = Math.min(size / image.width, size / image.height);
    const w = Math.max(1, Math.round(image.width * scale));
    const h = Math.max(1, Math.round(image.height * scale));
    const x = Math.round((size - w) / 2);
    const y = Math.round((size - h) / 2);
    context.drawImage(image, x, y, w, h);
    const dataUrl = canvas.toDataURL("image/png");
    if (dataUrl.length <= TIP_IMPORT_MAX_CHARS || size === TIP_IMPORT_SIZES[TIP_IMPORT_SIZES.length - 1]) {
      return dataUrl;
    }
  }
  return "";
}

// A small live-preview canvas that re-renders whenever the recipe/color change.
function RecipePreview({ recipe, color, width = PREVIEW_W, height = PREVIEW_H, className = "brush-preview" }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    renderRecipePreview(canvas.getContext("2d"), recipe, { color, width, height }).catch(() => {});
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
  onSaveImportedBrushes,
  onApplyRecipe,
}) {
  const [recipe, setRecipe] = useState(() => normalizeRecipe(initialRecipe || DEFAULT_RECIPE));
  const [name, setName] = useState("My Brush");
  const [tagsText, setTagsText] = useState("");
  const [importStatus, setImportStatus] = useState("");

  const update = (patch) => setRecipe((current) => normalizeRecipe({ ...current, ...patch }));
  const handleTipImport = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    if (/\.abr$/i.test(file.name)) {
      setImportStatus("Reading ABR...");
      try {
        const tips = await extractAbrBrushTips(await file.arrayBuffer(), { maxTips: 24 });
        if (tips.length === 0) {
          setImportStatus("No usable brush tips found in that ABR.");
          return;
        }
        const first = tips[0];
        update({ baseBrush: "stamp", tipDataUrl: first.tipDataUrl, tipId: "" });
        setName(first.title || file.name.replace(/\.abr$/i, ""));
        const saved = await onSaveImportedBrushes?.(tips, { fileName: file.name });
        setImportStatus(saved ? `Imported ${saved} ABR brush tip${saved === 1 ? "" : "s"}.` : `Loaded ${tips.length} ABR tip${tips.length === 1 ? "" : "s"}.`);
      } catch {
        setImportStatus("Couldn't read that ABR file.");
      }
      return;
    }
    if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
      setImportStatus("Use a PNG, JPEG, WebP, or ABR file.");
      return;
    }
    setImportStatus("Importing tip...");
    try {
      const tipDataUrl = await fileToTipDataUrl(file);
      if (!tipDataUrl || tipDataUrl.length > TIP_IMPORT_MAX_CHARS) {
        setImportStatus("That tip is too detailed. Try a simpler image.");
        return;
      }
      update({ baseBrush: "stamp", tipDataUrl, tipId: "" });
      setImportStatus("Tip imported.");
    } catch {
      setImportStatus("Couldn't import that image.");
    }
  };

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

          <label className="color-picker brush-tip-import">
            <span>Brush tip</span>
            <input type="file" accept="image/png,image/jpeg,image/webp,.abr" onChange={handleTipImport} />
          </label>

          {recipe.tipDataUrl ? (
            <div className="brush-tip-preview">
              <img src={recipe.tipDataUrl} alt="" />
              <button type="button" onClick={() => update({ baseBrush: "marker", tipDataUrl: "", tipId: "" })}>
                Remove tip
              </button>
            </div>
          ) : null}

          {importStatus ? <p className="brush-import-status">{importStatus}</p> : null}

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
