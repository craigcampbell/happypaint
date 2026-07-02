// Each brush carries an `icon` (emoji) so the picker reads as a fun, kid-friendly
// art box rather than a list of text chips.
//
// `dab` (Brush Engine Stage 2): brushes with a dab object render through
// makeStrokeRenderer — spaced stamps walked along the stroke — instead of the
// legacy drawBrushSegment lines. Ops from these brushes carry settings.v = 2 so
// every consumer (local / remote / spectator / history replay) routes the same
// way; brushes WITHOUT a dab entry (spray, eraser, anything custom) stay on the
// legacy path forever, keeping old history pixel-stable.
//   spacing  — dab step as a fraction of the dab's current size
//   minSize  — dab size at zero pressure, as a fraction of settings.size
//   flow     — per-dab base alpha (stroke opacity is applied ONCE at commit)
//   shape    — stamp: "round" | "pencil" | "crayon" | "ellipse" | "glow"
//              | "bristle" (oil/acrylic) | "water" (watercolor)
//   scatter  — perpendicular jitter as a fraction of dab size
//   rotJitter— random rotation range (radians) around the stroke tangent
//   grain    — paper-tooth strength etched at commit time (0 = none)
//   bristles — sub-dab count for shape "bristle" (seed-stable per stroke)
//   stretch  — bristle-dab elongation along the stroke tangent
//   wetEdge  — commit-pass darkened-rim strength (0 = none)
//   impasto  — commit-pass top-left emboss strength (0 = none)
//
// minSize values are tuned for a ≥3x thin-to-thick pressure range (Stage 3):
// with the 1.35 gamma, full press is 3-6x the lightest touch per brush.
export const brushCatalog = [
  {
    id: "marker",
    name: "Marker",
    icon: "🖊️",
    tier: "free",
    description: "Clean, bold color for coloring pages and quick sketches.",
    dab: { spacing: 0.1, minSize: 0.22, flow: 1, shape: "round" },
  },
  {
    id: "crayon",
    name: "Crayon",
    icon: "🖍️",
    tier: "free",
    description: "Waxy, grainy crayon — layer colors and they blend like real wax.",
    dab: { spacing: 0.14, minSize: 0.25, flow: 0.8, shape: "crayon", scatter: 0.08, grain: 0.22 },
  },
  {
    id: "pencil",
    name: "Pencil",
    icon: "✏️",
    tier: "free",
    description: "Light sketching with pressure-aware texture.",
    dab: { spacing: 0.16, minSize: 0.12, flow: 0.72, shape: "pencil", scatter: 0.05, grain: 0.14 },
  },
  {
    id: "paint",
    name: "Paint",
    icon: "🎨",
    tier: "free",
    description: "Soft opaque strokes with rounded edges.",
    dab: { spacing: 0.12, minSize: 0.2, flow: 0.9, shape: "ellipse", rotJitter: 0.3 },
  },
  {
    id: "oil",
    name: "Oil",
    icon: "🛢️",
    tier: "free",
    description: "Thick streaky oil paint — bristles, wet edges, and a buttery emboss.",
    dab: { spacing: 0.08, minSize: 0.3, flow: 0.85, shape: "bristle", bristles: 8, stretch: 2.2, wetEdge: 0.18, impasto: 0.14 },
  },
  {
    id: "acrylic",
    name: "Acrylic",
    icon: "🎨",
    tier: "free",
    description: "Bold fast-drying paint with visible brush bristles.",
    dab: { spacing: 0.1, minSize: 0.25, flow: 0.95, shape: "bristle", bristles: 5, stretch: 1.7, impasto: 0.1 },
  },
  {
    id: "watercolor",
    name: "Watercolor",
    icon: "💧",
    tier: "free",
    description: "Translucent washes that pool darker at the edges.",
    dab: { spacing: 0.14, minSize: 0.32, flow: 0.3, shape: "water", wetEdge: 0.25, grain: 0.18 },
  },
  {
    // No `dab`: spray is already a scatter stamp — it stays on the legacy path
    // (Stage 2 intentionally excludes it from v2 routing).
    id: "spray",
    name: "Spray",
    icon: "💨",
    tier: "free",
    description: "Airbrush dots for shading and backgrounds.",
  },
  {
    // No `dab`: erasing keeps the legacy direct destination-out path.
    id: "eraser",
    name: "Eraser",
    icon: "🧽",
    tier: "free",
    description: "Removes paint while keeping the paper texture.",
  },
  {
    id: "glow",
    name: "Glow",
    icon: "✨",
    tier: "free",
    description: "Soft neon glow — great for sparkles, magic, and night scenes.",
    dab: { spacing: 0.22, minSize: 0.3, flow: 0.85, shape: "glow" },
  },
];

// The Stage-2 dab params for a brush id, or null for legacy-path brushes
// (spray, eraser, unknown/custom ids). The single routing predicate every
// consumer shares: `settings.v >= 2 && getDab(settings.brush)`.
export function getDab(brushId) {
  const brush = brushCatalog.find((entry) => entry.id === brushId);
  return (brush && brush.dab) || null;
}

export const paperTextures = [
  {
    id: "linen",
    name: "Linen",
    icon: "🧵",
    file: "/linen.png",
    background: "#f7f1e5",
  },
  {
    id: "canvas",
    name: "Canvas",
    icon: "🖼️",
    file: "/canvas.png",
    background: "#f6f4ed",
  },
  {
    id: "smooth",
    name: "Smooth",
    icon: "⬜",
    file: "",
    background: "#ffffff",
  },
  {
    id: "night",
    name: "Night",
    icon: "🌙",
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

// Small, fast seedable PRNG (standard mulberry32). Used so the SAME stroke
// renders pixel-identically on every client (local, remote, spectator).
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Shift a hex colour's lightness by `amount` (-1..1): positive blends toward
// white, negative toward black. Integer channels + a fixed output format keep
// the tinted string byte-identical on every client (bristle parity).
export function shiftLightness(hex, amount) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex || "");
  if (!match) {
    return hex;
  }
  let digits = match[1];
  if (digits.length === 3) {
    digits = digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2];
  }
  const out = [0, 2, 4].map((i) => {
    const channel = parseInt(digits.slice(i, i + 2), 16);
    const shifted = amount >= 0 ? channel + (255 - channel) * amount : channel * (1 + amount);
    return Math.max(0, Math.min(255, Math.round(shifted)));
  });
  return `rgb(${out[0]},${out[1]},${out[2]})`;
}

// Per-point generator derived from the stroke seed + the point's COORDINATES
// (not its index): wire batching boundaries and the wire-level duplicate-point
// dedupe can drop/regroup points, so an index-based sequence would desync the
// local and remote randomness. Coordinates survive both.
export function pointRand(seed, x, y) {
  return mulberry32((seed ^ (Math.round(x) * 73856093) ^ (Math.round(y) * 19349663)) >>> 0);
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

function spray(ctx, point, size, color, opacity, rand) {
  const dots = clamp(Math.round(size * 1.4), 8, 70);

  ctx.globalAlpha = opacity * 0.34;
  ctx.fillStyle = color;
  ctx.beginPath();

  for (let index = 0; index < dots; index += 1) {
    const angle = rand() * Math.PI * 2;
    const distance = rand() * size * 0.64;
    const radius = Math.max(0.7, rand() * Math.max(1.4, size * 0.07));
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

// `rand` is the randomness source for this segment's jitter/scatter. The
// default keeps legacy (seedless) ops looking exactly like they used to; live
// strokes pass a pointRand(seed, x, y) generator so every client rolls the
// same dice for the same point.
export function drawBrushSegment(ctx, from, to, settings, rand = Math.random) {
  const pressure = clamp(to.pressure || 0.55, 0.06, 1);
  const sizeJitter = 1 + (rand() * 2 - 1) * settings.variation;
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

    line(ctx, from, to, baseSize * (0.85 + pressure * 0.35), "#000000", 1, "destination-out");
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
        rand,
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
    const w = baseSize * (0.3 + pressure * 0.9);
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
        const off = (rand() * 2 - 1) * w * 0.5;
        const r = Math.max(0.5, (0.2 + rand() * 0.55) * w * 0.5);
        ctx.globalAlpha = opacity * (0.16 + rand() * 0.5);
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

    line(ctx, from, to, baseSize * (0.16 + pressure * 0.92), settings.color, opacity * 0.72);

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
    line(ctx, from, to, baseSize * (0.26 + pressure * 0.92), settings.color, opacity * 0.78);
    line(ctx, from, to, Math.max(1, baseSize * 0.18), "#ffffff", opacity * 0.38);
    ctx.shadowBlur = 0;
    return;
  }

  if (settings.brush === "paint") {
    if (isTap) {
      dot(ctx, to, baseSize, settings.color, opacity * 0.82);
      return;
    }

    line(ctx, from, to, baseSize * (0.34 + pressure * 1.0), settings.color, opacity * 0.82);
    dot(ctx, to, baseSize * 0.42, settings.color, opacity * 0.26);
    return;
  }

  if (isTap) {
    dot(ctx, to, baseSize * (0.28 + pressure * 1.05), settings.color, opacity);
    return;
  }

  line(ctx, from, to, baseSize * (0.28 + pressure * 1.05), settings.color, opacity);
}

// ---------------------------------------------------------------------------
// Brush Engine Stage 2: the dab core.
//
// A v2 stroke is a walk of spaced stamps ("dabs") along the pointer path. The
// renderer instance holds ALL walk state (lastPoint, residual spacing
// distance, started flag) and lives in the per-stroke entry next to the
// Stage-1 buffer, so the 40ms wire batching CANNOT change output: the
// residual carries across addPoints calls, and per-dab randomness is
// coordinate-derived (pointRand(seed, dabX, dabY)) — already batching-proof.
// Dabs draw into the Stage-1 stroke buffer at their flow alpha, NEVER at
// settings.opacity (the buffer commits once at the stroke's opacity).

const TWO_PI = Math.PI * 2;
const DAB_MIN_STEP = 1.5; // world px — absolute spacing floor (perf guardrail)
const DAB_CAP = 600; // dabs per addPoints call before the step doubles

export function makeStrokeRenderer(settings) {
  const dab = getDab(settings.brush) || {};
  const color = settings.color;
  const seed = settings.seed;
  const size = clamp(settings.size || 24, 1, 160);
  const minSize = dab.minSize == null ? 0.5 : dab.minSize;
  const flowBase = dab.flow == null ? 1 : dab.flow;
  // Big brushes stamp fewer, larger dabs — blur/fleck cost scales with area.
  const spacingK = (dab.spacing == null ? 0.14 : dab.spacing) * (size > 80 ? 1.5 : 1);
  const scatterK = dab.scatter || 0;
  const rotJitter = dab.rotJitter || 0;
  const shape = dab.shape || "round";
  const stretchK = dab.stretch || 1;

  // Oil/acrylic bristle table: each bristle's lane / length / width / alpha /
  // tint is rolled ONCE here from the stroke seed (mulberry32(seed ^ index)),
  // NOT from the per-dab dice — so a bristle holds its exact character along
  // the whole stroke instead of shimmering dab to dab. Deterministic across
  // clients because it depends only on settings.seed + the catalog count.
  let bristleTable = null;
  if (shape === "bristle") {
    const count = dab.bristles || 6;
    bristleTable = [];
    for (let i = 0; i < count; i += 1) {
      const roll = mulberry32(((seed == null ? 0 : seed) ^ Math.imul(i, 2654435761)) >>> 0);
      bristleTable.push({
        offset: (roll() * 2 - 1) * 0.85, // perpendicular lane, fraction of radius
        length: 0.55 + roll() * 0.45, // along-tangent elongation variance
        width: 0.6 + roll() * 0.6, // ribbon thickness variance
        alpha: 0.55 + roll() * 0.45, // per-bristle paint load
        color: shiftLightness(color, (roll() * 2 - 1) * 0.08), // ±8% lightness
      });
    }
  }

  // --- Per-stroke walk state (the whole point of the instance) ---
  let lastPoint = null; // { x, y, pressure }
  let residual = 0; // distance already consumed past the last emitted dab
  let started = false;

  // pressure^1.35 taper: light touches thin out faster than linear, and the
  // widened minSize band gives every brush a ≥3x thin-to-thick range.
  const dabSizeAt = (pressure) => size * (minSize + (1 - minSize) * Math.pow(pressure, 1.35));

  // One stamp. `rand` consumption order is FIXED per brush (scatter → rot →
  // shape flecks), so the same seed + dab coordinate rolls the same dice on
  // every client.
  const emitDab = (ctx, x, y, pressure, angle) => {
    const rand = seed != null ? pointRand(seed, x, y) : Math.random;
    const sizePx = dabSizeAt(pressure);
    const flowAlpha = flowBase * (0.5 + 0.5 * pressure);
    let dx = x;
    let dy = y;
    if (scatterK > 0) {
      const off = (rand() * 2 - 1) * scatterK * sizePx;
      dx += -Math.sin(angle) * off; // perpendicular to the tangent
      dy += Math.cos(angle) * off;
    }
    const rot = rotJitter > 0 ? angle + (rand() - 0.5) * rotJitter : angle;
    const radius = sizePx / 2;
    ctx.fillStyle = color;
    if (shape === "ellipse") {
      // Loaded-brush paint: elongated 1.6x along the stroke tangent.
      ctx.globalAlpha = flowAlpha;
      ctx.save();
      ctx.translate(dx, dy);
      ctx.rotate(rot);
      ctx.scale(1.6, 1);
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, TWO_PI);
      ctx.fill();
      ctx.restore();
    } else if (shape === "pencil") {
      // Small graphite core + 2-3 tiny flecks of tooth around it.
      ctx.globalAlpha = flowAlpha;
      ctx.beginPath();
      ctx.arc(dx, dy, radius, 0, TWO_PI);
      ctx.fill();
      const flecks = rand() < 0.5 ? 2 : 3;
      for (let i = 0; i < flecks; i += 1) {
        const fa = rand() * TWO_PI;
        const fd = (0.3 + rand() * 0.7) * sizePx * 0.8;
        const fr = Math.max(0.35, sizePx * (0.05 + rand() * 0.09));
        ctx.globalAlpha = flowAlpha * (0.22 + rand() * 0.3);
        ctx.beginPath();
        ctx.arc(dx + Math.cos(fa) * fd, dy + Math.sin(fa) * fd, fr, 0, TWO_PI);
        ctx.fill();
      }
    } else if (shape === "crayon") {
      // Waxy base + 3-5 flecks at random alpha — the legacy crayon fleck look
      // (uneven coverage that blends optically when layered) in per-dab form.
      ctx.globalAlpha = flowAlpha * 0.4;
      ctx.beginPath();
      ctx.arc(dx, dy, radius, 0, TWO_PI);
      ctx.fill();
      const flecks = 3 + Math.floor(rand() * 3);
      for (let i = 0; i < flecks; i += 1) {
        const fa = rand() * TWO_PI;
        const fd = rand() * sizePx * 0.55;
        const fr = Math.max(0.5, (0.2 + rand() * 0.55) * radius);
        ctx.globalAlpha = flowAlpha * (0.16 + rand() * 0.5);
        ctx.beginPath();
        ctx.arc(dx + Math.cos(fa) * fd, dy + Math.sin(fa) * fd, fr, 0, TWO_PI);
        ctx.fill();
      }
    } else if (shape === "bristle") {
      // Oil/acrylic: N elongated sub-dab ribbons fanned perpendicular to the
      // tangent, stretched `stretchK` along it. All per-bristle variation
      // comes from the construction-time bristleTable (seed-stable), so the
      // streaks track the stroke instead of shimmering.
      ctx.save();
      ctx.translate(dx, dy);
      ctx.rotate(rot);
      const ribbonHalf = (radius * 1.7) / bristleTable.length;
      for (const bristle of bristleTable) {
        ctx.fillStyle = bristle.color;
        ctx.globalAlpha = flowAlpha * bristle.alpha;
        ctx.beginPath();
        ctx.ellipse(
          0,
          bristle.offset * radius,
          Math.max(0.5, radius * stretchK * bristle.length),
          Math.max(0.35, ribbonHalf * bristle.width),
          0,
          0,
          TWO_PI,
        );
        ctx.fill();
      }
      ctx.restore();
    } else if (shape === "water") {
      // Watercolor: a faint full-size wash under a denser core — a soft-edged
      // round dab without shadowBlur cost. Low flow means each pass lays a
      // translucent film that pools where dabs overlap.
      ctx.globalAlpha = flowAlpha * 0.5;
      ctx.beginPath();
      ctx.arc(dx, dy, radius, 0, TWO_PI);
      ctx.fill();
      ctx.globalAlpha = flowAlpha;
      ctx.beginPath();
      ctx.arc(dx, dy, radius * 0.68, 0, TWO_PI);
      ctx.fill();
    } else if (shape === "glow") {
      // Round dab under the existing neon shadow styling. shadowBlur is
      // expensive — glow's wider spacing (0.22) pays for it.
      ctx.globalAlpha = flowAlpha;
      ctx.shadowColor = color;
      ctx.shadowBlur = sizePx * 0.85;
      ctx.beginPath();
      ctx.arc(dx, dy, radius, 0, TWO_PI);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.globalAlpha = flowAlpha * 0.4;
      ctx.beginPath();
      ctx.arc(dx, dy, Math.max(0.5, radius * 0.35), 0, TWO_PI);
      ctx.fill();
      ctx.shadowBlur = 0;
    } else {
      // "round": crisp solid circle (marker).
      ctx.globalAlpha = flowAlpha;
      ctx.beginPath();
      ctx.arc(dx, dy, radius, 0, TWO_PI);
      ctx.fill();
    }
  };

  // Walk dabs from lastPoint through each incoming point. All consumers feed
  // this the same point sequence (wire consumers literally so; local feeds the
  // raw pre-quantize points), so with per-stroke residual + coordinate-seeded
  // dice the dab layout is batching-independent.
  const addPoints = (ctx, points) => {
    let emitted = 0;
    ctx.globalCompositeOperation = "source-over";
    for (const raw of points) {
      const pressure = clamp(raw.pressure == null ? 0.55 : raw.pressure, 0.06, 1);
      if (!started) {
        // First point of a stroke stamps immediately (taps leave a mark).
        started = true;
        emitDab(ctx, raw.x, raw.y, pressure, 0);
        emitted += 1;
        residual = Math.max(DAB_MIN_STEP, spacingK * dabSizeAt(pressure));
        lastPoint = { x: raw.x, y: raw.y, pressure };
        continue;
      }
      const sdx = raw.x - lastPoint.x;
      const sdy = raw.y - lastPoint.y;
      const d = Math.hypot(sdx, sdy);
      if (d < 1e-6) {
        // Stationary pressure-only update: skip WITHOUT touching walk state.
        // The wire dedup can drop such points, so consuming them here would
        // desync local vs remote dab placement.
        continue;
      }
      const angle = Math.atan2(sdy, sdx);
      let pos = residual;
      while (pos <= d) {
        const t = pos / d;
        const p = lastPoint.pressure + (pressure - lastPoint.pressure) * t;
        emitDab(ctx, lastPoint.x + sdx * t, lastPoint.y + sdy * t, p, angle);
        emitted += 1;
        let step = Math.max(DAB_MIN_STEP, spacingK * dabSizeAt(p));
        if (emitted > DAB_CAP) {
          // Giant-flick guardrail: past the cap the step doubles, and doubles
          // again per additional cap-block — stays smooth enough, can't jank.
          // Deterministic: the count is per call, and every parity-relevant
          // consumer feeds addPoints one point (= one segment) at a time.
          step *= Math.min(16, 2 ** Math.floor(emitted / DAB_CAP));
        }
        pos += step;
      }
      residual = pos - d;
      lastPoint = { x: raw.x, y: raw.y, pressure };
    }
    ctx.globalAlpha = 1;
  };

  // Stroke-end hook. Dabs are emitted as points arrive, so nothing to flush
  // today — this exists so the per-stroke lifecycle is explicit (Stage 3
  // taper/wet-edge will need it). Never called on overflow restarts.
  const end = () => {};

  return { addPoints, end };
}

// ---------------------------------------------------------------------------
// Paper grain (Stage 2): a fixed-seed noise tile "etched" out of a stroke
// buffer ONCE at commit time via destination-out. The FIXED constant seed
// matters: every client builds the byte-identical tile, so remote / replay /
// spectator commits stay pixel-equal to local.

const GRAIN_SEED = 0x9e3779b9;
const GRAIN_SIZE = 256;
let grainTile = null; // lazily-built, shared for the session

function getGrainTile() {
  if (!grainTile) {
    const canvas = document.createElement("canvas");
    canvas.width = GRAIN_SIZE;
    canvas.height = GRAIN_SIZE;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(GRAIN_SIZE, GRAIN_SIZE);
    const rand = mulberry32(GRAIN_SEED);
    const data = image.data;
    for (let i = 3; i < data.length; i += 4) {
      data[i] = (rand() * 256) | 0; // black pixels, random alpha (tooth depth)
    }
    ctx.putImageData(image, 0, 0);
    grainTile = canvas;
  }
  return grainTile;
}

// Erode `strength` worth of tooth across `bounds` ({x0, y0, w, h}, WORLD
// coords). Tiles are aligned to world-space multiples of the tile size — the
// buffer ctx carries the buffer's world-origin transform, so world position
// (not buffer position) decides the pattern phase: two strokes over the same
// paper spot share the same tooth.
export function applyGrain(bufferCtx, bounds, strength) {
  if (!(strength > 0)) {
    return;
  }
  const tile = getGrainTile();
  const startX = Math.floor(bounds.x0 / GRAIN_SIZE) * GRAIN_SIZE;
  const startY = Math.floor(bounds.y0 / GRAIN_SIZE) * GRAIN_SIZE;
  bufferCtx.save();
  bufferCtx.globalCompositeOperation = "destination-out";
  bufferCtx.globalAlpha = strength;
  for (let y = startY; y < bounds.y0 + bounds.h; y += GRAIN_SIZE) {
    for (let x = startX; x < bounds.x0 + bounds.w; x += GRAIN_SIZE) {
      bufferCtx.drawImage(tile, x, y);
    }
  }
  bufferCtx.restore();
}

// ---------------------------------------------------------------------------
// Stage 3 commit passes: wet edge + impasto. Each draws the stroke buffer
// ONTO ITSELF (source-atop, so nothing escapes the stroke's alpha) with a
// small offset and a brightness() filter — pure functions of the buffer's
// already-deterministic pixels, so three-way replay parity holds. On clients
// without canvas ctx.filter (ancient browsers) the pass no-ops entirely:
// skipping is the parity-safe fallback (an unfiltered stamp would still
// change pixels, differently).

let canvasFilterOk = null;
function supportsCanvasFilter() {
  if (canvasFilterOk == null) {
    try {
      const probe = document.createElement("canvas").getContext("2d");
      canvasFilterOk = typeof probe.filter === "string";
    } catch {
      canvasFilterOk = false;
    }
  }
  return canvasFilterOk;
}

// Darkened copy of the stroke stamped at (+1.5, +1.5) inside its own alpha:
// the offset leaves a lighter crescent on one rim and a pigment-pool shadow
// on the other — the watercolor/oil "wet edge".
function applyWetEdge(ctx, canvas, bounds, strength) {
  if (!supportsCanvasFilter()) {
    return;
  }
  ctx.save();
  try {
    ctx.globalCompositeOperation = "source-atop";
    ctx.globalAlpha = strength;
    ctx.filter = "brightness(0.55)";
    ctx.drawImage(canvas, bounds.x0 + 1.5, bounds.y0 + 1.5);
  } catch {
    /* filter unsupported mid-flight: leave the buffer untouched */
  }
  ctx.restore();
}

// Top-left light emboss: a brightened copy at (-1, -1) plus a darkened copy
// at (+1, +1), both clipped to the stroke — reads as raised paint ridges.
function applyImpasto(ctx, canvas, bounds, strength) {
  if (!supportsCanvasFilter()) {
    return;
  }
  ctx.save();
  try {
    ctx.globalCompositeOperation = "source-atop";
    ctx.globalAlpha = strength;
    ctx.filter = "brightness(1.6)";
    ctx.drawImage(canvas, bounds.x0 - 1, bounds.y0 - 1);
    ctx.filter = "brightness(0.45)";
    ctx.drawImage(canvas, bounds.x0 + 1, bounds.y0 + 1);
  } catch {
    /* filter unsupported mid-flight: leave the buffer untouched */
  }
  ctx.restore();
}

// One-stop pre-commit hook for a v2 stroke buffer: flush the dab renderer,
// then run the brush's commit passes (wet edge → impasto → paper grain) —
// inside the buffer, before the single opacity-stamped commit. `fx` is the
// brush's dab params object (or null for legacy strokes — full no-op). All
// consumers (local, remote, spectator, history replay, and every OVERFLOW
// commit) share this helper, so the passes can never diverge per consumer.
// Pass renderer = null on OVERFLOW commits: the renderer's residual/lastPoint
// walk state must survive the buffer restart untouched.
export function prepareStrokeCommit(buf, renderer, fx) {
  if (!buf || !buf.has()) {
    return;
  }
  if (renderer) {
    renderer.end(buf.getCtx());
  }
  if (!fx) {
    return;
  }
  const ctx = buf.getCtx();
  const bounds = buf.bounds();
  if (fx.wetEdge > 0) {
    applyWetEdge(ctx, buf.canvas, bounds, fx.wetEdge);
  }
  if (fx.impasto > 0) {
    applyImpasto(ctx, buf.canvas, bounds, fx.impasto);
  }
  if (fx.grain > 0) {
    applyGrain(ctx, bounds, fx.grain);
  }
}
