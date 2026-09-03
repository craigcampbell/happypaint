// The hover cursor's tip preview: ONE dab of the selected brush, drawn at the
// on-screen size, so you see the SHAPE you're about to lay down (bristle
// ribbons, a stretched paint dab, an airbrush cloud, pencil tooth…) — not just a
// size ring. The dab itself comes from the engine's own single-dab primitive
// (drawSingleDab → makeStrokeRenderer's emitDab, v3-first through
// getAuthoringDab) at full pressure with a horizontal tangent and a fixed seed,
// so the tip is exactly the stamp the next stroke embeds and never shimmers
// between renders. Only the pigment-free tools (eraser nib, spray cloud,
// smudge pad) are drawn by hand here.
//
// Only re-drawn when brush / colour / size / zoom change — never per pointer
// move — so it stays off the draw hot path (see updateBrushCursor in App.jsx).
import { dabExtent, drawSingleDab, mulberry32, previewDabFor } from "./brushes";

const TWO_PI = Math.PI * 2;
// Translucent tip so the paint underneath stays readable. Applied by App.jsx
// as the tip canvas's CSS opacity (the engine stamps at its own flow alpha —
// baking a multiplier into every shape would mean re-implementing them here).
export const BRUSH_TIP_ALPHA = 0.62;

// Widest extent of one dab as a multiple of `size` — the cursor canvas box has
// to hold the whole tip, and paint ellipses / bristle ribbons / flecks reach
// past the nominal circle. Same number the engine's buffer pad is built from.
export function brushTipExtent(brushId, tool) {
  if (tool !== "brush") {
    return 1;
  }
  if (brushId === "smudge") {
    return 1.5;
  }
  const dab = previewDabFor(brushId);
  return dab ? dabExtent(dab) : 1;
}

// `size` = dab diameter in CSS px; `box` = the (square) canvas size in CSS px.
// The context must already be DPR-scaled and cleared.
export function drawBrushTip(ctx, { brush, tool, size, color, box }) {
  const cx = box / 2;
  const cy = box / 2;
  const radius = size / 2;
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  if (tool !== "brush" || brush === "eraser") {
    return; // shape tools + eraser: the CSS ring says it all
  }
  const rand = mulberry32(4242);
  if (brush === "smudge") {
    // No pigment: a neutral streak fading along the drag direction.
    const grad = ctx.createLinearGradient(cx - radius * 1.4, 0, cx + radius * 1.4, 0);
    grad.addColorStop(0, "rgba(122,135,148,0.9)");
    grad.addColorStop(1, "rgba(122,135,148,0.05)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(cx, cy, radius * 1.4, radius * 0.6, 0, 0, TWO_PI);
    ctx.fill();
    return;
  }
  const fill = color || "#111827";
  ctx.fillStyle = fill;
  if (brush === "spray") {
    // Airbrush (legacy path, no dab): a dot cloud inside the radius, denser
    // for bigger tips.
    const dots = Math.round(Math.min(260, Math.max(18, radius * radius * 0.3)));
    const dotR = Math.max(0.6, radius * 0.06);
    for (let i = 0; i < dots; i += 1) {
      const angle = rand() * TWO_PI;
      const dist = Math.sqrt(rand()) * radius;
      ctx.globalAlpha = 0.45 + rand() * 0.5;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist, dotR, 0, TWO_PI);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    return;
  }
  // Every dab brush (marker / ink / pencil / crayon / paint / oil / acrylic /
  // watercolor / gouache / glow / custom recipes): the engine's own stamp.
  if (!drawSingleDab(ctx, { brush, color: fill, size, x: cx, y: cy, pressure: 1, angle: 0, seed: 4242 })) {
    // Unknown id (no dab params): one clean round dab.
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TWO_PI);
    ctx.fill();
  }
}
