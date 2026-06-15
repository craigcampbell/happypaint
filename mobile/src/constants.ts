import type { BrushId, BrushSettings, TextureId } from "./types";

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
  texture: "linen"
};

export const CANVAS_ASPECT_RATIO = 4 / 3;
