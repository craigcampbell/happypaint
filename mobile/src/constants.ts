import type { BrushId, BrushSettings, Frame, Layer, Stroke, StrokeItem, TextureId } from "./types";

export const DEFAULT_LAYER_NAMES = ["Background", "Sketch", "Color", "Detail"];

// Loop tooling defaults.
export const DEFAULT_FRAME_DURATION_MS = 200;
export const FRAME_COUNT_OPTIONS = [1, 2, 4, 8];

function makeLayerId(seed: number) {
  return `layer-${seed}-${Math.random().toString(36).slice(2)}`;
}

function makeFrameId(seed: number) {
  return `frame-${seed}-${Math.random().toString(36).slice(2)}`;
}

export function createDefaultLayers(): Layer[] {
  const now = Date.now();
  return DEFAULT_LAYER_NAMES.map((name, index) => ({
    id: makeLayerId(now + index),
    name,
    visible: true,
    locked: false,
    opacity: 1,
    items: []
  }));
}

export function createFrame(layers?: Layer[]): Frame {
  const now = Date.now();
  return {
    id: makeFrameId(now),
    durationMs: DEFAULT_FRAME_DURATION_MS,
    layers: layers ?? createDefaultLayers(),
    activeLayerId: (layers ?? createDefaultLayers())[0].id
  };
}

export function createDefaultFrames(): Frame[] {
  const layers = createDefaultLayers();
  return [
    {
      id: makeFrameId(Date.now()),
      durationMs: DEFAULT_FRAME_DURATION_MS,
      layers,
      activeLayerId: layers[0].id
    }
  ];
}

// Wrap a legacy flat stroke list into StrokeItems on the bottom layer.
export function strokesToItems(strokes: Stroke[]): StrokeItem[] {
  return strokes.map((stroke) => ({ kind: "stroke", id: stroke.id, stroke }));
}

export const COLORS = [
  "#111827",
  "#ffffff",
  "#ef4444",
  "#f59e0b",
  "#facc15",
  "#22c55e",
  "#0ea5e9",
  "#7c3aed",
  "#fca5a5",
  "#14b8a6"
];

export const BRUSHES: Array<{ id: BrushId; label: string; tier?: "studio" }> = [
  { id: "marker", label: "Marker" },
  { id: "pencil", label: "Pencil" },
  { id: "paint", label: "Paint" },
  { id: "spray", label: "Spray" },
  { id: "eraser", label: "Eraser" },
  { id: "glow", label: "Glow", tier: "studio" }
];

export const TEXTURES: Array<{ id: TextureId; label: string; background: string; tier?: "studio" }> = [
  { id: "linen", label: "Linen", background: "#f7f1e5" },
  { id: "canvas", label: "Canvas", background: "#f6f4ed" },
  { id: "smooth", label: "Smooth", background: "#ffffff" },
  { id: "night", label: "Night", background: "#171a22", tier: "studio" }
];

export const STUDIO_PACKS = [
  {
    id: "creator-brushes",
    title: "Creator Brushes",
    price: "150 Drops",
    perks: ["Glow brush", "Night paper", "Poster palette"]
  },
  {
    id: "export-plus",
    title: "Export Plus",
    price: "250 Drops",
    perks: ["Transparent PNG", "Wallpaper presets", "Large print export"]
  }
];

export const DEFAULT_SETTINGS: BrushSettings = {
  brush: "marker",
  color: "#111827",
  size: 24,
  opacity: 0.86,
  variation: 0.08,
  texture: "linen",
  tool: "brush",
  shapeFilled: false
};

export const CANVAS_ASPECT_RATIO = 4 / 3;
