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
    id: "gouache",
    name: "Gouache",
    icon: "🧴",
    tier: "free",
    description: "Opaque, soft, flat poster paint — bold matte color that just covers.",
    dab: { spacing: 0.1, minSize: 0.25, flow: 0.92, shape: "gouache", grain: 0.08, wetEdge: 0.08 },
  },
  {
    id: "ink",
    name: "Brushed ink",
    icon: "🖋️",
    tier: "free",
    description: "A pointed ink brush — press for bold strokes, lift for hairline tapers.",
    // minSize 0.08 is the whole point: a huge thin-to-thick pressure range, so
    // the stroke is ALL about taper. Crisp round dab, no commit passes.
    dab: { spacing: 0.06, minSize: 0.08, flow: 1, shape: "round" },
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
    // No `dab`: smudge is special-cased BY ID in every consumer. It has no
    // pigment of its own (noColor) — it sample-and-drags LAYER 0's existing
    // paint via makeSmudgeRenderer, directly, with no stroke buffer. Private
    // rooms only: in kid_safe rooms the picker ghosts it, startStroke falls
    // back to marker, and both client and server drop incoming smudge ops.
    id: "smudge",
    name: "Smudge",
    icon: "👉",
    tier: "free",
    privateOnly: true,
    noColor: true,
    description: "Drag and blend the paint that's already there — like a finger on wet paint.",
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
// (spray, eraser, unknown/custom ids). V2 strokes resolve through this static
// catalog forever; v3 strokes carry sanitized inline dab params instead.
export function getDab(brushId) {
  const brush = brushCatalog.find((entry) => entry.id === brushId);
  return (brush && brush.dab) || null;
}

// V3 authoring dabs are embedded into each new stroke's settings so future
// edits to the catalog cannot repaint old room history. The static v2 catalog
// above stays the replay contract for previously persisted strokes.
const NATURAL_DABS = {
  oil: {
    spacing: 0.065,
    minSize: 0.28,
    flow: 0.9,
    shape: "bristle",
    bristles: 12,
    stretch: 2.6,
    wetEdge: 0.12,
    impasto: 0.18,
    loaded: 1,
    load: 1.18,
    depletion: 0.018,
    reload: 0.004,
    tooth: 0.34,
    bristleMemory: 0.72,
    laneWobble: 0.14,
  },
  acrylic: {
    spacing: 0.075,
    minSize: 0.24,
    flow: 0.96,
    shape: "bristle",
    bristles: 9,
    stretch: 2.0,
    wetEdge: 0.04,
    impasto: 0.12,
    loaded: 1,
    load: 0.95,
    depletion: 0.03,
    reload: 0.002,
    tooth: 0.24,
    bristleMemory: 0.58,
    laneWobble: 0.09,
  },
};

const INLINE_SHAPES = new Set(["round", "pencil", "crayon", "ellipse", "glow", "bristle", "water", "gouache", "stamp"]);
const MAX_INLINE_STAMP_CHARS = 96_000;
const STAMP_DATA_URL_RE = /^data:image\/(?:png|jpeg|webp);base64,/i;

function finiteNumber(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clampNumber(value, fallback, min, max) {
  return clamp(finiteNumber(value, fallback), min, max);
}

function clampInt(value, fallback, min, max) {
  return Math.round(clampNumber(value, fallback, min, max));
}

function hashText(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `tip_${(h >>> 0).toString(36)}`;
}

function validStampDataUrl(value) {
  return typeof value === "string" && value.length <= MAX_INLINE_STAMP_CHARS && STAMP_DATA_URL_RE.test(value);
}

// Public because v3 ops can carry user/imported dab params. Keep this strict:
// these values are used on the draw hot path, so hostile or corrupt ops should
// degrade to a bounded brush, not a 10,000-bristle denial-of-service brush.
export function normalizeInlineDab(dab) {
  if (!dab || typeof dab !== "object") {
    return null;
  }
  const shape = INLINE_SHAPES.has(dab.shape) ? dab.shape : "round";
  const out = {
    spacing: clampNumber(dab.spacing, 0.14, 0.04, 0.5),
    minSize: clampNumber(dab.minSize, 0.5, 0.04, 1),
    flow: clampNumber(dab.flow, 1, 0.02, 1.5),
    shape,
    scatter: clampNumber(dab.scatter, 0, 0, 2),
    rotJitter: clampNumber(dab.rotJitter, 0, 0, Math.PI * 2),
    grain: clampNumber(dab.grain, 0, 0, 0.75),
    bristles: clampInt(dab.bristles, 6, 1, 24),
    stretch: clampNumber(dab.stretch, 1, 0.3, 4),
    wetEdge: clampNumber(dab.wetEdge, 0, 0, 0.5),
    impasto: clampNumber(dab.impasto, 0, 0, 0.5),
    loaded: clampNumber(dab.loaded, 0, 0, 1),
    load: clampNumber(dab.load, 1, 0.05, 1.5),
    depletion: clampNumber(dab.depletion, 0, 0, 0.08),
    reload: clampNumber(dab.reload, 0, 0, 0.04),
    tooth: clampNumber(dab.tooth, 0, 0, 0.75),
    bristleMemory: clampNumber(dab.bristleMemory, 0, 0, 0.95),
    laneWobble: clampNumber(dab.laneWobble, 0, 0, 0.5),
  };
  if (shape === "stamp") {
    const stampId = typeof dab.stampId === "string" && dab.stampId.length <= 48
      ? dab.stampId
      : validStampDataUrl(dab.stampDataUrl) ? hashText(dab.stampDataUrl) : "";
    const cached = stampId ? stampCache.get(stampId) : null;
    const stampDataUrl = validStampDataUrl(dab.stampDataUrl) ? dab.stampDataUrl : cached?.dataUrl || "";
    if (!stampId || !stampDataUrl) {
      return null;
    }
    out.stampDataUrl = stampDataUrl;
    out.stampId = stampId;
    out.roundness = clampNumber(dab.roundness, 1, 0.1, 2);
  }
  return out;
}

export function getAuthoringDab(brushId) {
  const natural = NATURAL_DABS[brushId];
  if (natural) {
    return { version: 3, dab: normalizeInlineDab(natural) };
  }
  const dab = getDab(brushId);
  return dab ? { version: 2, dab } : null;
}

export function getStrokeDab(settings) {
  if (settings && settings.v >= 3) {
    return normalizeInlineDab(settings.dab);
  }
  if (settings && settings.v >= 2) {
    return getDab(settings.brush);
  }
  return null;
}

const stampCache = new Map(); // stampId -> { image, dataUrl, ready, promise }
const tintedStampCache = new Map(); // `${stampId}|${color}` -> canvas

function stampEntryFor(dab) {
  const normalized = normalizeInlineDab(dab);
  if (!normalized || normalized.shape !== "stamp") {
    return null;
  }
  const existing = stampCache.get(normalized.stampId);
  if (existing && existing.dataUrl === normalized.stampDataUrl) {
    return existing;
  }
  const entry = { image: null, dataUrl: normalized.stampDataUrl, ready: false, promise: null };
  stampCache.set(normalized.stampId, entry);
  return entry;
}

export function preloadBrushStamp(dab) {
  const normalized = normalizeInlineDab(dab);
  if (!normalized || normalized.shape !== "stamp") {
    return Promise.resolve(false);
  }
  const entry = stampEntryFor(normalized);
  if (!entry) {
    return Promise.resolve(false);
  }
  if (entry.ready) {
    return Promise.resolve(true);
  }
  if (entry.promise) {
    return entry.promise;
  }
  entry.promise = new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      entry.image = image;
      entry.ready = true;
      resolve(true);
    };
    image.onerror = () => {
      entry.ready = false;
      resolve(false);
    };
    image.src = normalized.stampDataUrl;
  });
  return entry.promise;
}

export function isBrushStampReady(dab) {
  const normalized = normalizeInlineDab(dab);
  if (!normalized || normalized.shape !== "stamp") {
    return true;
  }
  const entry = stampCache.get(normalized.stampId);
  return !!entry?.ready;
}

function getStampImage(dab) {
  const entry = stampCache.get(dab.stampId);
  return entry?.ready ? entry.image : null;
}

function getTintedStamp(dab, color) {
  const image = getStampImage(dab);
  if (!image) {
    return null;
  }
  const key = `${dab.stampId}|${color}`;
  const cached = tintedStampCache.get(key);
  if (cached) {
    return cached;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, image.naturalWidth || image.width || 1);
  canvas.height = Math.max(1, image.naturalHeight || image.height || 1);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = "source-in";
  context.fillStyle = color;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = "source-over";
  tintedStampCache.set(key, canvas);
  return canvas;
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

// Parse a colour string to [r, g, b] ints. Hex (#abc / #aabbcc) covers every
// palette / colour-input value the app produces; rgb(...) covers colours that
// already round-tripped through the wet-mix path. Falls back to near-black.
export function parseColorRgb(color) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color || "");
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3) {
      digits = digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2];
    }
    return [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16)];
  }
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(color || "");
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  return [17, 24, 39];
}

// shiftLightness for numeric channels: same math, no string parsing on the
// wet-mix hot path (per-bristle tinting of the per-dab blended colour).
function tintRgbString(r, g, b, amount) {
  const shift = (c) => {
    const v = amount >= 0 ? c + (255 - c) * amount : c * (1 + amount);
    return Math.max(0, Math.min(255, Math.round(v)));
  };
  return `rgb(${shift(r)},${shift(g)},${shift(b)})`;
}

// Wet-canvas pickup strength per brush: how strongly a dab's colour blends
// toward the paint already on layer 0 under it (settings.wet strokes only).
const WET_PICKUP = { oil: 0.3, acrylic: 0.25, watercolor: 0.45, gouache: 0.2 };
// How fast the carried colour diffuses toward what the stroke passes over —
// the "drag" that smears a picked-up colour along the rest of the stroke.
const WET_DRAG = 0.15;

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

// `getMix` (optional): a sampler (x, y) -> [r, g, b] | null over the 1/8-scale
// LAYER-0 mix map. Only consulted when the op's settings carry wet: true AND
// the brush has a WET_PICKUP entry — so dry strokes cost nothing. Wetness rides
// IN the op settings, so replay is deterministic regardless of later toggles;
// cross-client differences in the sampled values (canvas AA) are accepted —
// bounded and cosmetic.
export function makeStrokeRenderer(settings, getMix) {
  const dab = getStrokeDab(settings) || {};
  const color = settings.color;
  const seed = settings.seed;
  const size = clamp(settings.size || 24, 1, 160);
  const wetPickup = settings.wet && typeof getMix === "function" ? WET_PICKUP[settings.brush] || 0 : 0;
  // Carried wet colour (floats, so the diffusion stays smooth). Starts at the
  // brush colour and is dragged toward every non-transparent sample it crosses.
  let mixR = 0;
  let mixG = 0;
  let mixB = 0;
  if (wetPickup > 0) {
    const base = parseColorRgb(color);
    mixR = base[0];
    mixG = base[1];
    mixB = base[2];
  }
  const minSize = dab.minSize == null ? 0.5 : dab.minSize;
  const flowBase = dab.flow == null ? 1 : dab.flow;
  // Big brushes stamp fewer, larger dabs — blur/fleck cost scales with area.
  const spacingK = (dab.spacing == null ? 0.14 : dab.spacing) * (size > 80 ? 1.5 : 1);
  const scatterK = dab.scatter || 0;
  const rotJitter = dab.rotJitter || 0;
  const shape = dab.shape || "round";
  const stretchK = dab.stretch || 1;
  const loadedPaint = shape === "bristle" && dab.loaded > 0;
  const bristleMemory = loadedPaint ? dab.bristleMemory || 0 : 0;
  const laneWobble = loadedPaint ? dab.laneWobble || 0 : 0;
  const tooth = loadedPaint ? dab.tooth || 0 : 0;
  const depletion = loadedPaint ? dab.depletion || 0 : 0;
  const reload = loadedPaint ? dab.reload || 0 : 0;
  const initialLoad = loadedPaint ? dab.load || 1 : 1;

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
      // NOTE: roll() consumption order is frozen (offset → length → width →
      // alpha → tint) — reordering would re-roll every persisted oil/acrylic
      // stroke's bristle character on the next history replay.
      const entry = {
        offset: (roll() * 2 - 1) * 0.85, // perpendicular lane, fraction of radius
        length: 0.55 + roll() * 0.45, // along-tangent elongation variance
        width: 0.6 + roll() * 0.6, // ribbon thickness variance
        alpha: 0.55 + roll() * 0.45, // per-bristle paint load
        tint: (roll() * 2 - 1) * 0.08, // ±8% lightness
      };
      if (loadedPaint) {
        entry.wobblePhase = roll() * TWO_PI;
        entry.wobbleRate = 0.65 + roll() * 0.7;
        entry.paintLoad = clamp(initialLoad * (0.75 + roll() * 0.45), 0.05, 1.5);
        entry.lastX = null;
        entry.lastY = null;
      }
      // Pre-built string for the dry path; the wet path re-tints per dab.
      entry.color = shiftLightness(color, entry.tint);
      bristleTable.push(entry);
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
    // Wet canvas: blend this dab's colour toward the paint already under it
    // (skipping transparent samples), and drag the carried colour along so a
    // picked-up hue smears down the rest of the stroke. Cheap: one CPU-array
    // sample + a few mults per dab — never a getImageData here.
    let dabColor = color;
    let wetR = 0;
    let wetG = 0;
    let wetB = 0;
    if (wetPickup > 0) {
      const sampled = getMix(dx, dy);
      if (sampled) {
        mixR += (sampled[0] - mixR) * WET_DRAG;
        mixG += (sampled[1] - mixG) * WET_DRAG;
        mixB += (sampled[2] - mixB) * WET_DRAG;
        wetR = mixR + (sampled[0] - mixR) * wetPickup;
        wetG = mixG + (sampled[1] - mixG) * wetPickup;
        wetB = mixB + (sampled[2] - mixB) * wetPickup;
      } else {
        wetR = mixR;
        wetG = mixG;
        wetB = mixB;
      }
      dabColor = `rgb(${Math.round(wetR)},${Math.round(wetG)},${Math.round(wetB)})`;
    }
    ctx.fillStyle = dabColor;
    if (shape === "stamp") {
      const stamp = getTintedStamp(dab, dabColor);
      if (!stamp) {
        return;
      }
      ctx.globalAlpha = flowAlpha;
      ctx.save();
      ctx.translate(dx, dy);
      ctx.rotate(rot);
      ctx.scale(dab.roundness || 1, 1);
      ctx.drawImage(stamp, -radius, -radius, radius * 2, radius * 2);
      ctx.restore();
    } else if (shape === "ellipse") {
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
    } else if (shape === "gouache") {
      // Matte poster paint: a round dab slightly stretched 1.3x along the
      // stroke tangent — soft, flat, opaque. Its light grain + wet-edge
      // character lands in the commit passes, not per dab.
      ctx.globalAlpha = flowAlpha;
      ctx.save();
      ctx.translate(dx, dy);
      ctx.rotate(rot);
      ctx.scale(1.3, 1);
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, TWO_PI);
      ctx.fill();
      ctx.restore();
    } else if (shape === "bristle") {
      // Oil/acrylic: N elongated sub-dab ribbons fanned perpendicular to the
      // tangent, stretched `stretchK` along it. All per-bristle variation
      // comes from the construction-time bristleTable (seed-stable), so the
      // streaks track the stroke instead of shimmering.
      const ribbonHalf = (radius * 1.7) / bristleTable.length;
      if (loadedPaint) {
        const tx = Math.cos(rot);
        const ty = Math.sin(rot);
        const nx = -Math.sin(rot);
        const ny = Math.cos(rot);
        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (let i = 0; i < bristleTable.length; i += 1) {
          const bristle = bristleTable[i];
          const wobble = Math.sin((x + y) * 0.006 * bristle.wobbleRate + bristle.wobblePhase) * laneWobble * radius;
          const lane = bristle.offset * radius + wobble;
          const bx = dx + nx * lane;
          const by = dy + ny * lane;
          const load = clamp(bristle.paintLoad, 0, 1.5);
          const dry = clamp(1 - load, 0, 1);
          const gapRoll = pointRand((seed == null ? 0 : seed) ^ Math.imul(i + 17, 1597334677), bx, by)();
          const skipChance = tooth * dry * (0.35 + 0.45 * (1 - pressure));
          if (gapRoll < skipChance) {
            bristle.paintLoad = clamp(load + reload * pressure, 0.02, 1.5);
            continue;
          }

          const toothAlpha = 1 - tooth * dry * (0.25 + gapRoll * 0.45);
          const width = Math.max(0.35, ribbonHalf * bristle.width * (0.45 + load * 0.65));
          const length = Math.max(0.8, radius * stretchK * bristle.length * (0.35 + load * 0.55));
          const alpha = clamp(flowAlpha * bristle.alpha * toothAlpha * (0.2 + Math.min(load, 1) * 0.85), 0.01, 1);

          ctx.strokeStyle = wetPickup > 0 ? tintRgbString(wetR, wetG, wetB, bristle.tint) : bristle.color;
          ctx.fillStyle = ctx.strokeStyle;
          ctx.globalAlpha = alpha;
          ctx.lineWidth = width;
          ctx.beginPath();
          if (bristle.lastX == null || bristleMemory <= 0) {
            ctx.moveTo(bx - tx * length * 0.5, by - ty * length * 0.5);
          } else {
            ctx.moveTo(bristle.lastX, bristle.lastY);
          }
          ctx.lineTo(bx + tx * length * 0.5, by + ty * length * 0.5);
          ctx.stroke();

          ctx.globalAlpha = alpha * 0.55;
          ctx.beginPath();
          ctx.ellipse(
            bx,
            by,
            Math.max(0.5, length * 0.32),
            Math.max(0.3, width * 0.55),
            rot,
            0,
            TWO_PI,
          );
          ctx.fill();

          bristle.lastX = bristle.lastX == null ? bx : bristle.lastX * bristleMemory + bx * (1 - bristleMemory);
          bristle.lastY = bristle.lastY == null ? by : bristle.lastY * bristleMemory + by * (1 - bristleMemory);
          bristle.paintLoad = clamp(load - depletion * (0.35 + pressure * 0.9) + reload * pressure * (1.5 - load), 0.02, 1.5);
        }
        ctx.restore();
      } else {
        ctx.save();
        ctx.translate(dx, dy);
        ctx.rotate(rot);
        for (const bristle of bristleTable) {
          // Wet dabs re-tint the blended colour per bristle (numeric, cheap);
          // dry dabs reuse the strings pre-built at construction.
          ctx.fillStyle = wetPickup > 0 ? tintRgbString(wetR, wetG, wetB, bristle.tint) : bristle.color;
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
      }
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
// Smudge (private rooms only): a dab walk that carries NO pigment. Each dab
// samples a square of LAYER 0 slightly BEHIND the motion and re-stamps it at
// the dab position at partial alpha — sample-and-drag, like a finger through
// wet paint. It draws DIRECTLY onto layer 0 (never a stroke buffer): the op
// stream is the source of truth and every consumer replays it against layer 0
// in server op order, so history replay is deterministic; live concurrent
// overlap can diverge briefly and self-heals on the next history frame.
// drawImage with source === destination canvas is well-defined (the source
// rect is snapshotted first), and the sampled rect is tiny — no full-canvas
// reads, no getImageData, so the hot path stays lean.

const SMUDGE_SPACING = 0.18;
const SMUDGE_MIN_SIZE = 0.3;
const SMUDGE_STRENGTH = 0.45; // per-dab re-stamp alpha
const SMUDGE_DRAG = 0.35; // sample offset behind the motion, fraction of dab size

export function makeSmudgeRenderer(settings, sourceCanvas) {
  const size = clamp(settings.size || 24, 1, 160);
  const dabSizeAt = (pressure) => size * (SMUDGE_MIN_SIZE + (1 - SMUDGE_MIN_SIZE) * Math.pow(pressure, 1.35));

  let lastPoint = null;
  let residual = 0;
  let started = false;

  const emitDab = (ctx, x, y, pressure, angle) => {
    const sizePx = dabSizeAt(pressure);
    const half = sizePx / 2;
    const shift = sizePx * SMUDGE_DRAG;
    // Source trails the motion; stamping it at the dab position drags paint
    // forward. Clamp the source rect to the canvas (shifting the destination
    // by the same amount) so edge dabs never reference out-of-bounds pixels.
    let sx = x - Math.cos(angle) * shift - half;
    let sy = y - Math.sin(angle) * shift - half;
    let w = sizePx;
    let h = sizePx;
    let dxOut = x - half;
    let dyOut = y - half;
    if (sx < 0) {
      dxOut -= sx;
      w += sx;
      sx = 0;
    }
    if (sy < 0) {
      dyOut -= sy;
      h += sy;
      sy = 0;
    }
    if (sx + w > sourceCanvas.width) {
      w = sourceCanvas.width - sx;
    }
    if (sy + h > sourceCanvas.height) {
      h = sourceCanvas.height - sy;
    }
    if (w < 1 || h < 1) {
      return;
    }
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = SMUDGE_STRENGTH;
    ctx.drawImage(sourceCanvas, sx, sy, w, h, dxOut, dyOut, w, h);
    ctx.restore();
  };

  // Same batching-proof walk as makeStrokeRenderer: per-stroke residual +
  // stationary-point skip, fed one point at a time by every consumer.
  const addPoints = (ctx, points) => {
    let emitted = 0;
    for (const raw of points) {
      const pressure = clamp(raw.pressure == null ? 0.55 : raw.pressure, 0.06, 1);
      if (!started) {
        started = true;
        // First dab has no direction yet: a zero-shift re-stamp is a no-op
        // visually, so just prime the walk state.
        residual = Math.max(DAB_MIN_STEP, SMUDGE_SPACING * dabSizeAt(pressure));
        lastPoint = { x: raw.x, y: raw.y, pressure };
        continue;
      }
      const sdx = raw.x - lastPoint.x;
      const sdy = raw.y - lastPoint.y;
      const d = Math.hypot(sdx, sdy);
      if (d < 1e-6) {
        continue; // stationary pressure-only update — see makeStrokeRenderer
      }
      const angle = Math.atan2(sdy, sdx);
      let pos = residual;
      while (pos <= d) {
        const t = pos / d;
        const p = lastPoint.pressure + (pressure - lastPoint.pressure) * t;
        emitDab(ctx, lastPoint.x + sdx * t, lastPoint.y + sdy * t, p, angle);
        emitted += 1;
        let step = Math.max(DAB_MIN_STEP, SMUDGE_SPACING * dabSizeAt(p));
        if (emitted > DAB_CAP) {
          step *= Math.min(16, 2 ** Math.floor(emitted / DAB_CAP)); // giant-flick guardrail
        }
        pos += step;
      }
      residual = pos - d;
      lastPoint = { x: raw.x, y: raw.y, pressure };
    }
  };

  // No end-commit: smudge already landed on layer 0 dab by dab. end:true on
  // the wire just cleans the per-stroke map entries in each consumer.
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
