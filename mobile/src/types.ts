export type BrushId = "marker" | "pencil" | "paint" | "spray" | "eraser" | "glow";

export type TextureId = "linen" | "canvas" | "smooth" | "night";

export type ToolMode = "gallery" | "studio" | "settings" | "together" | "discover" | "paintspace";

// The active studio tool. "brush" / "eraser" draw freehand strokes (the brush
// itself is chosen via BrushSettings.brush). The others place layer items.
export type StudioTool = "brush" | "eraser" | "fill" | "rect" | "ellipse" | "line" | "text";

export type ShapeKind = "rect" | "ellipse" | "line";

export type DrawPoint = {
  x: number;
  y: number;
  size: number;
};

export type SprayDot = {
  x: number;
  y: number;
  radius: number;
};

export type Stroke = {
  id: string;
  brush: BrushId;
  color: string;
  opacity: number;
  size: number;
  variation: number;
  points: DrawPoint[];
  sprayDots?: SprayDot[];
};

// --- Layer item discriminated union -----------------------------------------
// A stroke item wraps the existing Stroke shape so StrokeNode can be reused.
export type StrokeItem = {
  kind: "stroke";
  id: string;
  stroke: Stroke;
};

// A fill item paints a full-canvas colored rectangle. Because this is a vector
// (stroke list) renderer rather than a pixel buffer, a flood fill of a tapped
// region is approximated: tapping with the fill tool drops a full-canvas Rect
// of the chosen color at the BOTTOM of the active layer (behind later items).
export type FillItem = {
  kind: "fill";
  id: string;
  color: string;
  opacity: number;
};

export type ShapeItem = {
  kind: "shape";
  id: string;
  shape: ShapeKind;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  color: string;
  size: number;
  opacity: number;
  filled: boolean;
};

export type TextItem = {
  kind: "text";
  id: string;
  text: string;
  x: number;
  y: number;
  color: string;
  size: number;
  opacity: number;
};

// An image item places a bitmap (e.g. a Paint Space sticker) on a layer.
export type ImageItem = {
  kind: "image";
  id: string;
  uri: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
};

export type LayerItem = StrokeItem | FillItem | ShapeItem | TextItem | ImageItem;

export type Layer = {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  items: LayerItem[];
};

// --- Tiny Animation Loops ---------------------------------------------------
// Each frame owns its own layer stack. A still drawing is just a 1-frame loop.
export type Frame = {
  id: string;
  durationMs: number;
  layers: Layer[];
  activeLayerId: string;
};

export type DrawingProject = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  texture: TextureId;
  // Frame-based model. The active frame's layer stack is what the studio edits.
  frames: Frame[];
  activeFrameId: string;
  onionSkin?: boolean;
  previewUri?: string;
  importedImageUri?: string;
  // --- Backward-compat (optional reads only) --------------------------------
  // Pre-frame projects stored layers/activeLayerId at the top level; pre-layer
  // projects stored a flat `strokes` array. migrateProject() folds either into
  // a single frame. New code should not write these.
  layers?: Layer[];
  activeLayerId?: string;
  strokes?: Stroke[];
};

// --- Paint Space locker -----------------------------------------------------
// Mirrors backend public.space_assets (id, kind, title, payload, thumbnail,
// createdAt) so the local locker is sync-ready. `kind` is a youth-facing subset
// of the backend enum.
export type PaintSpaceKind = "sticker" | "palette" | "template" | "loop";

export type StickerPayload = {
  uri: string;
  width: number;
  height: number;
};

export type TemplatePayload = {
  // A template starts a new project from a saved frame stack plus paper.
  texture: TextureId;
  frames: Frame[];
  uri?: string;
};

export type PalettePayload = {
  colors: string[];
};

export type LoopFramePreview = {
  uri: string;
  durationMs: number;
};

export type LoopPayload = {
  // Visual frame previews (for thumbnails) plus the editable frame stack so the
  // loop can be rebuilt into a project.
  previews: LoopFramePreview[];
  frames: Frame[];
  texture: TextureId;
};

export type SpaceAssetPayload =
  | StickerPayload
  | TemplatePayload
  | PalettePayload
  | LoopPayload;

export type SpaceAsset = {
  id: string;
  kind: PaintSpaceKind;
  title: string;
  payload: SpaceAssetPayload;
  thumbnail?: string;
  previewUri?: string;
  createdAt: number;
  updatedAt: number;
};

export type BrushSettings = {
  brush: BrushId;
  color: string;
  size: number;
  opacity: number;
  variation: number;
  texture: TextureId;
  tool: StudioTool;
  shapeFilled: boolean;
};
