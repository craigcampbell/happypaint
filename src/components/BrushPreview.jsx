import { useEffect, useRef } from "react";
import { dabExtent, drawSingleDab, mulberry32, previewDabFor } from "../utils/brushes";

// Chip canvas (CSS px == canvas px) and the dab size that fits it.
const CHIP_W = 46;
const CHIP_H = 30;
const CHIP_DAB = 18;

// A tiny live preview of a brush's mark in the currently-selected colour, shown
// on the brush chips instead of an emoji. ONE centered dab per chip (not a
// stroke) so the picker stays calm and readable. The dab is the engine's own
// stamp (drawSingleDab → makeStrokeRenderer's emitDab, v3-first) at full
// pressure with a fixed seed, so the chip shows exactly what the brush lays
// down and never shimmers. Hand-drawn special cases: eraser = dashed "removes"
// nib, smudge = neutral drag streak, spray = dot cluster (legacy path, no dab),
// ink = a thick-to-hairline sweep (its dab is a plain disc — the taper IS the
// brush, and a disc would just duplicate the marker chip).
export default function BrushPreview({ brush, color }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    const w = cv.width;
    const h = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, w, h);
    if (brush === "eraser") {
      // Nothing to paint — show a dashed eraser nib so it reads as "removes".
      ctx.strokeStyle = "#7a8794";
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 2;
      ctx.strokeRect(w / 2 - 11, h / 2 - 8, 22, 16);
      ctx.setLineDash([]);
      return;
    }
    if (brush === "smudge") {
      // No pigment of its own — a neutral streak fading along the drag
      // direction, so it reads as "pushes the paint that's already there".
      const grad = ctx.createLinearGradient(w / 2 - 14, 0, w / 2 + 14, 0);
      grad.addColorStop(0, "rgba(122, 135, 148, 0.9)");
      grad.addColorStop(1, "rgba(122, 135, 148, 0.06)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2, 14, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const cx = w / 2;
    const cy = h / 2;
    const fill = color || "#111827";
    const rand = mulberry32(12345); // fixed seed → stable chip across re-renders
    ctx.fillStyle = fill;
    if (brush === "spray") {
      // Airbrush character: a small cluster of dots instead of one solid dab.
      for (let i = 0; i < 26; i += 1) {
        const angle = rand() * Math.PI * 2;
        const dist = Math.sqrt(rand()) * 10;
        ctx.globalAlpha = 0.45 + rand() * 0.5;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist, 0.6 + rand() * 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      return;
    }
    if (brush === "ink") {
      // All about taper: a thick-to-hairline sweep instead of a plain dot.
      ctx.beginPath();
      ctx.moveTo(cx - 16, cy);
      ctx.quadraticCurveTo(cx - 4, cy - 9, cx + 16, cy - 1);
      ctx.quadraticCurveTo(cx - 4, cy + 3, cx - 16, cy);
      ctx.closePath();
      ctx.fill();
      return;
    }
    // One centered dab of the real brush, shrunk so its widest reach (bristle
    // ribbons, the glow halo, thrown flecks) still fits the chip.
    const dab = previewDabFor(brush);
    const size = dab ? Math.min(CHIP_DAB, (w - 4) / dabExtent(dab)) : CHIP_DAB;
    if (!drawSingleDab(ctx, { brush, color: fill, size, x: cx, y: cy, pressure: 1, angle: 0, seed: 12345 })) {
      // Unknown id (no dab params): one clean round dab.
      ctx.beginPath();
      ctx.arc(cx, cy, CHIP_DAB / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0; // a legacy (v2) glow dab would leave a shadow set; the v3 halo doesn't
  }, [brush, color]);

  return <canvas ref={ref} width={CHIP_W} height={CHIP_H} className="brush-preview" aria-hidden="true" />;
}
