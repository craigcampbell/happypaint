// AI Assist v1 panel — LOCAL & SAFETY-GATED (docs/ai-policy.md).
//
// All helpers are local + deterministic (no network/model). The panel is gated
// behind a one-time consent screen (mirrors ai_consent: version + consentedAt,
// with a visible guardian-approval gate for child accounts). Generated outputs
// carry moderation_status: 'pending' in their stored shape. Server-side helpers
// (sketch cleanup, etc.) are deferred behind credits + moderation — noted in UI.

import { useMemo, useState } from "react";
import {
  AI_POLICY_VERSION,
  brushRecipeFromText,
  generatePaletteFromTheme,
  isAiConsented,
  shufflePrompt,
} from "../utils/aiAssist";

function ConsentGate({ onConsent }) {
  const [profileKind, setProfileKind] = useState("self");
  const [guardianApproved, setGuardianApproved] = useState(false);
  const isChild = profileKind === "child";
  const canConsent = !isChild || guardianApproved;

  return (
    <div className="ai-consent">
      <p className="ps-subtitle">
        AI Assist v1 runs <strong>entirely on your device</strong> — no data leaves it, no external model is called.
        It helps you <em>start</em> art (palettes, prompts, brush recipes); it never makes finished art for you.
      </p>
      <p className="economy-note">
        Policy version {AI_POLICY_VERSION}. Every AI helper is labeled AI-assisted and logged for transparency.
        Outputs you save start as <strong>pending moderation</strong>. You can turn AI off again any time.
      </p>

      <label className="color-picker ai-consent-row">
        <span>This account is</span>
        <select value={profileKind} onChange={(event) => setProfileKind(event.target.value)}>
          <option value="self">Mine (teen/adult)</option>
          <option value="child">A child I manage</option>
        </select>
      </label>

      {isChild ? (
        <label className="color-picker ai-consent-row">
          <span>Guardian approves AI Assist</span>
          <input
            type="checkbox"
            checked={guardianApproved}
            onChange={(event) => setGuardianApproved(event.target.checked)}
          />
        </label>
      ) : null}

      {isChild && !guardianApproved ? (
        <p className="economy-note">A guardian must approve AI Assist for a child account before it can be used.</p>
      ) : null}

      <button
        type="button"
        className="primary-action full-width"
        disabled={!canConsent}
        onClick={() => onConsent({ profileKind, guardianApproved })}
      >
        Turn on AI Assist
      </button>
    </div>
  );
}

export default function AiAssistPanel({
  consent,
  onConsent,
  onRevoke,
  onApplyPalette,
  onApplyBrushRecipe,
  onUsePrompt,
}) {
  const consented = isAiConsented(consent);

  const [theme, setTheme] = useState("neon arcade");
  const [palette, setPalette] = useState(() => generatePaletteFromTheme("neon arcade"));
  const [promptCard, setPromptCard] = useState(() => shufflePrompt(1));
  const [brushText, setBrushText] = useState("glitter gel pen");
  const [brushGen, setBrushGen] = useState(() => brushRecipeFromText("glitter gel pen"));

  const paletteColors = useMemo(() => palette.output.colors, [palette]);
  const recipe = brushGen.output.brush_recipe;

  return (
    <>
      {!consented ? (
        <ConsentGate onConsent={onConsent} />
      ) : (
        <div className="ai-assist-body">
          <div className="ai-consent-status">
            <span className="economy-balance-chip">AI on · v{AI_POLICY_VERSION}</span>
            <button type="button" onClick={onRevoke} title="Turn AI Assist off">
              Turn off
            </button>
          </div>

          {/* Palette from theme */}
          <section className="ai-section">
            <h3>Palette from a theme</h3>
            <div className="ai-input-row">
              <input
                type="text"
                value={theme}
                placeholder="e.g. sunset, forest, neon arcade"
                onChange={(event) => setTheme(event.target.value)}
              />
              <button type="button" onClick={() => setPalette(generatePaletteFromTheme(theme))}>
                Generate
              </button>
            </div>
            <div className="ps-palette-swatches ai-palette" aria-label="Generated palette">
              {paletteColors.map((color, idx) => (
                <span key={`${color}-${idx}`} style={{ backgroundColor: color }} title={color} />
              ))}
            </div>
            <button
              type="button"
              className="full-width"
              onClick={() => onApplyPalette?.(palette)}
              title="Use this palette in the studio"
            >
              Apply palette ({palette.input.rule})
            </button>
          </section>

          {/* Kid-safe prompt cards */}
          <section className="ai-section">
            <h3>Prompt card</h3>
            <div className="ai-prompt-card">
              <small>{promptCard.output.category}</small>
              <p>{promptCard.output.prompt}</p>
            </div>
            <div className="ai-input-row">
              <button type="button" onClick={() => setPromptCard(shufflePrompt())}>
                Shuffle prompt
              </button>
              <button type="button" onClick={() => onUsePrompt?.(promptCard)} title="Note this prompt">
                Use prompt
              </button>
            </div>
          </section>

          {/* Brush recipe from plain language */}
          <section className="ai-section">
            <h3>Brush recipe from words</h3>
            <div className="ai-input-row">
              <input
                type="text"
                value={brushText}
                placeholder="e.g. scratchy pencil, soft marker"
                onChange={(event) => setBrushText(event.target.value)}
              />
              <button type="button" onClick={() => setBrushGen(brushRecipeFromText(brushText))}>
                Translate
              </button>
            </div>
            <p className="economy-note ai-recipe-summary">
              {recipe.baseBrush} · size {recipe.size} · opacity {Math.round(recipe.opacity * 100)}% · variation{" "}
              {Math.round(recipe.variation * 100)}%
            </p>
            <button
              type="button"
              className="full-width"
              onClick={() => onApplyBrushRecipe?.(brushGen)}
              title="Apply to the current brush"
            >
              Apply brush
            </button>
          </section>

          <p className="economy-note">
            Server-side helpers (sketch-to-line cleanup, etc.) are deferred to a later phase behind AI credits and
            content moderation. v1 stays fully local.
          </p>
        </div>
      )}
    </>
  );
}
