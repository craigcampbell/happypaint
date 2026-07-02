import { useEffect, useRef } from "react";
import { mulberry32 } from "../utils/brushes";

// A tiny live preview of a brush's mark in the currently-selected colour, shown
// on the brush chips instead of an emoji. ONE centered dab per chip (not a
// stroke) so the picker stays calm and readable: marker/paint = clean solid
// dot, pencil/crayon = dot with a few paper-tooth flecks, glow = its neon
// halo, spray = a small cluster of dots, eraser = dashed "removes" nib.
export default function BrushPreview({ brush, color }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    const w = cv.width;
    const h = cv.height;
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
    if (brush === "oil" || brush === "acrylic") {
      // Streaky bristle character: a few stacked elongated ribbons, like one
      // dab of the real bristle stamp.
      const lanes = brush === "oil" ? 5 : 4;
      for (let i = 0; i < lanes; i += 1) {
        const offsetY = (i - (lanes - 1) / 2) * 3.4;
        ctx.globalAlpha = 0.55 + rand() * 0.45;
        ctx.beginPath();
        ctx.ellipse(cx, cy + offsetY, 12 + rand() * 5, 1.5 + rand(), 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      return;
    }
    if (brush === "gouache") {
      // Matte poster paint: the real dab's 1.3x tangent stretch, flat + opaque.
      ctx.beginPath();
      ctx.ellipse(cx, cy, 11.7, 9, 0, 0, Math.PI * 2);
      ctx.fill();
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
    if (brush === "watercolor") {
      // Translucent wash: faint full dab under a denser core, like the real
      // water stamp — reads as a soft wet pool.
      ctx.globalAlpha = 0.32;
      ctx.beginPath();
      ctx.arc(cx, cy, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.arc(cx, cy, 7.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      return;
    }
    if (brush === "glow") {
      // The dab under its neon shadow, like the real glow stamp.
      ctx.shadowColor = fill;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(cx, cy, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fill(); // second pass deepens the halo
      ctx.shadowBlur = 0;
      return;
    }
    // One clean centered dab (marker/paint solid; pencil/crayon textured below).
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.fill();
    if (brush === "pencil" || brush === "crayon") {
      // A few paper-tooth flecks so the graphite/waxy character still reads.
      ctx.globalCompositeOperation = "destination-out";
      for (let i = 0; i < 3; i += 1) {
        const angle = rand() * Math.PI * 2;
        const dist = 2 + rand() * 5;
        ctx.globalAlpha = 0.45 + rand() * 0.35;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist, 1 + rand(), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }
  }, [brush, color]);

  return <canvas ref={ref} width={46} height={30} className="brush-preview" aria-hidden="true" />;
}
