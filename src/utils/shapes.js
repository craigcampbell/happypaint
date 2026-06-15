// Shape / line / text rendering helpers shared by the live preview overlay and
// the final commit onto the active layer. Drawing onto a temp overlay first and
// committing on release keeps the active layer untouched while dragging.

export function drawShape(context, tool, start, end, settings) {
  const { color = "#111827", size = 8, opacity = 1, fillShape = false } = settings;

  context.save();
  context.globalAlpha = Math.max(0.05, Math.min(1, opacity));
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = Math.max(1, size);
  context.strokeStyle = color;
  context.fillStyle = color;

  if (tool === "line") {
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
  } else if (tool === "rect") {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);
    if (fillShape) {
      context.fillRect(x, y, w, h);
    } else {
      context.strokeRect(x, y, w, h);
    }
  } else if (tool === "ellipse") {
    const cx = (start.x + end.x) / 2;
    const cy = (start.y + end.y) / 2;
    const rx = Math.abs(end.x - start.x) / 2;
    const ry = Math.abs(end.y - start.y) / 2;
    context.beginPath();
    context.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    if (fillShape) {
      context.fill();
    } else {
      context.stroke();
    }
  }

  context.restore();
}

export function drawText(context, point, text, settings) {
  const { color = "#111827", fontSize = 64, opacity = 1, fontFamily = "system-ui, sans-serif" } = settings;

  if (!text) {
    return;
  }

  context.save();
  context.globalAlpha = Math.max(0.05, Math.min(1, opacity));
  context.fillStyle = color;
  context.textBaseline = "top";
  context.font = `700 ${Math.max(8, fontSize)}px ${fontFamily}`;

  const lines = String(text).split("\n");
  const lineHeight = Math.max(8, fontSize) * 1.2;
  lines.forEach((line, index) => {
    context.fillText(line, point.x, point.y + index * lineHeight);
  });

  context.restore();
}
