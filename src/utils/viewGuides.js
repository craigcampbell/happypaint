// Guides drawn over the canvas in SCREEN space, through the current view, so
// they stay glued to the page at any pan, zoom or rotation. `toScreen` maps a
// document point to canvas CSS pixels.

// The real mirror axes of a symmetry room. Mirror reflects across the page's
// vertical centre line, quad across both centre lines, and radial rotates
// around the page centre (see transformSymmetryPoint in symmetry.js), so the
// guide has to follow the page, not sit in the middle of the screen.
export function drawSymmetryGuide(ctx, symmetry, pageWidth, pageHeight, toScreen) {
  const cx = pageWidth / 2;
  const cy = pageHeight / 2;
  const lines = [];
  if (symmetry.mode === "mirror" || symmetry.mode === "quad") {
    lines.push([[cx, 0], [cx, pageHeight]]);
  }
  if (symmetry.mode === "quad") {
    lines.push([[0, cy], [pageWidth, cy]]);
  }
  if (symmetry.mode === "radial") {
    const reach = Math.hypot(cx, cy);
    for (let i = 0; i < symmetry.copies; i += 1) {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / symmetry.copies;
      lines.push([[cx, cy], [cx + Math.cos(angle) * reach, cy + Math.sin(angle) * reach]]);
    }
  }
  if (!lines.length) {
    return;
  }
  const corners = [[0, 0], [pageWidth, 0], [pageWidth, pageHeight], [0, pageHeight]].map(([x, y]) => toScreen(x, y));
  ctx.save();
  // Keep the guide on the page itself.
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < corners.length; i += 1) {
    ctx.lineTo(corners[i].x, corners[i].y);
  }
  ctx.closePath();
  ctx.clip();
  ctx.strokeStyle = "rgba(109, 40, 217, 0.3)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [from, to] of lines) {
    const a = toScreen(from[0], from[1]);
    const b = toScreen(to[0], to[1]);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  ctx.restore();
}
