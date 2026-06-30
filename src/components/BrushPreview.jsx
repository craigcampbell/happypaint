import { useEffect, useRef } from "react";
import { drawBrushSegment } from "../utils/brushes";

// A tiny live preview of a brush's actual mark in the currently-selected colour,
// shown on the brush chips instead of an emoji — so you see what each brush does
// (marker = solid, spray = dots, crayon = grainy, glow = glowy…) in your colour.
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
    const settings = {
      brush,
      color: color || "#111827",
      size: brush === "spray" ? 15 : 13,
      opacity: 0.95,
      variation: brush === "crayon" ? 0.12 : 0,
    };
    // A short S-curve, drawn with rising/falling pressure so the mark reads as a
    // real stroke (and shows the new pressure taper).
    const pts = [
      { x: 8, y: h - 7, pressure: 0.5 },
      { x: w * 0.36, y: 7, pressure: 0.95 },
      { x: w * 0.64, y: h - 6, pressure: 0.7 },
      { x: w - 8, y: 8, pressure: 0.4 },
    ];
    let last = pts[0];
    for (const point of pts) {
      drawBrushSegment(ctx, last, point, settings);
      last = point;
    }
  }, [brush, color]);

  return <canvas ref={ref} width={46} height={30} className="brush-preview" aria-hidden="true" />;
}
