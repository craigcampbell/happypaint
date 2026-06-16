import Slider from "@react-native-community/slider";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Eraser,
  Eye,
  EyeOff,
  FileImage,
  Film,
  FolderOpen,
  ImagePlus,
  Layers,
  Lock,
  Merge,
  Package,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Unlock
} from "lucide-react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as RNText,
  TextInput,
  View
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import {
  AlphaType,
  BlendMode,
  Canvas,
  ColorType,
  createPicture,
  Group,
  Image as SkiaImage,
  Line,
  matchFont,
  Oval,
  PaintStyle,
  Path,
  Picture,
  Rect,
  type SkCanvas,
  type SkPicture,
  Skia,
  StrokeCap,
  StrokeJoin,
  Text as SkiaText,
  useCanvasRef,
  useImage,
  vec
} from "@shopify/react-native-skia";

import {
  BRUSHES,
  CANVAS_ASPECT_RATIO,
  COLORS,
  createDefaultLayers,
  createFrame,
  DEFAULT_FRAME_DURATION_MS,
  TEXTURES
} from "../constants";
import { bytesToBase64, encodeGif, type RgbaFrame } from "../gif";
import { makeId } from "../ids";
import {
  copyImportAsync,
  exportPath,
  loopExportPath,
  previewPath,
  spaceAssetPath,
  writePng,
  writeText
} from "../storage";
import { makeSpaceAssetId, upsertSpaceAsset } from "../paintSpace";
import type {
  BrushId,
  BrushSettings,
  DrawPoint,
  DrawingProject,
  FillItem,
  Frame,
  ImageItem,
  Layer,
  LayerItem,
  LoopFramePreview,
  ShapeItem,
  ShapeKind,
  SpaceAsset,
  SprayDot,
  Stroke,
  StrokeItem,
  StudioTool,
  TextItem,
  TextureId
} from "../types";
import { IconButton } from "./IconButton";

type Props = {
  calmMode: boolean;
  // Studio-tier brushes/papers (Glow, Night) unlock via owning the Creator
  // Brushes pack (the "studio" entitlement). A locked tap routes to the Store.
  hasStudioTier: boolean;
  project: DrawingProject;
  settings: BrushSettings;
  onBack: () => void;
  onOpenSettings: () => void;
  onOpenStore: () => void;
  onOpenPaintSpace: () => void;
  onProjectChange: (project: DrawingProject) => void;
  onSettingsChange: (settings: BrushSettings) => void;
  // Apply flow: a sticker selected from the Paint Space to drop on the canvas.
  pendingSticker?: { uri: string; width: number; height: number } | null;
  onStickerConsumed?: () => void;
};

type CanvasSize = {
  width: number;
  height: number;
};

const MIN_CANVAS_WIDTH = 240;

// M4: hard cap on spray dots per stroke. Without this a long spray drag can
// accumulate tens of thousands of dots, each a Skia sub-path, blowing up both
// the live path rebuild cost and the serialized size.
const MAX_SPRAY_DOTS = 3000;

const TOOLS: Array<{ id: StudioTool; label: string }> = [
  { id: "brush", label: "Brush" },
  { id: "eraser", label: "Eraser" },
  { id: "fill", label: "Fill" },
  { id: "rect", label: "Rect" },
  { id: "ellipse", label: "Oval" },
  { id: "line", label: "Line" },
  { id: "text", label: "Text" }
];

// matchFont uses platform/system fonts so no font asset is required, which keeps
// text rendering Android-safe in Skia 2.6.2. On Android "sans-serif" is the
// guaranteed system family (matchFont falls back to it anyway), so this is the
// Android-safe choice.
const baseFontStyle = {
  fontFamily: Platform.select({ ios: "Helvetica", android: "sans-serif", default: "serif" }) ?? "serif",
  fontStyle: "normal" as const,
  fontWeight: "bold" as const
};

// M13: matchFont was called per TextItem with no cache, so N text items =>
// N font objects (and re-creation on every render). Share one font per size
// across all text items via a module-level cache keyed by font size.
const fontCache = new Map<number, ReturnType<typeof matchFont>>();

function getSharedFont(size: number) {
  const cached = fontCache.get(size);
  if (cached) {
    return cached;
  }
  const font = matchFont({ ...baseFontStyle, fontSize: size });
  fontCache.set(size, font);
  return font;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function makePoint(x: number, y: number, settings: BrushSettings): DrawPoint {
  const jitter = 1 + (Math.random() * 2 - 1) * settings.variation;
  return {
    x,
    y,
    size: Math.max(1, settings.size * jitter)
  };
}

function makeSprayDots(point: DrawPoint): SprayDot[] {
  const dots = clamp(Math.floor(point.size * 1.4), 10, 72);
  return Array.from({ length: dots }, () => {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * point.size;
    return {
      x: point.x + Math.cos(angle) * radius,
      y: point.y + Math.sin(angle) * radius,
      radius: Math.max(0.8, Math.random() * 2.4)
    };
  });
}

function pointSpacing(settings: BrushSettings) {
  if (settings.brush === "spray") {
    return Math.max(7, settings.size * 0.36);
  }

  if (settings.tool === "eraser") {
    return Math.max(4, settings.size * 0.22);
  }

  if (settings.brush === "pencil") {
    return Math.max(2, settings.size * 0.1);
  }

  return Math.max(3, settings.size * 0.14);
}

function makePath(points: DrawPoint[]) {
  const path = Skia.Path.Make();
  if (points.length === 0) {
    return path;
  }

  path.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const midX = (previous.x + current.x) / 2;
    const midY = (previous.y + current.y) / 2;
    path.quadTo(previous.x, previous.y, midX, midY);
  }
  return path;
}

function makeSprayPath(dots: SprayDot[]) {
  const path = Skia.Path.Make();

  for (const dot of dots) {
    path.addCircle(dot.x, dot.y, dot.radius);
  }

  return path;
}

// --- Imperative drawing (M2/M3) ---------------------------------------------
// Committed stroke / shape / fill items are flattened into a single cached
// SkPicture per contiguous run (see LayerCanvasItems below) instead of mounting
// one React-managed Skia node per item. These helpers replicate exactly what
// the declarative StrokeNode / ShapeNode render, but draw straight onto an
// SkCanvas so the whole run collapses to one node Skia repaints.

function strokePaint(color: string, opacity: number, width: number, style: PaintStyle, blend?: BlendMode) {
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  paint.setColor(Skia.Color(color));
  paint.setAlphaf(clamp(opacity, 0, 1));
  paint.setStyle(style);
  if (style === PaintStyle.Stroke) {
    paint.setStrokeWidth(width);
    paint.setStrokeCap(StrokeCap.Round);
    paint.setStrokeJoin(StrokeJoin.Round);
  }
  if (blend !== undefined) {
    paint.setBlendMode(blend);
  }
  return paint;
}

function drawStroke(canvas: SkCanvas, stroke: Stroke, paperBackground: string) {
  if (stroke.brush === "spray") {
    const path = makeSprayPath(stroke.sprayDots ?? []);
    canvas.drawPath(path, strokePaint(stroke.color, stroke.opacity, 0, PaintStyle.Fill));
    return;
  }

  const path = makePath(stroke.points);

  if (stroke.brush === "marker") {
    canvas.drawPath(path, strokePaint(stroke.color, stroke.opacity, stroke.size, PaintStyle.Stroke));
    return;
  }

  if (stroke.brush === "pencil") {
    canvas.drawPath(
      path,
      strokePaint(stroke.color, stroke.opacity * 0.72, Math.max(1, stroke.size * 0.62), PaintStyle.Stroke)
    );
    return;
  }

  if (stroke.brush === "eraser") {
    // M9: truly cut pixels with a clear blend instead of painting opaque paper.
    // The color/opacity are irrelevant under BlendMode.Clear; only the geometry
    // matters. This is isolated to the layer because each layer is composited as
    // its own offscreen group (see the layer <Group layer> in the render tree),
    // so the clear removes pixels from THIS layer only and the marks vanish on a
    // transparent / sticker / GIF export rather than becoming paper-colored blobs.
    canvas.drawPath(
      path,
      strokePaint("#000000", 1, stroke.size * 1.35, PaintStyle.Stroke, BlendMode.Clear)
    );
    return;
  }

  if (stroke.brush === "glow") {
    canvas.drawPath(path, strokePaint(stroke.color, stroke.opacity * 0.34, stroke.size * 1.6, PaintStyle.Stroke));
    canvas.drawPath(path, strokePaint(stroke.color, stroke.opacity * 0.84, stroke.size * 0.82, PaintStyle.Stroke));
    canvas.drawPath(path, strokePaint("#ffffff", stroke.opacity * 0.36, Math.max(1, stroke.size * 0.22), PaintStyle.Stroke));
    return;
  }

  // "paint" brush: a single stroked path. The old per-point Circle decoration
  // (up to 24 nodes/stroke) is dropped entirely (M2).
  canvas.drawPath(path, strokePaint(stroke.color, stroke.opacity * 0.82, stroke.size * 1.08, PaintStyle.Stroke));
}

function drawShape(canvas: SkCanvas, shape: ShapeItem) {
  if (shape.shape === "line") {
    const paint = strokePaint(shape.color, shape.opacity, shape.size, PaintStyle.Stroke);
    canvas.drawLine(shape.startX, shape.startY, shape.endX, shape.endY, paint);
    return;
  }

  const x = Math.min(shape.startX, shape.endX);
  const y = Math.min(shape.startY, shape.endY);
  const width = Math.abs(shape.endX - shape.startX);
  const height = Math.abs(shape.endY - shape.startY);
  const style = shape.filled ? PaintStyle.Fill : PaintStyle.Stroke;
  const paint = strokePaint(shape.color, shape.opacity, shape.size, style);
  const rect = Skia.XYWHRect(x, y, width, height);

  if (shape.shape === "rect") {
    canvas.drawRect(rect, paint);
  } else {
    canvas.drawOval(rect, paint);
  }
}

function drawFill(canvas: SkCanvas, color: string, opacity: number, canvasWidth: number, canvasHeight: number) {
  canvas.drawRect(Skia.XYWHRect(0, 0, canvasWidth, canvasHeight), strokePaint(color, opacity, 0, PaintStyle.Fill));
}

// True for the item kinds that can be flattened into an SkPicture. Image and
// text items need async decode / font resources, so they stay declarative.
function isPictureItem(item: LayerItem): item is StrokeItem | ShapeItem | FillItem {
  return item.kind === "stroke" || item.kind === "shape" || item.kind === "fill";
}

type StrokeNodeProps = {
  paperBackground: string;
  stroke: Stroke;
};

const StrokeNode = memo(function StrokeNode({ stroke, paperBackground }: StrokeNodeProps) {
  const path = useMemo(() => makePath(stroke.points), [stroke.points, stroke.points.length]);
  const sprayPath = useMemo(
    () => makeSprayPath(stroke.sprayDots ?? []),
    [stroke.sprayDots, stroke.sprayDots?.length]
  );

  if (stroke.brush === "marker") {
    return (
      <Path
        path={path}
        color={stroke.color}
        opacity={stroke.opacity}
        strokeCap="round"
        strokeJoin="round"
        strokeWidth={stroke.size}
        style="stroke"
      />
    );
  }

  if (stroke.brush === "pencil") {
    return (
      <Path
        path={path}
        color={stroke.color}
        opacity={stroke.opacity * 0.72}
        strokeCap="round"
        strokeJoin="round"
        strokeWidth={Math.max(1, stroke.size * 0.62)}
        style="stroke"
      />
    );
  }

  if (stroke.brush === "spray") {
    return (
      <Path path={sprayPath} color={stroke.color} opacity={stroke.opacity} />
    );
  }

  if (stroke.brush === "eraser") {
    // M9: clear blend cuts pixels from the (offscreen) layer group rather than
    // painting opaque paper, so live preview matches the committed picture and
    // erased regions stay transparent on export. Color is ignored under Clear.
    return (
      <Path
        blendMode="clear"
        path={path}
        color="#000000"
        opacity={1}
        strokeCap="round"
        strokeJoin="round"
        strokeWidth={stroke.size * 1.35}
        style="stroke"
      />
    );
  }

  if (stroke.brush === "glow") {
    return (
      <Group>
        <Path
          path={path}
          color={stroke.color}
          opacity={stroke.opacity * 0.34}
          strokeCap="round"
          strokeJoin="round"
          strokeWidth={stroke.size * 1.6}
          style="stroke"
        />
        <Path
          path={path}
          color={stroke.color}
          opacity={stroke.opacity * 0.84}
          strokeCap="round"
          strokeJoin="round"
          strokeWidth={stroke.size * 0.82}
          style="stroke"
        />
        <Path
          path={path}
          color="#ffffff"
          opacity={stroke.opacity * 0.36}
          strokeCap="round"
          strokeJoin="round"
          strokeWidth={Math.max(1, stroke.size * 0.22)}
          style="stroke"
        />
      </Group>
    );
  }

  // "paint" brush: a single stroked path. The old per-point Circle decoration
  // (up to 24 mounted nodes per stroke) is dropped to bound node growth (M2).
  return (
    <Path
      path={path}
      color={stroke.color}
      opacity={stroke.opacity * 0.82}
      strokeCap="round"
      strokeJoin="round"
      strokeWidth={stroke.size * 1.08}
      style="stroke"
    />
  );
}, (previous, next) => previous.stroke === next.stroke && previous.paperBackground === next.paperBackground);

type ShapeNodeProps = {
  shape: ShapeItem;
};

const ShapeNode = memo(function ShapeNode({ shape }: ShapeNodeProps) {
  const x = Math.min(shape.startX, shape.endX);
  const y = Math.min(shape.startY, shape.endY);
  const width = Math.abs(shape.endX - shape.startX);
  const height = Math.abs(shape.endY - shape.startY);

  if (shape.shape === "line") {
    return (
      <Line
        color={shape.color}
        opacity={shape.opacity}
        p1={vec(shape.startX, shape.startY)}
        p2={vec(shape.endX, shape.endY)}
        strokeCap="round"
        strokeWidth={shape.size}
        style="stroke"
      />
    );
  }

  if (shape.shape === "rect") {
    return (
      <Rect
        color={shape.color}
        height={height}
        opacity={shape.opacity}
        strokeWidth={shape.size}
        style={shape.filled ? "fill" : "stroke"}
        width={width}
        x={x}
        y={y}
      />
    );
  }

  return (
    <Oval
      color={shape.color}
      height={height}
      opacity={shape.opacity}
      strokeWidth={shape.size}
      style={shape.filled ? "fill" : "stroke"}
      width={width}
      x={x}
      y={y}
    />
  );
});

type LayerItemsProps = {
  items: LayerItem[];
  paperBackground: string;
  canvasWidth: number;
  canvasHeight: number;
};

// A render block is either a cached SkPicture flattening a contiguous run of
// stroke/shape/fill items (one Skia node total), or a single declarative
// image/text item that needs a hook-driven resource.
type RenderBlock =
  | { type: "picture"; key: string; items: Array<StrokeItem | ShapeItem | FillItem> }
  | { type: "element"; key: string; item: ImageItem | TextItem };

// M2 + M3: flatten committed stroke/shape/fill items per contiguous run into a
// single memoized SkPicture so Skia repaints one node per run rather than one
// per item, and the live stroke (a sibling node) no longer forces a re-walk of
// every committed mark each frame. Image/text items stay declarative (they need
// useImage / matchFont) and preserve z-order by splitting the run list.
const LayerItemsNode = memo(function LayerItemsNode({ items, paperBackground, canvasWidth, canvasHeight }: LayerItemsProps) {
  const blocks = useMemo<RenderBlock[]>(() => {
    const result: RenderBlock[] = [];
    let run: Array<StrokeItem | ShapeItem | FillItem> = [];
    const flushRun = () => {
      if (run.length > 0) {
        result.push({ type: "picture", key: `pic-${run[0].id}`, items: run });
        run = [];
      }
    };
    for (const item of items) {
      if (isPictureItem(item)) {
        run.push(item);
      } else {
        flushRun();
        result.push({ type: "element", key: item.id, item });
      }
    }
    flushRun();
    return result;
  }, [items]);

  return (
    <>
      {blocks.map((block) => {
        if (block.type === "element") {
          if (block.item.kind === "image") {
            return <ImageItemNode item={block.item} key={block.key} />;
          }
          return <TextNode item={block.item} key={block.key} />;
        }
        return (
          <PictureBlock
            canvasHeight={canvasHeight}
            canvasWidth={canvasWidth}
            items={block.items}
            key={block.key}
            paperBackground={paperBackground}
          />
        );
      })}
    </>
  );
});

type PictureBlockProps = {
  items: Array<StrokeItem | ShapeItem | FillItem>;
  paperBackground: string;
  canvasWidth: number;
  canvasHeight: number;
};

// Builds (and memoizes) one SkPicture for a contiguous run of flattenable items.
// Recomputed only when the run's items array, the paper color, or the canvas
// size changes — not on every live-stroke frame.
const PictureBlock = memo(function PictureBlock({ items, paperBackground, canvasWidth, canvasHeight }: PictureBlockProps) {
  const picture = useMemo<SkPicture>(
    () =>
      createPicture(
        (canvas) => {
          for (const item of items) {
            if (item.kind === "stroke") {
              drawStroke(canvas, item.stroke, paperBackground);
            } else if (item.kind === "shape") {
              drawShape(canvas, item);
            } else {
              drawFill(canvas, item.color, item.opacity, canvasWidth, canvasHeight);
            }
          }
        },
        Skia.XYWHRect(0, 0, canvasWidth, canvasHeight)
      ),
    [items, paperBackground, canvasWidth, canvasHeight]
  );

  return <Picture picture={picture} />;
});

type ImageItemNodeProps = {
  item: ImageItem;
};

function ImageItemNode({ item }: ImageItemNodeProps) {
  // M13: guard against an empty uri (e.g. a sticker import that hasn't resolved
  // a path yet) so useImage isn't handed "" to decode.
  const image = useImage(item.uri || null);
  if (!image) {
    return null;
  }
  return (
    <SkiaImage
      fit="contain"
      height={item.height}
      image={image}
      opacity={item.opacity}
      width={item.width}
      x={item.x}
      y={item.y}
    />
  );
}

type TextNodeProps = {
  item: TextItem;
};

function TextNode({ item }: TextNodeProps) {
  const font = useMemo(() => getSharedFont(item.size), [item.size]);
  // Skia draws text from the baseline; nudge down so the tap point is roughly the top.
  return <SkiaText color={item.color} font={font} opacity={item.opacity} text={item.text} x={item.x} y={item.y + item.size} />;
}

// M14: the in-progress stroke/shape used to live in StudioScreen's own state, so
// each rAF tick (~60/s) re-rendered the ENTIRE studio body (toolbars, layer list,
// frame strip). This component owns the live-stroke/shape state itself and the
// parent drives it imperatively through a ref, so only this tiny node subtree
// reconciles per frame; the chrome doesn't. The rAF coalescing still happens in
// the parent's scheduleLiveStrokeRender, which now calls setStroke here.
export type LiveStrokeHandle = {
  setStroke: (stroke: Stroke | null) => void;
  setShape: (shape: ShapeItem | null) => void;
};

type LiveStrokeLayerProps = {
  paperBackground: string;
};

const LiveStrokeLayer = forwardRef<LiveStrokeHandle, LiveStrokeLayerProps>(function LiveStrokeLayer(
  { paperBackground },
  ref
) {
  const [stroke, setStroke] = useState<Stroke | null>(null);
  const [shape, setShape] = useState<ShapeItem | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      setStroke,
      setShape
    }),
    []
  );

  return (
    <>
      {stroke ? <StrokeNode paperBackground={paperBackground} stroke={stroke} /> : null}
      {shape ? <ShapeNode shape={shape} /> : null}
    </>
  );
});

export function StudioScreen({
  calmMode,
  hasStudioTier,
  project,
  settings,
  onBack,
  onOpenSettings,
  onOpenStore,
  onOpenPaintSpace,
  onProjectChange,
  onSettingsChange,
  pendingSticker,
  onStickerConsumed
}: Props) {
  const canvasRef = useCanvasRef();
  const linenImage = useImage(require("../../assets/linen.png"));
  const canvasImage = useImage(require("../../assets/canvas.png"));
  // M13: pass null (not "") when there is no import so Skia never tries to decode
  // an empty path.
  const importedImage = useImage(project.importedImageUri ?? null);
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ width: MIN_CANVAS_WIDTH, height: MIN_CANVAS_WIDTH / CANVAS_ASPECT_RATIO });
  const [exporting, setExporting] = useState(false);
  // When set, the canvas renders ONLY this frame's layers (no paper/texture/import)
  // for one render so we can snapshot it — used by GIF export and loop saving.
  const [exportFrameId, setExportFrameId] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [renameLayer, setRenameLayer] = useState<{ id: string; value: string } | null>(null);
  const [textPrompt, setTextPrompt] = useState<{ x: number; y: number; value: string } | null>(null);

  const activeStrokeRef = useRef<Stroke | null>(null);
  const lastPointRef = useRef<DrawPoint | null>(null);
  const shapeStartRef = useRef<{ x: number; y: number } | null>(null);
  // M14: the in-progress shape value lives in a ref (so finishShape can read it
  // without the parent re-rendering each move); the visual is pushed to the
  // isolated <LiveStrokeLayer> imperatively.
  const liveShapeRef = useRef<ShapeItem | null>(null);
  const liveLayerRef = useRef<LiveStrokeHandle | null>(null);
  const rafRef = useRef<number | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // M6: single in-flight export/snapshot guard. Any capture that flips the
  // canvas into export mode (transparent PNG, per-frame snapshot, GIF) must
  // hold this so two captures can't run at once and grab the wrong scene. Also
  // used to stop the debounced preview snapshot from racing an export.
  const exportInFlightRef = useRef(false);

  const textureImage = settings.texture === "linen" ? linenImage : settings.texture === "canvas" ? canvasImage : null;
  const textureMeta = TEXTURES.find((texture) => texture.id === settings.texture) ?? TEXTURES[0];
  const paperBackground = textureMeta.background;

  const [isPlaying, setIsPlaying] = useState(false);
  const [previewFrameIndex, setPreviewFrameIndex] = useState(0);
  const playTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Frame model -----------------------------------------------------------
  // Each frame owns its own layer stack. The studio edits the ACTIVE frame's
  // layers; all the existing layer/tool/undo logic reads & writes through it.
  const frames: Frame[] = useMemo(() => {
    if (project.frames && project.frames.length > 0) {
      return project.frames;
    }
    // Defensive fallback for an unmigrated project (should not happen post-load).
    const layers = project.layers && project.layers.length > 0 ? project.layers : createDefaultLayers();
    return [
      {
        id: "frame-fallback",
        durationMs: DEFAULT_FRAME_DURATION_MS,
        layers,
        activeLayerId: project.activeLayerId && layers.some((l) => l.id === project.activeLayerId) ? project.activeLayerId : layers[0].id
      }
    ];
  }, [project.activeLayerId, project.frames, project.layers]);

  const activeFrameId = useMemo(() => {
    if (project.activeFrameId && frames.some((frame) => frame.id === project.activeFrameId)) {
      return project.activeFrameId;
    }
    return frames[0]?.id;
  }, [frames, project.activeFrameId]);

  const activeFrameIndex = useMemo(
    () => Math.max(0, frames.findIndex((frame) => frame.id === activeFrameId)),
    [activeFrameId, frames]
  );

  const activeFrame = useMemo(
    () => frames.find((frame) => frame.id === activeFrameId) ?? frames[0],
    [activeFrameId, frames]
  );

  const layers: Layer[] = useMemo(() => {
    if (activeFrame?.layers && activeFrame.layers.length > 0) {
      return activeFrame.layers;
    }
    return createDefaultLayers();
  }, [activeFrame]);

  const activeLayerId = useMemo(() => {
    if (activeFrame?.activeLayerId && layers.some((layer) => layer.id === activeFrame.activeLayerId)) {
      return activeFrame.activeLayerId;
    }
    return layers[0]?.id;
  }, [activeFrame, layers]);

  const activeLayer = useMemo(
    () => layers.find((layer) => layer.id === activeLayerId) ?? layers[0],
    [activeLayerId, layers]
  );

  const latestProject = useMemo<DrawingProject>(
    () => ({
      ...project,
      texture: settings.texture,
      frames,
      activeFrameId
    }),
    [activeFrameId, frames, project, settings.texture]
  );

  // M7: every mutation must build on the FRESHEST committed project, not on a
  // render-time closure snapshot. Two commits in the same tick (e.g. a sticker
  // apply landing alongside a stroke finish) would otherwise both read the same
  // stale `latestProject` and the second would clobber the first, dropping an
  // item. This ref always holds the latest project we know about — updated on
  // every render from the incoming props AND synchronously on every local commit
  // (commitProject) so the next mutation in the same tick sees the prior one.
  const latestProjectRef = useRef<DrawingProject>(latestProject);
  latestProjectRef.current = latestProject;

  // Write a layer stack (and optional active layer) back into the active frame
  // of the freshest project (M7: reads the ref, not the render snapshot).
  const writeActiveFrameLayers = useCallback(
    (nextLayers: Layer[], nextActiveLayerId?: string): DrawingProject => {
      const base = latestProjectRef.current;
      const nextFrames = base.frames.map((frame) => {
        if (frame.id !== activeFrameId) {
          return frame;
        }
        const activeStillExists = nextLayers.some(
          (layer) => layer.id === (nextActiveLayerId ?? frame.activeLayerId)
        );
        const resolvedActive = activeStillExists
          ? nextActiveLayerId ?? frame.activeLayerId
          : nextLayers[0]?.id;
        return { ...frame, layers: nextLayers, activeLayerId: resolvedActive };
      });
      return { ...base, frames: nextFrames, updatedAt: Date.now() };
    },
    [activeFrameId]
  );

  const canDraw = !!activeLayer && activeLayer.visible && !activeLayer.locked;

  const updateSettings = useCallback(
    (patch: Partial<BrushSettings>) => {
      onSettingsChange({ ...settings, ...patch });
    },
    [onSettingsChange, settings]
  );

  const captureToUri = useCallback(
    async (uri: string) => {
      const image = canvasRef.current?.makeImageSnapshot();
      // M11: encode then ALWAYS release the native snapshot. This path runs on
      // the debounced preview save (~every 420ms while drawing) plus every PNG /
      // share / photos / template export, so a leaked SkImage here accumulates
      // native memory fast.
      try {
        const base64 = image?.encodeToBase64();
        if (!base64) {
          throw new Error("The painting is still getting ready.");
        }
        await writePng(uri, base64);
        return uri;
      } finally {
        image?.dispose();
      }
    },
    [canvasRef]
  );

  // Forward ref to schedulePreviewSave so savePreview's failure path can retry
  // the preview without referencing a hook declared after it (M17).
  const reschedulePreviewRef = useRef<((project: DrawingProject) => void) | null>(null);

  const savePreview = useCallback(
    async (nextProject: DrawingProject) => {
      // M6: never snapshot for a preview while an export capture owns the canvas
      // (it has flipped the background/frame). Skip; the next commit reschedules.
      if (exportInFlightRef.current) {
        return;
      }
      try {
        const uri = await captureToUri(previewPath(nextProject.id));
        onProjectChange({ ...nextProject, previewUri: `${uri}?updated=${Date.now()}` });
      } catch {
        // M17: the project body was already persisted on commit, so do NOT fire
        // another full onProjectChange here (it was a redundant whole-project
        // save). Only the PREVIEW snapshot failed — just retry it later.
        reschedulePreviewRef.current?.(nextProject);
      }
    },
    [captureToUri, onProjectChange]
  );

  const schedulePreviewSave = useCallback(
    (nextProject: DrawingProject) => {
      if (previewTimerRef.current) {
        clearTimeout(previewTimerRef.current);
      }

      previewTimerRef.current = setTimeout(() => {
        previewTimerRef.current = null;
        void savePreview(nextProject);
      }, 420);
    },
    [savePreview]
  );

  reschedulePreviewRef.current = schedulePreviewSave;

  // M7: centralized commit. Advances the freshest-project ref SYNCHRONOUSLY so a
  // second mutation in the same tick chains off the first, then notifies the
  // parent and schedules the debounced preview snapshot.
  const commitProject = useCallback(
    (nextProject: DrawingProject) => {
      latestProjectRef.current = nextProject;
      onProjectChange(nextProject);
      schedulePreviewSave(nextProject);
    },
    [onProjectChange, schedulePreviewSave]
  );

  // Commit a single new item to the active layer of the active frame. M7: read
  // the active frame's CURRENT layers from the freshest project ref so two
  // commits in the same tick (sticker apply + stroke finish) chain instead of
  // one clobbering the other.
  const appendItemToActiveLayer = useCallback(
    (item: LayerItem, position: "top" | "bottom" = "top") => {
      const base = latestProjectRef.current;
      const frame = base.frames.find((f) => f.id === activeFrameId) ?? base.frames[0];
      const baseLayers = frame?.layers ?? layers;
      const targetLayerId =
        frame?.activeLayerId && baseLayers.some((l) => l.id === frame.activeLayerId)
          ? frame.activeLayerId
          : baseLayers[0]?.id;
      const nextLayers = baseLayers.map((layer) => {
        if (layer.id !== targetLayerId) {
          return layer;
        }
        const items = position === "bottom" ? [item, ...layer.items] : [...layer.items, item];
        return { ...layer, items };
      });
      commitProject(writeActiveFrameLayers(nextLayers));
    },
    [activeFrameId, commitProject, layers, writeActiveFrameLayers]
  );

  const updateLayers = useCallback(
    (nextLayers: Layer[], nextActiveId?: string) => {
      commitProject(writeActiveFrameLayers(nextLayers, nextActiveId));
    },
    [commitProject, writeActiveFrameLayers]
  );

  useEffect(() => {
    return () => {
      if (previewTimerRef.current) {
        clearTimeout(previewTimerRef.current);
      }
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
      if (playTimerRef.current) {
        clearTimeout(playTimerRef.current);
      }
    };
  }, []);

  const scheduleLiveStrokeRender = useCallback(() => {
    if (rafRef.current !== null) {
      return;
    }
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      // M14: push the live stroke into the isolated layer; the parent never
      // re-renders for this. rAF coalescing is preserved.
      liveLayerRef.current?.setStroke(
        activeStrokeRef.current
          ? {
              ...activeStrokeRef.current,
              points: activeStrokeRef.current.points,
              sprayDots: activeStrokeRef.current.sprayDots
            }
          : null
      );
    });
  }, []);

  const addStrokePoint = useCallback(
    (x: number, y: number) => {
      const stroke = activeStrokeRef.current;
      if (!stroke) {
        return;
      }

      const point = makePoint(clamp(x, 0, canvasSize.width), clamp(y, 0, canvasSize.height), settings);
      const previous = lastPointRef.current;
      const points: DrawPoint[] = [];

      if (previous) {
        const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
        const steps = Math.max(1, Math.floor(distance / pointSpacing(settings)));
        for (let index = 1; index <= steps; index += 1) {
          const t = index / steps;
          points.push(
            makePoint(
              previous.x + (point.x - previous.x) * t,
              previous.y + (point.y - previous.y) * t,
              settings
            )
          );
        }
      } else {
        points.push(point);
      }

      stroke.points.push(...points);
      if (stroke.brush === "spray") {
        const sprayDots = stroke.sprayDots ?? [];
        // M4: stop accumulating once the per-stroke cap is hit. Bounds both the
        // live path rebuild cost and the serialized payload.
        for (const sprayedPoint of points) {
          if (sprayDots.length >= MAX_SPRAY_DOTS) {
            break;
          }
          const dots = makeSprayDots(sprayedPoint);
          const room = MAX_SPRAY_DOTS - sprayDots.length;
          sprayDots.push(...(dots.length > room ? dots.slice(0, room) : dots));
        }
        stroke.sprayDots = sprayDots;
      }

      lastPointRef.current = point;
      scheduleLiveStrokeRender();
    },
    [canvasSize.height, canvasSize.width, scheduleLiveStrokeRender, settings]
  );

  const finishStroke = useCallback(() => {
    const stroke = activeStrokeRef.current;
    activeStrokeRef.current = null;
    lastPointRef.current = null;
    liveLayerRef.current?.setStroke(null);

    if (!stroke || stroke.points.length === 0) {
      return;
    }

    const item: StrokeItem = { kind: "stroke", id: stroke.id, stroke };
    appendItemToActiveLayer(item);
  }, [appendItemToActiveLayer]);

  const startStroke = useCallback(
    (x: number, y: number) => {
      const brush: BrushId = settings.tool === "eraser" ? "eraser" : settings.brush;
      const stroke: Stroke = {
        id: makeId("stroke"),
        brush,
        color: settings.color,
        opacity: settings.opacity,
        size: settings.size,
        variation: settings.variation,
        points: [],
        sprayDots: brush === "spray" ? [] : undefined
      };
      activeStrokeRef.current = stroke;
      lastPointRef.current = null;
      addStrokePoint(x, y);
    },
    [addStrokePoint, settings]
  );

  // --- Shape / line tool -----------------------------------------------------
  const startShape = useCallback((x: number, y: number) => {
    shapeStartRef.current = { x, y };
  }, []);

  const moveShape = useCallback(
    (x: number, y: number) => {
      const start = shapeStartRef.current;
      if (!start) {
        return;
      }
      const shapeKind: ShapeKind =
        settings.tool === "rect" ? "rect" : settings.tool === "ellipse" ? "ellipse" : "line";
      const next: ShapeItem = {
        kind: "shape",
        id: "live-shape",
        shape: shapeKind,
        startX: start.x,
        startY: start.y,
        endX: clamp(x, 0, canvasSize.width),
        endY: clamp(y, 0, canvasSize.height),
        color: settings.color,
        size: settings.size,
        opacity: settings.opacity,
        filled: settings.shapeFilled
      };
      // M14: keep the value in a ref for finishShape and push the visual into the
      // isolated layer; the parent chrome doesn't re-render on shape drags.
      liveShapeRef.current = next;
      liveLayerRef.current?.setShape(next);
    },
    [canvasSize.height, canvasSize.width, settings.color, settings.opacity, settings.shapeFilled, settings.size, settings.tool]
  );

  const finishShape = useCallback(() => {
    const live = liveShapeRef.current;
    shapeStartRef.current = null;
    liveShapeRef.current = null;
    liveLayerRef.current?.setShape(null);
    if (!live) {
      return;
    }
    const dx = Math.abs(live.endX - live.startX);
    const dy = Math.abs(live.endY - live.startY);
    if (dx < 2 && dy < 2) {
      return;
    }
    appendItemToActiveLayer({ ...live, id: makeId("shape") });
  }, [appendItemToActiveLayer]);

  // --- Fill tool -------------------------------------------------------------
  const placeFill = useCallback(() => {
    const fill: FillItem = {
      kind: "fill",
      id: makeId("fill"),
      color: settings.color,
      opacity: settings.opacity
    };
    appendItemToActiveLayer(fill, "bottom");
  }, [appendItemToActiveLayer, settings.color, settings.opacity]);

  // --- Text tool -------------------------------------------------------------
  const commitText = useCallback(
    (text: string, x: number, y: number) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      const item: TextItem = {
        kind: "text",
        id: makeId("text"),
        text: trimmed,
        x,
        y,
        color: settings.color,
        size: Math.max(12, settings.size),
        opacity: settings.opacity
      };
      appendItemToActiveLayer(item);
    },
    [appendItemToActiveLayer, settings.color, settings.opacity, settings.size]
  );

  const promptForText = useCallback(
    (x: number, y: number) => {
      if (Platform.OS === "ios" && typeof Alert.prompt === "function") {
        Alert.prompt("Add text", "Type the words to place on your art.", [
          { text: "Cancel", style: "cancel" },
          { text: "Add", onPress: (value?: string) => commitText(value ?? "", x, y) }
        ]);
        return;
      }
      // Android-safe fallback: a small modal with a TextInput.
      setTextPrompt({ x, y, value: "" });
    },
    [commitText]
  );

  const handleTap = useCallback(
    (x: number, y: number) => {
      if (!canDraw) {
        return;
      }
      const cx = clamp(x, 0, canvasSize.width);
      const cy = clamp(y, 0, canvasSize.height);
      if (settings.tool === "fill") {
        placeFill();
      } else if (settings.tool === "text") {
        promptForText(cx, cy);
      }
    },
    [canDraw, canvasSize.height, canvasSize.width, placeFill, promptForText, settings.tool]
  );

  // RNGH replaces the old PanResponder (finding M10). `.maxPointers(1)` means a
  // second finger or a resting palm can never feed coordinates into the active
  // stroke — the gesture simply won't recognize a 2+ pointer interaction — so the
  // manual `touches.length > 1` JS guards are gone. With NO reanimated installed,
  // these callbacks run on the JS thread by default, so the existing JS stroke
  // logic / refs / state setters are called directly (no runOnJS, no worklets).
  //
  // A Pan only activates after movement, so pure taps (fill / text tools) are
  // handled by a separate Tap gesture; the two are composed with Gesture.Race so
  // exactly one wins per interaction. The Pan handles brush/eraser/shape/line.
  //
  // e.x / e.y are LOCAL to the GestureDetector's view (the canvas frame), which
  // is the same coordinate space the old PanResponder's locationX/locationY used;
  // they are clamped to canvasSize exactly as before.
  const pan = useMemo(() => {
    const panGesture = Gesture.Pan()
      .minPointers(1)
      .maxPointers(1)
      // A stroke that briefly leaves the canvas bounds should not be dropped; the
      // points are clamped to canvasSize when added.
      .shouldCancelWhenOutside(false)
      .onBegin((e) => {
        if (!canDraw) {
          return;
        }
        if (settings.tool === "brush" || settings.tool === "eraser") {
          startStroke(e.x, e.y);
        } else if (settings.tool === "rect" || settings.tool === "ellipse" || settings.tool === "line") {
          startShape(clamp(e.x, 0, canvasSize.width), clamp(e.y, 0, canvasSize.height));
        }
      })
      .onUpdate((e) => {
        if (!canDraw) {
          return;
        }
        if (settings.tool === "brush" || settings.tool === "eraser") {
          addStrokePoint(e.x, e.y);
        } else if (settings.tool === "rect" || settings.tool === "ellipse" || settings.tool === "line") {
          moveShape(e.x, e.y);
        }
      })
      .onEnd(() => {
        if (settings.tool === "brush" || settings.tool === "eraser") {
          finishStroke();
        } else if (settings.tool === "rect" || settings.tool === "ellipse" || settings.tool === "line") {
          finishShape();
        }
      })
      // onFinalize fires for every interaction (including a cancelled / failed
      // gesture where onEnd never ran), so it cleans up any dangling active
      // stroke/shape. finishStroke/finishShape are idempotent: with nothing
      // active they no-op, and after a real onEnd the refs are already cleared.
      .onFinalize(() => {
        if (settings.tool === "brush" || settings.tool === "eraser") {
          finishStroke();
        } else if (settings.tool === "rect" || settings.tool === "ellipse" || settings.tool === "line") {
          finishShape();
        }
      });

    // Fill / text are placed on a single tap (no drag). Race so a tap that turns
    // into a drag still goes to the Pan, and a clean tap places the fill/text.
    const tapGesture = Gesture.Tap()
      .maxDuration(400)
      .onEnd((e, success) => {
        if (!success || !canDraw) {
          return;
        }
        if (settings.tool === "fill" || settings.tool === "text") {
          handleTap(e.x, e.y);
        }
      });

    return Gesture.Race(panGesture, tapGesture);
  }, [addStrokePoint, canDraw, canvasSize.height, canvasSize.width, finishShape, finishStroke, handleTap, moveShape, settings.tool, startShape, startStroke]);

  // --- Undo / clear ----------------------------------------------------------
  const undo = useCallback(() => {
    if (!activeLayer || activeLayer.items.length === 0) {
      return;
    }
    const nextLayers = layers.map((layer) =>
      layer.id === activeLayer.id ? { ...layer, items: layer.items.slice(0, -1) } : layer
    );
    updateLayers(nextLayers);
  }, [activeLayer, layers, updateLayers]);

  const clear = useCallback(() => {
    Alert.alert("Clear frame?", "This removes every mark from every layer of the current frame.", [
      { text: "Keep drawing", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => {
          const nextLayers = layers.map((layer) => ({ ...layer, items: [] }));
          updateLayers(nextLayers);
        }
      }
    ]);
  }, [layers, updateLayers]);

  // --- Layer operations ------------------------------------------------------
  const selectLayer = useCallback(
    (id: string) => {
      const base = latestProjectRef.current;
      const nextFrames = base.frames.map((frame) =>
        frame.id === activeFrameId ? { ...frame, activeLayerId: id } : frame
      );
      const next = { ...base, frames: nextFrames };
      latestProjectRef.current = next;
      onProjectChange(next);
    },
    [activeFrameId, onProjectChange]
  );

  const addLayer = useCallback(() => {
    const layer: Layer = {
      id: makeId("layer"),
      name: `Layer ${layers.length + 1}`,
      visible: true,
      locked: false,
      opacity: 1,
      items: []
    };
    const activeIndex = layers.findIndex((item) => item.id === activeLayerId);
    const nextLayers = [...layers];
    nextLayers.splice(activeIndex + 1, 0, layer);
    updateLayers(nextLayers, layer.id);
  }, [activeLayerId, layers, updateLayers]);

  const patchLayer = useCallback(
    (id: string, patch: Partial<Layer>) => {
      const nextLayers = layers.map((layer) => (layer.id === id ? { ...layer, ...patch } : layer));
      updateLayers(nextLayers);
    },
    [layers, updateLayers]
  );

  const duplicateLayer = useCallback(
    (id: string) => {
      const index = layers.findIndex((layer) => layer.id === id);
      if (index < 0) {
        return;
      }
      const source = layers[index];
      const copy: Layer = {
        ...source,
        id: makeId("layer"),
        name: `${source.name} copy`,
        items: source.items.map((item) => ({ ...item, id: makeId(item.kind) }))
      };
      const nextLayers = [...layers];
      nextLayers.splice(index + 1, 0, copy);
      updateLayers(nextLayers, copy.id);
    },
    [layers, updateLayers]
  );

  const deleteLayer = useCallback(
    (id: string) => {
      if (layers.length <= 1) {
        Alert.alert("Keep one layer", "A painting needs at least one layer.");
        return;
      }
      const nextLayers = layers.filter((layer) => layer.id !== id);
      updateLayers(nextLayers, nextLayers[0]?.id);
    },
    [layers, updateLayers]
  );

  const moveLayer = useCallback(
    (id: string, direction: -1 | 1) => {
      const index = layers.findIndex((layer) => layer.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= layers.length) {
        return;
      }
      const nextLayers = [...layers];
      const [moved] = nextLayers.splice(index, 1);
      nextLayers.splice(target, 0, moved);
      updateLayers(nextLayers);
    },
    [layers, updateLayers]
  );

  // Merge a layer DOWN into the one beneath it (lower in the stack / earlier index).
  const mergeDown = useCallback(
    (id: string) => {
      const index = layers.findIndex((layer) => layer.id === id);
      if (index <= 0) {
        Alert.alert("Nothing below", "This is the bottom layer; there is nothing to merge into.");
        return;
      }
      const below = layers[index - 1];
      const above = layers[index];
      const merged: Layer = { ...below, items: [...below.items, ...above.items] };
      const nextLayers = layers.filter((layer) => layer.id !== id);
      nextLayers[index - 1] = merged;
      updateLayers(nextLayers, merged.id);
    },
    [layers, updateLayers]
  );

  // --- Frame operations ------------------------------------------------------
  const commitFrames = useCallback(
    (nextFrames: Frame[], nextActiveFrameId?: string) => {
      const base = latestProjectRef.current;
      const activeStillExists = nextFrames.some(
        (frame) => frame.id === (nextActiveFrameId ?? activeFrameId)
      );
      const resolvedActive = activeStillExists ? nextActiveFrameId ?? activeFrameId : nextFrames[0]?.id;
      commitProject({
        ...base,
        frames: nextFrames,
        activeFrameId: resolvedActive,
        updatedAt: Date.now()
      });
    },
    [activeFrameId, commitProject]
  );

  const selectFrame = useCallback(
    (id: string) => {
      const base = latestProjectRef.current;
      const next = { ...base, activeFrameId: id };
      latestProjectRef.current = next;
      onProjectChange(next);
    },
    [onProjectChange]
  );

  const addFrame = useCallback(() => {
    const frame = createFrame();
    const baseFrames = latestProjectRef.current.frames;
    const index = baseFrames.findIndex((item) => item.id === activeFrameId);
    const nextFrames = [...baseFrames];
    nextFrames.splice(index + 1, 0, frame);
    commitFrames(nextFrames, frame.id);
  }, [activeFrameId, commitFrames]);

  const duplicateFrame = useCallback(() => {
    const baseFrames = latestProjectRef.current.frames;
    const index = baseFrames.findIndex((item) => item.id === activeFrameId);
    if (index < 0) {
      return;
    }
    const source = baseFrames[index];
    // Deep copy: fresh ids on frame, layers, and items.
    const idMap = new Map<string, string>();
    const copiedLayers: Layer[] = source.layers.map((layer) => {
      const newLayerId = makeId("layer");
      idMap.set(layer.id, newLayerId);
      return {
        ...layer,
        id: newLayerId,
        items: layer.items.map((item) => ({ ...item, id: makeId(item.kind) }))
      };
    });
    const copy: Frame = {
      id: makeId("frame"),
      durationMs: source.durationMs,
      layers: copiedLayers,
      activeLayerId: idMap.get(source.activeLayerId) ?? copiedLayers[0]?.id
    };
    const nextFrames = [...baseFrames];
    nextFrames.splice(index + 1, 0, copy);
    commitFrames(nextFrames, copy.id);
  }, [activeFrameId, commitFrames]);

  const deleteFrame = useCallback(
    (id: string) => {
      const baseFrames = latestProjectRef.current.frames;
      if (baseFrames.length <= 1) {
        Alert.alert("Keep one frame", "A loop needs at least one frame.");
        return;
      }
      const nextFrames = baseFrames.filter((frame) => frame.id !== id);
      commitFrames(nextFrames, nextFrames[0]?.id);
    },
    [commitFrames]
  );

  const moveFrame = useCallback(
    (id: string, direction: -1 | 1) => {
      const baseFrames = latestProjectRef.current.frames;
      const index = baseFrames.findIndex((frame) => frame.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= baseFrames.length) {
        return;
      }
      const nextFrames = [...baseFrames];
      const [moved] = nextFrames.splice(index, 1);
      nextFrames.splice(target, 0, moved);
      commitFrames(nextFrames);
    },
    [commitFrames]
  );

  const setFrameDuration = useCallback(
    (durationMs: number) => {
      const nextFrames = latestProjectRef.current.frames.map((frame) =>
        frame.id === activeFrameId ? { ...frame, durationMs } : frame
      );
      commitFrames(nextFrames);
    },
    [activeFrameId, commitFrames]
  );

  const toggleOnionSkin = useCallback(() => {
    const base = latestProjectRef.current;
    const next = { ...base, onionSkin: !base.onionSkin, updatedAt: Date.now() };
    latestProjectRef.current = next;
    onProjectChange(next);
  }, [onProjectChange]);

  // --- Loop preview playback -------------------------------------------------
  useEffect(() => {
    if (playTimerRef.current) {
      clearTimeout(playTimerRef.current);
      playTimerRef.current = null;
    }
    if (!isPlaying || frames.length <= 1) {
      return;
    }
    const current = frames[previewFrameIndex] ?? frames[0];
    playTimerRef.current = setTimeout(() => {
      setPreviewFrameIndex((index) => (index + 1) % frames.length);
    }, Math.max(40, current.durationMs));
    return () => {
      if (playTimerRef.current) {
        clearTimeout(playTimerRef.current);
        playTimerRef.current = null;
      }
    };
  }, [frames, isPlaying, previewFrameIndex]);

  const togglePlay = useCallback(() => {
    setIsPlaying((playing) => {
      if (!playing) {
        setPreviewFrameIndex(activeFrameIndex);
      }
      return !playing;
    });
  }, [activeFrameIndex]);

  // The frame being shown on canvas: during playback it follows the preview
  // cursor; otherwise it is the frame being edited.
  const displayFrameIndex = isPlaying ? previewFrameIndex : activeFrameIndex;
  const displayFrame = frames[displayFrameIndex] ?? activeFrame;
  const onionFrame = displayFrameIndex > 0 ? frames[displayFrameIndex - 1] : null;
  const showOnion = !!latestProject.onionSkin && !isPlaying && !!onionFrame;

  // --- Apply: drop a Paint Space sticker on the active layer -----------------
  useEffect(() => {
    if (!pendingSticker) {
      return;
    }
    // M15: don't size/place the sticker until the canvas has a real laid-out
    // width. Before onLayout fires, canvasSize is still the MIN_CANVAS_WIDTH
    // placeholder, which would size the sticker against the wrong dimensions.
    // The sticker stays queued; once onLayout updates canvasSize this effect
    // re-runs (canvasSize is in the deps) and applies it at the correct size.
    if (canvasSize.width <= MIN_CANVAS_WIDTH) {
      return;
    }
    const maxW = canvasSize.width * 0.6;
    const maxH = canvasSize.height * 0.6;
    const ratio = pendingSticker.height > 0 ? pendingSticker.width / pendingSticker.height : 1;
    let width = maxW;
    let height = width / (ratio || 1);
    if (height > maxH) {
      height = maxH;
      width = height * (ratio || 1);
    }
    const item: ImageItem = {
      kind: "image",
      id: makeId("image"),
      uri: pendingSticker.uri,
      x: (canvasSize.width - width) / 2,
      y: (canvasSize.height - height) / 2,
      width,
      height,
      opacity: 1
    };
    appendItemToActiveLayer(item);
    onStickerConsumed?.();
  }, [appendItemToActiveLayer, canvasSize.height, canvasSize.width, onStickerConsumed, pendingSticker]);

  // --- Import ----------------------------------------------------------------
  const importFromPhotos = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: false,
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1
    });
    if (result.canceled || !result.assets[0]?.uri) {
      return;
    }
    const base = latestProjectRef.current;
    const importedUri = await copyImportAsync(result.assets[0].uri, base.id);
    const nextProject = { ...latestProjectRef.current, importedImageUri: importedUri, updatedAt: Date.now() };
    latestProjectRef.current = nextProject;
    onProjectChange(nextProject);
  }, [onProjectChange]);

  const importFromFiles = useCallback(async () => {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
      type: "image/*"
    });
    if (result.canceled || !result.assets[0]?.uri) {
      return;
    }
    const base = latestProjectRef.current;
    const importedUri = await copyImportAsync(result.assets[0].uri, base.id);
    const nextProject = { ...latestProjectRef.current, importedImageUri: importedUri, updatedAt: Date.now() };
    latestProjectRef.current = nextProject;
    onProjectChange(nextProject);
  }, [onProjectChange]);

  // --- Export ----------------------------------------------------------------
  // captureToUri snapshots whatever the Canvas currently renders. For a
  // transparent export we flip `exporting` on (which drops the paper Rect,
  // texture and import) for one synchronous render, snapshot, then flip back.
  const captureTransparent = useCallback(
    async (uri: string) => {
      if (exportInFlightRef.current) {
        throw new Error("Another export is still running. Please wait for it to finish.");
      }
      exportInFlightRef.current = true;
      setExporting(true);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      try {
        return await captureToUri(uri);
      } finally {
        setExporting(false);
        exportInFlightRef.current = false;
      }
    },
    [captureToUri]
  );

  const exportPng = useCallback(async () => {
    try {
      const uri = await captureToUri(exportPath(latestProject.id));
      Alert.alert("Saved PNG", uri);
    } catch (error) {
      Alert.alert("Export failed", error instanceof Error ? error.message : "Please try again.");
    }
  }, [captureToUri, latestProject.id]);

  const exportTransparentPng = useCallback(async () => {
    try {
      const uri = await captureTransparent(exportPath(latestProject.id));
      const available = await Sharing.isAvailableAsync();
      if (available) {
        await Sharing.shareAsync(uri, { dialogTitle: "Share transparent PNG", mimeType: "image/png" });
      } else {
        Alert.alert("Saved transparent PNG", uri);
      }
    } catch (error) {
      Alert.alert("Export failed", error instanceof Error ? error.message : "Please try again.");
    }
  }, [captureTransparent]);

  const sharePng = useCallback(async () => {
    try {
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        Alert.alert("Sharing unavailable", "This device cannot open the share sheet right now.");
        return;
      }
      const uri = await captureToUri(exportPath(latestProject.id));
      await Sharing.shareAsync(uri, {
        dialogTitle: "Share Happy Paint artwork",
        mimeType: "image/png"
      });
    } catch (error) {
      Alert.alert("Share failed", error instanceof Error ? error.message : "Please try again.");
    }
  }, [captureToUri, latestProject.id]);

  const saveToPhotos = useCallback(async () => {
    try {
      const permission = await MediaLibrary.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Photos permission needed", "Allow photo access to save your painting.");
        return;
      }
      const uri = await captureToUri(exportPath(latestProject.id));
      await MediaLibrary.saveToLibraryAsync(uri);
      Alert.alert("Saved to photos", "Your painting is now in the device photo library.");
    } catch (error) {
      Alert.alert("Save failed", error instanceof Error ? error.message : "Please try again.");
    }
  }, [captureToUri, latestProject.id]);

  // --- Per-frame snapshot helpers (loop export) ------------------------------
  // Render a single frame transparently, snapshot it, and return the SkImage.
  // M6: acquire/release the single in-flight export lock for a whole capture
  // sequence. GIF/loop export snapshot many frames; the lock is held across the
  // entire loop so the preview snapshot (and a second export) can't interleave.
  const withExportLock = useCallback(async <T,>(run: () => Promise<T>): Promise<T> => {
    if (exportInFlightRef.current) {
      throw new Error("Another export is still running. Please wait for it to finish.");
    }
    exportInFlightRef.current = true;
    try {
      return await run();
    } finally {
      exportInFlightRef.current = false;
    }
  }, []);

  // Snapshot a single frame transparently. Assumes the export lock is already
  // held by the caller (it is invoked inside a withExportLock sequence).
  const snapshotFrameImage = useCallback(
    async (frameId: string) => {
      setExporting(true);
      setExportFrameId(frameId);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      try {
        return canvasRef.current?.makeImageSnapshot() ?? null;
      } finally {
        setExportFrameId(null);
        setExporting(false);
      }
    },
    [canvasRef]
  );

  // GIF export. We snapshot every frame, read RGBA pixels via Skia readPixels,
  // and hand them to the self-contained encoder in gif.ts. If pixel reads are
  // unavailable on this Skia build we fall back to a tiled sprite-sheet PNG plus
  // a JSON sidecar of per-frame durations.
  const exportGif = useCallback(async () => {
    if (frames.length < 2) {
      Alert.alert("Add more frames", "A loop needs at least 2 frames. Add a frame in the Loop panel first.");
      return;
    }
    if (exportInFlightRef.current) {
      Alert.alert("Export in progress", "Please wait for the current export to finish.");
      return;
    }
    setBusyLabel("Building GIF...");
    try {
      const rgbaFrames: RgbaFrame[] = [];
      let width = 0;
      let height = 0;
      let pixelReadFailed = false;
      const pngImages: { base64: string }[] = [];

      // M6: hold the export lock for the whole capture sequence so no other
      // capture (preview snapshot or a second export) can grab the canvas while
      // it is flipped into per-frame export mode.
      await withExportLock(async () => {
        for (const frame of frames) {
          const image = await snapshotFrameImage(frame.id);
          if (!image) {
            throw new Error("The painting is still getting ready.");
          }
          const w = image.width();
          const h = image.height();
          width = w;
          height = h;
          // Keep a PNG copy for the sprite-sheet fallback.
          pngImages.push({ base64: image.encodeToBase64() });

          if (!pixelReadFailed) {
            const pixels = image.readPixels(0, 0, {
              width: w,
              height: h,
              // M12: use the proper Skia enums instead of hardcoded literals so a
              // future/platform Skia build can't silently swap channels.
              colorType: ColorType.RGBA_8888,
              alphaType: AlphaType.Unpremul
            });
            if (pixels && pixels instanceof Uint8Array && pixels.length === w * h * 4) {
              rgbaFrames.push({ width: w, height: h, data: pixels, delayMs: frame.durationMs });
            } else {
              pixelReadFailed = true;
            }
          }
          // M6: free the per-frame Skia image immediately so we never hold every
          // frame's native bitmap at once.
          image.dispose();
        }
      });

      if (!pixelReadFailed && rgbaFrames.length === frames.length) {
        // Real GIF path. Encoding yields to the event loop between frames so the
        // UI stays responsive (M6).
        setBusyLabel("Encoding GIF...");
        const bytes = await encodeGif(rgbaFrames);
        const base64 = bytesToBase64(bytes);
        const uri = loopExportPath(latestProject.id, "gif");
        await writePng(uri, base64); // writes base64 to file (encoding-agnostic)
        const available = await Sharing.isAvailableAsync();
        if (available) {
          await Sharing.shareAsync(uri, { dialogTitle: "Share animated GIF", mimeType: "image/gif" });
        } else {
          Alert.alert("Saved GIF", uri);
        }
        return;
      }

      // Sprite-sheet fallback: tile every PNG frame horizontally onto one Skia
      // surface and write per-frame durations as a JSON sidecar.
      const surface = Skia.Surface.MakeOffscreen(width * pngImages.length, height);
      if (!surface) {
        throw new Error("Could not allocate the sprite sheet surface.");
      }
      const canvas = surface.getCanvas();
      for (let i = 0; i < pngImages.length; i += 1) {
        const data = Skia.Data.fromBase64(pngImages[i].base64);
        const img = Skia.Image.MakeImageFromEncoded(data);
        if (img) {
          canvas.drawImage(img, width * i, 0);
          img.dispose();
        }
      }
      surface.flush();
      const sheet = surface.makeImageSnapshot();
      const sheetUri = loopExportPath(latestProject.id, "png");
      const sheetBase64 = sheet.encodeToBase64();
      // M6/M11: release the sprite-sheet surface and snapshot native memory.
      sheet.dispose();
      surface.dispose();
      await writePng(sheetUri, sheetBase64);
      const sidecarUri = `${sheetUri}.json`;
      await writeText(
        sidecarUri,
        JSON.stringify({
          type: "happy-paint-spritesheet",
          frameWidth: width,
          frameHeight: height,
          frames: frames.map((f) => ({ durationMs: f.durationMs }))
        })
      );
      const available = await Sharing.isAvailableAsync();
      if (available) {
        await Sharing.shareAsync(sheetUri, { dialogTitle: "Share sprite sheet", mimeType: "image/png" });
      }
      Alert.alert(
        "GIF unavailable",
        "Raw pixel reading is not supported on this build, so a tiled sprite-sheet PNG plus a durations sidecar were exported instead."
      );
    } catch (error) {
      Alert.alert("GIF export failed", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setBusyLabel(null);
    }
  }, [frames, latestProject.id, snapshotFrameImage, withExportLock]);

  // --- Save to Paint Space ---------------------------------------------------
  const saveStickerToSpace = useCallback(async () => {
    setBusyLabel("Saving sticker...");
    try {
      const id = makeSpaceAssetId();
      const uri = await captureTransparent(spaceAssetPath(id));
      const asset: SpaceAsset = {
        id,
        kind: "sticker",
        title: `${latestProject.title} sticker`,
        payload: { uri, width: Math.round(canvasSize.width), height: Math.round(canvasSize.height) },
        thumbnail: uri,
        previewUri: uri,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await upsertSpaceAsset(asset);
      Alert.alert("Saved to Paint Space", "Your sticker is in the locker.");
    } catch (error) {
      Alert.alert("Save failed", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setBusyLabel(null);
    }
  }, [captureTransparent, canvasSize.height, canvasSize.width, latestProject.title]);

  const saveTemplateToSpace = useCallback(async () => {
    setBusyLabel("Saving template...");
    try {
      const id = makeSpaceAssetId();
      let preview: string | undefined;
      try {
        preview = await captureToUri(spaceAssetPath(id));
      } catch {
        preview = latestProject.previewUri;
      }
      // Deep copy frames so the template is independent of this project.
      const templateFrames: Frame[] = latestProject.frames.map((frame) => ({
        ...frame,
        layers: frame.layers.map((layer) => ({ ...layer, items: layer.items.map((item) => ({ ...item })) }))
      }));
      const asset: SpaceAsset = {
        id,
        kind: "template",
        title: `${latestProject.title} template`,
        payload: { texture: settings.texture, frames: templateFrames, uri: preview },
        thumbnail: preview,
        previewUri: preview,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await upsertSpaceAsset(asset);
      Alert.alert("Saved to Paint Space", "Your template is in the locker.");
    } catch (error) {
      Alert.alert("Save failed", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setBusyLabel(null);
    }
  }, [captureToUri, latestProject.frames, latestProject.previewUri, latestProject.title, settings.texture]);

  const savePaletteToSpace = useCallback(async () => {
    // Selected color first, then the standard swatches as "recent".
    const colors = Array.from(new Set([settings.color, ...COLORS])).slice(0, 12);
    const id = makeSpaceAssetId();
    const asset: SpaceAsset = {
      id,
      kind: "palette",
      title: "My palette",
      payload: { colors },
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await upsertSpaceAsset(asset);
    Alert.alert("Saved to Paint Space", "Your palette is in the locker.");
  }, [settings.color]);

  const saveLoopToSpace = useCallback(async () => {
    if (exportInFlightRef.current) {
      Alert.alert("Export in progress", "Please wait for the current export to finish.");
      return;
    }
    setBusyLabel("Saving loop...");
    try {
      const id = makeSpaceAssetId();
      const previews: LoopFramePreview[] = [];
      // M6: hold the lock for the whole per-frame capture loop.
      await withExportLock(async () => {
        for (let i = 0; i < frames.length; i += 1) {
          const frame = frames[i];
          const image = await snapshotFrameImage(frame.id);
          let uri = "";
          if (image) {
            uri = spaceAssetPath(`${id}-${i}`);
            await writePng(uri, image.encodeToBase64());
            image.dispose();
          }
          previews.push({ uri, durationMs: frame.durationMs });
        }
      });
      const loopFrames: Frame[] = latestProject.frames.map((frame) => ({
        ...frame,
        layers: frame.layers.map((layer) => ({ ...layer, items: layer.items.map((item) => ({ ...item })) }))
      }));
      const asset: SpaceAsset = {
        id,
        kind: "loop",
        title: `${latestProject.title} loop`,
        payload: { previews, frames: loopFrames, texture: settings.texture },
        thumbnail: previews[0]?.uri,
        previewUri: previews[0]?.uri,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await upsertSpaceAsset(asset);
      Alert.alert("Saved to Paint Space", "Your loop is in the locker.");
    } catch (error) {
      Alert.alert("Save failed", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setBusyLabel(null);
    }
  }, [frames, latestProject.frames, latestProject.title, settings.texture, snapshotFrameImage, withExportLock]);

  const showBackground = !exporting;
  // During an export snapshot we render only the targeted frame's layers.
  const renderFrame = exportFrameId
    ? frames.find((frame) => frame.id === exportFrameId) ?? displayFrame
    : displayFrame;
  const renderLayers = renderFrame?.layers ?? layers;
  // Live items only render on top of the active layer of the frame being edited.
  const activeIndex = renderLayers.findIndex((layer) => layer.id === activeLayerId);
  const liveEditable = !exportFrameId && !isPlaying && renderFrame?.id === activeFrameId;

  return (
    <ScrollView contentContainerStyle={[styles.screen, calmMode && styles.calmScreen]}>
      <View style={styles.header}>
        <IconButton icon={ArrowLeft} label="Gallery" onPress={onBack} />
        <View style={styles.titleBlock}>
          <RNText style={styles.title}>{project.title}</RNText>
          <RNText style={styles.subtitle}>Autosaves while you paint</RNText>
        </View>
        <IconButton icon={Package} label="Space" onPress={onOpenPaintSpace} />
        <IconButton icon={SlidersHorizontal} label="Settings" onPress={onOpenSettings} />
      </View>

      <View
        onLayout={(event) => {
          const width = Math.max(MIN_CANVAS_WIDTH, event.nativeEvent.layout.width);
          setCanvasSize({ width, height: width / CANVAS_ASPECT_RATIO });
        }}
        style={styles.canvasShell}
      >
        <GestureDetector gesture={pan}>
          <View style={[styles.canvasFrame, { height: canvasSize.height }]}>
          <Canvas ref={canvasRef} style={styles.canvas}>
            {showBackground ? (
              <Rect color={paperBackground} height={canvasSize.height} width={canvasSize.width} x={0} y={0} />
            ) : null}
            {showBackground && textureImage ? (
              <SkiaImage
                fit="cover"
                height={canvasSize.height}
                image={textureImage}
                opacity={0.42}
                width={canvasSize.width}
                x={0}
                y={0}
              />
            ) : null}
            {showBackground && importedImage ? (
              <SkiaImage
                fit="contain"
                height={canvasSize.height}
                image={importedImage}
                opacity={0.72}
                width={canvasSize.width}
                x={0}
                y={0}
              />
            ) : null}
            {showOnion && onionFrame ? (
              <Group opacity={0.25}>
                {onionFrame.layers.map((layer) =>
                  layer.visible ? (
                    // M9: same offscreen isolation so onion-skin eraser marks clear
                    // only within their layer.
                    <Group key={`onion-${layer.id}`} layer opacity={layer.opacity}>
                      <LayerItemsNode
                        canvasHeight={canvasSize.height}
                        canvasWidth={canvasSize.width}
                        items={layer.items}
                        paperBackground={paperBackground}
                      />
                    </Group>
                  ) : null
                )}
              </Group>
            ) : null}
            {renderLayers.map((layer, index) => {
              if (!layer.visible) {
                return null;
              }
              return (
                // M9: `layer` forces this layer into its own offscreen group so an
                // eraser stroke's BlendMode.Clear cuts pixels from THIS layer only
                // (committed picture + live preview) instead of punching through to
                // the canvas background or covering lower layers with paper color.
                <Group key={layer.id} layer opacity={layer.opacity}>
                  <LayerItemsNode
                    canvasHeight={canvasSize.height}
                    canvasWidth={canvasSize.width}
                    items={layer.items}
                    paperBackground={paperBackground}
                  />
                  {liveEditable && index === activeIndex ? (
                    <LiveStrokeLayer paperBackground={paperBackground} ref={liveLayerRef} />
                  ) : null}
                </Group>
              );
            })}
          </Canvas>
          </View>
        </GestureDetector>
        {!canDraw ? (
          <RNText style={styles.lockedHint}>
            {activeLayer && !activeLayer.visible ? "Active layer is hidden." : "Active layer is locked."}
          </RNText>
        ) : null}
      </View>

      <View style={styles.toolbar}>
        <IconButton icon={RotateCcw} label="Undo" onPress={undo} disabled={!activeLayer || activeLayer.items.length === 0} />
        <IconButton icon={Trash2} label="Clear" onPress={clear} tone="danger" />
        <IconButton icon={Share2} label="Share" onPress={sharePng} />
        <IconButton icon={Save} label="Export" onPress={exportPng} />
        <IconButton icon={Download} label="Photos" onPress={saveToPhotos} />
        <IconButton icon={FileImage} label="PNG (clear)" onPress={exportTransparentPng} />
      </View>

      <View style={styles.panel}>
        <View style={styles.panelHeader}>
          <Film size={20} color="#0f172a" />
          <RNText style={styles.panelTitle}>Loop</RNText>
          <View style={styles.layerHeaderActions}>
            <IconButton icon={isPlaying ? Pause : Play} label={isPlaying ? "Pause" : "Play"} onPress={togglePlay} />
          </View>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.frameStrip}>
          {frames.map((frame, index) => {
            const isActive = frame.id === activeFrameId;
            const isPreview = isPlaying && index === previewFrameIndex;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
                key={frame.id}
                onPress={() => selectFrame(frame.id)}
                style={[styles.frameChip, isActive && styles.frameChipActive, isPreview && styles.frameChipPreview]}
              >
                <RNText style={[styles.frameChipText, isActive && styles.segmentTextActive]}>{index + 1}</RNText>
                <RNText style={styles.frameChipMeta}>{frame.durationMs}ms</RNText>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={styles.toolbar}>
          <IconButton icon={Plus} label="Add frame" onPress={addFrame} />
          <IconButton icon={Copy} label="Duplicate" onPress={duplicateFrame} />
          <IconButton icon={ChevronDown} label="Earlier" onPress={() => moveFrame(activeFrameId, -1)} disabled={frames.length < 2} />
          <IconButton icon={ChevronUp} label="Later" onPress={() => moveFrame(activeFrameId, 1)} disabled={frames.length < 2} />
          <IconButton icon={Trash2} label="Delete frame" onPress={() => deleteFrame(activeFrameId)} tone="danger" disabled={frames.length < 2} />
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: !!latestProject.onionSkin }}
          onPress={toggleOnionSkin}
          style={[styles.segment, styles.fillToggle, latestProject.onionSkin && styles.segmentActive]}
        >
          <RNText style={[styles.segmentText, latestProject.onionSkin && styles.segmentTextActive]}>
            {latestProject.onionSkin ? "Onion skin on" : "Onion skin off"}
          </RNText>
        </Pressable>

        <SliderControl
          label="Frame duration (ms)"
          maximum={1000}
          minimum={40}
          step={20}
          value={activeFrame?.durationMs ?? DEFAULT_FRAME_DURATION_MS}
          onChange={setFrameDuration}
        />

        <View style={styles.toolbar}>
          <IconButton icon={Film} label="Export GIF" onPress={exportGif} disabled={!!busyLabel} />
        </View>
      </View>

      <View style={styles.panel}>
        <View style={styles.panelHeader}>
          <Package size={20} color="#0f172a" />
          <RNText style={styles.panelTitle}>Save to Paint Space</RNText>
        </View>
        <View style={styles.toolbar}>
          <IconButton icon={ImagePlus} label="Sticker" onPress={saveStickerToSpace} disabled={!!busyLabel} />
          <IconButton icon={FileImage} label="Template" onPress={saveTemplateToSpace} disabled={!!busyLabel} />
          <IconButton icon={Sparkles} label="Palette" onPress={savePaletteToSpace} />
          <IconButton icon={Film} label="Loop" onPress={saveLoopToSpace} disabled={!!busyLabel} />
          <IconButton icon={FolderOpen} label="Open locker" onPress={onOpenPaintSpace} />
        </View>
      </View>

      <View style={styles.panel}>
        <View style={styles.panelHeader}>
          <Sparkles size={20} color="#0f172a" />
          <RNText style={styles.panelTitle}>Tool</RNText>
        </View>
        <View style={styles.segmentRow}>
          {TOOLS.map((tool) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: settings.tool === tool.id }}
              key={tool.id}
              onPress={() => updateSettings({ tool: tool.id })}
              style={[styles.segment, settings.tool === tool.id && styles.segmentActive]}
            >
              <RNText style={[styles.segmentText, settings.tool === tool.id && styles.segmentTextActive]}>{tool.label}</RNText>
            </Pressable>
          ))}
        </View>
        {settings.tool === "rect" || settings.tool === "ellipse" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: settings.shapeFilled }}
            onPress={() => updateSettings({ shapeFilled: !settings.shapeFilled })}
            style={[styles.segment, styles.fillToggle, settings.shapeFilled && styles.segmentActive]}
          >
            <RNText style={[styles.segmentText, settings.shapeFilled && styles.segmentTextActive]}>
              {settings.shapeFilled ? "Filled shape" : "Outline shape"}
            </RNText>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.panel}>
        <View style={styles.panelHeader}>
          <Sparkles size={20} color="#0f172a" />
          <RNText style={styles.panelTitle}>Brush</RNText>
        </View>

        <View style={styles.segmentRow}>
          {BRUSHES.filter((brush) => brush.id !== "eraser").map((brush) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: settings.brush === brush.id }}
              key={brush.id}
              onPress={() => {
                if (brush.tier === "studio" && !hasStudioTier) {
                  Alert.alert(
                    "Studio pack",
                    "Unlock the Glow brush and studio tools with the Creator Brushes pack in the Store.",
                    [
                      { text: "Not now", style: "cancel" },
                      { text: "Open Store", onPress: onOpenStore }
                    ]
                  );
                  return;
                }
                updateSettings({ brush: brush.id as BrushId, tool: "brush" });
              }}
              style={[styles.segment, settings.brush === brush.id && settings.tool === "brush" && styles.segmentActive]}
            >
              <RNText style={[styles.segmentText, settings.brush === brush.id && settings.tool === "brush" && styles.segmentTextActive]}>
                {brush.label}
                {brush.tier === "studio" && !hasStudioTier ? " +" : ""}
              </RNText>
            </Pressable>
          ))}
        </View>

        <RNText style={styles.controlLabel}>Color</RNText>
        <View style={styles.swatches}>
          {COLORS.map((color) => (
            <Pressable
              accessibilityLabel={`Use ${color}`}
              accessibilityRole="button"
              key={color}
              onPress={() => updateSettings({ color })}
              style={[
                styles.swatch,
                { backgroundColor: color },
                settings.color === color && styles.swatchActive,
                color === "#ffffff" && styles.whiteSwatch
              ]}
            />
          ))}
        </View>

        <SliderControl label="Size" maximum={72} minimum={2} step={1} value={settings.size} onChange={(size) => updateSettings({ size })} />
        <SliderControl
          label="Variation"
          maximum={0.8}
          minimum={0}
          step={0.05}
          value={settings.variation}
          onChange={(variation) => updateSettings({ variation })}
        />
        <SliderControl
          label="Opacity"
          maximum={1}
          minimum={0.15}
          step={0.05}
          value={settings.opacity}
          onChange={(opacity) => updateSettings({ opacity })}
        />
      </View>

      <View style={styles.panel}>
        <View style={styles.panelHeader}>
          <Layers size={20} color="#0f172a" />
          <RNText style={styles.panelTitle}>Layers</RNText>
          <View style={styles.layerHeaderActions}>
            <IconButton icon={Plus} label="Add" onPress={addLayer} />
          </View>
        </View>

        {[...layers].reverse().map((layer) => {
          const isActive = layer.id === activeLayerId;
          return (
            <View key={layer.id} style={[styles.layerRow, isActive && styles.layerRowActive]}>
              <Pressable accessibilityRole="button" onPress={() => selectLayer(layer.id)} style={styles.layerNameButton}>
                <RNText numberOfLines={1} style={[styles.layerName, isActive && styles.layerNameActive]}>
                  {layer.name}
                </RNText>
                <RNText style={styles.layerMeta}>{layer.items.length} items - {Math.round(layer.opacity * 100)}%</RNText>
              </Pressable>
              <View style={styles.layerActions}>
                <Pressable accessibilityLabel="Toggle visibility" onPress={() => patchLayer(layer.id, { visible: !layer.visible })} style={styles.layerIcon}>
                  {layer.visible ? <Eye size={18} color="#0f172a" /> : <EyeOff size={18} color="#94a3b8" />}
                </Pressable>
                <Pressable accessibilityLabel="Toggle lock" onPress={() => patchLayer(layer.id, { locked: !layer.locked })} style={styles.layerIcon}>
                  {layer.locked ? <Lock size={18} color="#b91c1c" /> : <Unlock size={18} color="#0f172a" />}
                </Pressable>
                <Pressable accessibilityLabel="Rename layer" onPress={() => setRenameLayer({ id: layer.id, value: layer.name })} style={styles.layerIcon}>
                  <Pencil size={18} color="#0f172a" />
                </Pressable>
                <Pressable accessibilityLabel="Move layer up" onPress={() => moveLayer(layer.id, 1)} style={styles.layerIcon}>
                  <ChevronUp size={18} color="#0f172a" />
                </Pressable>
                <Pressable accessibilityLabel="Move layer down" onPress={() => moveLayer(layer.id, -1)} style={styles.layerIcon}>
                  <ChevronDown size={18} color="#0f172a" />
                </Pressable>
                <Pressable accessibilityLabel="Merge down" onPress={() => mergeDown(layer.id)} style={styles.layerIcon}>
                  <Merge size={18} color="#0f172a" />
                </Pressable>
                <Pressable accessibilityLabel="Duplicate layer" onPress={() => duplicateLayer(layer.id)} style={styles.layerIcon}>
                  <Copy size={18} color="#0f172a" />
                </Pressable>
                <Pressable accessibilityLabel="Delete layer" onPress={() => deleteLayer(layer.id)} style={styles.layerIcon}>
                  <Trash2 size={18} color="#b91c1c" />
                </Pressable>
              </View>
              {isActive ? (
                <View style={styles.layerOpacity}>
                  <SliderControl
                    label="Layer opacity"
                    maximum={1}
                    minimum={0}
                    step={0.05}
                    value={layer.opacity}
                    onChange={(opacity) => patchLayer(layer.id, { opacity })}
                  />
                </View>
              ) : null}
            </View>
          );
        })}
      </View>

      <View style={styles.panel}>
        <View style={styles.panelHeader}>
          <FileImage size={20} color="#0f172a" />
          <RNText style={styles.panelTitle}>Paper and import</RNText>
        </View>
        <View style={styles.segmentRow}>
          {TEXTURES.map((texture) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: settings.texture === texture.id }}
              key={texture.id}
              onPress={() => {
                if (texture.tier === "studio" && !hasStudioTier) {
                  Alert.alert(
                    "Studio pack",
                    "Unlock the Night paper and studio papers with the Creator Brushes pack in the Store.",
                    [
                      { text: "Not now", style: "cancel" },
                      { text: "Open Store", onPress: onOpenStore }
                    ]
                  );
                  return;
                }
                updateSettings({ texture: texture.id as TextureId });
              }}
              style={[styles.segment, settings.texture === texture.id && styles.segmentActive]}
            >
              <RNText style={[styles.segmentText, settings.texture === texture.id && styles.segmentTextActive]}>
                {texture.label}
                {texture.tier === "studio" && !hasStudioTier ? " +" : ""}
              </RNText>
            </Pressable>
          ))}
        </View>
        <View style={styles.toolbar}>
          <IconButton icon={ImagePlus} label="Photo" onPress={importFromPhotos} />
          <IconButton icon={FolderOpen} label="File" onPress={importFromFiles} />
          <IconButton
            icon={Eraser}
            label="Remove import"
            onPress={() => {
              const next = { ...latestProjectRef.current, importedImageUri: undefined, updatedAt: Date.now() };
              latestProjectRef.current = next;
              onProjectChange(next);
            }}
            disabled={!latestProject.importedImageUri}
          />
        </View>
      </View>

      <Modal animationType="fade" transparent visible={!!renameLayer} onRequestClose={() => setRenameLayer(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <RNText style={styles.modalTitle}>Rename layer</RNText>
            <TextInput
              autoFocus
              onChangeText={(value) => setRenameLayer((current) => (current ? { ...current, value } : current))}
              style={styles.modalInput}
              value={renameLayer?.value ?? ""}
            />
            <View style={styles.modalActions}>
              <Pressable onPress={() => setRenameLayer(null)} style={[styles.modalButton, styles.modalButtonGhost]}>
                <RNText style={styles.modalButtonText}>Cancel</RNText>
              </Pressable>
              <Pressable
                onPress={() => {
                  if (renameLayer) {
                    patchLayer(renameLayer.id, { name: renameLayer.value.trim() || "Layer" });
                  }
                  setRenameLayer(null);
                }}
                style={[styles.modalButton, styles.modalButtonPrimary]}
              >
                <RNText style={[styles.modalButtonText, styles.modalButtonTextPrimary]}>Save</RNText>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal animationType="fade" transparent visible={!!textPrompt} onRequestClose={() => setTextPrompt(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <RNText style={styles.modalTitle}>Add text</RNText>
            <TextInput
              autoFocus
              onChangeText={(value) => setTextPrompt((current) => (current ? { ...current, value } : current))}
              placeholder="Type here"
              style={styles.modalInput}
              value={textPrompt?.value ?? ""}
            />
            <View style={styles.modalActions}>
              <Pressable onPress={() => setTextPrompt(null)} style={[styles.modalButton, styles.modalButtonGhost]}>
                <RNText style={styles.modalButtonText}>Cancel</RNText>
              </Pressable>
              <Pressable
                onPress={() => {
                  if (textPrompt) {
                    commitText(textPrompt.value, textPrompt.x, textPrompt.y);
                  }
                  setTextPrompt(null);
                }}
                style={[styles.modalButton, styles.modalButtonPrimary]}
              >
                <RNText style={[styles.modalButtonText, styles.modalButtonTextPrimary]}>Add</RNText>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal animationType="fade" transparent visible={!!busyLabel}>
        <View style={styles.modalBackdrop}>
          <View style={styles.busyCard}>
            <ActivityIndicator color="#0f766e" />
            <RNText style={styles.modalButtonText}>{busyLabel}</RNText>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function SliderControl({
  label,
  maximum,
  minimum,
  onChange,
  step,
  value
}: {
  label: string;
  maximum: number;
  minimum: number;
  onChange: (value: number) => void;
  step: number;
  value: number;
}) {
  const displayValue = maximum <= 1 ? Math.round(value * 100) : Math.round(value);

  return (
    <View style={styles.sliderRow}>
      <View style={styles.sliderHeader}>
        <RNText style={styles.controlLabel}>{label}</RNText>
        <RNText style={styles.valueLabel}>{displayValue}</RNText>
      </View>
      <Slider
        maximumTrackTintColor="#cbd5e1"
        maximumValue={maximum}
        minimumTrackTintColor="#0f766e"
        minimumValue={minimum}
        onSlidingComplete={onChange}
        step={step}
        thumbTintColor="#0f766e"
        value={value}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  busyCard: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 12,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 16
  },
  calmScreen: {
    gap: 18
  },
  canvas: {
    flex: 1
  },
  canvasFrame: {
    backgroundColor: "#ffffff",
    borderColor: "#1f2937",
    borderRadius: 8,
    borderWidth: 2,
    overflow: "hidden",
    width: "100%"
  },
  canvasShell: {
    width: "100%"
  },
  controlLabel: {
    color: "#334155",
    fontSize: 14,
    fontWeight: "900",
    marginBottom: 8,
    marginTop: 10
  },
  fillToggle: {
    flexGrow: 0,
    marginTop: 10
  },
  frameChip: {
    alignItems: "center",
    backgroundColor: "#f8fafc",
    borderColor: "#d1d5db",
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: "center",
    minWidth: 56,
    paddingHorizontal: 10,
    paddingVertical: 10
  },
  frameChipActive: {
    backgroundColor: "#ccfbf1",
    borderColor: "#0f766e"
  },
  frameChipMeta: {
    color: "#64748b",
    fontSize: 11,
    fontWeight: "700"
  },
  frameChipPreview: {
    borderColor: "#f59e0b",
    borderWidth: 2
  },
  frameChipText: {
    color: "#334155",
    fontSize: 16,
    fontWeight: "900"
  },
  frameStrip: {
    flexDirection: "row",
    gap: 8,
    paddingVertical: 4
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10
  },
  layerActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    marginTop: 8
  },
  layerHeaderActions: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end"
  },
  layerIcon: {
    alignItems: "center",
    backgroundColor: "#f8fafc",
    borderColor: "#e2e8f0",
    borderRadius: 8,
    borderWidth: 1,
    height: 34,
    justifyContent: "center",
    width: 34
  },
  layerMeta: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "700"
  },
  layerName: {
    color: "#0f172a",
    fontSize: 15,
    fontWeight: "800"
  },
  layerNameActive: {
    color: "#134e4a"
  },
  layerNameButton: {
    flex: 1
  },
  layerOpacity: {
    width: "100%"
  },
  layerRow: {
    borderColor: "#e2e8f0",
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 8,
    padding: 10
  },
  layerRowActive: {
    backgroundColor: "#ecfeff",
    borderColor: "#0f766e"
  },
  lockedHint: {
    color: "#b91c1c",
    fontSize: 12,
    fontWeight: "800",
    marginTop: 6
  },
  modalActions: {
    flexDirection: "row",
    gap: 10,
    justifyContent: "flex-end",
    marginTop: 16
  },
  modalBackdrop: {
    alignItems: "center",
    backgroundColor: "rgba(15,23,42,0.45)",
    flex: 1,
    justifyContent: "center",
    padding: 24
  },
  modalButton: {
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10
  },
  modalButtonGhost: {
    backgroundColor: "#f1f5f9"
  },
  modalButtonPrimary: {
    backgroundColor: "#0f766e"
  },
  modalButtonText: {
    color: "#0f172a",
    fontSize: 14,
    fontWeight: "800"
  },
  modalButtonTextPrimary: {
    color: "#ffffff"
  },
  modalCard: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    padding: 18,
    width: "100%"
  },
  modalInput: {
    borderColor: "#cbd5e1",
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  modalTitle: {
    color: "#0f172a",
    fontSize: 18,
    fontWeight: "900",
    marginBottom: 12
  },
  panel: {
    backgroundColor: "#ffffff",
    borderColor: "#dbe3ef",
    borderRadius: 8,
    borderWidth: 1,
    padding: 12
  },
  panelHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    marginBottom: 10
  },
  panelTitle: {
    color: "#0f172a",
    fontSize: 18,
    fontWeight: "900"
  },
  screen: {
    gap: 14,
    padding: 16,
    paddingBottom: 28
  },
  segment: {
    alignItems: "center",
    backgroundColor: "#f8fafc",
    borderColor: "#d1d5db",
    borderRadius: 8,
    borderWidth: 1,
    flexGrow: 1,
    minHeight: 40,
    minWidth: 76,
    paddingHorizontal: 10,
    paddingVertical: 10
  },
  segmentActive: {
    backgroundColor: "#ccfbf1",
    borderColor: "#0f766e"
  },
  segmentRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  segmentText: {
    color: "#334155",
    fontSize: 14,
    fontWeight: "800"
  },
  segmentTextActive: {
    color: "#134e4a"
  },
  sliderHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  sliderRow: {
    marginTop: 4
  },
  subtitle: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "700"
  },
  swatch: {
    borderColor: "#ffffff",
    borderRadius: 18,
    borderWidth: 3,
    height: 36,
    width: 36
  },
  swatchActive: {
    borderColor: "#0f172a",
    transform: [{ scale: 1.08 }]
  },
  swatches: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 6
  },
  title: {
    color: "#0f172a",
    fontSize: 20,
    fontWeight: "900"
  },
  titleBlock: {
    flex: 1,
    minWidth: 0
  },
  toolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  valueLabel: {
    color: "#0f766e",
    fontSize: 13,
    fontWeight: "900"
  },
  whiteSwatch: {
    borderColor: "#cbd5e1"
  }
});
