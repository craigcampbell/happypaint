export const brushCatalog = [
  {
    id: "marker",
    name: "Marker",
    tier: "free",
    description: "Clean, bold color for coloring pages and quick sketches.",
  },
  {
    id: "crayon",
    name: "Crayon",
    tier: "free",
    description: "Waxy, grainy crayon — layer colors and they blend like real wax.",
  },
  {
    id: "pencil",
    name: "Pencil",
    tier: "free",
    description: "Light sketching with pressure-aware texture.",
  },
  {
    id: "paint",
    name: "Paint",
    tier: "free",
    description: "Soft opaque strokes with rounded edges.",
  },
  {
    id: "spray",
    name: "Spray",
    tier: "free",
    description: "Airbrush dots for shading and backgrounds.",
  },
  {
    id: "eraser",
    name: "Eraser",
    tier: "free",
    description: "Removes paint while keeping the paper texture.",
  },
  {
    id: "glow",
    name: "Glow",
    tier: "studio",
    description: "A premium neon brush pack hook for store unlocks.",
  },
];

export const paperTextures = [
  {
    id: "linen",
    name: "Linen",
    file: "/linen.png",
    background: "#f7f1e5",
  },
  {
    id: "canvas",
    name: "Canvas",
    file: "/canvas.png",
    background: "#f6f4ed",
  },
  {
    id: "smooth",
    name: "Smooth",
    file: "",
    background: "#ffffff",
  },
  {
    id: "night",
    name: "Night",
    file: "",
    background: "#171a22",
    tier: "studio",
  },
];

export const paletteCatalog = [
  {
    id: "starter",
    name: "Starter",
    colors: [
      "#000000", "#5b6770", "#ffffff", "#8b5a2b",
      "#e53935", "#ff8a80", "#e67e22", "#f9a825",
      "#fbd400", "#fff59d", "#2ecc71", "#aed581",
      "#0e9c7c", "#1abc9c", "#1e88e5", "#74b9ff",
      "#27406b", "#8e44ad", "#e84393", "#ff9ff3",
      "#ffd1b3", "#e0a96d", "#a9744f", "#3a2a1a",
    ],
  },
  {
    id: "soft",
    name: "Soft",
    colors: ["#2f2f3a", "#f8fafc", "#fca5a5", "#fdba74", "#fde68a", "#86efac", "#93c5fd", "#c4b5fd"],
  },
  {
    id: "poster",
    name: "Poster",
    tier: "studio",
    colors: ["#0f172a", "#f8fafc", "#be123c", "#ea580c", "#ca8a04", "#15803d", "#0369a1", "#6d28d9"],
  },
];

export function getBrush(id) {
  return brushCatalog.find((brush) => brush.id === id) || brushCatalog[0];
}

export function getTexture(id) {
  return paperTextures.find((texture) => texture.id === id) || paperTextures[0];
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function line(ctx, from, to, width, color, opacity, composite = "source-over") {
  ctx.globalCompositeOperation = composite;
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

function spray(ctx, point, size, color, opacity) {
  const dots = clamp(Math.round(size * 1.4), 8, 70);

  ctx.globalAlpha = opacity * 0.34;
  ctx.fillStyle = color;
  ctx.beginPath();

  for (let index = 0; index < dots; index += 1) {
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.random() * size * 0.64;
    const radius = Math.max(0.7, Math.random() * Math.max(1.4, size * 0.07));
    const dotX = point.x + Math.cos(angle) * distance;
    const dotY = point.y + Math.sin(angle) * distance;

    ctx.moveTo(dotX + radius, dotY);
    ctx.arc(dotX, dotY, radius, 0, Math.PI * 2);
  }

  ctx.fill();
  ctx.globalAlpha = 1;
}

function dot(ctx, point, size, color, opacity) {
  ctx.globalAlpha = opacity;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(point.x, point.y, size / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

export function drawBrushSegment(ctx, from, to, settings) {
  const pressure = clamp(to.pressure || 0.55, 0.18, 1);
  const sizeJitter = 1 + (Math.random() * 2 - 1) * settings.variation;
  const baseSize = clamp(settings.size * sizeJitter, 1, 160);
  const opacity = clamp(settings.opacity, 0.05, 1);
  const isTap = Math.hypot(to.x - from.x, to.y - from.y) < 0.1;

  if (settings.brush === "eraser") {
    if (isTap) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.arc(to.x, to.y, baseSize / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
      return;
    }

    line(ctx, from, to, baseSize * (0.7 + pressure * 0.7), "#000000", 1, "destination-out");
    return;
  }

  if (settings.brush === "spray") {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    const steps = clamp(Math.ceil(distance / Math.max(6, baseSize * 0.32)), 1, 12);

    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      spray(
        ctx,
        {
          x: from.x + dx * ratio,
          y: from.y + dy * ratio,
        },
        baseSize,
        settings.color,
        opacity,
      );
    }
    return;
  }

  if (settings.brush === "crayon") {
    // Waxy crayon: scatter short, jittered, semi-transparent flecks along the
    // segment so coverage is uneven. The gaps let the colour underneath show
    // through, so layering two crayons blends optically — like real wax on paper.
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    const w = baseSize * (0.55 + pressure * 0.5);
    const steps = clamp(Math.ceil(dist / Math.max(1.4, w * 0.3)), 1, 40);
    const dl = dist || 1;
    const nx = -dy / dl; // perpendicular unit (for sideways grain)
    const ny = dx / dl;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = settings.color;
    for (let s = 0; s <= steps; s += 1) {
      const t = steps === 0 ? 0 : s / steps;
      const px = from.x + dx * t;
      const py = from.y + dy * t;
      for (let f = 0; f < 2; f += 1) {
        const off = (Math.random() * 2 - 1) * w * 0.5;
        const r = Math.max(0.5, (0.2 + Math.random() * 0.55) * w * 0.5);
        ctx.globalAlpha = opacity * (0.16 + Math.random() * 0.5);
        ctx.beginPath();
        ctx.arc(px + nx * off, py + ny * off, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    return;
  }

  if (settings.brush === "pencil") {
    if (isTap) {
      dot(ctx, to, baseSize * 0.5, settings.color, opacity * 0.7);
      return;
    }

    line(ctx, from, to, baseSize * (0.28 + pressure * 0.58), settings.color, opacity * 0.72);

    if (baseSize > 8) {
      line(
        ctx,
        { x: from.x + 1.5, y: from.y - 1.2 },
        { x: to.x + 1.5, y: to.y - 1.2 },
        baseSize * 0.12,
        settings.color,
        opacity * 0.22,
      );
    }
    return;
  }

  if (settings.brush === "glow") {
    if (isTap) {
      dot(ctx, to, baseSize, settings.color, opacity * 0.78);
      return;
    }

    ctx.shadowColor = settings.color;
    ctx.shadowBlur = baseSize * 0.85;
    line(ctx, from, to, baseSize * (0.44 + pressure * 0.5), settings.color, opacity * 0.78);
    line(ctx, from, to, Math.max(1, baseSize * 0.18), "#ffffff", opacity * 0.38);
    ctx.shadowBlur = 0;
    return;
  }

  if (settings.brush === "paint") {
    if (isTap) {
      dot(ctx, to, baseSize, settings.color, opacity * 0.82);
      return;
    }

    line(ctx, from, to, baseSize * (0.62 + pressure * 0.48), settings.color, opacity * 0.82);
    dot(ctx, to, baseSize * 0.42, settings.color, opacity * 0.26);
    return;
  }

  if (isTap) {
    dot(ctx, to, baseSize * (0.5 + pressure * 0.55), settings.color, opacity);
    return;
  }

  line(ctx, from, to, baseSize * (0.5 + pressure * 0.55), settings.color, opacity);
}
