// The hover cursor's tip preview: ONE dab of the selected brush, drawn at the
// on-screen size, so you see the SHAPE you're about to lay down (bristle
// ribbons, a stretched paint dab, an airbrush cloud, pencil tooth…) — not just a
// size ring. Mirrors the per-shape stamps in makeStrokeRenderer (brushes.js)
// and the palette chip (BrushPreview.jsx) at full pressure with a horizontal
// tangent. Dice are fixed-seeded so the preview never shimmers between renders.
//
// Only re-drawn when brush / colour / size / zoom change — never per pointer
// move — so it stays off the draw hot path (see updateBrushCursor in App.jsx).
import { getDab, mulberry32, shiftLightness } from "./brushes";

const TWO_PI = Math.PI * 2;
const PREVIEW_ALPHA = 0.62; // translucent: the paint underneath stays readable

// Widest extent of one dab as a multiple of `size` — the cursor canvas box has
// to hold the whole tip, and paint ellipses / bristle ribbons / flecks reach
// past the nominal circle.
export function brushTipExtent(brushId, tool) {
  if (tool !== "brush") {
    return 1;
  }
  if (brushId === "smudge") {
    return 1.5;
  }
  const dab = getDab(brushId);
  if (!dab) {
    return 1;
  }
  switch (dab.shape) {
    case "ellipse":
      return 1.6;
    case "gouache":
      return 1.3;
    case "bristle":
      return Math.max(1, dab.stretch || 1);
    case "pencil":
      return 1.7;
    case "crayon":
      return 1.3;
    case "glow":
      return 1.6;
    default:
      return 1;
  }
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
    ctx.globalAlpha = PREVIEW_ALPHA;
    ctx.beginPath();
    ctx.ellipse(cx, cy, radius * 1.4, radius * 0.6, 0, 0, TWO_PI);
    ctx.fill();
    return;
  }
  const fill = color || "#111827";
  ctx.fillStyle = fill;
  if (brush === "spray") {
    // Airbrush: a dot cloud inside the radius, denser for bigger tips.
    const dots = Math.round(Math.min(260, Math.max(18, radius * radius * 0.3)));
    const dotR = Math.max(0.6, radius * 0.06);
    for (let i = 0; i < dots; i += 1) {
      const angle = rand() * TWO_PI;
      const dist = Math.sqrt(rand()) * radius;
      ctx.globalAlpha = PREVIEW_ALPHA * (0.45 + rand() * 0.5);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist, dotR, 0, TWO_PI);
      ctx.fill();
    }
    return;
  }
  const dab = getDab(brush) || {};
  const flowAlpha = PREVIEW_ALPHA * Math.min(1, Math.max(0.5, dab.flow == null ? 1 : dab.flow));
  switch (dab.shape) {
    case "ellipse": {
      // Loaded-brush paint: 1.6x along the stroke tangent.
      ctx.globalAlpha = flowAlpha;
      ctx.beginPath();
      ctx.ellipse(cx, cy, radius * 1.6, radius, 0, 0, TWO_PI);
      ctx.fill();
      return;
    }
    case "gouache": {
      ctx.globalAlpha = flowAlpha;
      ctx.beginPath();
      ctx.ellipse(cx, cy, radius * 1.3, radius, 0, 0, TWO_PI);
      ctx.fill();
      return;
    }
    case "pencil": {
      // Graphite core + a few tooth flecks around it.
      ctx.globalAlpha = flowAlpha;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TWO_PI);
      ctx.fill();
      for (let i = 0; i < 3; i += 1) {
        const fa = rand() * TWO_PI;
        const fd = (0.3 + rand() * 0.7) * size * 0.8;
        const fr = Math.max(0.35, size * (0.05 + rand() * 0.09));
        ctx.globalAlpha = flowAlpha * (0.22 + rand() * 0.3);
        ctx.beginPath();
        ctx.arc(cx + Math.cos(fa) * fd, cy + Math.sin(fa) * fd, fr, 0, TWO_PI);
        ctx.fill();
      }
      return;
    }
    case "crayon": {
      // Waxy base + flecks: uneven coverage, like the real dab.
      ctx.globalAlpha = flowAlpha * 0.4;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TWO_PI);
      ctx.fill();
      for (let i = 0; i < 5; i += 1) {
        const fa = rand() * TWO_PI;
        const fd = rand() * size * 0.55;
        const fr = Math.max(0.5, (0.2 + rand() * 0.55) * radius);
        ctx.globalAlpha = flowAlpha * (0.16 + rand() * 0.5);
        ctx.beginPath();
        ctx.arc(cx + Math.cos(fa) * fd, cy + Math.sin(fa) * fd, fr, 0, TWO_PI);
        ctx.fill();
      }
      return;
    }
    case "water": {
      // Faint full wash under a denser core.
      ctx.globalAlpha = flowAlpha * 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TWO_PI);
      ctx.fill();
      ctx.globalAlpha = flowAlpha;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.68, 0, TWO_PI);
      ctx.fill();
      return;
    }
    case "glow": {
      ctx.globalAlpha = flowAlpha;
      ctx.shadowColor = fill;
      ctx.shadowBlur = Math.max(4, radius * 0.6);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TWO_PI);
      ctx.fill();
      ctx.fill(); // second pass deepens the halo
      ctx.shadowBlur = 0;
      return;
    }
    case "bristle": {
      // Oil/acrylic: N ribbons fanned across the tip, stretched along it. Same
      // roll order as the engine's bristle table (offset → length → width →
      // alpha → tint) so the preview has the real streaky character.
      const count = dab.bristles || 6;
      const stretch = dab.stretch || 1;
      const ribbonHalf = (radius * 1.7) / count;
      const tintable = /^#/.test(fill);
      for (let i = 0; i < count; i += 1) {
        const roll = mulberry32((4242 ^ Math.imul(i, 2654435761)) >>> 0);
        const offset = (roll() * 2 - 1) * 0.85;
        const length = 0.55 + roll() * 0.45;
        const width = 0.6 + roll() * 0.6;
        const alpha = 0.55 + roll() * 0.45;
        const tint = (roll() * 2 - 1) * 0.08;
        ctx.fillStyle = tintable ? shiftLightness(fill, tint) : fill;
        ctx.globalAlpha = flowAlpha * alpha;
        ctx.beginPath();
        ctx.ellipse(
          cx,
          cy + offset * radius,
          Math.max(0.5, radius * stretch * length),
          Math.max(0.35, ribbonHalf * width),
          0,
          0,
          TWO_PI,
        );
        ctx.fill();
      }
      return;
    }
    default: {
      // Marker / ink / custom recipes: one clean round dab.
      ctx.globalAlpha = flowAlpha;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TWO_PI);
      ctx.fill();
    }
  }
}
