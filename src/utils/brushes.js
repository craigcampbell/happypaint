import { createStrokeBuffer } from "./strokeBuffer";
import { FAMILIES, SPRITE_PX, SPRITE_UNIT, getCarryScratch, getPaperTile, getSmudgeScratch, getSoftMaskInverse, getTintedSprite, packRgb5, spriteFamilyIndex } from "./brushSprites";
import { LATENT_SIZE, latentToRgb, mixLatent, rgbToLatent } from "./pigment";

// Sprite lifecycle hooks (App.jsx: idle prebuild of the fixed-seed atlases
// after the studio mounts — pass the IdleDeadline through so the build paces
// itself one piece per idle slice; release of every backing store on unmount
// / tab hidden so iOS gets its canvas memory back).
export { prebuildBrushSprites, releaseBrushSprites } from "./brushSprites";

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
// v3 inline dabs (NATURAL_DABS below) add the SPRITE shapes — "wash" |
// "graphite" | "wax" | "softOval" | "matte" | "loaded" | "halo": one drawImage
// of a fixed-seed atlas texture (brushSprites.js) per dab, which is what
// gives a blotch an irregular rim and a pencil its tooth at zero per-dab
// cost — and these fields:
//   blend      — "multiply" commits (and previews) the stroke with multiply,
//                so overlapping strokes glaze darker (luma guard: see
//                getStrokeComposite); anything else is source-over
//   aspect     — sprite stretch along the tangent (x:y); aspectJitter adds a
//                per-dab roll on top
//   sizeJitter / flowJitter — per-dab size / alpha rolls (wash: stop cells tiling)
//   spacingJitter — per-dab ±fraction on the step to the next dab (wash: no
//                fixed period for the rims to braid on)
//   variants   — how many of the family's atlas variants a stroke may roll
//   bloom      — wash: chance of a second 1.3x, 0.3-alpha stamp of another variant
//   dry        — wash: chance (x (1 - pressure)) of a drybrush tooth variant, and
//                the light-touch fade below pressure 0.35
//   startFlow  — wash: extra pigment load over the first 6 sizes of travel
//   bleed / granulation — watercolor commit passes (filter-free), see prepareStrokeCommit
//   laneCull   — loaded: stamp only as many bristle lanes as the dab is wide
//   mixModel   — "km": the dab colour is a Kubelka-Munk pigment mix of what
//                the bristles carry and the paint under the dab (Stage 3:
//                kmSample in makeStrokeRenderer); absent = the frozen legacy
//                RGB-lerp wet pickup
//   mix        — km: the fraction of the under-paint a DRY dab takes on
//                (0 = a dry stroke never samples)
//   pickup     — the fraction a WET dab (settings.wet) takes on; absent =
//                the legacy WET_PICKUP table
//   drag       — how fast the carried colour drifts toward what the stroke
//                passes over (wet; x 0.35 for a dry km stroke)
//
// minSize values are tuned for a ≥3x thin-to-thick pressure range (Stage 3):
// with the 1.35 gamma, full press is 3-6x the lightest touch per brush.
export const brushCatalog = [
  {
    id: "marker",
    name: "Marker",
    icon: "🖊️",
    tier: "free",
    description: "Clean, bold color that darkens where lines cross — for coloring pages and outlines.",
    dab: { spacing: 0.1, minSize: 0.22, flow: 1, shape: "round" },
  },
  {
    id: "crayon",
    name: "Crayon",
    icon: "🖍️",
    tier: "free",
    description: "Waxy, broken coverage with paper grain — layer colors like real wax.",
    dab: { spacing: 0.14, minSize: 0.25, flow: 0.8, shape: "crayon", scatter: 0.08, grain: 0.22 },
  },
  {
    id: "pencil",
    name: "Pencil",
    icon: "✏️",
    tier: "free",
    description: "Grainy graphite line — light for sketching, press harder for darker marks.",
    dab: { spacing: 0.16, minSize: 0.12, flow: 0.72, shape: "pencil", scatter: 0.05, grain: 0.14 },
  },
  {
    id: "paint",
    name: "Paint",
    icon: "🎨",
    tier: "free",
    description: "Soft, loaded oval strokes with rounded edges.",
    dab: { spacing: 0.12, minSize: 0.2, flow: 0.9, shape: "ellipse", rotJitter: 0.3 },
  },
  {
    id: "oil",
    name: "Oil",
    icon: "🛢️",
    tier: "free",
    description: "Thick, solid oil paint with bristle streaks, wet edges, and a buttery emboss.",
    dab: { spacing: 0.08, minSize: 0.3, flow: 0.85, shape: "bristle", bristles: 8, stretch: 2.2, wetEdge: 0.18, impasto: 0.14 },
  },
  {
    id: "acrylic",
    name: "Acrylic",
    icon: "🎨",
    tier: "free",
    description: "Bold, fast-drying paint with solid coverage and visible brush streaks.",
    dab: { spacing: 0.1, minSize: 0.25, flow: 0.95, shape: "bristle", bristles: 5, stretch: 1.7, impasto: 0.1 },
  },
  {
    id: "watercolor",
    name: "Watercolor",
    icon: "💧",
    tier: "free",
    description: "Soft translucent washes with uneven edges and paper texture — layers glaze darker.",
    dab: { spacing: 0.14, minSize: 0.32, flow: 0.3, shape: "water", wetEdge: 0.25, grain: 0.18 },
  },
  {
    id: "gouache",
    name: "Gouache",
    icon: "🧴",
    tier: "free",
    description: "Flat matte poster paint with slightly irregular edges — bold color that just covers.",
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
    // pigment of its own (noColor) — it moves / softens LAYER 0's existing
    // paint via makeSmudgeRenderer. Its ops carry settings.v = 3 +
    // settings.smudgeMode ("drag" | "blend" — the Smudge | Blend toggle) +
    // settings.strength and run as buffered strokes that sample layer 0
    // (makeStrokeEntryCore); legacy ops (no `v`) keep the frozen square
    // renderer, which draws on layer 0 directly. Private rooms only: in
    // kid_safe rooms the picker ghosts it, startStroke falls back to
    // marker, and both client and server drop incoming smudge ops.
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
    description: "Smooth neon glow with a soft halo — for sparkles, magic, and night scenes.",
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
// edits to this table cannot repaint old room history (the numbers below are
// what a NEW stroke persists; every stroke already on a server carries its
// own copy). The static v2 catalog above stays the replay contract for
// pre-v3 strokes. Ink stays v2 on purpose: its crisp disc + taper is the
// brush. Marker keeps the analytic disc and only gains the multiply glaze.
const NATURAL_DABS = {
  marker: { spacing: 0.1, minSize: 0.22, flow: 1, shape: "round", blend: "multiply" },
  pencil: {
    spacing: 0.16,
    minSize: 0.12,
    flow: 0.72,
    shape: "graphite",
    scatter: 0.05,
    aspect: 1.15,
    grain: 0.14,
    blend: "multiply",
  },
  crayon: {
    spacing: 0.14,
    minSize: 0.25,
    flow: 0.85,
    shape: "wax",
    scatter: 0.08,
    rotJitter: 0.25,
    aspect: 1.05,
    aspectJitter: 0.25,
    grain: 0.22,
  },
  paint: {
    spacing: 0.12,
    minSize: 0.2,
    flow: 0.9,
    shape: "softOval",
    aspect: 1.6,
    rotJitter: 0.3,
    mixModel: "km",
    mix: 0.15,
    pickup: 0.3,
    drag: 0.15,
  },
  gouache: {
    spacing: 0.1,
    minSize: 0.25,
    flow: 0.92,
    shape: "matte",
    aspect: 1.3,
    grain: 0.08,
    mixModel: "km",
    mix: 0.1,
    pickup: 0.2,
  },
  watercolor: {
    spacing: 0.13,
    minSize: 0.34,
    flow: 0.17,
    shape: "wash",
    // Rims that land on a fixed period braid into a scallop down the stroke
    // (Stage 2's look): throw each dab sideways, vary its size and its step,
    // and let it turn — the wash sprite's rim is firmest across the stroke,
    // so the turn stays under half a right angle.
    scatter: 0.09,
    rotJitter: 0.55,
    sizeJitter: 0.22,
    flowJitter: 0.35,
    spacingJitter: 0.3,
    bloom: 0.33,
    dry: 0.6,
    startFlow: 1.3,
    // The commit passes are what the live preview can't show (pen-up pop):
    // these strengths sit just under the lab's 0.024 stroke-mean cap. No
    // wetEdge: the wash sprite's own lateral rim pools 1.14-1.89x its core
    // (sprite-lab, 7 of 8 variants >= 1.15 — the spec's condition for
    // dropping the filter pass), and that pass was the one commit-time
    // ctx.filter blit left on a v3 watercolor, ~half its pen-up cost on a
    // CPU-raster canvas (iPad Safari).
    bleed: 0.2,
    granulation: 0.27,
    wetEdge: 0,
    blend: "multiply",
    mixModel: "km",
    mix: 0,
    pickup: 0.35,
    drag: 0.15,
  },
  oil: {
    spacing: 0.065,
    minSize: 0.28,
    flow: 0.9,
    shape: "loaded",
    bristles: 10,
    stretch: 2.4,
    wetEdge: 0.12,
    impasto: 0.16,
    loaded: 1,
    load: 1.18,
    // The ribbons ARE the streaks now (the sprite body is the coverage), so
    // their paint load must last: at the old 0.018/dab it was gone four
    // brush-widths in, leaving 0.1-alpha slivers and a flat body. ~0.004
    // net per dab = a long stroke dries out toward its end, not its start.
    depletion: 0.005,
    reload: 0.003,
    tooth: 0.34,
    bristleMemory: 0.72,
    laneWobble: 0.14,
    laneCull: 1,
    mixModel: "km",
    mix: 0.3,
    pickup: 0.35,
    drag: 0.18,
  },
  acrylic: {
    spacing: 0.075,
    minSize: 0.24,
    flow: 0.96,
    shape: "loaded",
    bristles: 8,
    stretch: 1.9,
    wetEdge: 0.04,
    impasto: 0.1,
    loaded: 1,
    load: 0.95,
    depletion: 0.008, // faster-drying than oil (see the oil note), still ~10 brush-widths
    reload: 0.002,
    tooth: 0.24,
    bristleMemory: 0.58,
    laneWobble: 0.09,
    laneCull: 1,
    mixModel: "km",
    mix: 0.15,
    pickup: 0.25,
    drag: 0.15,
  },
  glow: { spacing: 0.12, minSize: 0.3, flow: 0.85, shape: "halo" },
};

const INLINE_SHAPES = new Set([
  "round", "pencil", "crayon", "ellipse", "glow", "bristle", "water", "gouache", "stamp",
  "wash", "graphite", "wax", "softOval", "matte", "loaded", "halo",
]);
// The shapes that stamp a brushSprites.js atlas (shape id == family id).
const SPRITE_SHAPES = new Set(["wash", "graphite", "wax", "softOval", "matte", "loaded", "halo"]);
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
    // Sprite-shape / composite fields (Stage 2). Worst hostile case: halo = 2
    // drawImages per dab, wash with bloom = 2, loaded = 1 + <= 24 ribbons.
    // aspect / aspectJitter are tighter than the spec's 3 / 1: no shipped dab
    // stretches past 1.6 (+ 0.25 jitter), and a 3 + 1 stretch at size 160 is
    // a 4 x 160 px cell per dab — the wide, slow rasterisation a hostile op
    // would pick, and most of what pushed the pad past MAX_PAD.
    blend: dab.blend === "multiply" ? "multiply" : "source-over",
    aspect: clampNumber(dab.aspect, 1, 0.3, 2),
    aspectJitter: clampNumber(dab.aspectJitter, 0, 0, 0.5),
    sizeJitter: clampNumber(dab.sizeJitter, 0, 0, 0.5),
    flowJitter: clampNumber(dab.flowJitter, 0, 0, 0.6),
    spacingJitter: clampNumber(dab.spacingJitter, 0, 0, 0.5),
    variants: clampInt(dab.variants, 8, 1, 8),
    bloom: clampNumber(dab.bloom, 0, 0, 0.6),
    dry: clampNumber(dab.dry, 0, 0, 1),
    startFlow: clampNumber(dab.startFlow, 1, 1, 1.6),
    bleed: clampNumber(dab.bleed, 0, 0, 0.3),
    granulation: clampNumber(dab.granulation, 0, 0, 0.75),
    laneCull: clampInt(dab.laneCull, 0, 0, 1),
    mixModel: dab.mixModel === "km" ? "km" : "",
    mix: clampNumber(dab.mix, 0, 0, 0.9),
    drag: clampNumber(dab.drag, 0.15, 0, 0.5),
  };
  // `pickup` is only present when the op carries one: absent means "the
  // legacy WET_PICKUP[brush] table", which is what every pre-Stage-2 op
  // (v2 catalog dabs, the first v3 oil/acrylic dabs) must keep resolving to.
  if (dab.pickup != null && Number.isFinite(Number(dab.pickup))) {
    out.pickup = clampNumber(dab.pickup, 0, 0, 0.9);
  }
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

// The blend mode a stroke's buffer commits (and previews) with — a pure
// function of the op settings, decided in ONE place so local / remote /
// spectator / replay can never disagree. Only a dab that asks for "multiply"
// AND a colour dark enough for multiply to read (luma < 0.92; near-white
// multiplied over paper would vanish) gets it; everything else, including
// every persisted op today (no dab carries `blend` yet), is source-over.
// `dab` may be passed by callers that already normalized it (one
// normalizeInlineDab per pen-down, not two).
export function getStrokeComposite(settings, dab = getStrokeDab(settings)) {
  if (!dab || dab.blend !== "multiply") {
    return "source-over";
  }
  const [r, g, b] = parseColorRgb(settings.color);
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luma < 0.92 ? "multiply" : "source-over";
}

// A sprite cell is SPRITE_PX wide for a SPRITE_UNIT-px unit radius, so a
// stamped cell reaches SPRITE_EXTENT (~1.19) radii — the wash rim swells out
// to there; every other family is transparent past 1 radius, but the cell is
// what gets drawn, so the box is sized for it.
const SPRITE_EXTENT = SPRITE_PX / 2 / SPRITE_UNIT;
const SPRITE_HALF = SPRITE_PX / 2;
const HALO_RADIUS = 2.4; // the glow halo stamp, in dab radii
const BLOOM_RADIUS = 1.3; // the wash bloom stamp, in dab radii

// Ink-bbox bookkeeping (see makeStrokeRenderer's inkBounds): how far one
// dab's pixels can reach from its centre, in dab RADII, per shape branch —
// the sprite cell (transparent past its circular guard, so a rotated cell's
// ink stays inside the circle of its larger half-extent) and, for the
// legacy branches, the widest fleck / ellipse / ribbon / shadow the branch
// draws. INK_MARGIN (world px) is added on top for edge anti-aliasing and
// the bilinear footprint of a scaled or fractionally-offset drawImage.
const INK_MARGIN = 2;
const HALO_REACH = HALO_RADIUS * SPRITE_EXTENT;
// Legacy branch reaches (emitDab): pencil = core + flecks thrown 0.8 x size
// out with radius up to 0.14 x size; crayon = flecks 0.55 x size out with
// radius up to 0.75 r; glow = the disc + the 0.85 x size shadowBlur (Skia's
// kernel support is 3 sigma = 1.5 x blur = 2.55 r); a ribbon (bristle /
// loaded) = the lane throw (0.85 r + wobble) + a full-load ribbon's length
// along the tangent (stretch x 1.175 r, half of it past the lane, but the
// legacy branch's ellipse blob spans the whole of stretch r) + the ribbon's
// half-width (1.7 r / bristles x 1.2 wide), see ribbonReach.
const LEGACY_REACH = { round: 1, water: 1, ellipse: 1.6, gouache: 1.3, pencil: 1.9, crayon: 1.9, glow: 4 };

// Widest reach of ONE dab as a multiple of `size` (dab diameter = 1): what a
// box has to be to hold the whole stamp — stretched ellipses, fanned bristle
// ribbons, pencil/crayon flecks, the glow halo. Shared by the cursor tip and
// the chips (box sizing) and the stroke-buffer pad. Numbers come from the
// shape branches in emitDab (fleck throw + fleck radius, ribbon length, blur
// spread, sprite cell x stretch); a new shape id adds its own case here.
export function dabExtent(dab) {
  const d = dab || {};
  let extent;
  switch (d.shape) {
    case "ellipse":
      extent = 1.6;
      break;
    case "gouache":
      extent = 1.3;
      break;
    case "bristle":
      extent = Math.max(1, d.stretch || 1);
      break;
    case "pencil":
      extent = 1.9; // flecks thrown up to 0.8 x size, radius up to 0.14 x size
      break;
    case "crayon":
      extent = 1.9; // flecks up to 0.55 x size out, radius up to 0.375 x size
      break;
    case "glow":
      extent = 2.7; // shadowBlur 0.85 x size spreads about that far past the disc
      break;
    case "stamp":
      extent = Math.max(1, d.roundness || 1) * 1.42; // rotated square: its diagonal
      break;
    case "wash":
    case "graphite":
    case "wax":
    case "softOval":
    case "matte":
      // The cell, stretched by the widest aspect roll and the size roll; a
      // wash bloom stamps a second cell at BLOOM_RADIUS.
      extent = SPRITE_EXTENT * Math.max(1, (d.aspect || 1) + (d.aspectJitter || 0)) * (1 + (d.sizeJitter || 0));
      if (d.shape === "wash" && d.bloom > 0) {
        extent *= BLOOM_RADIUS;
      }
      break;
    case "loaded":
      extent = SPRITE_EXTENT * Math.max(1, d.stretch || 1); // the base cell; ribbons stay inside it
      break;
    case "halo":
      extent = HALO_RADIUS; // (1 - rho)^2 is 0 at 1 radius: the cell margin past it is empty
      break;
    default:
      extent = 1; // round, water
  }
  // Scatter throws the dab centre sideways by up to scatter x size.
  return extent + 2 * (d.scatter || 0);
}

// The stroke buffer's ensure() margin around each point. Today's legacy pad
// (size x 3 + 40) is the floor: every shape shipped so far reaches less than
// 3 x size, and shrinking the pad would move buffer allocations / overflow
// points and so repaint persisted strokes. A wider dab (a hostile inline
// stretch/scatter) grows it instead of clipping — up to MAX_PAD. The cap is
// what stops a hostile v3 dab (aspect + aspectJitter + sizeJitter + bloom +
// scatter 2 at size 160 reaches ~13 x size) from pinning the margin at
// ensure()'s 1020 ceiling, where EVERY point of the stroke overflows the
// 2048² buffer: a commit-pass + 16 MB re-allocation per point, persisted,
// so every replay of that op pays it again. 640 moves no legitimate stroke:
// the widest shipped dab is under 3 x size, so the pad of any stroke the
// studio persists is at most 3 x 160 + 40 = 520 — inside the cap, and the
// golden groups (every shipped shape at sizes up to 90, the overflow and
// symmetry strokes included) prove no buffer rect or overflow point moved.
const LEGACY_PAD_EXTENT = 3;
const MAX_PAD = 640;
export function strokeBufferPad(settings, dab) {
  return Math.min(MAX_PAD, (settings.size || 24) * Math.max(LEGACY_PAD_EXTENT, dabExtent(dab)) + 40);
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
// wet-mix hot path (per-bristle tinting of the per-dab blended colour, up to
// 24 strings per 5-bit colour-bucket change). Module-level helper rather
// than a closure per call — the call runs inside the dab loop, so it must
// allocate nothing but the string it returns; the concatenation of rounded
// ints is byte-identical to the template it replaces (goldens prove it).
function shiftChannel(c, amount) {
  const v = amount >= 0 ? c + (255 - c) * amount : c * (1 + amount);
  return Math.max(0, Math.min(255, Math.round(v)));
}
function tintRgbString(r, g, b, amount) {
  return "rgb(" + shiftChannel(r, amount) + "," + shiftChannel(g, amount) + "," + shiftChannel(b, amount) + ")";
}
// The per-bucket colour string for integer channels (see wetColor).
function rgbString(r, g, b) {
  return "rgb(" + r + "," + g + "," + b + ")";
}

// Wet-canvas pickup strength per brush: how strongly a dab's colour blends
// toward the paint already on layer 0 under it (settings.wet strokes only).
const WET_PICKUP = { oil: 0.3, acrylic: 0.25, watercolor: 0.45, gouache: 0.2 };
// How fast the carried colour diffuses toward what the stroke passes over —
// the "drag" that smears a picked-up colour along the rest of the stroke.
const WET_DRAG = 0.15;

// Pigment mixing (Stage 3: dabs with mixModel "km"). mixLatent's `t` is a
// Kubelka-Munk concentration share — pigment b lands at weight t² (times its
// luminance) against (1 - t)² for a — so t = 0.15 is a ~3% blend, not the
// 15% the same number means to the legacy lerp. The dab's mix / pickup /
// drag keep the lerp's meaning (the FRACTION of the under colour a dab takes
// on); this maps a fraction to the t at which two equal-luminance pigments
// contribute in the ratio share : 1 - share. Computed once per stroke.
function kmShareToT(share) {
  if (!(share > 0)) {
    return 0;
  }
  if (share >= 1) {
    return 1;
  }
  const a = Math.sqrt(share);
  return a / (a + Math.sqrt(1 - share));
}
// How much of its own pigment a loaded brush re-supplies per dab (a fraction,
// mapped like the dab params): the carried colour drifts back toward the
// brush colour at this rate — over paint, so a long ride settles at a mix
// instead of converging to the under-paint, and over blank paper, so a
// picked-up colour fades out over ~20 dabs instead of persisting for the
// rest of the stroke (Stage 0 found the legacy lerp never recovers). Frozen
// once shipped, like WET_DRAG: changing it repaints every persisted km
// stroke that crossed paint.
const KM_RELOAD = 0.08;
const KM_RELOAD_T = kmShareToT(KM_RELOAD);

// Per-point generator derived from the stroke seed + the point's COORDINATES
// (not its index): wire batching boundaries and the wire-level duplicate-point
// dedupe can drop/regroup points, so an index-based sequence would desync the
// local and remote randomness. Coordinates survive both.
export function pointRand(seed, x, y) {
  return mulberry32((seed ^ (Math.round(x) * 73856093) ^ (Math.round(y) * 19349663)) >>> 0);
}

// The FIRST draw of pointRand(seed, x, y) without building the generator —
// bit-identical to `pointRand(seed, x, y)()`, zero allocation. The sprite
// path's per-lane dice use this so a loaded dab allocates nothing.
function pointRoll(seed, x, y) {
  let state = (seed ^ (Math.round(x) * 73856093) ^ (Math.round(y) * 19349663)) >>> 0;
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// A sprite dab composes the buffer's world-origin transform with its own
// placement in ONE setTransform, so the renderer has to know that transform.
// Buffered consumers pass strokeBuffer.base(); identity-space ones (brush
// studio preview, chips, the DPR-scaled cursor tip) pass nothing, and the
// current transform is read once per addPoints / stamp call (not per dab)
// into this reused object. Uniform scale + translation only — that is all
// any consumer applies.
const IDENTITY_BASE = Object.freeze({ s: 1, tx: 0, ty: 0 });
const capturedBase = { s: 1, tx: 0, ty: 0 };
function currentBase(ctx) {
  if (typeof ctx.getTransform !== "function") {
    return IDENTITY_BASE;
  }
  const m = ctx.getTransform();
  capturedBase.s = m.a;
  capturedBase.tx = m.e;
  capturedBase.ty = m.f;
  return capturedBase;
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
// Below this radius a sprite dab is an analytic disc instead (a pure function
// of pressure + size, parity-safe): under ~3 px across the texture can't
// resolve anyway. Deliberately not the 3 px the spec floated — at 3 px the
// light end of a pencil / watercolor stroke turned into solid discs.
const SPRITE_ARC_RADIUS = 1.5;
// Streak salt for the per-stroke `loaded` variant roll (see makeStrokeRenderer).
const LOADED_VARIANT_SALT = 0x51ab3e7d;
// `loaded` ribbons ride ON TOP of a solid sprite body in the same colour, so
// the bristle table's ±8% lightness tints (tuned for ribbons over paper) are
// widened to ±28% — otherwise the streaks vanish into the body.
const LOADED_TINT_GAIN = 3.5;
// The wash bloom (second stamp) alpha, as a fraction of the dab's.
const BLOOM_ALPHA = 0.3;
// The `loaded` body sprite's alpha, as a fraction of the dab's flow. The
// body lands UNDER the ribbons (see emitSpriteDab), so this only decides how
// solid a single dab / tap is and how fast the film closes at a stroke edge.
const LOADED_BODY_ALPHA = 0.8;

// `getMix` (optional): a sampler (x, y) -> [r, g, b] | null over the 1/8-scale
// LAYER-0 mix map. Only consulted when the op's settings carry wet: true AND
// the brush picks up (dab.pickup, else the legacy WET_PICKUP entry) — so dry
// strokes cost nothing. Wetness rides IN the op settings, so replay is
// deterministic regardless of later toggles; cross-client differences in the
// sampled values (canvas AA) are accepted — bounded and cosmetic.
export function makeStrokeRenderer(settings, getMix) {
  const dab = getStrokeDab(settings) || {};
  const color = settings.color;
  const seed = settings.seed;
  const seedValue = seed == null ? 0 : seed;
  const size = clamp(settings.size || 24, 1, 160);
  const pickupK = dab.pickup == null ? WET_PICKUP[settings.brush] || 0 : dab.pickup;
  const dragK = dab.drag == null ? WET_DRAG : dab.drag;
  const sampler = typeof getMix === "function" ? getMix : null;
  // Which colour path this stroke is on. Ops whose dab says mixModel "km"
  // mix pigment (kmSample below); every other op — v2 catalog dabs, the
  // Stage-0 v3 bristle dabs, anything hostile — keeps the frozen RGB-lerp
  // wet pickup. A wet km stroke takes on `pickup` of the under-paint, a dry
  // one `mix` (0 = never samples: watercolor's multiply glaze is its dry
  // mixing). Stamp tips are excluded: their tint cache is keyed per colour
  // string, and a varying colour would grow it per dab.
  const kmModel = dab.mixModel === "km";
  const wetPickup = !kmModel && settings.wet && sampler ? pickupK : 0;
  const kmShare = kmModel && sampler && dab.shape !== "stamp" ? (settings.wet ? pickupK : dab.mix || 0) : 0;
  const kmActive = kmShare > 0;
  const kmPickupT = kmShareToT(kmShare);
  const kmDragT = kmShareToT(settings.wet ? dragK : dragK * 0.35);
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

  // --- Sprite shapes (Stage 2) ---
  const spriteIndex = SPRITE_SHAPES.has(shape) ? spriteFamilyIndex(shape) : -1;
  const spriteShape = spriteIndex >= 0;
  const isHalo = shape === "halo";
  const isLoaded = shape === "loaded";
  const isWash = shape === "wash";
  const plainSprite = spriteShape && !isHalo && !isLoaded; // rolls the aspect/size/flow jitters
  const family = spriteShape ? FAMILIES[spriteIndex] : null;
  const variantCount = spriteShape ? Math.min(dab.variants || 8, family.variants) : 0;
  const bakedAspect = spriteShape ? family.aspect : 1; // `loaded` bakes 2:1
  const aspectK = dab.aspect || 1;
  const aspectJitterK = dab.aspectJitter || 0;
  const sizeJitterK = dab.sizeJitter || 0;
  const flowJitterK = dab.flowJitter || 0;
  const spacingJitterK = plainSprite ? dab.spacingJitter || 0 : 0;
  const bloomK = isWash ? dab.bloom || 0 : 0;
  const dryK = isWash ? dab.dry || 0 : 0;
  const startFlowK = dab.startFlow || 1;
  const laneCull = isLoaded && dab.laneCull > 0;
  // The dry (un-sampled) colour lands EXACTLY (spec P4): the exact tint slot
  // is keyed on the full 24-bit colour, so a picked palette colour is what
  // reaches the paper. Only a wet stroke, whose colour varies per dab, goes
  // through the 5-bit bucket slots.
  const dryRgb = spriteShape ? parseColorRgb(color) : null;
  const dryR = dryRgb ? dryRgb[0] : 0;
  const dryG = dryRgb ? dryRgb[1] : 0;
  const dryB = dryRgb ? dryRgb[2] : 0;
  const exactTint = wetPickup <= 0;
  // Per dab: the km path points this at the bucket slot while the mixed
  // colour differs from the raw one, and back at the exact slot once the
  // carry has relaxed (or the mix lands in the raw colour's bucket).
  let dabExact = exactTint;
  // --- Pigment mixing state (Stage 3), used by kmSample ---
  // Allocated on the FIRST non-null sample, so a km stroke over blank paper
  // never pays for it and never runs a mix. carry = what the bristles hold,
  // brush = the reservoir that re-supplies it, under = the sampled paint
  // (re-decomposed only when the 8-px mix-map cell colour changes), out =
  // the deposited mix. Per renderer, not module-level: remote strokes
  // interleave with the local one, each carrying its own colour.
  let kmCarry = null;
  let kmBrush = null;
  let kmUnder = null;
  let kmOut = null;
  let kmUnderKey = -1; // packed 24-bit colour kmUnder was decomposed from
  let kmDirty = false; // carry != brush colour: keep relaxing (and painting the carry)
  const kmRgb = [0, 0, 0]; // latentToRgb scratch
  const kmRaw = kmActive ? parseColorRgb(color) : null;
  const kmRawKey5 = kmRaw ? packRgb5(kmRaw[0], kmRaw[1], kmRaw[2]) : -1;
  const ensureKmState = () => {
    kmCarry = rgbToLatent(kmRaw[0], kmRaw[1], kmRaw[2], new Float64Array(LATENT_SIZE));
    kmBrush = new Float64Array(LATENT_SIZE);
    kmBrush.set(kmCarry);
    kmUnder = new Float64Array(LATENT_SIZE);
    kmOut = new Float64Array(LATENT_SIZE);
  };
  // `loaded` lanes are baked per VARIANT, so a coherent streak along the
  // stroke needs ONE variant per stroke — rolled here from the seed like the
  // bristle table, not per dab.
  const strokeVariant = isLoaded ? (mulberry32((seedValue ^ LOADED_VARIANT_SALT) >>> 0)() * variantCount) | 0 : -1;
  // Wet-path colour cache: the tint strings (ribbons / the tiny-dab disc) are
  // rebuilt only when the 5-bit colour bucket changes, never per dab.
  let wetKey5 = -1;
  let wetColor = color;
  // The world-origin transform sprite dabs compose with (see currentBase).
  let strokeBase = IDENTITY_BASE;

  // The ribbon parameters serve the frozen `bristle` loaded-paint branch AND
  // the sprite `loaded` shape (its ribbons ride on top of the sprite base).
  const ribbonPaint = loadedPaint || isLoaded;
  const bristleMemory = ribbonPaint ? dab.bristleMemory || 0 : 0;
  const laneWobble = ribbonPaint ? dab.laneWobble || 0 : 0;
  const tooth = ribbonPaint ? dab.tooth || 0 : 0;
  const depletion = ribbonPaint ? dab.depletion || 0 : 0;
  const reload = ribbonPaint ? dab.reload || 0 : 0;
  const initialLoad = ribbonPaint ? dab.load || 1 : 1;

  // Oil/acrylic bristle table: each bristle's lane / length / width / alpha /
  // tint is rolled ONCE here from the stroke seed (mulberry32(seed ^ index)),
  // NOT from the per-dab dice — so a bristle holds its exact character along
  // the whole stroke instead of shimmering dab to dab. Deterministic across
  // clients because it depends only on settings.seed + the catalog count.
  let bristleTable = null;
  if (shape === "bristle" || isLoaded) {
    const count = dab.bristles || 6;
    bristleTable = [];
    for (let i = 0; i < count; i += 1) {
      const roll = mulberry32((seedValue ^ Math.imul(i, 2654435761)) >>> 0);
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
      if (ribbonPaint) {
        entry.wobblePhase = roll() * TWO_PI;
        entry.wobbleRate = 0.65 + roll() * 0.7;
        entry.paintLoad = clamp(initialLoad * (0.75 + roll() * 0.45), 0.05, 1.5);
        entry.lastX = null;
        entry.lastY = null;
      }
      if (isLoaded) {
        entry.tint *= LOADED_TINT_GAIN; // after the roll: the dice order stays frozen
      }
      // Pre-built string for the dry path; the legacy wet path re-tints per
      // dab, the sprite / km paths re-tint `wetColor` per colour bucket.
      entry.color = shiftLightness(color, entry.tint);
      entry.wetColor = entry.color;
      bristleTable.push(entry);
    }
  }

  // --- Ink bbox (world px) ---
  // A SUPERSET of every non-transparent pixel this renderer has stamped
  // since the last resetInk(), kept with four compares per dab, so the
  // commit passes (prepareStrokeCommit) can work on the stroke's own rect
  // instead of the whole allocated buffer (a 2048² buffer holds a size-80
  // stroke that inks a tenth of it). Pixel-identical by construction: every
  // pass is a no-op where the buffer is transparent (destination-over /
  // source-atop / destination-out) or a self-blit of transparent pixels, so
  // the pass rect only has to CONTAIN the ink. The reach per dab is radius x
  // the shape's widest draw (LEGACY_REACH / ribbonReach / the sprite cell),
  // and inkBounds() pads the result by INK_MARGIN. Survives buffer grows
  // (world coords); the overflow sites restart it with the buffer via
  // prepareStrokeCommit(…, final = false). Deterministic per op stream —
  // and the passes' pixels don't depend on it anyway (spec P3).
  let inkX0 = Infinity;
  let inkY0 = Infinity;
  let inkX1 = -Infinity;
  let inkY1 = -Infinity;
  const inkRect = { x0: 0, y0: 0, w: 0, h: 0 }; // stable: inkBounds() mutates it in place
  const ribbonReach = bristleTable ? 0.85 + laneWobble + stretchK + 2.04 / bristleTable.length : 0;
  const loadedReachK = isLoaded ? Math.max(ribbonReach, Math.max(stretchK, 1) * SPRITE_EXTENT) : 0;
  let legacyReachK = LEGACY_REACH[shape] || 1;
  if (shape === "bristle") {
    legacyReachK = ribbonReach;
  } else if (shape === "stamp") {
    legacyReachK = Math.hypot(dab.roundness || 1, 1); // a rotated roundness x 1 square: its half-diagonal
  }
  const inkAdd = (cx, cy, reach) => {
    if (cx - reach < inkX0) {
      inkX0 = cx - reach;
    }
    if (cy - reach < inkY0) {
      inkY0 = cy - reach;
    }
    if (cx + reach > inkX1) {
      inkX1 = cx + reach;
    }
    if (cy + reach > inkY1) {
      inkY1 = cy + reach;
    }
  };
  const inkBounds = () => {
    if (inkX0 > inkX1) {
      inkRect.x0 = 0;
      inkRect.y0 = 0;
      inkRect.w = 0; // nothing stamped since the last reset
      inkRect.h = 0;
      return inkRect;
    }
    inkRect.x0 = Math.floor(inkX0) - INK_MARGIN;
    inkRect.y0 = Math.floor(inkY0) - INK_MARGIN;
    inkRect.w = Math.ceil(inkX1) + INK_MARGIN - inkRect.x0;
    inkRect.h = Math.ceil(inkY1) + INK_MARGIN - inkRect.y0;
    return inkRect;
  };
  const resetInk = () => {
    inkX0 = Infinity;
    inkY0 = Infinity;
    inkX1 = -Infinity;
    inkY1 = -Infinity;
  };

  // --- Per-stroke walk state (the whole point of the instance) ---
  let lastPoint = null; // { x, y, pressure }
  let residual = 0; // distance already consumed past the last emitted dab
  let started = false;
  let walked = 0; // cumulative path length: the wash's startFlow load decays over it
  // The last dab's spacing roll (sprite shapes with spacingJitter): addPoints
  // scales the step to the NEXT dab by it, so dabs stop landing on a fixed
  // period. 1 for every other dab / shape.
  let stepScale = 1;

  // pressure^1.35 taper: light touches thin out faster than linear, and the
  // widened minSize band gives every brush a ≥3x thin-to-thick range.
  const dabSizeAt = (pressure) => size * (minSize + (1 - minSize) * Math.pow(pressure, 1.35));

  // One stamp. `rand` consumption order is FROZEN per shape, so the same seed
  // + dab coordinate rolls the same dice on every client — and reordering
  // would re-roll every persisted stroke of that shape:
  //   round / water / glow / ellipse / gouache / stamp: scatter → rot
  //   pencil / crayon: scatter → rot → fleck count → per fleck (angle, dist,
  //     radius, alpha)
  //   bristle: scatter → rot (lanes roll their own pointRand generators)
  //   wash / graphite / wax / softOval / matte: variant → scatter → rot →
  //     aspectJitter → sizeJitter → flowJitter; wash then → bloom roll
  //     (→ bloom variant, only when it fires) → dry roll; then (all five)
  //     → spacing roll (Stage 3, spacingJitter > 0 only — appended LAST)
  //   halo: scatter → rot (no variant roll: halo + core are fixed variants)
  //   loaded: (variant rolled ONCE per stroke from the seed) scatter → rot,
  //     then the lanes' own pointRoll gap dice
  // A roll is consumed only when its parameter is > 0 (scatter, rotJitter,
  // the jitters, bloom, dry), exactly like the legacy scatter / rot rolls —
  // the parameters ride in the op, so this is deterministic per stroke.
  //
  // DAB-PATH-BEGIN — the per-dab hot path. scripts/brush-lab.mjs --guard scans
  // this region: no readbacks, no ctx.filter / shadowBlur, no allocation. The
  // shape branches in emitDab are FROZEN legacy stamps (persisted v1/v2/v3
  // ops replay through them byte-for-byte); their save/restore and the glow
  // shadowBlur are grandfathered with `guard-ok` — the v3 shapes ship on the
  // sprite path (emitSpriteDab) instead of rewriting these.

  // One sprite stamp: compose base x [rotation x scale x translation] into a
  // single setTransform, then ONE drawImage of the tinted slot centred on the
  // origin. rx / ry are the stamp's half-extents in world px along / across
  // the tangent; the family's baked aspect is undone in sy.
  const stampSprite = (ctx, b, slot, x, y, c, s, rx, ry, alpha) => {
    const sx = rx / SPRITE_UNIT;
    const sy = (ry * bakedAspect) / SPRITE_UNIT;
    ctx.setTransform(b.s * c * sx, b.s * s * sx, -b.s * s * sy, b.s * c * sy, b.s * x + b.tx, b.s * y + b.ty);
    ctx.globalAlpha = alpha;
    ctx.drawImage(slot, -SPRITE_HALF, -SPRITE_HALF, SPRITE_PX, SPRITE_PX);
  };

  // The tinted slot for `variant` in this dab's colour: the exact slot while
  // the dab colour IS the raw colour (dry, or km fully relaxed), the 5-bit
  // bucket while it differs (wetR/G/B set by the caller).
  let wetR = 0;
  let wetG = 0;
  let wetB = 0;
  const tintedSlot = (variant) => (dabExact
    ? getTintedSprite(shape, variant, dryR, dryG, dryB, true)
    : getTintedSprite(shape, variant, wetR, wetG, wetB));

  // The km dab colour at (x, y) — Stage 3. Leaves wetR/G/B, the cached
  // strings (rebuilt only on a 5-bit bucket change) and dabExact set for the
  // stamp. With a non-null sample: the bristles take on the under-paint
  // (drag), the reservoir re-supplies its own pigment (KM_RELOAD), and what
  // lands is the carry mixed with the under-paint once more (pickup). Over
  // blank paper the reservoir keeps re-supplying, so a picked-up colour
  // fades back to the brush colour instead of persisting; once the carry
  // lands back in the raw colour's 5-bit bucket it snaps there and every
  // further blank-paper dab is the RAW colour at zero cost (spec P4). Every
  // step is a pure function of the op stream + the samples (no dice), so
  // local / remote / replay agree. Three mixLatent + one latentToRgb per
  // sampled dab (~1 µs), one + one while relaxing, nothing once relaxed; no
  // allocation (the latents are the renderer's, the sample array is the mix
  // map's reused one — read before the next sample, never kept).
  const kmSample = (x, y) => {
    const sampled = getMix(x, y);
    if (sampled) {
      if (!kmCarry) {
        ensureKmState();
      }
      const key = (sampled[0] << 16) | (sampled[1] << 8) | sampled[2];
      if (key !== kmUnderKey) {
        kmUnderKey = key;
        rgbToLatent(sampled[0], sampled[1], sampled[2], kmUnder);
      }
      mixLatent(kmCarry, kmUnder, kmDragT, kmCarry);
      mixLatent(kmCarry, kmBrush, KM_RELOAD_T, kmCarry);
      mixLatent(kmCarry, kmUnder, kmPickupT, kmOut);
      latentToRgb(kmOut, kmRgb);
      kmDirty = true;
    } else if (kmDirty) {
      mixLatent(kmCarry, kmBrush, KM_RELOAD_T, kmCarry);
      latentToRgb(kmCarry, kmRgb);
    } else {
      dabExact = true;
      return;
    }
    const key5 = packRgb5(kmRgb[0], kmRgb[1], kmRgb[2]);
    dabExact = key5 === kmRawKey5;
    if (dabExact) {
      if (!sampled) {
        // Relaxed back into the raw bucket: canonical state, and no more
        // mixing until the next sample.
        kmCarry.set(kmBrush);
        kmDirty = false;
      }
      return;
    }
    wetR = kmRgb[0];
    wetG = kmRgb[1];
    wetB = kmRgb[2];
    if (key5 !== wetKey5) {
      wetKey5 = key5;
      wetColor = rgbString(wetR, wetG, wetB);
      if (bristleTable) {
        for (let i = 0; i < bristleTable.length; i += 1) {
          bristleTable[i].wetColor = tintRgbString(wetR, wetG, wetB, bristleTable[i].tint);
        }
      }
    }
  };

  // The v3 sprite dab (rand order: see the table above).
  const emitSpriteDab = (ctx, rand, x, y, pressure, angle, sizePx, flowAlpha) => {
    let variant = 0;
    if (strokeVariant >= 0) {
      variant = strokeVariant;
    } else if (!isHalo) {
      variant = (rand() * variantCount) | 0;
    }
    let dx = x;
    let dy = y;
    if (scatterK > 0) {
      const off = (rand() * 2 - 1) * scatterK * sizePx;
      dx += -Math.sin(angle) * off; // perpendicular to the tangent
      dy += Math.cos(angle) * off;
    }
    const rot = rotJitter > 0 ? angle + (rand() - 0.5) * rotJitter : angle;
    let aspect = aspectK;
    let radius = sizePx / 2;
    let alpha = flowAlpha;
    if (plainSprite) {
      if (aspectJitterK > 0) {
        aspect += rand() * aspectJitterK;
      }
      if (sizeJitterK > 0) {
        radius *= 1 + (rand() * 2 - 1) * sizeJitterK;
      }
      if (flowJitterK > 0) {
        alpha *= 1 - rand() * flowJitterK;
      }
    }
    // Wash: a second, larger, fainter stamp of ANOTHER variant sometimes
    // blooms out of a dab (breaks the tiling), and a light touch rolls a
    // drybrush tooth variant + fades toward nothing below pressure 0.35.
    let bloomVariant = -1;
    if (bloomK > 0 && rand() < bloomK) {
      bloomVariant = (variant + 1 + ((rand() * (variantCount - 1)) | 0)) % variantCount;
    }
    if (dryK > 0) {
      if (rand() < dryK * (1 - pressure)) {
        variant |= 4; // the family's tooth variants are 4-7
      }
      if (pressure < 0.35) {
        const t = pressure / 0.35;
        alpha *= t * t;
      }
    }
    // Ink bbox: the cell's larger half-extent (a bloom stamps a second cell
    // at BLOOM_RADIUS; the halo at HALO_RADIUS; loaded = body + ribbons).
    inkAdd(dx, dy, radius * (isHalo ? HALO_REACH : isLoaded ? loadedReachK : Math.max(aspect, 1) * SPRITE_EXTENT * (bloomVariant >= 0 ? BLOOM_RADIUS : 1)));
    // Spacing roll — last in the order (Stage 3): the step to the next dab
    // is scaled by 1 ± spacingJitter (see stepScale).
    stepScale = 1;
    if (spacingJitterK > 0) {
      stepScale = 1 + (rand() * 2 - 1) * spacingJitterK;
    }
    // Fresh load: extra pigment over the first 6 sizes of travel (`walked`
    // lives on the renderer, so it survives overflow restarts).
    if (startFlowK > 1) {
      const fresh = 1 - walked / (6 * size);
      if (fresh > 0) {
        alpha *= 1 + (startFlowK - 1) * fresh;
      }
    }
    if (alpha > 1) {
      alpha = 1;
    }
    // Colour. Legacy wet (no mixModel): the frozen RGB lerp toward the paint
    // under the dab; km: the pigment mix (kmSample). The tint strings follow
    // the 5-bit bucket either way.
    let fallback = color;
    if (wetPickup > 0) {
      const sampled = getMix(dx, dy);
      if (sampled) {
        mixR += (sampled[0] - mixR) * dragK;
        mixG += (sampled[1] - mixG) * dragK;
        mixB += (sampled[2] - mixB) * dragK;
        wetR = mixR + (sampled[0] - mixR) * wetPickup;
        wetG = mixG + (sampled[1] - mixG) * wetPickup;
        wetB = mixB + (sampled[2] - mixB) * wetPickup;
      } else {
        wetR = mixR;
        wetG = mixG;
        wetB = mixB;
      }
      wetR = (wetR + 0.5) | 0;
      wetG = (wetG + 0.5) | 0;
      wetB = (wetB + 0.5) | 0;
      const key5 = packRgb5(wetR, wetG, wetB);
      if (key5 !== wetKey5) {
        wetKey5 = key5;
        wetColor = rgbString(wetR, wetG, wetB);
        if (bristleTable) {
          for (let i = 0; i < bristleTable.length; i += 1) {
            bristleTable[i].wetColor = tintRgbString(wetR, wetG, wetB, bristleTable[i].tint);
          }
        }
      }
      fallback = wetColor;
    } else if (kmActive) {
      kmSample(dx, dy);
      if (!dabExact) {
        fallback = wetColor;
      }
    }
    const b = strokeBase;
    // Sub-pixel dabs fall back to an analytic arc: don't touch (re-tint) a
    // ring slot for a sprite that is never drawn.
    const slot = radius < SPRITE_ARC_RADIUS ? null : tintedSlot(variant);
    if (!slot) {
      ctx.setTransform(b.s, 0, 0, b.s, b.tx, b.ty);
      ctx.fillStyle = fallback;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(dx, dy, radius, 0, TWO_PI);
      ctx.fill();
      return;
    }
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    if (isHalo) {
      // Neon: the halo variant at HALO_RADIUS with 'lighter' INSIDE the buffer
      // (overlapping halos add up and bloom toward white), then the core.
      ctx.globalCompositeOperation = "lighter";
      stampSprite(ctx, b, slot, dx, dy, c, s, radius * HALO_RADIUS, radius * HALO_RADIUS, alpha * 0.5);
      ctx.globalCompositeOperation = "source-over";
      stampSprite(ctx, b, tintedSlot(1), dx, dy, c, s, radius, radius, alpha);
      return;
    }
    if (isLoaded) {
      // The solid loaded-paint body, stretched along the tangent, laid UNDER
      // what the stroke already holds (destination-over): it fills coverage
      // without burying the previous dabs' bristle ribbons — a body stamped
      // over them buried a ribbon under the dozen bodies that followed it
      // (0.55^12 of it left), and no ribbon alpha or tint gain got streaks
      // through that. The ribbons below ride on top, so the streaks are
      // exactly what the ribbons paint and the body is the paper-facing
      // film. Still one drawImage per dab; the composite is put back for
      // the ribbons.
      ctx.globalCompositeOperation = "destination-over";
      stampSprite(ctx, b, slot, dx, dy, c, s, radius * stretchK, radius, alpha * LOADED_BODY_ALPHA);
      ctx.globalCompositeOperation = "source-over";
      ctx.setTransform(b.s, 0, 0, b.s, b.tx, b.ty);
      // Bristle ribbons, as the frozen `bristle` loaded-paint branch draws
      // them (lane wobble, tooth gaps, paint-load depletion, bristle memory)
      // minus its per-bristle body blob (the sprite is the body now), its
      // save/restore and its per-bristle string building. Not shared with
      // that branch on purpose: it is frozen, this one is free to change
      // until it ships. laneCull stamps only as many lanes as the dab is
      // wide (a 12 px dab has no room for 10 distinct streaks), culled from
      // the END of the table so the surviving bristles keep their character.
      const nx = -s;
      const ny = c;
      const lanes = laneCull ? Math.min(bristleTable.length, Math.max(3, (sizePx / 2.5) | 0)) : bristleTable.length;
      const ribbonHalf = (radius * 1.7) / bristleTable.length;
      for (let i = 0; i < lanes; i += 1) {
        const bristle = bristleTable[i];
        const wobble = Math.sin((x + y) * 0.006 * bristle.wobbleRate + bristle.wobblePhase) * laneWobble * radius;
        const lane = bristle.offset * radius + wobble;
        const bx = dx + nx * lane;
        const by = dy + ny * lane;
        const load = clamp(bristle.paintLoad, 0, 1.5);
        const dry = clamp(1 - load, 0, 1);
        const gapRoll = pointRoll(seedValue ^ Math.imul(i + 17, 1597334677), bx, by);
        const skipChance = tooth * dry * (0.35 + 0.45 * (1 - pressure));
        if (gapRoll < skipChance) {
          bristle.paintLoad = clamp(load + reload * pressure, 0.02, 1.5);
          continue;
        }
        const toothAlpha = 1 - tooth * dry * (0.25 + gapRoll * 0.45);
        const width = Math.max(0.35, ribbonHalf * bristle.width * (0.45 + load * 0.65));
        const length = Math.max(0.8, radius * stretchK * bristle.length * (0.35 + load * 0.55));
        const ribbonAlpha = clamp(alpha * bristle.alpha * toothAlpha * (0.2 + Math.min(load, 1) * 0.85), 0.01, 1);
        ctx.strokeStyle = dabExact ? bristle.color : bristle.wetColor;
        ctx.globalAlpha = ribbonAlpha;
        ctx.lineWidth = width;
        ctx.beginPath();
        if (bristle.lastX == null || bristleMemory <= 0) {
          ctx.moveTo(bx - c * length * 0.5, by - s * length * 0.5);
        } else {
          ctx.moveTo(bristle.lastX, bristle.lastY);
          // The ribbon starts at the bristle's remembered position (an EMA
          // that survives an overflow restart), so the ink bbox must cover
          // it too — pixel-neutral, it only ever grows the pass rect.
          inkAdd(bristle.lastX, bristle.lastY, width);
        }
        ctx.lineTo(bx + c * length * 0.5, by + s * length * 0.5);
        ctx.stroke();
        bristle.lastX = bristle.lastX == null ? bx : bristle.lastX * bristleMemory + bx * (1 - bristleMemory);
        bristle.lastY = bristle.lastY == null ? by : bristle.lastY * bristleMemory + by * (1 - bristleMemory);
        bristle.paintLoad = clamp(load - depletion * (0.35 + pressure * 0.9) + reload * pressure * (1.5 - load), 0.02, 1.5);
      }
      return;
    }
    stampSprite(ctx, b, slot, dx, dy, c, s, radius * aspect, radius, alpha);
    if (bloomVariant >= 0) {
      stampSprite(ctx, b, tintedSlot(bloomVariant), dx, dy, c, s, radius * BLOOM_RADIUS * aspect, radius * BLOOM_RADIUS, alpha * BLOOM_ALPHA);
    }
  };

  const emitDab = (ctx, x, y, pressure, angle) => {
    const rand = seed != null ? pointRand(seed, x, y) : Math.random;
    const sizePx = dabSizeAt(pressure);
    const flowAlpha = flowBase * (0.5 + 0.5 * pressure);
    if (spriteShape) {
      emitSpriteDab(ctx, rand, x, y, pressure, angle, sizePx, flowAlpha);
      return;
    }
    let dx = x;
    let dy = y;
    if (scatterK > 0) {
      const off = (rand() * 2 - 1) * scatterK * sizePx;
      dx += -Math.sin(angle) * off; // perpendicular to the tangent
      dy += Math.cos(angle) * off;
    }
    const rot = rotJitter > 0 ? angle + (rand() - 0.5) * rotJitter : angle;
    const radius = sizePx / 2;
    inkAdd(dx, dy, radius * legacyReachK); // ink bbox: the branch's widest draw (LEGACY_REACH)
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
    } else if (kmActive) {
      // A km dab on a legacy shape (nothing authored ships this, but an
      // inline dab may say so): the pigment mix as the fill colour.
      kmSample(dx, dy);
      if (!dabExact) {
        dabColor = wetColor;
      }
    }
    ctx.fillStyle = dabColor;
    if (shape === "stamp") {
      const stamp = getTintedStamp(dab, dabColor);
      if (!stamp) {
        return;
      }
      ctx.globalAlpha = flowAlpha;
      ctx.save(); // guard-ok — frozen legacy branch (Stage 2 sprite shapes use setTransform instead)
      ctx.translate(dx, dy);
      ctx.rotate(rot);
      ctx.scale(dab.roundness || 1, 1);
      ctx.drawImage(stamp, -radius, -radius, radius * 2, radius * 2);
      ctx.restore(); // guard-ok — frozen legacy branch (Stage 2 sprite shapes use setTransform instead)
    } else if (shape === "ellipse") {
      // Loaded-brush paint: elongated 1.6x along the stroke tangent.
      ctx.globalAlpha = flowAlpha;
      ctx.save(); // guard-ok — frozen legacy branch (Stage 2 sprite shapes use setTransform instead)
      ctx.translate(dx, dy);
      ctx.rotate(rot);
      ctx.scale(1.6, 1);
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, TWO_PI);
      ctx.fill();
      ctx.restore(); // guard-ok — frozen legacy branch (Stage 2 sprite shapes use setTransform instead)
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
      ctx.save(); // guard-ok — frozen legacy branch (Stage 2 sprite shapes use setTransform instead)
      ctx.translate(dx, dy);
      ctx.rotate(rot);
      ctx.scale(1.3, 1);
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, TWO_PI);
      ctx.fill();
      ctx.restore(); // guard-ok — frozen legacy branch (Stage 2 sprite shapes use setTransform instead)
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
        ctx.save(); // guard-ok — frozen legacy branch (Stage 2 sprite shapes use setTransform instead)
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

          ctx.strokeStyle = wetPickup > 0 ? tintRgbString(wetR, wetG, wetB, bristle.tint) : dabExact ? bristle.color : bristle.wetColor;
          ctx.fillStyle = ctx.strokeStyle;
          ctx.globalAlpha = alpha;
          ctx.lineWidth = width;
          ctx.beginPath();
          if (bristle.lastX == null || bristleMemory <= 0) {
            ctx.moveTo(bx - tx * length * 0.5, by - ty * length * 0.5);
          } else {
            ctx.moveTo(bristle.lastX, bristle.lastY);
            inkAdd(bristle.lastX, bristle.lastY, width); // ink bbox covers the remembered start (pixel-neutral)
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
        ctx.restore(); // guard-ok — frozen legacy branch (Stage 2 sprite shapes use setTransform instead)
      } else {
        ctx.save(); // guard-ok — frozen legacy branch (Stage 2 sprite shapes use setTransform instead)
        ctx.translate(dx, dy);
        ctx.rotate(rot);
        for (const bristle of bristleTable) {
          // Wet dabs re-tint the blended colour per bristle (numeric, cheap);
          // dry dabs reuse the strings pre-built at construction.
          ctx.fillStyle = wetPickup > 0 ? tintRgbString(wetR, wetG, wetB, bristle.tint) : dabExact ? bristle.color : bristle.wetColor;
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
        ctx.restore(); // guard-ok — frozen legacy branch (Stage 2 sprite shapes use setTransform instead)
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
      ctx.shadowBlur = sizePx * 0.85; // guard-ok — frozen legacy glow branch (Stage 2 replaces it for v3 ops)
      ctx.beginPath();
      ctx.arc(dx, dy, radius, 0, TWO_PI);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.globalAlpha = flowAlpha * 0.4;
      ctx.beginPath();
      ctx.arc(dx, dy, Math.max(0.5, radius * 0.35), 0, TWO_PI);
      ctx.fill();
      ctx.shadowBlur = 0; // guard-ok — frozen legacy glow branch (Stage 2 replaces it for v3 ops)
    } else {
      // "round": crisp solid circle (marker).
      ctx.globalAlpha = flowAlpha;
      ctx.beginPath();
      ctx.arc(dx, dy, radius, 0, TWO_PI);
      ctx.fill();
    }
  };
  // DAB-PATH-END

  // Walk dabs from lastPoint through each incoming point. All consumers feed
  // this the same point sequence — the local client feeds the very object the
  // wire sends (quarter-px quantized + deduped, see drawBrushFromEvent) — so
  // with per-stroke residual + coordinate-seeded dice the dab layout is
  // batching-independent and pixel-identical on every client.
  //
  // `base` (optional) is the buffer's world-origin transform from
  // strokeBuffer.base(). Sprite shapes (Stage 2) compose it with their own
  // per-dab placement in a single setTransform, so after the point loop the
  // origin transform is put back ONCE here — one call per addPoints, not a
  // save/restore pair per dab. The legacy vector branches above never leave
  // the transform changed, so re-setting it is pixel-neutral for them. Omit
  // it for identity-space consumers (brush studio preview, chips, cursor tip).
  const addPoints = (ctx, points, base) => {
    let emitted = 0;
    ctx.globalCompositeOperation = "source-over";
    strokeBase = base || (spriteShape ? currentBase(ctx) : IDENTITY_BASE);
    if (isLoaded) {
      // Ribbon caps, once per call (the legacy branch sets them per dab
      // inside its save/restore).
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    }
    for (const raw of points) {
      const pressure = clamp(raw.pressure == null ? 0.55 : raw.pressure, 0.06, 1);
      if (!started) {
        // First point of a stroke stamps immediately (taps leave a mark).
        started = true;
        emitDab(ctx, raw.x, raw.y, pressure, 0);
        emitted += 1;
        residual = Math.max(DAB_MIN_STEP, spacingK * dabSizeAt(pressure) * stepScale);
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
        let step = Math.max(DAB_MIN_STEP, spacingK * dabSizeAt(p) * stepScale);
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
      walked += d;
      lastPoint = { x: raw.x, y: raw.y, pressure };
    }
    ctx.globalAlpha = 1;
    if (base) {
      ctx.setTransform(base.s, 0, 0, base.s, base.tx, base.ty);
    } else if (spriteShape) {
      // Identity-space consumer: put back whatever transform it had.
      ctx.setTransform(strokeBase.s, 0, 0, strokeBase.s, strokeBase.tx, strokeBase.ty);
    }
  };

  // One dab, outside the walk: no residual/lastPoint bookkeeping, so the
  // preview surfaces (cursor tip, chips via drawSingleDab) show exactly the
  // stamp emitDab lays down without opening a stroke. Drawn in the ctx's
  // current (uniformly scaled) space — the cursor tip is DPR-scaled.
  const stamp = (ctx, x, y, pressure, angle) => {
    ctx.globalCompositeOperation = "source-over";
    strokeBase = spriteShape ? currentBase(ctx) : IDENTITY_BASE;
    if (isLoaded) {
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    }
    emitDab(ctx, x, y, clamp(pressure == null ? 1 : pressure, 0.06, 1), angle || 0);
    ctx.globalAlpha = 1;
    if (spriteShape) {
      ctx.setTransform(strokeBase.s, 0, 0, strokeBase.s, strokeBase.tx, strokeBase.ty);
    }
  };

  // Stroke-end hook. Dabs are emitted as points arrive, so nothing to flush
  // today — this exists so the per-stroke lifecycle is explicit (a future
  // taper / wet-edge will need it). Never called on overflow restarts
  // (prepareStrokeCommit final = false).
  const end = () => {};

  return { addPoints, stamp, end, inkBounds, resetInk };
}

// ---------------------------------------------------------------------------
// The single-dab primitive for the preview surfaces (brushTip.js cursor tip,
// BrushPreview.jsx chips): ONE stamp of `brush` (v3-first through
// getAuthoringDab, so the tip previews the dab the engine will embed in the
// next stroke) or of explicit `settings`, at (x, y) in the ctx's own space.
// Scatter is zeroed so the stamp sits where asked; everything else — flecks,
// ribbons, halo, rotation jitter — is the engine's own emitDab with a fixed
// seed, so the preview never shimmers between renders. A v2 catalog dab is
// re-expressed as an inline v3 dab (normalizeInlineDab fills exactly the
// defaults emitDab would read), which renders identically.
export function previewDabFor(brushOrSettings) {
  const settings = typeof brushOrSettings === "string" ? null : brushOrSettings;
  const dab = settings
    ? getStrokeDab(settings)
    : getAuthoringDab(brushOrSettings)?.dab || null;
  return dab ? { ...dab, scatter: 0 } : null;
}

// A single wash dab at flow 0.12 is invisible on a chip; a stroke pixel sees
// ~7 overlapping dabs, so ONE preview dab is shown at a legible floor instead
// (shape, texture and rim are the brush's own — only the film is thicker).
const PREVIEW_FLOW_FLOOR = 0.45;

export function drawSingleDab(ctx, { brush, settings, color, size, x, y, angle = 0, pressure = 1, seed = 4242 }) {
  const dab = previewDabFor(settings || brush);
  if (!dab) {
    return false;
  }
  const previewSettings = {
    brush: settings?.brush || brush || "marker",
    color: color || settings?.color || "#111827",
    size,
    opacity: 1,
    seed,
    v: 3,
    dab: dab.flow < PREVIEW_FLOW_FLOOR ? { ...dab, flow: PREVIEW_FLOW_FLOOR } : dab,
  };
  makeStrokeRenderer(previewSettings).stamp(ctx, x, y, pressure, angle);
  return true;
}

// ---------------------------------------------------------------------------
// The ONE per-stroke entry builder every consumer starts from — App.jsx
// (local stroke + each symmetry copy + remote strokes), opReplay.applyOp
// (history / spectator / film) — so the buffer, the dab renderer, the commit
// passes, the pad, the opacity and the commit composite are decided in a
// single place and can never drift between consumers. Callers spread the
// result into their entry and add their own fields (frameId, lastTouch,
// settings, seed...). Returns null for a v3 op whose inline dab failed to
// normalize (nothing can draw it).
//
// `buffered: false` is the past-the-cap fallback (too many concurrent remote
// strokes): no buffer, so no renderer / passes either — the legacy direct
// per-segment path, exactly as before.
//
// Known divergences between the local studio and a remote / replay consumer
// (opReplay.applyOp, App's remote branch, LiveRoomCanvas) — bounded and
// documented here (and in ARCHITECTURE.md) rather than fixed, because each
// fix repaints persisted history or costs the dab path:
// - Ops carry no layer: a remote / replay consumer commits every stroke to
//   layer 0 while the studio commits to the active layer. A pre-existing
//   class, widened by multiply — a multiply stroke on a layer >= 1
//   multiplies over different pixels locally than remotely.
// - Symmetry with >= 5 copies: the studio buffers every copy, but remote /
//   replay consumers cap concurrent buffers at 4 (MAX_STROKE_BUFFERS /
//   REMOTE_BUFFER_CAP), so copies 5+ replay on the legacy direct-segment
//   path — no dabs, no commit passes. Pinned by the symmetry-radial8 golden.
// - Symmetry + an overflow-sized stroke + copies that overlap: the studio
//   banks each copy's chunk the instant that copy's ensure() overflows, in
//   copy order per point; a replay consumer expands the op into per-copy
//   strokes and walks each batch by batch, so two overlapping copies' chunks
//   can commit in the other order (visible for source-over shapes only).
// - Non-hex colour strings: the legacy vector branches paint whatever the
//   canvas parses, while sprite shapes tint through parseColorRgb, whose
//   fallback is near-black — the same on every consumer, but not the colour
//   a legacy shape would show for the same string.
// - v3 smudge strokes that interleave inside ONE consumer share the carry
//   scratch (a module singleton, cleared at every stroke start): a remote
//   smudge landing during a local one, or two users' smudge ops interleaved
//   in history, mix their carried colour / blur temp. Bounded (a dab lands
//   at <= strength alpha of a feathered pad) and inside smudge's accepted
//   live-overlap divergence anyway — every consumer samples layer 0 as it
//   stands when the stroke starts, so two smudges over the same paint never
//   matched pixel-for-pixel across consumers. Past a remote / replay
//   consumer's buffer cap (4 open strokes) a v3 smudge op is skipped (it
//   has no direct fallback), the way a 5th symmetry copy loses its dabs.
export function makeStrokeEntryCore(settings, getMix, { buffered = true, smudgeSource = null } = {}) {
  if (settings.brush === "smudge") {
    // v3 smudge (Stage 4): a buffered stroke like every brush — its dabs
    // land in the buffer and commit once at pen-up — whose renderer SAMPLES
    // `smudgeSource`, the consumer's layer 0 as it stands before the stroke.
    // That is the whole point: a finger that re-samples its own deposits
    // (the direct legacy way) recycles them, and above strength ~0.3 the
    // smear self-sustains at a fixed point and never fades (measured — see
    // makeSmudgeV3Renderer); sampling the pre-stroke paper lets the load
    // fade at its own rate. No dab, no commit passes, source-over, opacity
    // 1 (Strength IS smudge's strength; the opacity slider is hidden for it
    // and the op's opacity is ignored, as the legacy renderer ignored it).
    // Legacy smudge ops (no `v`) never reach here — every consumer routes
    // them to the direct legacy renderer first. Past a consumer's buffer
    // cap (buffered: false) there is no direct fallback for v3: the stroke
    // gets a SKIP entry (no buffer, no renderer) that stays in the consumer's
    // stroke map until its end-op, so every later op of the stroke is
    // dropped too — a consistently missing stroke, never a partial one that
    // resumes mid-way once a buffer frees. (Local always buffers, so this is
    // the documented over-cap local-vs-remote divergence class.)
    const smudge = normalizeSmudgeSettings(settings);
    if (!smudge.v3) {
      return null;
    }
    if (!buffered || !smudgeSource) {
      return {
        buf: null,
        renderer: null,
        fx: null,
        composite: "source-over",
        opacity: 1,
        drawSettings: { ...settings, opacity: 1 },
        pad: strokeBufferPad(settings, null),
        skip: true, // consumers: no direct fallback either
      };
    }
    return {
      buf: createStrokeBuffer(),
      renderer: makeSmudgeRenderer(settings, smudgeSource),
      fx: null,
      composite: "source-over",
      opacity: 1,
      drawSettings: { ...settings, opacity: 1 },
      pad: strokeBufferPad(settings, null),
    };
  }
  const dab = getStrokeDab(settings);
  if (settings.v >= 3 && !dab) {
    return null;
  }
  const buf = buffered ? createStrokeBuffer() : null;
  const composite = getStrokeComposite(settings, dab);
  if (buf) {
    buf.composite = composite; // every buf.commit() inherits it by default
  }
  return {
    buf,
    // Per-stroke dab walk state → wire batching can't move dabs. Null →
    // legacy segment path (no dab params, or no buffer).
    renderer: dab && buf ? makeStrokeRenderer(settings, getMix) : null,
    // Commit passes (bleed / wet edge / impasto / granulation / grain): the
    // dab plus the stroke size, which the bleed offset scales with.
    fx: dab && buf ? { ...dab, size: clamp(settings.size || 24, 1, 160) } : null,
    composite,
    opacity: Math.min(1, Math.max(0.05, settings.opacity == null ? 1 : settings.opacity)),
    drawSettings: { ...settings, opacity: 1 }, // legacy segments paint at full alpha into the buffer
    pad: strokeBufferPad(settings, dab),
  };
}

// ---------------------------------------------------------------------------
// Smudge (private rooms only): a dab walk that carries NO pigment — it moves
// and softens the paint already on LAYER 0. Ops carry no layer, so every
// consumer samples and lands smudge on layer 0 (the studio too, whatever
// layer is active) in server op order: history replay is deterministic, and
// live concurrent overlap can diverge briefly and self-heals on the next
// history frame.
//
// Two generations share the brush id "smudge"; the OP decides which one
// renders it (never the catalog, never a client setting):
// - LEGACY (no settings.v): makeLegacySmudgeRenderer — every dab re-stamps a
//   SQUARE of layer 0 sampled slightly behind the motion through one
//   self-referential drawImage, DIRECTLY onto layer 0 (no buffer). Frozen
//   verbatim: persisted history replays through it byte-for-byte (the
//   smudge-legacy golden pins it).
// - v3 (settings.v >= 3, Stage 4): makeSmudgeV3Renderer — the feathered
//   "drag" and "blend" modes named by settings.smudgeMode, run as a normal
//   BUFFERED stroke (makeStrokeEntryCore) that samples the pre-stroke layer
//   0 and commits once at pen-up. A stale client that predates v3 renders
//   these ops with the legacy square instead: bounded, cosmetic, and the
//   server needs no change (server.js still drops every smudge op in a
//   kid_safe room by brush id).
// normalizeSmudgeSettings is the ONE reading of a smudge op's generation /
// mode / strength, and makeSmudgeRenderer is the ONE factory that applies
// it — the studio's local walker (startStroke), applyRemoteOp, opReplay
// (spectators, history, film export) and the lab all build their renderer
// through it, so no consumer can route an op differently.

const SMUDGE_SPACING = 0.18;
const SMUDGE_MIN_SIZE = 0.3;
const SMUDGE_STRENGTH = 0.45; // default per-dab re-stamp alpha (no strength set)
const SMUDGE_DRAG = 0.35; // sample offset behind the motion, fraction of dab size

// v3 (Stage 4) constants. Frozen once shipped: a v3 op carries only its mode
// and strength, so these numbers ARE the persisted look.
const SMUDGE_BLEND_SPACING = 0.22;
// drag: the carry's EMA weight per dab — the rate the finger's load turns
// over, so ~1 / pickup dabs is how far a picked-up colour rides (half-life
// ~10 dabs at a feather touch, ~30 when pressed hard: the smudge-length
// curve of every finger tool). Interpolated on the pressure-driven strength.
const SMUDGE_PICKUP_LIGHT = 0.07;
const SMUDGE_PICKUP_HARD = 0.02;
const SMUDGE_PAD = 128; // drag: the carry pad, px of the carry singleton — the finger's face in dab space
// The feather drawn over the pad after every pickup (the inverse mask,
// destination-out) so its rim can't fill up to a hard disc across many
// dabs: the cell size and origin of the mask for a SMUDGE_PAD-wide dab
// (same rule as SMUDGE_MASK_CELL).
const SMUDGE_PAD_MASK_CELL = SMUDGE_PAD * (SPRITE_PX / (2 * SPRITE_UNIT));
const SMUDGE_PAD_MASK_ORIGIN = (SMUDGE_PAD - SMUDGE_PAD_MASK_CELL) / 2;
// Blend's box pyramid: level i of the halving chain lives in the carry (odd
// i) or the scratch (even i) at these x offsets (y 0), sized for the largest
// dab (160 px -> 80 / 40 / 20 / 10 / 5); an even last level is parked at
// BLEND_FINAL_X in the carry so the up-sample never reads the canvas it
// writes. The scratch regions sit right of the footprint's 160-px column
// (plus its 1-px clear margin). Module constants: no per-dab allocation.
const BLEND_CARRY_X = [0, 128, 176]; // levels 1, 3, 5
const BLEND_SCRATCH_X = [168, 216]; // levels 2, 4
const BLEND_FINAL_X = 200;
// The soft-mask sprite's unit radius is SPRITE_UNIT px of its SPRITE_PX cell.
// Drawn at cell = dab size x this, centred on the dab, its feather (alpha 1
// inside 0.55 radii, 0 at the rim) reaches exactly the dab's edge.
export const SMUDGE_MASK_CELL = SPRITE_PX / (2 * SPRITE_UNIT); // shared with the cursor tip

// The one reading of a smudge op's settings — every consumer's renderer is
// built from this. `v3` picks the generation (an op without v >= 3 is the
// frozen legacy square, whatever else it carries); `mode` is "blend" only
// when the op says exactly that, otherwise "drag" (missing, unknown or
// hostile values degrade to drag, never throw); `strength` is the Strength
// slider clamped the way the legacy renderer clamps it, a non-numeric value
// falling back to the default; `size` is clamped like every brush.
export function normalizeSmudgeSettings(settings) {
  const s = settings || {};
  const v3 = s.v >= 3;
  const strength = typeof s.strength === "number" && Number.isFinite(s.strength) ? s.strength : SMUDGE_STRENGTH;
  const size = typeof s.size === "number" && Number.isFinite(s.size) && s.size > 0 ? s.size : 24;
  return {
    v3,
    mode: v3 && s.smudgeMode === "blend" ? "blend" : "drag",
    strength: clamp(strength, 0.05, 0.95),
    size: clamp(size, 1, 160),
  };
}

// The smudge renderer for an op: { addPoints(ctx, points), end() }.
// `sourceCanvas` is layer 0 (the paint being smeared); `ctx` is where the
// dabs land — layer 0 itself for a legacy op, the stroke buffer's
// world-transformed context for a v3 op. Fed one point per addPoints call
// by every consumer, like the dab renderers, so wire batching can't move a
// dab.
export function makeSmudgeRenderer(settings, sourceCanvas) {
  const smudge = normalizeSmudgeSettings(settings);
  if (!smudge.v3) {
    return makeLegacySmudgeRenderer(settings, sourceCanvas);
  }
  return makeSmudgeV3Renderer(smudge, sourceCanvas);
}

// LEGACY smudge (ops without `v`): sample-and-drag of a SQUARE rect via a
// self-referential drawImage. drawImage with source === destination canvas
// is well-defined (the source rect is snapshotted first) — but that
// snapshot is the WHOLE 4000x2500 layer, ~8 ms per dab, which is why v3
// below never draws layer -> layer. FROZEN: this body must stay byte-for-
// byte (the smudge-legacy golden), so read it as history, not as a template.
function makeLegacySmudgeRenderer(settings, sourceCanvas) {
  const size = clamp(settings.size || 24, 1, 160);
  // How hard the finger pulls paint: the per-dab re-stamp alpha. User-set via
  // the Strength slider (settings.strength, 0..1); falls back to the default.
  const strength = clamp(settings.strength == null ? SMUDGE_STRENGTH : settings.strength, 0.05, 0.95);
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
    ctx.globalAlpha = strength;
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

// v3 smudge (Stage 4): the feathered blend brush. Both modes stamp a SOFT
// disc (the fixed-seed softMask sprite — the same feather on every client)
// instead of the legacy square, and pressure drives how hard the finger
// presses. Per-dab state lives in two module-singleton 256^2 scratches
// (brushSprites.getSmudgeScratch / getCarryScratch): the sampled footprint
// and the finger's carry — never a per-stroke allocation.
//
// "drag" (default): the footprint is sampled TRAILING the motion by
//   SMUDGE_DRAG x size, and what lands under the dab is the CARRY — the
//   finger's load, an EMA (weight SMUDGE_PICKUP_LIGHT..HARD) of the
//   footprints it touched, kept in a dab-relative pad — at the pressure-
//   driven strength. Paint moves with the finger (the load lags the dab by
//   the trail plus the EMA's memory), and past an edge the load fades by
//   (1 - pickup) per dab: the carried colour thins out over ~10 dabs at a
//   feather touch and rides ~3x further when pressed hard (the lab's carry
//   metric). This only works because the footprint is the PRE-STROKE paper
//   (the stroke lands in a buffer): a finger that re-samples its own
//   deposits recycles them, and with ~4 overlapping dabs that loop's gain
//   exceeds 1 above strength ~0.3 — measured both ways (a direct re-stamp,
//   and carry-only on the live layer), the last 15% of a 300-px tail onto
//   blank paper still read as the field colour at ~0.85-0.95 alpha.
// "blend": the footprint is sampled CENTRED (no trail), box-blurred by an
//   exact 2x-halving pyramid (a bilinear drawImage at exactly half size is
//   a 2x2 texel average; chained to a ~4-px image and drawn back up in one
//   bilinear draw, it is a blur of about a quarter of the dab from plain
//   drawImage calls), and laid back at strength. Nothing moves, so circling
//   over an edge converges to a smooth average and can never smear a
//   drawing away.
//
// Determinism: no dice at all. The walk and the carry are pure functions of
// the fed point sequence, and every draw is a scaled drawImage of pixels the
// same engine produced, so local / remote / replay agree byte-for-byte on
// one engine (cross-engine resampling kernels may drift — accepted, as for
// every bilinear stamp). The carry is a singleton: two smudge strokes that
// interleave in one consumer (a live remote stroke during a local one, or
// two users' ops interleaved in history) share it — a bounded, documented
// divergence (see makeStrokeEntryCore's list), cleared at every stroke start.
function makeSmudgeV3Renderer({ mode, strength, size }, sourceCanvas) {
  const blend = mode === "blend";
  const spacing = blend ? SMUDGE_BLEND_SPACING : SMUDGE_SPACING;
  const dabSizeAt = (pressure) => size * (SMUDGE_MIN_SIZE + (1 - SMUDGE_MIN_SIZE) * Math.pow(pressure, 1.35));
  // Pressure drives strength: 0.35x the slider at a feather touch, rising
  // (faster near full pressure) to the slider value when pressed hard.
  const strengthAt = (pressure) => strength * (0.35 + 0.65 * pressure * (0.5 + 0.5 * pressure));
  // The feather as its INVERSE (alpha 1 - mask, opaque to the cell corners):
  // a destination-out draw of it multiplies by the feather like
  // destination-in with the mask would, but bounded to the drawn cell —
  // destination-in is canvas-wide (see getSoftMaskInverse).
  const feather = getSoftMaskInverse();

  // The scratches are re-fetched per addPoints call (not cached for the
  // stroke): releaseBrushSprites (tab hidden) can drop them mid-stroke, and
  // a fresh singleton must replace the dead canvas instead of throwing.
  // A carry seen for the first time is cleared — the finger starts clean.
  // Once per stroke in the normal case; never per dab.
  let scratch = null;
  let scratchCtx = null;
  let carry = null;
  let carryCtx = null;
  const bindScratches = () => {
    const nextScratch = getSmudgeScratch();
    if (nextScratch !== scratch) {
      scratch = nextScratch;
      scratchCtx = scratch ? scratch.getContext("2d") : null;
      if (scratchCtx) {
        scratchCtx.setTransform(1, 0, 0, 1, 0, 0);
        scratchCtx.globalAlpha = 1;
      }
    }
    const nextCarry = getCarryScratch();
    if (nextCarry !== carry) {
      carry = nextCarry;
      carryCtx = carry ? carry.getContext("2d") : null;
      if (carryCtx) {
        carryCtx.setTransform(1, 0, 0, 1, 0, 0);
        carryCtx.globalCompositeOperation = "source-over";
        carryCtx.globalAlpha = 1;
        carryCtx.fillStyle = "#000000"; // the fade's destination-out fill: opaque, so globalAlpha alone sets the decay
        carryCtx.clearRect(0, 0, carry.width, carry.height);
      }
    }
    return scratchCtx != null && carryCtx != null && feather != null;
  };

  // The dab's footprint on layer 0: the sample rect clamped to the canvas,
  // the destination shifted by the same amount so the sampled pixels keep
  // their exact offset — the legacy rule. Written into these slots, so a
  // dab allocates nothing.
  let fx = 0; // clamped sample origin on layer 0
  let fy = 0;
  let fw = 0; // clamped sample size
  let fh = 0;
  let fdx = 0; // where the footprint lands
  let fdy = 0;
  const clipFootprint = (ux, uy, sizePx, x, y) => {
    const half = sizePx / 2;
    fx = ux;
    fy = uy;
    fw = sizePx;
    fh = sizePx;
    fdx = x - half;
    fdy = y - half;
    if (fx < 0) {
      fdx -= fx;
      fw += fx;
      fx = 0;
    }
    if (fy < 0) {
      fdy -= fy;
      fh += fy;
      fy = 0;
    }
    if (fx + fw > sourceCanvas.width) {
      fw = sourceCanvas.width - fx;
    }
    if (fy + fh > sourceCanvas.height) {
      fh = sourceCanvas.height - fy;
    }
    return fw >= 1 && fh >= 1;
  };

  // DAB-PATH-BEGIN — the v3 smudge per-dab path (Stage 4). Layer 0 is only
  // ever a drawImage SOURCE into the scratch or a DESTINATION for the
  // scratch / carry, never both in one call (a self-referential drawImage
  // snapshots the whole 4000x2500 layer: ~8 ms per dab, the legacy cost).
  // Every step is a tiny fill / drawImage bounded to a <= 190^2 rect (the
  // feather's cell around a 160-px dab): no readbacks, no allocation, no
  // save/restore, no canvas-wide composite (clearRect + source-over stand
  // in for 'copy'; the inverse feather + destination-out for the mask's
  // destination-in). `ctx` is the stroke buffer's context (world
  // coordinates through its origin transform): the deposits accumulate
  // there and commit once at pen-up.

  // Layer 0's [fx, fy, fw, fh] -> scratch (0, 0), then feathered by the
  // inverse mask centred on the UNCLIPPED dab, so an edge-clipped dab keeps
  // the same disc the way the legacy square keeps its offset. The rect is
  // inscribed in the feather's cell, so the destination-out clears every
  // pixel of the rect outside the disc; what lies outside the cell is
  // never read (the deposits read [0, 0, fw, fh] only).
  const sampleFootprint = (ux, uy, sizePx) => {
    scratchCtx.globalCompositeOperation = "source-over";
    scratchCtx.globalAlpha = 1;
    scratchCtx.clearRect(0, 0, fw + 1, fh + 1);
    scratchCtx.drawImage(sourceCanvas, fx, fy, fw, fh, 0, 0, fw, fh);
    scratchCtx.globalCompositeOperation = "destination-out";
    const cell = sizePx * SMUDGE_MASK_CELL;
    scratchCtx.drawImage(feather, ux - fx + (sizePx - cell) / 2, uy - fy + (sizePx - cell) / 2, cell, cell);
  };

  const emitDrag = (ctx, x, y, pressure, angle) => {
    const sizePx = dabSizeAt(pressure);
    const half = sizePx / 2;
    const shift = sizePx * SMUDGE_DRAG;
    // Source trails the motion; stamping it at the dab drags paint forward.
    const ux = x - Math.cos(angle) * shift - half;
    const uy = y - Math.sin(angle) * shift - half;
    if (!clipFootprint(ux, uy, sizePx, x, y)) {
      return;
    }
    sampleFootprint(ux, uy, sizePx);
    // Carry: the finger's load, an EMA of the trailing footprints in
    // dab-relative pad space (the pad is the finger's face whatever the dab
    // size is; a clipped dab maps onto its share of the pad). Fade by
    // pickup (destination-out) FIRST, then fill the freed capacity from the
    // footprint (destination-over): for a loaded finger that is exactly
    // pad = (1 - pickup) x pad + pickup x footprint; a clean finger loads
    // fully on its first touch; blank paper (a transparent footprint)
    // refills nothing, so only the fade remains and the colour thins out.
    const padK = SMUDGE_PAD / sizePx;
    const px = (fx - ux) * padK;
    const py = (fy - uy) * padK;
    const pw = fw * padK;
    const ph = fh * padK;
    const alpha = strengthAt(pressure);
    carryCtx.globalCompositeOperation = "destination-out";
    carryCtx.globalAlpha = SMUDGE_PICKUP_LIGHT + (SMUDGE_PICKUP_HARD - SMUDGE_PICKUP_LIGHT) * alpha;
    carryCtx.fillRect(0, 0, SMUDGE_PAD, SMUDGE_PAD);
    carryCtx.globalCompositeOperation = "destination-over";
    carryCtx.globalAlpha = 1;
    carryCtx.drawImage(scratch, 0, 0, fw, fh, px, py, pw, ph);
    // Re-feather the pad: with a slow turnover its rim would otherwise fill
    // up to a hard disc over many dabs (each pickup adds most where the pad
    // is thinnest); the mask keeps the profile a smooth feather.
    carryCtx.globalCompositeOperation = "destination-out";
    carryCtx.drawImage(feather, SMUDGE_PAD_MASK_ORIGIN, SMUDGE_PAD_MASK_ORIGIN, SMUDGE_PAD_MASK_CELL, SMUDGE_PAD_MASK_CELL);
    // Deposit the load under the dab at the pressure-driven strength: paint
    // picked up a few dabs back lands here, so an edge is dragged forward
    // and the colour it carries fades over the dabs that follow.
    ctx.globalAlpha = alpha;
    ctx.drawImage(carry, px, py, pw, ph, fdx, fdy, fw, fh);
  };

  const emitBlend = (ctx, x, y, pressure) => {
    const sizePx = dabSizeAt(pressure);
    const half = sizePx / 2;
    const ux = x - half; // centred: no trail, nothing moves
    const uy = y - half;
    if (!clipFootprint(ux, uy, sizePx, x, y)) {
      return;
    }
    sampleFootprint(ux, uy, sizePx);
    scratchCtx.globalCompositeOperation = "source-over";
    // The carry pad is a shared singleton: a concurrent drag stroke in the
    // same consumer leaves it in destination-out, so reset before the pyramid
    // writes level 1 there.
    carryCtx.globalCompositeOperation = "source-over";
    // Box pyramid: halve down to a ~4-px image (a comparison ladder, no
    // log per dab), ping-ponging scratch -> carry -> scratch -> carry so no
    // draw ever reads the canvas it writes. Integer level sizes so every
    // client sees the same texel grid; the +1 clears keep each level's
    // edge texels blank for the bilinear reads.
    const levels = fw >= 90 ? 5 : fw >= 45 ? 4 : fw >= 23 ? 3 : fw >= 11 ? 2 : 1;
    let src = scratch;
    let sx = 0;
    let sw = fw;
    let sh = fh;
    for (let i = 1; i <= levels; i += 1) {
      const dw = Math.max(1, Math.round(sw / 2));
      const dh = Math.max(1, Math.round(sh / 2));
      const toCarry = (i & 1) === 1;
      const dctx = toCarry ? carryCtx : scratchCtx;
      const dx = toCarry ? BLEND_CARRY_X[i >> 1] : BLEND_SCRATCH_X[(i >> 1) - 1];
      dctx.clearRect(dx, 0, dw + 1, dh + 1);
      dctx.drawImage(src, sx, 0, sw, sh, dx, 0, dw, dh);
      src = toCarry ? carry : scratch;
      sx = dx;
      sw = dw;
      sh = dh;
    }
    if (src === scratch) {
      // An even level count ends in the scratch: park it in the carry so
      // the up-sample below reads the carry and writes the scratch.
      carryCtx.clearRect(BLEND_FINAL_X, 0, sw + 1, sh + 1);
      carryCtx.drawImage(scratch, sx, 0, sw, sh, BLEND_FINAL_X, 0, sw, sh);
      sx = BLEND_FINAL_X;
    }
    scratchCtx.clearRect(0, 0, fw + 1, fh + 1);
    scratchCtx.drawImage(carry, sx, 0, sw, sh, 0, 0, fw, fh);
    ctx.globalAlpha = strengthAt(pressure);
    ctx.drawImage(scratch, 0, 0, fw, fh, fdx, fdy, fw, fh);
  };
  // DAB-PATH-END

  // The legacy walk (per-stroke residual + stationary-point skip, fed one
  // point at a time by every consumer), with the mode's spacing and no
  // per-point object: three numbers hold the last point.
  const emit = blend ? emitBlend : emitDrag;
  let lastX = 0;
  let lastY = 0;
  let lastP = 0;
  let residual = 0;
  let started = false;

  const addPoints = (ctx, points) => {
    if (!bindScratches()) {
      return; // no DOM / no sprites: nothing to smear with
    }
    // The layer ctx is left canonical by everything that draws on it, but
    // the deposit relies on source-over — assert it once per call.
    ctx.globalCompositeOperation = "source-over";
    let emitted = 0;
    for (const raw of points) {
      const pressure = clamp(raw.pressure == null ? 0.55 : raw.pressure, 0.06, 1);
      if (!started) {
        started = true;
        // First point has no direction yet: prime the walk, no dab.
        residual = Math.max(DAB_MIN_STEP, spacing * dabSizeAt(pressure));
        lastX = raw.x;
        lastY = raw.y;
        lastP = pressure;
        continue;
      }
      const sdx = raw.x - lastX;
      const sdy = raw.y - lastY;
      const d = Math.hypot(sdx, sdy);
      if (d < 1e-6) {
        continue; // stationary pressure-only update — see makeStrokeRenderer
      }
      const angle = blend ? 0 : Math.atan2(sdy, sdx);
      let pos = residual;
      while (pos <= d) {
        const t = pos / d;
        const p = lastP + (pressure - lastP) * t;
        emit(ctx, lastX + sdx * t, lastY + sdy * t, p, angle);
        emitted += 1;
        let step = Math.max(DAB_MIN_STEP, spacing * dabSizeAt(p));
        if (emitted > DAB_CAP) {
          step *= Math.min(16, 2 ** Math.floor(emitted / DAB_CAP)); // giant-flick guardrail
        }
        pos += step;
      }
      residual = pos - d;
      lastX = raw.x;
      lastY = raw.y;
      lastP = pressure;
    }
    ctx.globalAlpha = 1;
  };

  // Nothing to flush at pen-up (every dab already landed in the buffer),
  // no ink bbox to keep (smudge has no commit passes — fx is null, so
  // prepareStrokeCommit never asks; null means "the whole buffer" anyway)
  // and nothing to restart on an overflow bank: the walk and the carry
  // survive a buffer restart as they are, like every dab renderer's.
  const end = () => {};
  const inkBounds = () => null;
  const resetInk = () => {};

  return { addPoints, end, inkBounds, resetInk };
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

// Erode `strength` worth of tooth across `rect` ({x0, y0, w, h}, WORLD
// coords: the stroke's ink rect, or the whole buffer). Tiles are aligned to
// world-space multiples of the tile size — the buffer ctx carries the
// buffer's world-origin transform, so world position (not buffer position)
// decides the pattern phase: two strokes over the same paper spot share the
// same tooth. Bounding the tile loop to the rect is pixel-neutral: a tile
// that only covers transparent pixels erodes nothing (destination-out).
export function applyGrain(bufferCtx, rect, strength) {
  if (!(strength > 0)) {
    return;
  }
  const tile = getGrainTile();
  const startX = Math.floor(rect.x0 / GRAIN_SIZE) * GRAIN_SIZE;
  const startY = Math.floor(rect.y0 / GRAIN_SIZE) * GRAIN_SIZE;
  bufferCtx.save();
  bufferCtx.globalCompositeOperation = "destination-out";
  bufferCtx.globalAlpha = strength;
  for (let y = startY; y < rect.y0 + rect.h; y += GRAIN_SIZE) {
    for (let x = startX; x < rect.x0 + rect.w; x += GRAIN_SIZE) {
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
//
// Every self-blit below is the 9-argument drawImage of `rect` — the pass
// rect prepareStrokeCommit derives from the renderer's ink bbox — read from
// the buffer at (rect - bounds origin) and drawn back at the same world
// rect plus the pass's offset. Reading a sub-rect is pixel-identical to
// drawing the whole buffer as long as the sub-rect's outermost pixel ring
// is transparent (prepareStrokeCommit grows the rect past the ink by more
// than each pass's offset + 1 px of bilinear footprint): the copy reads the
// same source pixels, and everything the whole-buffer draw would have added
// outside the rect is a transparent source over a transparent (source-atop:
// untouched) destination.
//
// The filtered draws are also CLIPPED to the rect (clipPassRect): Chrome
// renders a ctx.filter draw through a layer sized to the clip, not to the
// drawn rect, so without the clip a 900 x 400 px stroke still paid two
// 2048² filter layers at pen-up (~60 ms on a CPU-raster canvas) however
// small its source sub-rect was. The clip contains every destination pixel
// the pass can change (rect grown by the pass's offset; pixels outside are
// transparent and source-atop leaves them alone), so it is pixel-neutral.
function clipPassRect(ctx, rect, reach) {
  ctx.beginPath();
  ctx.rect(rect.x0 - reach, rect.y0 - reach, rect.w + 2 * reach, rect.h + 2 * reach);
  ctx.clip();
}

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
function applyWetEdge(ctx, canvas, bounds, rect, strength) {
  if (!supportsCanvasFilter()) {
    return;
  }
  ctx.save();
  try {
    clipPassRect(ctx, rect, 2);
    ctx.globalCompositeOperation = "source-atop";
    ctx.globalAlpha = strength;
    ctx.filter = "brightness(0.55)";
    ctx.drawImage(canvas, rect.x0 - bounds.x0, rect.y0 - bounds.y0, rect.w, rect.h, rect.x0 + 1.5, rect.y0 + 1.5, rect.w, rect.h);
  } catch {
    /* filter unsupported mid-flight: leave the buffer untouched */
  }
  ctx.restore();
}

// Top-left light emboss: a brightened copy at (-1, -1) plus a darkened copy
// at (+1, +1), both clipped to the stroke — reads as raised paint ridges.
function applyImpasto(ctx, canvas, bounds, rect, strength) {
  if (!supportsCanvasFilter()) {
    return;
  }
  const sx = rect.x0 - bounds.x0;
  const sy = rect.y0 - bounds.y0;
  ctx.save();
  try {
    clipPassRect(ctx, rect, 2);
    ctx.globalCompositeOperation = "source-atop";
    ctx.globalAlpha = strength;
    ctx.filter = "brightness(1.6)";
    ctx.drawImage(canvas, sx, sy, rect.w, rect.h, rect.x0 - 1, rect.y0 - 1, rect.w, rect.h);
    ctx.filter = "brightness(0.45)";
    ctx.drawImage(canvas, sx, sy, rect.w, rect.h, rect.x0 + 1, rect.y0 + 1, rect.w, rect.h);
  } catch {
    /* filter unsupported mid-flight: leave the buffer untouched */
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Watercolor commit passes (Stage 2), both filter-free. Like every commit
// pass, a pure function of the buffer's pixels + the op settings + fixed
// tiles — never of the buffer's dimensions or any consumer-local state
// (spec P3) — so three-way parity holds.

// Bleed: four offset copies of the stroke drawn BEHIND it (destination-over)
// at (±b, 0) / (0, ±b), each at strength / 4 — a soft fringe of pigment that
// crept past the wet boundary. b scales with the stroke size (1.5..6 px).
// The fringe lands OUTSIDE the ink, so the caller's rect is the ink grown by
// more than b: every pixel the fringe can reach is inside the drawn rect,
// and what the whole-buffer draw would add past it is a transparent source
// (read from beyond the ink) — nothing.
function bleedOffset(size) {
  return clamp(0.08 * size, 1.5, 6);
}
function applyBleed(ctx, canvas, bounds, rect, strength, b) {
  const sx = rect.x0 - bounds.x0;
  const sy = rect.y0 - bounds.y0;
  ctx.save();
  ctx.globalCompositeOperation = "destination-over";
  ctx.globalAlpha = strength / 4;
  ctx.drawImage(canvas, sx, sy, rect.w, rect.h, rect.x0 + b, rect.y0, rect.w, rect.h);
  ctx.drawImage(canvas, sx, sy, rect.w, rect.h, rect.x0 - b, rect.y0, rect.w, rect.h);
  ctx.drawImage(canvas, sx, sy, rect.w, rect.h, rect.x0, rect.y0 + b, rect.w, rect.h);
  ctx.drawImage(canvas, sx, sy, rect.w, rect.h, rect.x0, rect.y0 - b, rect.w, rect.h);
  ctx.restore();
}

// Granulation: pigment settling into the paper's valleys. The paper tile
// (brushSprites.js: black, alpha = 2-octave value noise, seamless) is laid
// world-aligned like applyGrain — same phase rule, so two strokes over the
// same spot share the same paper — twice: source-atop darkens the stroke
// where the paper is deep, then destination-out thins it there, so the
// valleys read denser AND the film breaks up. The tile loop is bounded to
// `rect` like applyGrain's (neither composite touches a transparent pixel).
function applyGranulation(ctx, rect, strength) {
  const tile = getPaperTile();
  if (!tile) {
    return;
  }
  const tileSize = tile.width;
  const startX = Math.floor(rect.x0 / tileSize) * tileSize;
  const startY = Math.floor(rect.y0 / tileSize) * tileSize;
  ctx.save();
  ctx.globalCompositeOperation = "source-atop";
  ctx.globalAlpha = strength * 0.55;
  for (let y = startY; y < rect.y0 + rect.h; y += tileSize) {
    for (let x = startX; x < rect.x0 + rect.w; x += tileSize) {
      ctx.drawImage(tile, x, y);
    }
  }
  ctx.globalCompositeOperation = "destination-out";
  ctx.globalAlpha = strength * 0.25;
  for (let y = startY; y < rect.y0 + rect.h; y += tileSize) {
    for (let x = startX; x < rect.x0 + rect.w; x += tileSize) {
      ctx.drawImage(tile, x, y);
    }
  }
  ctx.restore();
}

// The world rect a commit pass works on: the renderer's ink bbox grown by
// `reach` (the pass's own offset + resampling footprint), clipped to the
// buffer — or the whole buffer when no ink bbox is known (renderer-less
// entries). One module-level object, filled in place; false = empty.
const PASS_RECT = { x0: 0, y0: 0, w: 0, h: 0 };
function passRect(bounds, ink, reach) {
  const x0 = ink ? Math.max(bounds.x0, ink.x0 - reach) : bounds.x0;
  const y0 = ink ? Math.max(bounds.y0, ink.y0 - reach) : bounds.y0;
  const x1 = ink ? Math.min(bounds.x0 + bounds.w, ink.x0 + ink.w + reach) : bounds.x0 + bounds.w;
  const y1 = ink ? Math.min(bounds.y0 + bounds.h, ink.y0 + ink.h + reach) : bounds.y0 + bounds.h;
  if (x1 <= x0 || y1 <= y0) {
    return false;
  }
  PASS_RECT.x0 = x0;
  PASS_RECT.y0 = y0;
  PASS_RECT.w = x1 - x0;
  PASS_RECT.h = y1 - y0;
  return true;
}

// One-stop pre-commit hook for a v2 stroke buffer: flush the dab renderer,
// then run the brush's commit passes — inside the buffer, before the single
// opacity-stamped commit. Pass order is FROZEN (spec P3): renderer.end →
// bleed → wet edge → impasto → granulation → grain. `fx` is the entry core's
// { ...dab, size } (or null for legacy strokes — full no-op). All consumers
// (local, remote, spectator, history replay, and every OVERFLOW commit) share
// this helper, so the passes can never diverge per consumer. Pass `final =
// false` on OVERFLOW commits: end() is skipped (the renderer's residual /
// lastPoint walk state must survive the buffer restart untouched) and the
// renderer's ink bbox is cleared for the buffer the caller restarts next.
//
// The passes run on the renderer's ink bbox (renderer.inkBounds(): a
// superset of the stroke's pixels), grown per pass by its own reach and
// clipped to the buffer — not on the whole allocated buffer, which for a
// size-80 stroke is 2048² of mostly-transparent pixels and, on a CPU-raster
// canvas (iPad Safari, the lab's software renderer), 4 + 1 full-buffer
// blits per watercolor pen-up. Pixel-identical (proved by the golden
// groups): each pass is a no-op wherever the buffer is transparent, so the
// rect only has to contain the ink plus what a pass adds — bleed's fringe
// (grown by ceil(b) + 1 for the passes that follow), and the wet-edge /
// impasto offsets (1.5 px + 1 px of bilinear footprint). A renderer-less
// entry (no ink bbox) keeps the whole-buffer passes.
//
// Accepted preview "pops" (the live preview is the raw buffer at the
// stroke's opacity + composite, so a pass that changes pixels lands at
// pen-up): the passes themselves (kept small — the lab's penUpPop gates
// watercolor at <= 0.024 stroke-mean), and for multiply strokes the preview
// multiplies over the whole document composite while the commit multiplies
// only into the active layer — identical on a single-layer room, a visible
// shift under a second layer, a layer opacity < 1, a trace-a-photo sheet or
// an onion-skin ghost drawn beneath the preview.
//
// Known divergences (local vs remote / replay), all bounded and documented
// rather than fixed here — see makeStrokeEntryCore's block for the list.
export function prepareStrokeCommit(buf, renderer, fx, final = true) {
  if (buf && buf.has()) {
    if (renderer && final) {
      renderer.end(buf.getCtx());
    }
    if (fx) {
      runCommitPasses(buf, renderer ? renderer.inkBounds() : null, fx);
    }
  }
  if (renderer && !final) {
    renderer.resetInk(); // the caller buf.reset()s next: the ink starts over with the buffer
  }
}

function runCommitPasses(buf, ink, fx) {
  if (ink && !(ink.w > 0 && ink.h > 0)) {
    return; // nothing stamped into this buffer: every pass is a no-op on transparent pixels
  }
  const ctx = buf.getCtx();
  const bounds = buf.bounds();
  let grow = 0; // how far past the ink bbox the passes so far have put pixels
  if (fx.bleed > 0) {
    const b = bleedOffset(clamp(fx.size || 24, 1, 160));
    if (passRect(bounds, ink, Math.ceil(b) + 2)) {
      applyBleed(ctx, buf.canvas, bounds, PASS_RECT, fx.bleed, b);
    }
    grow = Math.ceil(b) + 1; // the fringe: a fractional offset resamples one pixel further
  }
  if (fx.wetEdge > 0 && passRect(bounds, ink, grow + 3)) {
    applyWetEdge(ctx, buf.canvas, bounds, PASS_RECT, fx.wetEdge);
  }
  if (fx.impasto > 0 && passRect(bounds, ink, grow + 3)) {
    applyImpasto(ctx, buf.canvas, bounds, PASS_RECT, fx.impasto);
  }
  if (fx.granulation > 0 && passRect(bounds, ink, grow)) {
    applyGranulation(ctx, PASS_RECT, fx.granulation);
  }
  if (fx.grain > 0 && passRect(bounds, ink, grow)) {
    applyGrain(ctx, PASS_RECT, fx.grain);
  }
}
