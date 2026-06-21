import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  brushCatalog,
  drawBrushSegment,
  getTexture,
  paletteCatalog,
  paperTextures,
} from "./utils/brushes";
import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  compositeLayers,
  compositeLayerRange,
  createDefaultLayers,
  createLayer,
  createLayerCanvas,
  cloneLayerCanvas,
  restoreLayersFromSnapshot,
  snapshotLayers,
  snapshotActiveLayer,
} from "./utils/layers";
import { floodFill } from "./utils/fill";
import { drawShape, drawText } from "./utils/shapes";
import {
  DEFAULT_FRAME_DURATION,
  MAX_FRAMES,
  cloneFrame,
  compositeFrameToCanvas,
  createFrame,
} from "./utils/frames";
import { encodeGif } from "./utils/gif";
import { idbGet, idbGetKV, idbSet, idbSetKV, isIdbAvailable } from "./utils/idb";
import { getSession, onAuthStateChange } from "./utils/auth";
import { schedulePush, startSync, stopSync } from "./utils/sync";
import {
  addAsset,
  createAsset,
  loadPaintSpace,
  makeId,
  removeAsset,
  renameAsset as renamePaintSpaceAsset,
  savePaintSpace,
} from "./utils/paintSpace";
import {
  TIP_PRESETS,
  creditDrops,
  hasEntitlement,
  loadEconomy,
  migrateLegacyStudioPass,
  saveEconomy,
  sendTip,
  spendDrops,
} from "./utils/economy";
import {
  SNAPSHOT_WIDTH,
  SNAPSHOT_HEIGHT,
  createReplayRecorder,
  loadReplaySnapshots,
} from "./utils/replay";
import {
  isAiConsented,
  loadAiConsent,
  revokeAiConsent,
  saveAiConsent,
} from "./utils/aiAssist";
import { buildBrushAssetFields, recipeToBrushSettings } from "./utils/brushStudio";
import { publishPack } from "./utils/brushPacks";
import LayerPanel from "./components/LayerPanel";
import FrameStrip from "./components/FrameStrip";
import PaintSpacePanel from "./components/PaintSpacePanel";
import ReplayPlayer from "./components/ReplayPlayer";
import AiAssistPanel from "./components/AiAssistPanel";
import BrushStudio from "./components/BrushStudio";
import PublishPackModal from "./components/PublishPackModal";
import WalletPanel from "./components/WalletPanel";
import StorePanel from "./components/StorePanel";
import CreatorDashboard from "./components/CreatorDashboard";
import MarketingSite from "./components/MarketingSite";
import TogetherPanel from "./components/TogetherPanel";
import LiveAdmin from "./components/LiveAdmin";
import AccountPanel from "./components/AccountPanel";
import { useMultiplayer } from "./hooks/useMultiplayer";
import "./App.css";

const MAX_HISTORY = 18;
const MAX_GALLERY_ITEMS = 10;
// Cap layers per artist — each is a full-size canvas, so this keeps memory and
// compositing sane on phones/tablets.
const MAX_LAYERS = 6;

// Avatar colour choices for the profile menu.
const AVATAR_COLORS = [
  "#FF6B6B", "#F8961E", "#FEE440", "#8AC926", "#06D6A0",
  "#4ECDC4", "#45B7D1", "#2D6CDF", "#9B5DE5", "#F15BB5",
];

const PROFILE_STORAGE_KEY = "drawesome:profile:v1";

const STORAGE_KEYS = {
  draft: "happypaint:draft:v3",
  gallery: "happypaint:gallery:v2",
  studio: "happypaint:studio-pass:v1",
};

// The draft autosave now lives in IndexedDB (much larger quota than the ~5MB
// localStorage budget, and it stores layer PNGs as Blobs without base64
// inflation). STORAGE_KEYS.draft is kept only for back-compat migration of an
// existing localStorage draft (W3).
const DRAFT_IDB_KEY = "draft:v4";

// The gallery and Paint Space lockers now persist their full arrays in
// IndexedDB (much larger quota than the ~5MB localStorage budget, and a quota
// overflow rejects instead of silently dropping the save). STORAGE_KEYS.gallery
// is kept only for one-time back-compat migration and as the private-mode
// fallback store. Gallery items keep their base64 dataURLs; IDB swallows them
// happily and they stay sync-ready for the backend.
const GALLERY_IDB_KEY = "gallery:v2";

// Downscaled GIF size keeps exports small and quantization fast. The 1600x1200
// canvas is 4:3, so we keep that ratio.
const GIF_EXPORT_WIDTH = 320;
const GIF_EXPORT_HEIGHT = 240;
const FRAME_THUMB_WIDTH = 96;
const FRAME_THUMB_HEIGHT = 72;
const MAX_PALETTE_COLORS = 10;

const TOOLS = [
  { id: "brush", name: "Brush" },
  { id: "fill", name: "Fill" },
  { id: "rect", name: "Rectangle" },
  { id: "ellipse", name: "Ellipse" },
  { id: "line", name: "Line" },
  { id: "text", name: "Text" },
];

function readJson(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function createImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

// Decode a PNG Blob into an Image, revoking the temporary object URL once the
// browser has finished decoding it (or on error) so we never leak URLs.
function createImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = (error) => {
      URL.revokeObjectURL(url);
      reject(error);
    };
    image.src = url;
  });
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/png", 0.95);
  });
}

async function canvasToDataUrl(canvas) {
  const blob = await canvasToBlob(canvas);

  if (!blob) {
    return "";
  }

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => resolve("");
    reader.readAsDataURL(blob);
  });
}

function todayName() {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
}

function downloadBlob(blob, filename) {
  // Append the anchor to the DOM before clicking (some browsers — notably
  // Firefox — ignore clicks on detached anchors) and defer the revoke so the
  // download has time to start before the object URL is torn down (W15).
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function StudioApp({ initialJoinCode = "", initialPrompt = "" }) {
  const displayCanvasRef = useRef(null);
  const displayContextRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const overlayContextRef = useRef(null);

  // Full-resolution (1600x1200) document composite. Everything composites here
  // at art resolution; the visible display canvas is a DPR-scaled blit of it so
  // it stays crisp on Retina/tablet screens (W6).
  const docCanvasRef = useRef(null);
  const docContextRef = useRef(null);
  const displayDprRef = useRef(1);

  // Stroke-time composite caches (W1/W2). On stroke-start we pre-render the
  // static content beneath the active layer (including onion-skin neighbours)
  // and the static content above it into two offscreen canvases, so each move
  // blits below + activeLayer + above (3 draws) instead of recompositing the
  // whole stack + neighbour frames every pointer move.
  const belowCacheRef = useRef(null); // canvas: onion + visible layers under active
  const aboveCacheRef = useRef(null); // canvas: visible layers above active
  const compositeCacheValidRef = useRef(false);
  const activeStrokeLayerIdRef = useRef(null);

  // rAF coalescing for per-move display updates (W5).
  const rafPendingRef = useRef(0);

  // Opacity-slider drag state (W13): a single undo snapshot is taken at
  // drag-start, and the live recomposite during the drag is rAF-throttled
  // instead of running synchronously on every slider tick.
  const opacityRafRef = useRef(0);
  const opacityDragActiveRef = useRef(false);

  // GIF encode worker (W7). Lazily created; null if Workers are unavailable, in
  // which case GIF export falls back to encoding synchronously on the main
  // thread. Tracks the in-flight job id so stale results are ignored.
  const gifWorkerRef = useRef(null);
  const gifJobSeedRef = useRef(0);

  // Live layer stack (bottom-to-top) plus the active layer id. Refs hold the
  // canonical canvases so pointer handlers never go stale; React state mirrors
  // the meta so the UI re-renders on changes.
  //
  // The layer stack belongs to the ACTIVE FRAME. framesRef holds every frame
  // (each frame is its own mini layer-project); layersRef/activeLayerIdRef are
  // always a live view of framesRef.current[activeFrameIndexRef.current], so
  // every existing layer/tool/undo path keeps working unchanged. After any
  // layer mutation, commitLayersToFrame() writes them back into the frame.
  const layersRef = useRef([]);
  const activeLayerIdRef = useRef(null);

  const framesRef = useRef([]);
  const activeFrameIndexRef = useRef(0);
  const playTimerRef = useRef(null);
  const onionSkinRef = useRef(false);

  const historyRef = useRef([]);
  const redoRef = useRef([]);
  const lastPointRef = useRef(null);
  const shapeStartRef = useRef(null);
  // Bounding box of the last shape/line preview drawn onto the overlay, so each
  // pointermove only clears that region (plus a margin) instead of the whole
  // 1600x1200 overlay (W11).
  const shapePreviewRectRef = useRef(null);
  const activePointerRef = useRef(null);
  const activeCanvasRectRef = useRef(null);
  // Pen prioritization / palm rejection (W14). Once a pen contact is seen we
  // prefer it: touch contacts (especially large-contact palm rests) are ignored
  // while a pen is the active input. Mouse and lone-finger touch keep working.
  const penSeenRef = useRef(false);
  const dirtyRef = useRef(false);
  const autosaveTimerRef = useRef(null);
  const saveInFlightRef = useRef(false);
  const settingsRef = useRef(null);
  // Mirror the gallery / Paint Space arrays so the async save callbacks build the
  // next array from the latest committed value without re-creating on each change.
  const galleryRef = useRef([]);
  const paintSpaceAssetsRef = useRef([]);

  // Snapshot-based replay recorder (W: Room Replay & Timelapse). Captures
  // downscaled composited snapshots over time (NOT a stroke stream); see
  // utils/replay.js. A debounced flush persists the series to IndexedDB.
  const replayRecorderRef = useRef(null);
  const replayFlushTimerRef = useRef(0);

  // --- Realtime multiplayer (shared canvas) ---
  // Everyone in the same room draws together. A friend's strokes land on a
  // dedicated offscreen "remote" canvas that is blitted on top of the local
  // layer composite, so remote art never touches the local layer/undo system.
  const roomId = (initialJoinCode || "MAIN").toUpperCase().slice(0, 16) || "MAIN";
  const remoteCanvasRef = useRef(null); // offscreen 1600x1200: all friends' art, merged
  const mpRef = useRef(null); // { sendOp, sendCursor, sendClear } once the hook mounts
  const strokeNetRef = useRef(null); // outgoing in-progress brush stroke buffer
  const remoteStrokeLastRef = useRef(new Map()); // incoming strokeId -> last point
  const remoteCursorsRef = useRef(new Map()); // userId -> { x, y, name, color, drawing, ts }
  const cursorSentAtRef = useRef(0);
  const [remoteCursors, setRemoteCursors] = useState([]);
  const [chatDraft, setChatDraft] = useState("");
  const [showChat, setShowChat] = useState(true);

  // --- Viewport: pan / zoom across the large mural ---
  // World coords are the CANVAS_WIDTH x CANVAS_HEIGHT document. The view maps
  // world -> CSS px in the display box: cssX = worldX * scale + tx.
  const viewRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const viewInitRef = useRef(false);
  const pointersRef = useRef(new Map()); // active pointers (gesture detection)
  const gestureRef = useRef(null); // two-finger pan/zoom state
  const panPointerRef = useRef(null); // single-pointer pan (hand tool)
  const panLastRef = useRef({ x: 0, y: 0 });
  const handToolRef = useRef(false);
  const viewRectRef = useRef(null); // display rect captured at gesture start
  const [zoomPct, setZoomPct] = useState(100);
  const [handTool, setHandTool] = useState(false);
  const imageInputRef = useRef(null); // hidden file input for GIF / image import
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearBanner, setClearBanner] = useState(null); // { by } when the mural was cleared
  const clearBannerTimerRef = useRef(null);
  const [showAvatarMenu, setShowAvatarMenu] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const profileRef = useRef(null); // persisted { name, color }, applied on connect

  // Saved-to-server artwork ("My Art"), keyed by an anonymous per-device id.
  const userKeyRef = useRef(null);
  const [myDrawings, setMyDrawings] = useState([]);
  const [savesMax, setSavesMax] = useState(12);
  const [showMyArt, setShowMyArt] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false); // mobile tools drawer
  const [chatPos, setChatPos] = useState(null); // {left, top} once the chat is dragged
  const [showReport, setShowReport] = useState(false);
  const [reportReason, setReportReason] = useState("");
  // Coloring sheet: a shared, locked line-art overlay artists colour under/over.
  const sheetImageRef = useRef(null);
  const sheetRectRef = useRef(null);
  const sheetModeRef = useRef("over"); // 'over' = lines on top (colour under)
  const [sheetId, setSheetId] = useState(null);
  const [sheetMode, setSheetMode] = useState("over");
  const [sheets, setSheets] = useState([]);
  const brushSectionRef = useRef(null); // scroll target when "Paint" opens the tools
  const lastPaintBrushRef = useRef("marker"); // remember the brush to restore after erasing
  const [savingArt, setSavingArt] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);

  const [layers, setLayers] = useState([]);
  const [activeLayerId, setActiveLayerId] = useState(null);

  const [frames, setFrames] = useState([]);
  const [activeFrameIndex, setActiveFrameIndex] = useState(0);
  const [frameThumbnails, setFrameThumbnails] = useState({});
  const [isPlaying, setIsPlaying] = useState(false);
  const [onionSkin, setOnionSkin] = useState(false);
  const [isExportingGif, setIsExportingGif] = useState(false);

  const [paintSpaceAssets, setPaintSpaceAssets] = useState([]);
  const [showPaintSpace, setShowPaintSpace] = useState(false);
  const [recentColors, setRecentColors] = useState([]);

  const [selectedTool, setSelectedTool] = useState("brush");
  const [selectedBrush, setSelectedBrush] = useState("marker");
  const [selectedColor, setSelectedColor] = useState("#111827");
  const [selectedTexture, setSelectedTexture] = useState("linen");
  const [brushSize, setBrushSize] = useState(24);
  const [brushOpacity, setBrushOpacity] = useState(0.86);
  const [brushVariation, setBrushVariation] = useState(0.08);
  const [fillShape, setFillShape] = useState(false);
  const [textSize, setTextSize] = useState(64);
  const [gallery, setGallery] = useState([]);
  const [status, setStatus] = useState("Ready");
  const [historyCount, setHistoryCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  // Economy state (mock wallet, ledger, store ownership, entitlements). Loaded
  // async from IndexedDB. The studio brush/paper tier now unlocks via the
  // "studio" entitlement (owning the Creator Brushes pack) instead of a boolean.
  const [economy, setEconomy] = useState(null);
  const [showWallet, setShowWallet] = useState(false);
  const [showStore, setShowStore] = useState(false);
  const [showCreator, setShowCreator] = useState(false);

  // Studio feature panels: replay/timelapse, AI assist, brush studio.
  const [showReplay, setShowReplay] = useState(false);
  const [replaySnapshots, setReplaySnapshots] = useState([]);
  const [replayCount, setReplayCount] = useState(0);
  const [isExportingTimelapse, setIsExportingTimelapse] = useState(false);
  const [showAiAssist, setShowAiAssist] = useState(false);
  const [aiConsent, setAiConsent] = useState(null);
  const [showBrushStudio, setShowBrushStudio] = useState(false);
  const [showPublishPack, setShowPublishPack] = useState(false);
  const [showAccount, setShowAccount] = useState(false);

  // Saved brush recipes are the kind === "brush" Paint Space assets.
  const savedBrushAssets = useMemo(
    () => paintSpaceAssets.filter((asset) => asset.kind === "brush"),
    [paintSpaceAssets],
  );

  const studioUnlocked = hasEntitlement(economy, "studio");

  const selectedTextureMeta = useMemo(() => getTexture(selectedTexture), [selectedTexture]);
  const activePalette = paletteCatalog[studioUnlocked ? 2 : 0];

  // Write the live layer view back into the active frame so frame switches and
  // exports always see the latest pixels/meta.
  const commitLayersToFrame = useCallback(() => {
    const frame = framesRef.current[activeFrameIndexRef.current];
    if (frame) {
      frame.layers = layersRef.current;
      frame.activeLayerId = activeLayerIdRef.current;
    }
  }, []);

  // Mirror live refs into state so React components stay in sync.
  const syncLayerState = useCallback(() => {
    commitLayersToFrame();
    setLayers(layersRef.current.map((layer) => ({ ...layer })));
    setActiveLayerId(activeLayerIdRef.current);
  }, [commitLayersToFrame]);

  // Render a small thumbnail data URL for one frame, on a white page so it
  // matches the canvas (transparent layers were showing through as junk).
  const renderFrameThumbnail = useCallback((frame) => {
    const canvas = document.createElement("canvas");
    canvas.width = FRAME_THUMB_WIDTH;
    canvas.height = FRAME_THUMB_HEIGHT;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, FRAME_THUMB_WIDTH, FRAME_THUMB_HEIGHT);
    const composed = compositeFrameToCanvas(frame, { width: FRAME_THUMB_WIDTH, height: FRAME_THUMB_HEIGHT });
    ctx.drawImage(composed, 0, 0);
    return canvas.toDataURL("image/png");
  }, []);

  // Mirror frame meta into React state (shallow refs; canvases stay in refs)
  // and refresh thumbnails for the strip. To avoid recompositing + PNG-encoding
  // every frame on any structural change (W9), only frames whose id is NOT
  // already in the thumbnail cache (i.e. newly created/duplicated) are
  // regenerated; `regenerateIds` forces specific existing ids (e.g. the active
  // frame after an edit, or all frames on a full reset). Untouched frames reuse
  // their existing dataURL, and stale entries for removed frames are dropped.
  const syncFrameState = useCallback(
    ({ regenerateIds = null } = {}) => {
      commitLayersToFrame();
      const snapshot = framesRef.current.map((frame) => ({ id: frame.id, durationMs: frame.durationMs }));
      setFrames(snapshot);
      setActiveFrameIndex(activeFrameIndexRef.current);
      const forced = regenerateIds === "all" ? null : new Set(regenerateIds || []);
      setFrameThumbnails((current) => {
        const thumbs = {};
        for (const frame of framesRef.current) {
          const needsRegen = regenerateIds === "all" || !current[frame.id] || forced?.has(frame.id);
          thumbs[frame.id] = needsRegen ? renderFrameThumbnail(frame) : current[frame.id];
        }
        return thumbs;
      });
    },
    [commitLayersToFrame, renderFrameThumbnail],
  );

  // Refresh just the active frame's thumbnail after an edit (cheap; one frame).
  const refreshActiveThumbnail = useCallback(() => {
    commitLayersToFrame();
    const frame = framesRef.current[activeFrameIndexRef.current];
    if (!frame) {
      return;
    }
    const dataUrl = renderFrameThumbnail(frame);
    setFrameThumbnails((current) => ({ ...current, [frame.id]: dataUrl }));
  }, [commitLayersToFrame, renderFrameThumbnail]);

  const getActiveLayer = useCallback(() => {
    return layersRef.current.find((layer) => layer.id === activeLayerIdRef.current) || null;
  }, []);

  useEffect(() => {
    settingsRef.current = {
      tool: selectedTool,
      brush: selectedBrush,
      color: selectedColor,
      opacity: brushOpacity,
      size: brushSize,
      variation: brushVariation,
      texture: selectedTexture,
      fillShape,
      textSize,
      studioUnlocked,
    };
  }, [
    brushOpacity,
    brushSize,
    brushVariation,
    fillShape,
    selectedBrush,
    selectedColor,
    selectedTexture,
    selectedTool,
    studioUnlocked,
    textSize,
  ]);

  const updateHistoryCounts = useCallback(() => {
    setHistoryCount(historyRef.current.length);
    setRedoCount(redoRef.current.length);
  }, []);

  const markChanged = useCallback((message = "Saved locally") => {
    dirtyRef.current = true;
    setStatus(message);
  }, []);

  const getViewportSize = () => {
    const display = displayCanvasRef.current;
    if (!display) {
      return { w: 1, h: 1 };
    }
    const rect = display.getBoundingClientRect();
    return { w: rect.width || 1, h: rect.height || 1 };
  };

  const fitScaleFor = (w, h) => Math.min(w / CANVAS_WIDTH, h / CANVAS_HEIGHT);

  // Keep scale within [≈fit, 8x] and keep the page framed: centered when it is
  // smaller than the viewport, otherwise pinned so it always covers the box.
  const clampView = (v) => {
    const { w, h } = getViewportSize();
    const fit = fitScaleFor(w, h);
    v.scale = Math.max(fit * 0.9, Math.min(8, v.scale));
    const worldW = CANVAS_WIDTH * v.scale;
    const worldH = CANVAS_HEIGHT * v.scale;
    v.tx = worldW <= w ? (w - worldW) / 2 : Math.min(0, Math.max(w - worldW, v.tx));
    v.ty = worldH <= h ? (h - worldH) / 2 : Math.min(0, Math.max(h - worldH, v.ty));
    return v;
  };

  const syncZoomLabel = () => {
    const { w, h } = getViewportSize();
    const fit = fitScaleFor(w, h) || 1;
    setZoomPct(Math.round((viewRef.current.scale / fit) * 100));
  };

  const fitView = () => {
    const { w, h } = getViewportSize();
    const fit = fitScaleFor(w, h);
    viewRef.current = {
      scale: fit,
      tx: (w - CANVAS_WIDTH * fit) / 2,
      ty: (h - CANVAS_HEIGHT * fit) / 2,
    };
    syncZoomLabel();
  };

  // The first view people see: zoomed in past "fit" and centred, so there's a
  // comfortable drawing area instead of the whole tiny mural.
  const startView = () => {
    const { w, h } = getViewportSize();
    const scale = fitScaleFor(w, h) * 1.9;
    viewRef.current = {
      scale,
      tx: w / 2 - (CANVAS_WIDTH / 2) * scale,
      ty: h / 2 - (CANVAS_HEIGHT / 2) * scale,
    };
    clampView(viewRef.current);
    syncZoomLabel();
  };

  // Blit the document through the current view: a neutral backdrop (the "table"),
  // a white mural page, then the composited drawing, with a soft page border.
  const blitToDisplay = useCallback(() => {
    const context = displayContextRef.current;
    const doc = docCanvasRef.current;
    const display = displayCanvasRef.current;
    if (!context || !doc || !display) {
      return;
    }
    const dpr = displayDprRef.current || 1;
    const { scale, tx, ty } = viewRef.current;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, display.width, display.height);
    context.fillStyle = "#e9eef4";
    context.fillRect(0, 0, display.width, display.height);
    context.setTransform(scale * dpr, 0, 0, scale * dpr, tx * dpr, ty * dpr);
    context.imageSmoothingEnabled = scale < 2.5;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    context.drawImage(doc, 0, 0);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.strokeStyle = "rgba(45,108,223,0.35)";
    context.lineWidth = Math.max(1, dpr);
    context.strokeRect(tx * dpr, ty * dpr, CANVAS_WIDTH * scale * dpr, CANVAS_HEIGHT * scale * dpr);
  }, []);

  const applyView = () => {
    clampView(viewRef.current);
    syncZoomLabel();
    blitToDisplay();
  };

  // Zoom by `factor` about a focal point given in CSS px within the display box.
  const zoomAt = (factor, fx, fy) => {
    const v = viewRef.current;
    const worldX = (fx - v.tx) / v.scale;
    const worldY = (fy - v.ty) / v.scale;
    v.scale = v.scale * factor;
    clampView(v);
    v.tx = fx - worldX * v.scale;
    v.ty = fy - worldY * v.scale;
    applyView();
  };

  const zoomByButton = (factor) => {
    const { w, h } = getViewportSize();
    zoomAt(factor, w / 2, h / 2);
  };

  const panBy = (dx, dy) => {
    const v = viewRef.current;
    v.tx += dx;
    v.ty += dy;
    applyView();
  };

  // Paint the onion-skin neighbour frames faintly onto the document context.
  // Shared by the full recomposite and the "below" stroke cache so the result
  // is identical whether or not a stroke is in progress.
  const paintOnionSkin = useCallback((context) => {
    if (!onionSkinRef.current || framesRef.current.length <= 1) {
      return;
    }
    const index = activeFrameIndexRef.current;
    const previous = framesRef.current[index - 1];
    const next = framesRef.current[index + 1];
    if (previous) {
      context.globalAlpha = 0.28;
      context.drawImage(compositeFrameToCanvas(previous), 0, 0);
    }
    if (next) {
      context.globalAlpha = 0.2;
      context.drawImage(compositeFrameToCanvas(next), 0, 0);
    }
    context.globalAlpha = 1;
  }, []);

  // Full recomposite of the active frame (onion + every layer) into the document
  // canvas, then blit to the display. Used on stroke-end and on any structural /
  // opacity / visibility / frame change. Invalidates the per-stroke caches since
  // the layer stack they were built from may have changed.
  // Draw the room's coloring sheet (a locked line-art overlay) at the given size.
  const drawSheet = useCallback((context, width = CANVAS_WIDTH, height = CANVAS_HEIGHT) => {
    const img = sheetImageRef.current;
    const rect = sheetRectRef.current;
    if (!img || !rect) {
      return;
    }
    const sx = width / CANVAS_WIDTH;
    const sy = height / CANVAS_HEIGHT;
    context.globalAlpha = 1;
    context.drawImage(img, rect.x * sx, rect.y * sy, rect.w * sx, rect.h * sy);
  }, []);

  const renderDisplay = useCallback(() => {
    const context = docContextRef.current;
    if (!context) {
      return;
    }
    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    paintOnionSkin(context);
    if (sheetModeRef.current === "under") {
      drawSheet(context);
    }
    compositeLayers(context, layersRef.current);
    if (sheetModeRef.current !== "under") {
      drawSheet(context);
    }
    compositeCacheValidRef.current = false;
    blitToDisplay();
  }, [blitToDisplay, drawSheet, paintOnionSkin]);

  // Drop the cached below/above composites so the next stroke rebuilds them.
  const invalidateCompositeCache = useCallback(() => {
    compositeCacheValidRef.current = false;
  }, []);

  // Pre-render the static content around the active layer once at stroke-start
  // (W1/W2): "below" = onion neighbours + all visible layers under the active
  // layer; "above" = all visible layers above it. During the stroke each move
  // only blits below + activeLayer + above into the document canvas.
  const buildCompositeCache = useCallback(() => {
    const activeId = activeLayerIdRef.current;
    const layers = layersRef.current;
    const activeIndex = layers.findIndex((layer) => layer.id === activeId);
    if (activeIndex < 0) {
      compositeCacheValidRef.current = false;
      return false;
    }

    if (!belowCacheRef.current) {
      belowCacheRef.current = createLayerCanvas();
    }
    if (!aboveCacheRef.current) {
      aboveCacheRef.current = createLayerCanvas();
    }

    const belowCtx = belowCacheRef.current.getContext("2d");
    belowCtx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    paintOnionSkin(belowCtx);
    compositeLayerRange(belowCtx, layers, 0, activeIndex);

    const aboveCtx = aboveCacheRef.current.getContext("2d");
    aboveCtx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    compositeLayerRange(aboveCtx, layers, activeIndex + 1, layers.length);

    activeStrokeLayerIdRef.current = activeId;
    compositeCacheValidRef.current = true;
    return true;
  }, [paintOnionSkin]);

  // Fast per-move composite while a stroke is live: below cache + active layer
  // (at its own opacity) + above cache, into the document canvas, then blit.
  // Falls back to a full recomposite if the cache is stale.
  const renderStrokeFrame = useCallback(() => {
    const context = docContextRef.current;
    if (!context) {
      return;
    }
    if (!compositeCacheValidRef.current || activeStrokeLayerIdRef.current !== activeLayerIdRef.current) {
      renderDisplay();
      return;
    }
    const active = layersRef.current.find((layer) => layer.id === activeLayerIdRef.current);
    if (!active) {
      renderDisplay();
      return;
    }
    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    context.globalAlpha = 1;
    if (sheetModeRef.current === "under") {
      drawSheet(context);
    }
    context.drawImage(belowCacheRef.current, 0, 0);
    if (active.visible && active.opacity > 0) {
      context.globalAlpha = active.opacity;
      context.drawImage(active.canvas, 0, 0);
      context.globalAlpha = 1;
    }
    context.drawImage(aboveCacheRef.current, 0, 0);
    if (sheetModeRef.current !== "under") {
      drawSheet(context);
    }
    blitToDisplay();
  }, [blitToDisplay, drawSheet, renderDisplay]);

  // Schedule a single per-move composite per painted frame (W5). Coalesces
  // bursts of pointermove handlers into at most one composite per rAF.
  const scheduleStrokeFrame = useCallback(() => {
    if (rafPendingRef.current) {
      return;
    }
    rafPendingRef.current = window.requestAnimationFrame(() => {
      rafPendingRef.current = 0;
      renderStrokeFrame();
    });
  }, [renderStrokeFrame]);

  // Flush any pending rAF composite immediately (used on stroke-end).
  const flushStrokeFrame = useCallback(() => {
    if (rafPendingRef.current) {
      window.cancelAnimationFrame(rafPendingRef.current);
      rafPendingRef.current = 0;
    }
  }, []);

  // Size the visible display canvas backing store to its CSS box * devicePixel-
  // Ratio so the 1600x1200 document blits in crisp on Retina/tablet screens
  // (W6). The overlay (pointer + shape preview) stays in 1600x1200 doc space so
  // getPoint's rect-normalized mapping is unaffected. Re-blits after resizing.
  const resizeDisplayCanvas = useCallback(() => {
    const display = displayCanvasRef.current;
    if (!display) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const rect = display.getBoundingClientRect();
    const cssWidth = rect.width || display.clientWidth || CANVAS_WIDTH;
    const cssHeight = rect.height || display.clientHeight || CANVAS_HEIGHT;
    const backingWidth = Math.max(1, Math.round(cssWidth * dpr));
    const backingHeight = Math.max(1, Math.round(cssHeight * dpr));
    if (display.width !== backingWidth || display.height !== backingHeight) {
      display.width = backingWidth;
      display.height = backingHeight;
      const context = display.getContext("2d", { alpha: true, desynchronized: true });
      context.imageSmoothingEnabled = true;
      displayContextRef.current = context;
    }
    displayDprRef.current = dpr;
    if (!viewInitRef.current) {
      viewInitRef.current = true;
      startView();
    } else {
      clampView(viewRef.current);
      syncZoomLabel();
    }
    blitToDisplay();
  }, [blitToDisplay]);

  // Push an undo entry. Brush/fill/shape/text ops only touch the ACTIVE layer,
  // so they snapshot just that layer + a lightweight structural descriptor (W4)
  // — roughly Nx less memory than cloning the whole stack. Structural ops
  // (add/delete/reorder/merge/duplicate/visibility) pass scope="full".
  const pushHistory = useCallback(
    (scope = "active") => {
      const entry =
        scope === "full"
          ? snapshotLayers(layersRef.current, activeLayerIdRef.current)
          : snapshotActiveLayer(layersRef.current, activeLayerIdRef.current);
      historyRef.current.push(entry);

      if (historyRef.current.length > MAX_HISTORY) {
        historyRef.current.shift();
      }

      redoRef.current = [];
      updateHistoryCounts();
    },
    [updateHistoryCounts],
  );

  // Capture the current state in the SAME shape as the entry we are about to
  // apply, so undo/redo round-trips correctly for both snapshot kinds.
  const captureInverse = useCallback((entry) => {
    return entry.kind === "active"
      ? snapshotActiveLayer(layersRef.current, activeLayerIdRef.current)
      : snapshotLayers(layersRef.current, activeLayerIdRef.current);
  }, []);

  // Apply a layer snapshot (used by undo/redo). Full snapshots rebuild the whole
  // stack; active snapshots only swap the active layer's pixels back in, leaving
  // every other layer untouched. Ensures the active id still points at a layer.
  const applySnapshot = useCallback(
    (snapshot) => {
      if (snapshot.kind === "active") {
        const target = layersRef.current.find((layer) => layer.id === snapshot.activeLayerId);
        if (target && snapshot.activeCanvas) {
          target.canvas = cloneLayerCanvas(snapshot.activeCanvas);
        } else if (target && !snapshot.activeCanvas) {
          target.canvas.getContext("2d").clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        }
        const stillExists = layersRef.current.some((layer) => layer.id === snapshot.activeLayerId);
        if (stillExists) {
          activeLayerIdRef.current = snapshot.activeLayerId;
        }
      } else {
        layersRef.current = restoreLayersFromSnapshot(snapshot);
        const stillExists = layersRef.current.some((layer) => layer.id === snapshot.activeLayerId);
        activeLayerIdRef.current = stillExists
          ? snapshot.activeLayerId
          : layersRef.current[layersRef.current.length - 1]?.id || null;
      }
      invalidateCompositeCache();
      renderDisplay();
      syncLayerState();
      updateHistoryCounts();
    },
    [invalidateCompositeCache, renderDisplay, syncLayerState, updateHistoryCounts],
  );

  const undo = useCallback(() => {
    const previous = historyRef.current.pop();
    if (!previous) {
      return;
    }
    redoRef.current.push(captureInverse(previous));
    applySnapshot(previous);
    markChanged("Undo");
  }, [applySnapshot, captureInverse, markChanged]);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) {
      return;
    }
    historyRef.current.push(captureInverse(next));
    applySnapshot(next);
    markChanged("Redo");
  }, [applySnapshot, captureInverse, markChanged]);

  // Show the "mural cleared — bring it back" banner for a while (whoever cleared).
  const showClearBanner = useCallback((by) => {
    setClearBanner({ by });
    if (clearBannerTimerRef.current) {
      window.clearTimeout(clearBannerTimerRef.current);
    }
    clearBannerTimerRef.current = window.setTimeout(() => setClearBanner(null), 30000);
  }, []);

  // Ask the room to undo the most recent clear (restores it for everyone).
  const restoreCanvas = useCallback(() => {
    mpRef.current?.sendRestore?.();
    setStatus("Bringing the canvas back…");
  }, []);

  const clearCanvas = useCallback(() => {
    if (layersRef.current.length === 0) {
      return;
    }
    // Clear is a shared wipe: clear EVERY layer (the mural everyone shares) so it
    // empties for all artists, snapshot for local undo, and tell the room.
    pushHistory("full");
    layersRef.current.forEach((layer) => layer.canvas.getContext("2d").clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT));
    remoteStrokeLastRef.current.clear();
    mpRef.current?.sendClear();
    renderDisplay();
    refreshActiveThumbnail();
    markChanged("Canvas cleared");
    showClearBanner("You");
  }, [markChanged, pushHistory, refreshActiveThumbnail, renderDisplay, showClearBanner]);

  // Build the paper-texture background as an offscreen canvas at any size.
  const renderPaper = useCallback(async (context, { width, height, textureId }) => {
    const texture = getTexture(textureId);
    const scaleX = width / CANVAS_WIDTH;
    const scaleY = height / CANVAS_HEIGHT;

    context.fillStyle = texture.background || "#ffffff";
    context.fillRect(0, 0, width, height);

    if (texture.file) {
      try {
        const image = await createImage(texture.file);
        const patternCanvas = document.createElement("canvas");
        const patternContext = patternCanvas.getContext("2d");
        const patternSize = Math.max(96, Math.round(320 * Math.min(scaleX, scaleY)));
        patternCanvas.width = patternSize;
        patternCanvas.height = patternSize;
        patternContext.drawImage(image, 0, 0, patternSize, patternSize);
        context.fillStyle = context.createPattern(patternCanvas, "repeat");
        context.fillRect(0, 0, width, height);
      } catch {
        context.fillStyle = texture.background || "#ffffff";
        context.fillRect(0, 0, width, height);
      }
    }
  }, []);

  // Flatten the layer stack into a single export canvas.
  // transparent = true skips the paper fill (layers only on a clear background).
  const composeCanvas = useCallback(
    async ({ width = CANVAS_WIDTH, height = CANVAS_HEIGHT, textureId = selectedTexture, transparent = false } = {}) => {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      canvas.width = width;
      canvas.height = height;

      if (!transparent) {
        await renderPaper(context, { width, height, textureId });
      }

      if (sheetModeRef.current === "under") {
        drawSheet(context, width, height);
      }
      compositeLayers(context, layersRef.current, { width, height });
      if (sheetModeRef.current !== "under") {
        drawSheet(context, width, height);
      }
      return canvas;
    },
    [drawSheet, renderPaper, selectedTexture],
  );

  // ---- Replay snapshot recorder (snapshot-based, NOT per-stroke) ----

  // Synchronously paint the current composite (a flat paper-tint background plus
  // the live layer stack) into a snapshot-sized context. Synchronous so the
  // recorder can call it off the draw hot path without awaiting an async paper
  // image load (the tinted fill keeps GIFs/replay readable without alpha).
  const paintReplayComposite = useCallback(
    (context, width, height) => {
      const texture = getTexture(settingsRef.current?.texture || selectedTexture);
      context.fillStyle = texture.background || "#ffffff";
      context.fillRect(0, 0, width, height);
      compositeLayers(context, layersRef.current, { width, height });
    },
    [selectedTexture],
  );

  // Debounced persist of the snapshot series to IndexedDB (idle, off hot path).
  const scheduleReplayFlush = useCallback(() => {
    if (replayFlushTimerRef.current) {
      return;
    }
    replayFlushTimerRef.current = window.setTimeout(() => {
      replayFlushTimerRef.current = 0;
      replayRecorderRef.current?.flush();
    }, 5000);
  }, []);

  // Note that the canvas changed so the recorder may take a (debounced, idle)
  // keyframe; capture on a meaningful event when `event` is true (stroke-batch
  // end / layer or frame change). Never blocks the draw hot path — the recorder
  // itself debounces and renders the downscaled snapshot asynchronously.
  const recordReplay = useCallback(
    (event = false) => {
      const recorder = replayRecorderRef.current;
      if (!recorder) {
        return;
      }
      if (event) {
        recorder.captureEvent();
      } else {
        recorder.markDirty();
      }
      scheduleReplayFlush();
    },
    [scheduleReplayFlush],
  );

  // Honest, async draft autosave (W3). Layers are encoded to PNG Blobs and
  // written to IndexedDB (large quota, no base64 inflation). `dirtyRef` is only
  // cleared and "Autosaved" shown when the write actually SUCCEEDS; on any
  // failure (quota, IndexedDB unavailable) we keep `dirtyRef` true so the timer
  // retries and surface a clear "couldn't autosave" status. If IndexedDB is
  // unavailable we fall back to localStorage with the same honest behaviour
  // (this can still hit the ~5MB quota, hence the IndexedDB primary path).
  const saveDraft = useCallback(async () => {
    if (saveInFlightRef.current || layersRef.current.length === 0) {
      return;
    }

    saveInFlightRef.current = true;
    try {
      const savedAt = new Date().toISOString();
      const activeLayerId = activeLayerIdRef.current;
      const settings = settingsRef.current;

      if (isIdbAvailable()) {
        // Encode each layer to a PNG Blob; store Blobs directly (no base64).
        const layerData = [];
        for (const layer of layersRef.current) {
          const blob = await canvasToBlob(layer.canvas);
          layerData.push({
            id: layer.id,
            name: layer.name,
            visible: layer.visible,
            opacity: layer.opacity,
            locked: layer.locked,
            blob,
          });
        }

        await idbSet(DRAFT_IDB_KEY, {
          version: 4,
          layers: layerData,
          activeLayerId,
          settings,
          savedAt,
        });
        // The IndexedDB write is now the source of truth — drop any legacy
        // localStorage draft so it can't shadow it or hold quota.
        try {
          window.localStorage.removeItem(STORAGE_KEYS.draft);
        } catch {
          // ignore — removing a stale key failing is non-fatal
        }
      } else {
        // Fallback: localStorage with base64 dataURLs. Throw on quota failure so
        // we report honestly instead of swallowing it.
        const layerData = [];
        for (const layer of layersRef.current) {
          const dataUrl = await canvasToDataUrl(layer.canvas);
          layerData.push({
            id: layer.id,
            name: layer.name,
            visible: layer.visible,
            opacity: layer.opacity,
            locked: layer.locked,
            image: dataUrl,
          });
        }
        window.localStorage.setItem(
          STORAGE_KEYS.draft,
          JSON.stringify({ layers: layerData, activeLayerId, settings, savedAt }),
        );
      }

      dirtyRef.current = false;
      setStatus("Autosaved");
    } catch {
      // Keep dirtyRef true so the next interval retries, and tell the truth.
      setStatus("Couldn't autosave — storage full");
    } finally {
      saveInFlightRef.current = false;
    }
  }, []);

  const applyDraftSettings = useCallback((draftSettings) => {
    if (!draftSettings) {
      return;
    }
    setSelectedTool(draftSettings.tool || "brush");
    setSelectedBrush(draftSettings.brush || "marker");
    setSelectedColor(draftSettings.color || "#111827");
    setSelectedTexture(draftSettings.texture || "linen");
    setBrushSize(draftSettings.size || 24);
    setBrushOpacity(draftSettings.opacity || 0.86);
    setBrushVariation(draftSettings.variation || 0.08);
    setFillShape(Boolean(draftSettings.fillShape));
    setTextSize(draftSettings.textSize || 64);
  }, []);

  // Rebuild the live layer stack from saved draft layer data.
  const restoreLayersFromDraft = useCallback(
    async (draftLayers) => {
      const rebuilt = [];
      for (const item of draftLayers) {
        const layer = createLayer({
          name: item.name,
          visible: item.visible,
          opacity: typeof item.opacity === "number" ? item.opacity : 1,
          locked: Boolean(item.locked),
        });
        if (item.id) {
          layer.id = item.id;
        }
        // New drafts store a PNG Blob; legacy localStorage drafts store a
        // base64 dataURL under `image`. Support both.
        let image = null;
        if (item.blob) {
          image = await createImageFromBlob(item.blob).catch(() => null);
        } else if (item.image) {
          image = await createImage(item.image).catch(() => null);
        }
        if (image) {
          layer.canvas.getContext("2d").drawImage(image, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        }
        rebuilt.push(layer);
      }

      if (rebuilt.length === 0) {
        return;
      }

      // Drafts restore as a single frame holding the saved layer stack.
      const frame = createFrame({ layers: rebuilt });
      framesRef.current = [frame];
      activeFrameIndexRef.current = 0;
      layersRef.current = frame.layers;
      activeLayerIdRef.current = frame.activeLayerId;
      renderDisplay();
      syncLayerState();
      syncFrameState({ regenerateIds: "all" });
    },
    [renderDisplay, syncFrameState, syncLayerState],
  );

  // Load the saved draft from IndexedDB; if none exists there but a legacy
  // localStorage draft does, fall back to it and migrate it into IndexedDB so
  // existing users never lose their work (W3 back-compat). Returns the draft
  // object (with `layers`) or null. `migrated` tracks whether we already wrote
  // the legacy draft forward so we only delete the localStorage copy once a
  // fresh IndexedDB save has actually succeeded.
  const loadDraft = useCallback(async () => {
    if (isIdbAvailable()) {
      const idbDraft = await idbGet(DRAFT_IDB_KEY).catch(() => null);
      if (idbDraft?.layers?.length) {
        return idbDraft;
      }
    }
    // No IndexedDB draft — try the legacy localStorage draft (base64 layers).
    const legacy = readJson(STORAGE_KEYS.draft, null);
    if (legacy?.layers?.length) {
      return { ...legacy, fromLegacy: true };
    }
    return null;
  }, []);

  const restoreDraft = useCallback(async () => {
    const draft = await loadDraft();

    if (!draft?.layers?.length) {
      setStatus("No saved draft yet");
      return;
    }

    pushHistory("full");
    await restoreLayersFromDraft(draft.layers);

    if (draft.activeLayerId && layersRef.current.some((layer) => layer.id === draft.activeLayerId)) {
      activeLayerIdRef.current = draft.activeLayerId;
      syncLayerState();
    }

    applyDraftSettings(draft.settings);
    // Restoring a legacy localStorage draft schedules a migration to IndexedDB:
    // mark dirty so the autosave timer rewrites it forward (and clears the
    // localStorage copy) on its next tick.
    if (draft.fromLegacy) {
      dirtyRef.current = true;
    }
    markChanged("Draft restored");
  }, [applyDraftSettings, loadDraft, markChanged, pushHistory, restoreLayersFromDraft, syncLayerState]);

  // Persist the gallery array. IndexedDB when available (large quota), else
  // localStorage. Rejects on failure so the caller can surface an honest status
  // instead of silently dropping a saved piece.
  const persistGallery = useCallback(async (items) => {
    if (isIdbAvailable()) {
      await idbSetKV(GALLERY_IDB_KEY, items);
      return;
    }
    // Private-mode fallback: let QuotaExceededError surface (no silent catch).
    window.localStorage.setItem(STORAGE_KEYS.gallery, JSON.stringify(items));
  }, []);

  // Async gallery load: IndexedDB first; if empty there but a legacy localStorage
  // gallery exists, migrate it forward into IndexedDB and clear the localStorage
  // copy so existing users keep their saved pieces. Falls back to localStorage
  // when IndexedDB is unavailable. Never throws (worst case: an empty gallery).
  const loadGallery = useCallback(async () => {
    if (isIdbAvailable()) {
      try {
        const stored = await idbGetKV(GALLERY_IDB_KEY);
        if (Array.isArray(stored)) {
          return stored;
        }
        const legacy = readJson(STORAGE_KEYS.gallery, null);
        if (Array.isArray(legacy) && legacy.length > 0) {
          await idbSetKV(GALLERY_IDB_KEY, legacy);
          try {
            window.localStorage.removeItem(STORAGE_KEYS.gallery);
          } catch {
            // Non-fatal: leaving the legacy key just costs a little quota.
          }
          return legacy;
        }
        return [];
      } catch {
        const legacy = readJson(STORAGE_KEYS.gallery, []);
        return Array.isArray(legacy) ? legacy : [];
      }
    }
    const legacy = readJson(STORAGE_KEYS.gallery, []);
    return Array.isArray(legacy) ? legacy : [];
  }, []);

  const saveToGallery = useCallback(async () => {
    if (layersRef.current.length === 0) {
      return;
    }

    const fullCanvas = await composeCanvas();
    const previewCanvas = await composeCanvas({ width: 400, height: 300 });
    const item = {
      id: makeId("gallery"),
      name: `Happy Paint ${todayName()}`,
      layer: await canvasToDataUrl(fullCanvas),
      textureId: selectedTexture,
      preview: await canvasToDataUrl(previewCanvas),
      createdAt: new Date().toISOString(),
    };

    const next = [item, ...galleryRef.current].slice(0, MAX_GALLERY_ITEMS);
    try {
      await persistGallery(next);
    } catch {
      // Honest failure: don't pretend the save worked.
      setStatus("Couldn't save gallery — storage full");
      return;
    }
    galleryRef.current = next;
    setGallery(next);
    setStatus("Saved to gallery");
    // Best-effort cloud push (debounced; no-op when signed out / local-only).
    schedulePush();
  }, [composeCanvas, persistGallery, selectedTexture]);

  const exportPng = useCallback(async () => {
    const exportCanvas = await composeCanvas();
    const blob = await canvasToBlob(exportCanvas);

    if (blob) {
      downloadBlob(blob, `happy-paint-${Date.now()}.png`);
      setStatus("PNG exported");
    }
  }, [composeCanvas]);

  const exportTransparentPng = useCallback(async () => {
    const exportCanvas = await composeCanvas({ transparent: true });
    const blob = await canvasToBlob(exportCanvas);

    if (blob) {
      downloadBlob(blob, `happy-paint-transparent-${Date.now()}.png`);
      setStatus("Transparent PNG exported");
    }
  }, [composeCanvas]);

  // ---- Saved artwork on the server ("My Art") ----
  const showToast = useCallback((message) => {
    setToast(message);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3600);
  }, []);

  const loadMyDrawings = useCallback(async () => {
    const key = userKeyRef.current;
    if (!key) {
      return;
    }
    try {
      const res = await fetch(`/api/artworks?userKey=${encodeURIComponent(key)}`, { cache: "no-store" });
      const data = await res.json();
      setMyDrawings(Array.isArray(data.items) ? data.items : []);
      if (data.max) {
        setSavesMax(data.max);
      }
    } catch {
      // Offline / server down — leave the list as-is.
    }
  }, []);

  const saveToServer = useCallback(async () => {
    const key = userKeyRef.current;
    if (!key || savingArt) {
      return;
    }
    setSavingArt(true);
    showToast("Saving…");
    try {
      const full = await composeCanvas({ width: 1600, height: 1000 });
      const preview = await composeCanvas({ width: 320, height: 200 });
      const image = await canvasToDataUrl(full);
      const thumb = await canvasToDataUrl(preview);
      const res = await fetch("/api/artworks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userKey: key, name: `Drawing ${todayName()}`, image, thumb }),
      });
      if (res.status === 409) {
        const data = await res.json().catch(() => ({ max: savesMax }));
        showToast(`You've saved the max (${data.max}). Open 📁 My Art and delete one first.`);
        return;
      }
      if (!res.ok) {
        throw new Error("save failed");
      }
      const data = await res.json();
      showToast(`Saved! 🎉 (${data.count}/${data.max}) — find it in 📁 My Art`);
      await loadMyDrawings();
    } catch {
      showToast("Couldn't save — please try again");
    } finally {
      setSavingArt(false);
    }
  }, [composeCanvas, loadMyDrawings, savesMax, savingArt, showToast]);

  const openDrawing = useCallback(
    async (id) => {
      const key = userKeyRef.current;
      if (!key) {
        return;
      }
      try {
        const res = await fetch(`/api/artworks/${id}?userKey=${encodeURIComponent(key)}`, { cache: "no-store" });
        if (!res.ok) {
          throw new Error("not found");
        }
        const data = await res.json();
        const image = await createImage(data.image).catch(() => null);
        if (!image) {
          throw new Error("decode failed");
        }
        pushHistory("full");
        const layer = createLayer({ name: "Saved art" });
        layer.canvas.getContext("2d").drawImage(image, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        const frame = createFrame({ layers: [layer] });
        framesRef.current = [frame];
        activeFrameIndexRef.current = 0;
        layersRef.current = frame.layers;
        activeLayerIdRef.current = frame.activeLayerId;
        renderDisplay();
        syncLayerState();
        syncFrameState();
        setShowMyArt(false);
        markChanged("Opened your saved drawing");
        showToast("Opened — keep drawing! ✏️");
      } catch {
        showToast("Couldn't open that drawing");
      }
    },
    [markChanged, renderDisplay, showToast, syncFrameState, syncLayerState],
  );

  const deleteDrawing = useCallback(
    async (id) => {
      const key = userKeyRef.current;
      if (!key) {
        return;
      }
      try {
        await fetch(`/api/artworks/${id}?userKey=${encodeURIComponent(key)}`, { method: "DELETE" });
      } catch {
        // ignore
      }
      await loadMyDrawings();
    },
    [loadMyDrawings],
  );

  // Import a GIF / image (open to everyone) and stamp it onto the active layer,
  // centred in the current view, then broadcast it so friends see it too.
  const importImage = useCallback(
    async (file) => {
      if (!file) {
        return;
      }
      const active = getActiveLayer();
      if (!active) {
        return;
      }
      if (active.locked || !active.visible) {
        setStatus(active.locked ? "Layer is locked" : "Layer is hidden");
        return;
      }
      setStatus("Importing…");
      const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => resolve("");
        reader.readAsDataURL(file);
      });
      const image = dataUrl ? await createImage(dataUrl).catch(() => null) : null;
      if (!image) {
        setStatus("Couldn't load that image");
        return;
      }
      const maxW = CANVAS_WIDTH * 0.45;
      const maxH = CANVAS_HEIGHT * 0.45;
      const ratio = Math.min(maxW / image.width, maxH / image.height, 1);
      const w = Math.max(1, Math.round(image.width * ratio));
      const h = Math.max(1, Math.round(image.height * ratio));
      const { scale, tx, ty } = viewRef.current;
      const vs = getViewportSize();
      const cx = (vs.w / 2 - tx) / scale;
      const cy = (vs.h / 2 - ty) / scale;
      const x = Math.round(cx - w / 2);
      const y = Math.round(cy - h / 2);
      pushHistory();
      active.canvas.getContext("2d").drawImage(image, x, y, w, h);
      renderDisplay();
      refreshActiveThumbnail();
      mpRef.current?.sendOp({ kind: "image", dataUrl, x, y, w, h });
      markChanged("Image added");
    },
    [getActiveLayer, markChanged, pushHistory, refreshActiveThumbnail, renderDisplay],
  );

  const sharePng = useCallback(async () => {
    const exportCanvas = await composeCanvas();
    const blob = await canvasToBlob(exportCanvas);

    if (!blob) {
      return;
    }

    const file = new File([blob], "happy-paint.png", { type: "image/png" });

    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: "Happy Paint",
      });
      setStatus("Shared");
    } else {
      downloadBlob(blob, `happy-paint-${Date.now()}.png`);
      setStatus("Sharing unavailable, PNG exported");
    }
  }, [composeCanvas]);

  // Restore a flattened gallery item onto a fresh single layer.
  const restoreGalleryItem = useCallback(
    async (item) => {
      pushHistory("full");
      setSelectedTexture(item.textureId || "linen");

      const layer = createLayer({ name: "Artwork" });
      const image = await createImage(item.layer).catch(() => null);
      if (image) {
        layer.canvas.getContext("2d").drawImage(image, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      }
      const frame = createFrame({ layers: [layer] });
      framesRef.current = [frame];
      activeFrameIndexRef.current = 0;
      layersRef.current = frame.layers;
      activeLayerIdRef.current = frame.activeLayerId;
      renderDisplay();
      syncLayerState();
      syncFrameState();
      markChanged("Artwork restored");
    },
    [markChanged, pushHistory, renderDisplay, syncFrameState, syncLayerState],
  );

  const chooseBrush = useCallback(
    (brushId) => {
      const brush = brushCatalog.find((item) => item.id === brushId);

      if (brush?.tier === "studio" && !studioUnlocked) {
        setShowStore(true);
        setStatus("Studio brush — unlock with the Creator Brushes pack");
        return;
      }

      setSelectedBrush(brushId);
      setSelectedTool("brush");
      // Picking a brush means you want to draw — drop out of the pan/hand tool.
      handToolRef.current = false;
      setHandTool(false);
    },
    [studioUnlocked],
  );

  const chooseTexture = useCallback(
    (textureId) => {
      const texture = paperTextures.find((item) => item.id === textureId);

      if (texture?.tier === "studio" && !studioUnlocked) {
        setShowStore(true);
        setStatus("Studio paper — unlock with the Creator Brushes pack");
        return;
      }

      setSelectedTexture(textureId);
    },
    [studioUnlocked],
  );

  // Track recently used colors so palettes can be saved to the Paint Space.
  const rememberColor = useCallback((color) => {
    setRecentColors((current) => {
      const next = [color, ...current.filter((item) => item !== color)];
      return next.slice(0, MAX_PALETTE_COLORS);
    });
  }, []);

  const choosePaletteColor = useCallback(
    (color) => {
      setSelectedColor(color);
      rememberColor(color);
      handToolRef.current = false;
      setHandTool(false);
    },
    [rememberColor],
  );

  const getPoint = useCallback((event) => {
    const canvas = displayCanvasRef.current;
    const rect = activeCanvasRectRef.current || canvas.getBoundingClientRect();
    const { scale, tx, ty } = viewRef.current;
    const cssX = event.clientX - rect.left;
    const cssY = event.clientY - rect.top;
    const pressure = event.pressure && event.pressure > 0 ? event.pressure : event.pointerType === "mouse" ? 0.62 : 0.72;

    // Screen (CSS px) -> world coords through the current view.
    return {
      x: (cssX - tx) / scale,
      y: (cssY - ty) / scale,
      pressure,
    };
  }, []);

  // Send the buffered points of the in-progress stroke to the room. Throttled
  // to ~40ms unless `force` (stroke end) so volume stays sane while feeling live.
  const flushStrokeNet = useCallback((force) => {
    const net = strokeNetRef.current;
    const mp = mpRef.current;
    if (!net || !mp || net.pending.length === 0) {
      return;
    }
    const now = Date.now();
    if (!force && now - net.lastSent < 40) {
      return;
    }
    net.lastSent = now;
    const points = net.pending;
    net.pending = [];
    mp.sendOp({ kind: "draw", strokeId: net.id, settings: net.settings, points });
  }, []);

  // Relay this pointer's position to the room as a live cursor (throttled to
  // ~50ms). Coordinates are normalised 0..1 so each friend can place the cursor
  // correctly regardless of their own canvas size. `drawing` reflects whether a
  // stroke is in progress so the cursor can pulse while painting.
  const sendCursorThrottled = useCallback(
    (event) => {
      const mp = mpRef.current;
      if (!mp) {
        return;
      }
      const now = Date.now();
      if (now - cursorSentAtRef.current < 50) {
        return;
      }
      cursorSentAtRef.current = now;
      const p = getPoint(event.nativeEvent);
      mp.sendCursor(p.x / CANVAS_WIDTH, p.y / CANVAS_HEIGHT, activePointerRef.current === event.pointerId);
    },
    [getPoint],
  );

  const drawBrushFromEvent = useCallback(
    (event) => {
      const settings = settingsRef.current;
      const active = getActiveLayer();

      if (!settings || !active || activePointerRef.current !== event.pointerId) {
        return;
      }

      const context = active.canvas.getContext("2d");
      const nativeEvent = event.nativeEvent;
      const coalescedEvents = typeof nativeEvent.getCoalescedEvents === "function" ? nativeEvent.getCoalescedEvents() : [];
      const events = coalescedEvents.length > 0 ? coalescedEvents : [nativeEvent];

      const net = strokeNetRef.current;
      for (const pointerEvent of events) {
        const point = getPoint(pointerEvent);
        const lastPoint = lastPointRef.current || point;
        drawBrushSegment(context, lastPoint, point, settings);
        lastPointRef.current = point;
        if (net) {
          net.pending.push({ x: Math.round(point.x), y: Math.round(point.y), pressure: point.pressure });
        }
      }

      // Stream the buffered points to the room (throttled), so friends see the
      // stroke grow live rather than only on pen-up.
      flushStrokeNet(false);

      // Coalesced, cache-backed display update (W1/W2/W5): at most one
      // below + active + above composite per painted frame.
      scheduleStrokeFrame();
    },
    [flushStrokeNet, getActiveLayer, getPoint, scheduleStrokeFrame],
  );

  // ---- Pointer lifecycle. Branches by tool but shares capture/setup. ----

  const beginInteraction = useCallback(
    (event) => {
      if (event.button !== undefined && event.button !== 0) {
        return false;
      }

      const active = getActiveLayer();
      if (!active) {
        return false;
      }

      if (active.locked) {
        setStatus("Layer is locked");
        return false;
      }

      if (!active.visible) {
        setStatus("Layer is hidden");
        return false;
      }

      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      activePointerRef.current = event.pointerId;
      activeCanvasRectRef.current = event.currentTarget.getBoundingClientRect();
      return true;
    },
    [getActiveLayer],
  );

  // Decide whether to ignore a pointerdown for palm rejection / pen priority
  // (W14). Conservative: pen always wins and is remembered; once a pen has been
  // used, touch contacts are ignored (the user is drawing with the pen and
  // resting their hand); and any touch with a large contact patch is treated as
  // a palm. Mouse and a normal lone finger are never rejected.
  const shouldRejectPointer = useCallback((event) => {
    const type = event.pointerType;
    if (type === "pen") {
      penSeenRef.current = true;
      return false;
    }
    if (type === "touch") {
      if (penSeenRef.current) {
        return true; // Prefer the pen; ignore resting-hand / second-finger touches.
      }
      // Palm heuristic: real fingertips report a small contact patch. A large
      // width/height is almost certainly a palm or forearm resting on a tablet.
      const PALM_CONTACT = 45; // CSS px
      if ((event.width || 0) > PALM_CONTACT || (event.height || 0) > PALM_CONTACT) {
        return true;
      }
    }
    return false;
  }, []);

  const startStroke = useCallback(
    (event) => {
      if (shouldRejectPointer(event)) {
        return;
      }
      const settings = settingsRef.current;
      const tool = settings?.tool || "brush";

      // Fill is a single click: commit immediately, no drag.
      if (tool === "fill") {
        if (event.button !== undefined && event.button !== 0) {
          return;
        }
        const active = getActiveLayer();
        if (!active) {
          return;
        }
        if (active.locked || !active.visible) {
          setStatus(active.locked ? "Layer is locked" : "Layer is hidden");
          return;
        }
        event.preventDefault();
        activeCanvasRectRef.current = event.currentTarget.getBoundingClientRect();
        const point = getPoint(event.nativeEvent);
        pushHistory();
        const filled = floodFill(active.canvas, point.x, point.y, settings.color, {
          tolerance: 0.16,
          opacity: settings.opacity,
        });
        if (filled) {
          renderDisplay();
          refreshActiveThumbnail();
          recordReplay(true);
          markChanged("Filled");
        } else {
          historyRef.current.pop();
          updateHistoryCounts();
        }
        activeCanvasRectRef.current = null;
        return;
      }

      // Text is placed via a prompt at the click point.
      if (tool === "text") {
        if (event.button !== undefined && event.button !== 0) {
          return;
        }
        const active = getActiveLayer();
        if (!active) {
          return;
        }
        if (active.locked || !active.visible) {
          setStatus(active.locked ? "Layer is locked" : "Layer is hidden");
          return;
        }
        event.preventDefault();
        activeCanvasRectRef.current = event.currentTarget.getBoundingClientRect();
        const point = getPoint(event.nativeEvent);
        activeCanvasRectRef.current = null;
        const text = window.prompt("Enter text:");
        if (text) {
          pushHistory();
          drawText(active.canvas.getContext("2d"), point, text, {
            color: settings.color,
            opacity: settings.opacity,
            fontSize: settings.textSize,
          });
          mpRef.current?.sendOp({
            kind: "text",
            point: { x: point.x, y: point.y },
            text,
            opts: { color: settings.color, opacity: settings.opacity, fontSize: settings.textSize },
          });
          renderDisplay();
          refreshActiveThumbnail();
          recordReplay(true);
          markChanged("Text added");
        }
        return;
      }

      if (!beginInteraction(event)) {
        return;
      }

      if (tool === "rect" || tool === "ellipse" || tool === "line") {
        shapeStartRef.current = getPoint(event.nativeEvent);
        return;
      }

      // Default: brush / eraser stroke. Pre-render the static below/above
      // composite ONCE here so each move only blits 3 layers (W1/W2).
      lastPointRef.current = getPoint(event.nativeEvent);
      pushHistory();
      buildCompositeCache();
      // Open an outgoing network stroke so each painted point streams to friends.
      strokeNetRef.current = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        settings: {
          brush: settings.brush,
          color: settings.color,
          size: settings.size,
          opacity: settings.opacity,
          variation: settings.variation,
        },
        pending: [],
        lastSent: 0,
      };
      drawBrushFromEvent(event);
      markChanged("Drawing");
    },
    [beginInteraction, buildCompositeCache, drawBrushFromEvent, getActiveLayer, getPoint, markChanged, pushHistory, recordReplay, refreshActiveThumbnail, renderDisplay, shouldRejectPointer, updateHistoryCounts],
  );

  const continueStroke = useCallback(
    (event) => {
      // Relay a live cursor even while not painting (hover presence).
      sendCursorThrottled(event);

      if (activePointerRef.current !== event.pointerId) {
        return;
      }

      event.preventDefault();
      const tool = settingsRef.current?.tool || "brush";

      if (tool === "rect" || tool === "ellipse" || tool === "line") {
        // Preview shape on the overlay so the active layer stays clean. Clear
        // only the previous preview's bounding box (plus a margin to cover the
        // stroke width / round caps), not the entire 1600x1200 overlay (W11).
        const overlay = overlayContextRef.current;
        const start = shapeStartRef.current;
        if (overlay && start) {
          const prev = shapePreviewRectRef.current;
          if (prev) {
            overlay.clearRect(prev.x, prev.y, prev.w, prev.h);
          }
          const end = getPoint(event.nativeEvent);
          drawShape(overlay, tool, start, end, {
            color: settingsRef.current.color,
            size: settingsRef.current.size,
            opacity: settingsRef.current.opacity,
            fillShape: settingsRef.current.fillShape,
          });
          // Record this preview's bbox (with a margin) for the next clear.
          const margin = Math.max(2, settingsRef.current.size || 1) + 4;
          const x = Math.min(start.x, end.x) - margin;
          const y = Math.min(start.y, end.y) - margin;
          const w = Math.abs(end.x - start.x) + margin * 2;
          const h = Math.abs(end.y - start.y) + margin * 2;
          shapePreviewRectRef.current = { x, y, w, h };
        }
        return;
      }

      drawBrushFromEvent(event);
    },
    [drawBrushFromEvent, getPoint],
  );

  const finishStroke = useCallback(
    (event) => {
      if (activePointerRef.current !== event.pointerId) {
        return;
      }

      event.preventDefault();
      event.currentTarget.releasePointerCapture?.(event.pointerId);

      const tool = settingsRef.current?.tool || "brush";

      if (tool === "rect" || tool === "ellipse" || tool === "line") {
        const overlay = overlayContextRef.current;
        const start = shapeStartRef.current;
        const active = getActiveLayer();
        if (start && active) {
          const end = getPoint(event.nativeEvent);
          pushHistory();
          const shapeOpts = {
            color: settingsRef.current.color,
            size: settingsRef.current.size,
            opacity: settingsRef.current.opacity,
            fillShape: settingsRef.current.fillShape,
          };
          drawShape(active.canvas.getContext("2d"), tool, start, end, shapeOpts);
          mpRef.current?.sendOp({
            kind: "shape",
            tool,
            start: { x: start.x, y: start.y },
            end: { x: end.x, y: end.y },
            opts: shapeOpts,
          });
          renderDisplay();
          markChanged("Shape added");
        }
        if (overlay) {
          overlay.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        }
        shapeStartRef.current = null;
        shapePreviewRectRef.current = null;
      } else {
        // Brush/eraser: push the tail of the stroke to the room, then flush any
        // pending per-move composite and do one full recomposite (this also
        // invalidates the per-stroke caches).
        flushStrokeNet(true);
        strokeNetRef.current = null;
        flushStrokeFrame();
        renderDisplay();
        markChanged("Stroke saved");
      }

      activePointerRef.current = null;
      activeCanvasRectRef.current = null;
      lastPointRef.current = null;
      activeStrokeLayerIdRef.current = null;
      invalidateCompositeCache();
      updateHistoryCounts();
      refreshActiveThumbnail();
      // Stroke-batch end: mark the recorder dirty so a timed keyframe is taken.
      recordReplay(false);
    },
    [flushStrokeFrame, getActiveLayer, getPoint, invalidateCompositeCache, markChanged, pushHistory, recordReplay, refreshActiveThumbnail, renderDisplay, updateHistoryCounts],
  );

  // ---- Pointer routing: draw vs. pan/zoom ----------------------------------
  // One finger / mouse draws (unless the hand tool is on); two fingers pan and
  // pinch-zoom; the wheel zooms about the cursor. We track every active pointer
  // so a second finger can take over a stroke as a gesture.

  const abortActiveStroke = () => {
    if (activePointerRef.current != null) {
      flushStrokeFrame();
      strokeNetRef.current = null;
      activePointerRef.current = null;
      lastPointRef.current = null;
      activeStrokeLayerIdRef.current = null;
      invalidateCompositeCache();
      renderDisplay();
    }
  };

  const handleCanvasPointerDown = (event) => {
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewRectRef.current = event.currentTarget.getBoundingClientRect();

    if (pointersRef.current.size >= 2) {
      abortActiveStroke();
      const pts = [...pointersRef.current.values()];
      gestureRef.current = {
        lastDist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
        lastMid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
      };
      return;
    }

    if (handToolRef.current) {
      panPointerRef.current = event.pointerId;
      panLastRef.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }

    startStroke(event);
  };

  const handleCanvasPointerMove = (event) => {
    if (pointersRef.current.has(event.pointerId)) {
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    if (gestureRef.current) {
      const pts = [...pointersRef.current.values()];
      if (pts.length < 2) {
        return;
      }
      const rect = viewRectRef.current || event.currentTarget.getBoundingClientRect();
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const g = gestureRef.current;
      panBy(mid.x - g.lastMid.x, mid.y - g.lastMid.y);
      zoomAt(dist / g.lastDist, mid.x - rect.left, mid.y - rect.top);
      g.lastDist = dist;
      g.lastMid = mid;
      return;
    }

    if (panPointerRef.current === event.pointerId) {
      panBy(event.clientX - panLastRef.current.x, event.clientY - panLastRef.current.y);
      panLastRef.current = { x: event.clientX, y: event.clientY };
      return;
    }

    continueStroke(event);
  };

  const handleCanvasPointerUp = (event) => {
    pointersRef.current.delete(event.pointerId);

    if (gestureRef.current) {
      if (pointersRef.current.size < 2) {
        gestureRef.current = null;
      }
      return;
    }
    if (panPointerRef.current === event.pointerId) {
      panPointerRef.current = null;
      return;
    }
    finishStroke(event);
  };

  const toggleHandTool = () => {
    setHandTool((on) => {
      handToolRef.current = !on;
      return !on;
    });
  };

  // ---- Layer actions (mutate refs, snapshot before, then sync state) ----

  const handleSelectLayer = useCallback(
    (id) => {
      activeLayerIdRef.current = id;
      syncLayerState();
    },
    [syncLayerState],
  );

  const handleAddLayer = useCallback(() => {
    if (layersRef.current.length >= MAX_LAYERS) {
      setStatus(`Layer limit reached (${MAX_LAYERS} max)`);
      return;
    }
    pushHistory("full");
    const layer = createLayer({ name: `Layer ${layersRef.current.length + 1}` });
    layersRef.current = [...layersRef.current, layer];
    activeLayerIdRef.current = layer.id;
    renderDisplay();
    syncLayerState();
    recordReplay(true);
    markChanged("Layer added");
  }, [markChanged, pushHistory, recordReplay, renderDisplay, syncLayerState]);

  const handleDeleteLayer = useCallback(
    (id) => {
      if (layersRef.current.length <= 1) {
        return;
      }
      pushHistory("full");
      const index = layersRef.current.findIndex((layer) => layer.id === id);
      layersRef.current = layersRef.current.filter((layer) => layer.id !== id);
      if (activeLayerIdRef.current === id) {
        const fallback = layersRef.current[Math.max(0, index - 1)] || layersRef.current[0];
        activeLayerIdRef.current = fallback?.id || null;
      }
      renderDisplay();
      syncLayerState();
      recordReplay(true);
      markChanged("Layer deleted");
    },
    [markChanged, pushHistory, recordReplay, renderDisplay, syncLayerState],
  );

  const handleDuplicateLayer = useCallback(
    (id) => {
      if (layersRef.current.length >= MAX_LAYERS) {
        setStatus(`Layer limit reached (${MAX_LAYERS} max)`);
        return;
      }
      const index = layersRef.current.findIndex((layer) => layer.id === id);
      const source = layersRef.current[index];
      if (!source) {
        return;
      }
      pushHistory("full");
      const copy = createLayer({
        name: `${source.name} copy`,
        visible: source.visible,
        opacity: source.opacity,
        locked: source.locked,
      });
      copy.canvas = cloneLayerCanvas(source.canvas);
      const next = layersRef.current.slice();
      next.splice(index + 1, 0, copy);
      layersRef.current = next;
      activeLayerIdRef.current = copy.id;
      renderDisplay();
      syncLayerState();
      markChanged("Layer duplicated");
    },
    [markChanged, pushHistory, renderDisplay, syncLayerState],
  );

  // Merge a layer down onto the one below it (respecting opacity), then remove it.
  const handleMergeDown = useCallback(
    (id) => {
      const index = layersRef.current.findIndex((layer) => layer.id === id);
      if (index <= 0) {
        return;
      }
      pushHistory("full");
      const upper = layersRef.current[index];
      const lower = layersRef.current[index - 1];
      const context = lower.canvas.getContext("2d");
      context.globalAlpha = upper.opacity;
      context.drawImage(upper.canvas, 0, 0);
      context.globalAlpha = 1;
      layersRef.current = layersRef.current.filter((layer) => layer.id !== id);
      if (activeLayerIdRef.current === id) {
        activeLayerIdRef.current = lower.id;
      }
      renderDisplay();
      syncLayerState();
      markChanged("Merged down");
    },
    [markChanged, pushHistory, renderDisplay, syncLayerState],
  );

  const moveLayer = useCallback(
    (id, direction) => {
      const index = layersRef.current.findIndex((layer) => layer.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= layersRef.current.length) {
        return;
      }
      pushHistory("full");
      const next = layersRef.current.slice();
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      layersRef.current = next;
      renderDisplay();
      syncLayerState();
      markChanged("Layer reordered");
    },
    [markChanged, pushHistory, renderDisplay, syncLayerState],
  );

  const handleMoveUp = useCallback((id) => moveLayer(id, 1), [moveLayer]);
  const handleMoveDown = useCallback((id) => moveLayer(id, -1), [moveLayer]);

  const handleToggleVisible = useCallback(
    (id) => {
      const layer = layersRef.current.find((item) => item.id === id);
      if (!layer) {
        return;
      }
      layer.visible = !layer.visible;
      renderDisplay();
      syncLayerState();
      markChanged(layer.visible ? "Layer shown" : "Layer hidden");
    },
    [markChanged, renderDisplay, syncLayerState],
  );

  const handleToggleLock = useCallback(
    (id) => {
      const layer = layersRef.current.find((item) => item.id === id);
      if (!layer) {
        return;
      }
      layer.locked = !layer.locked;
      syncLayerState();
      markChanged(layer.locked ? "Layer locked" : "Layer unlocked");
    },
    [markChanged, syncLayerState],
  );

  // Take the single undo snapshot for an opacity drag (W13). Called on the
  // slider's pointerdown/focus so the whole drag collapses to one history entry
  // instead of one per tick.
  const handleOpacityDragStart = useCallback(() => {
    if (opacityDragActiveRef.current) {
      return;
    }
    opacityDragActiveRef.current = true;
    pushHistory("full");
  }, [pushHistory]);

  const handleOpacityDragEnd = useCallback(() => {
    opacityDragActiveRef.current = false;
    // Flush any pending throttled recomposite so the final opacity is shown.
    if (opacityRafRef.current) {
      window.cancelAnimationFrame(opacityRafRef.current);
      opacityRafRef.current = 0;
    }
    renderDisplay();
  }, [renderDisplay]);

  const handleOpacityChange = useCallback(
    (id, opacity) => {
      const layer = layersRef.current.find((item) => item.id === id);
      if (!layer) {
        return;
      }
      // If the change arrives without a preceding drag-start (e.g. keyboard
      // arrow on the slider), still snapshot once so it stays undoable.
      if (!opacityDragActiveRef.current) {
        handleOpacityDragStart();
      }
      layer.opacity = opacity;
      // Sync the UI state immediately (cheap), but rAF-throttle the heavier full
      // recomposite so dragging the slider doesn't recomposite per tick (W13).
      syncLayerState();
      dirtyRef.current = true;
      if (!opacityRafRef.current) {
        opacityRafRef.current = window.requestAnimationFrame(() => {
          opacityRafRef.current = 0;
          renderDisplay();
        });
      }
    },
    [handleOpacityDragStart, renderDisplay, syncLayerState],
  );

  const handleRenameLayer = useCallback(
    (id) => {
      const layer = layersRef.current.find((item) => item.id === id);
      if (!layer) {
        return;
      }
      const name = window.prompt("Rename layer:", layer.name);
      if (name && name.trim()) {
        layer.name = name.trim();
        syncLayerState();
        markChanged("Layer renamed");
      }
    },
    [markChanged, syncLayerState],
  );

  // ---- Frame (Tiny Animation Loops) actions ----

  // ---- Playback preview: cycle frames at their durations on the display. ----

  const stopPlayback = useCallback(() => {
    if (playTimerRef.current) {
      window.cancelAnimationFrame(playTimerRef.current);
      playTimerRef.current = null;
    }
    setIsPlaying(false);
    // Restore the active frame's editable composite.
    renderDisplay();
  }, [renderDisplay]);

  // Playback uses a requestAnimationFrame loop with a timestamp accumulator
  // (W17) instead of a drifting setTimeout chain: each rAF advances by the real
  // elapsed time, so authored per-frame durations are honoured even when the
  // tab was just unthrottled, and timers don't pile up in background tabs.
  const startPlayback = useCallback(() => {
    if (framesRef.current.length <= 1) {
      return;
    }
    commitLayersToFrame();
    setIsPlaying(true);
    const context = docContextRef.current;
    let cursor = 0;
    let lastTime = 0;
    let accumulator = 0;

    const paintFrame = (frame) => {
      // Composite the frame into the art-resolution document, then blit it to
      // the DPR-sized display canvas (same path as editing — stays crisp).
      context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      compositeLayers(context, frame.layers);
      blitToDisplay();
    };

    const step = (timestamp) => {
      const frames = framesRef.current;
      if (frames.length === 0) {
        return;
      }
      if (lastTime === 0) {
        // First tick: show frame 0 immediately and start the clock.
        lastTime = timestamp;
        paintFrame(frames[0]);
        playTimerRef.current = window.requestAnimationFrame(step);
        return;
      }
      accumulator += timestamp - lastTime;
      lastTime = timestamp;
      // Advance as many frames as the elapsed time covers (catch up after a
      // background-throttle pause), clamping each duration like the old loop.
      let advanced = false;
      let guard = 0;
      let duration = Math.max(40, frames[cursor % frames.length].durationMs);
      while (accumulator >= duration && guard < frames.length + 1) {
        accumulator -= duration;
        cursor += 1;
        advanced = true;
        guard += 1;
        duration = Math.max(40, frames[cursor % frames.length].durationMs);
      }
      if (advanced) {
        paintFrame(frames[cursor % frames.length]);
      }
      playTimerRef.current = window.requestAnimationFrame(step);
    };

    playTimerRef.current = window.requestAnimationFrame(step);
  }, [blitToDisplay, commitLayersToFrame]);

  const handleTogglePlay = useCallback(() => {
    if (playTimerRef.current) {
      stopPlayback();
    } else {
      startPlayback();
    }
  }, [startPlayback, stopPlayback]);

  // Point the live layer view at a frame and repaint.
  const activateFrame = useCallback(
    (index) => {
      const clamped = Math.max(0, Math.min(index, framesRef.current.length - 1));
      activeFrameIndexRef.current = clamped;
      const frame = framesRef.current[clamped];
      layersRef.current = frame.layers;
      activeLayerIdRef.current = frame.activeLayerId;
      // History is per-frame editing context; clear so undo never crosses frames.
      historyRef.current = [];
      redoRef.current = [];
      updateHistoryCounts();
      renderDisplay();
      syncLayerState();
      setActiveFrameIndex(clamped);
      recordReplay(true);
    },
    [recordReplay, renderDisplay, syncLayerState, updateHistoryCounts],
  );

  const handleSelectFrame = useCallback(
    (index) => {
      if (index === activeFrameIndexRef.current) {
        return;
      }
      if (playTimerRef.current) {
        stopPlayback();
      }
      activateFrame(index);
      markChanged(`Frame ${index + 1}`);
    },
    [activateFrame, markChanged, stopPlayback],
  );

  const handleAddFrame = useCallback(() => {
    if (framesRef.current.length >= MAX_FRAMES) {
      setStatus(`Loops are capped at ${MAX_FRAMES} frames`);
      return;
    }
    commitLayersToFrame();
    const blank = createFrame({ layers: createDefaultLayers() });
    const insertAt = activeFrameIndexRef.current + 1;
    framesRef.current.splice(insertAt, 0, blank);
    activateFrame(insertAt);
    syncFrameState();
    markChanged("Frame added");
  }, [activateFrame, commitLayersToFrame, syncFrameState, markChanged]);

  const handleDuplicateFrame = useCallback(
    (index) => {
      if (framesRef.current.length >= MAX_FRAMES) {
        setStatus(`Loops are capped at ${MAX_FRAMES} frames`);
        return;
      }
      commitLayersToFrame();
      const source = framesRef.current[index];
      if (!source) {
        return;
      }
      const copy = cloneFrame(source);
      framesRef.current.splice(index + 1, 0, copy);
      activateFrame(index + 1);
      syncFrameState();
      markChanged("Frame duplicated");
    },
    [activateFrame, commitLayersToFrame, syncFrameState, markChanged],
  );

  const handleDeleteFrame = useCallback(
    (index) => {
      if (framesRef.current.length <= 1) {
        return;
      }
      framesRef.current.splice(index, 1);
      const nextIndex = Math.max(0, index - 1);
      activateFrame(nextIndex);
      syncFrameState();
      markChanged("Frame deleted");
    },
    [activateFrame, syncFrameState, markChanged],
  );

  const handleMoveFrame = useCallback(
    (index, direction) => {
      const target = index + direction;
      if (target < 0 || target >= framesRef.current.length) {
        return;
      }
      commitLayersToFrame();
      const list = framesRef.current;
      const [moved] = list.splice(index, 1);
      list.splice(target, 0, moved);
      activateFrame(target);
      syncFrameState();
      markChanged("Frame reordered");
    },
    [activateFrame, commitLayersToFrame, syncFrameState, markChanged],
  );

  const handleFrameDurationChange = useCallback(
    (index, durationMs) => {
      const frame = framesRef.current[index];
      if (!frame) {
        return;
      }
      frame.durationMs = durationMs;
      setFrames(framesRef.current.map((item) => ({ id: item.id, durationMs: item.durationMs })));
      dirtyRef.current = true;
    },
    [],
  );

  const handleToggleOnion = useCallback(() => {
    setOnionSkin((value) => {
      const next = !value;
      onionSkinRef.current = next;
      renderDisplay();
      return next;
    });
  }, [renderDisplay]);

  // ---- GIF export: composite each frame (paper + layers) downscaled to
  // ImageData, then encode off the main thread in a Web Worker so the tab never
  // freezes during quantization + LZW (W7). Falls back to a synchronous encode
  // if a Worker can't be created. ----

  // Lazily create the GIF worker. Returns null if Workers are unsupported or
  // construction throws (we then fall back to the synchronous encoder).
  const getGifWorker = useCallback(() => {
    if (gifWorkerRef.current !== null) {
      return gifWorkerRef.current || null;
    }
    try {
      gifWorkerRef.current = new Worker(new URL("./utils/gif.worker.js", import.meta.url), {
        type: "module",
      });
    } catch {
      gifWorkerRef.current = false; // sentinel: tried, unavailable
    }
    return gifWorkerRef.current || null;
  }, []);

  const exportGif = useCallback(async () => {
    if (isExportingGif) {
      return;
    }
    if (playTimerRef.current) {
      stopPlayback();
    }
    commitLayersToFrame();
    setIsExportingGif(true);
    setStatus("Encoding GIF…");

    try {
      // Composite each frame (paper + visible layers) to ImageData at GIF size
      // on the main thread; the heavy encode happens off-thread.
      const imageFrames = [];
      for (const frame of framesRef.current) {
        const canvas = document.createElement("canvas");
        canvas.width = GIF_EXPORT_WIDTH;
        canvas.height = GIF_EXPORT_HEIGHT;
        const context = canvas.getContext("2d");
        // Paper background so GIFs (which can't show partial alpha) look right.
        await renderPaper(context, {
          width: GIF_EXPORT_WIDTH,
          height: GIF_EXPORT_HEIGHT,
          textureId: selectedTexture,
        });
        compositeLayers(context, frame.layers, { width: GIF_EXPORT_WIDTH, height: GIF_EXPORT_HEIGHT });
        const imageData = context.getImageData(0, 0, GIF_EXPORT_WIDTH, GIF_EXPORT_HEIGHT);
        imageFrames.push({ data: imageData, delayMs: frame.durationMs });
      }

      const frameCount = framesRef.current.length;
      const worker = getGifWorker();

      let bytes;
      if (worker) {
        const jobId = (gifJobSeedRef.current += 1);
        bytes = await new Promise((resolve, reject) => {
          const handleMessage = (event) => {
            const message = event.data || {};
            if (message.id !== jobId) {
              return;
            }
            worker.removeEventListener("message", handleMessage);
            worker.removeEventListener("error", handleError);
            if (message.ok) {
              resolve(message.bytes);
            } else {
              reject(new Error(message.error || "GIF worker failed"));
            }
          };
          const handleError = (error) => {
            worker.removeEventListener("message", handleMessage);
            worker.removeEventListener("error", handleError);
            reject(error);
          };
          worker.addEventListener("message", handleMessage);
          worker.addEventListener("error", handleError);

          // Transfer each frame's pixel buffer to avoid a copy.
          const payloadFrames = imageFrames.map((frame) => ({
            buffer: frame.data.data.buffer,
            width: frame.data.width,
            height: frame.data.height,
            delayMs: frame.delayMs,
          }));
          worker.postMessage(
            { id: jobId, width: GIF_EXPORT_WIDTH, height: GIF_EXPORT_HEIGHT, frames: payloadFrames },
            payloadFrames.map((frame) => frame.buffer),
          );
        });
      } else {
        // Fallback: encode synchronously on the main thread.
        bytes = encodeGif(
          imageFrames.map((frame) => ({ source: frame.data, delayMs: frame.delayMs })),
          { width: GIF_EXPORT_WIDTH, height: GIF_EXPORT_HEIGHT },
        );
      }

      const blob = new Blob([bytes], { type: "image/gif" });
      downloadBlob(blob, `happy-paint-loop-${Date.now()}.gif`);
      setStatus(`GIF exported (${frameCount} frames)`);
    } catch {
      setStatus("GIF export failed");
    } finally {
      setIsExportingGif(false);
    }
  }, [commitLayersToFrame, getGifWorker, isExportingGif, renderPaper, selectedTexture, stopPlayback]);

  // ---- Replay & Timelapse ----

  // Open the replay player: snapshot the latest frame now (so the player shows
  // current work) then load the recorder's series into state.
  const openReplay = useCallback(async () => {
    const recorder = replayRecorderRef.current;
    if (recorder) {
      await recorder.captureManual();
    }
    setReplaySnapshots(recorder ? recorder.getSnapshots().slice() : []);
    setShowReplay(true);
  }, []);

  // Encode the captured snapshots into a GIF timelapse using the SAME
  // worker-based GIF encoder as the loop export. Returns the GIF bytes (or null).
  const encodeTimelapseBytes = useCallback(async () => {
    const recorder = replayRecorderRef.current;
    const snaps = recorder ? recorder.getSnapshots() : [];
    if (snaps.length === 0) {
      return null;
    }
    // Decode each snapshot Blob to ImageData at snapshot size on the main thread;
    // the heavy quantize + LZW happens off-thread (worker) like the loop export.
    const imageFrames = [];
    for (const snap of snaps) {
      const image = await createImageFromBlob(snap.blob).catch(() => null);
      if (!image) {
        continue;
      }
      const canvas = document.createElement("canvas");
      canvas.width = SNAPSHOT_WIDTH;
      canvas.height = SNAPSHOT_HEIGHT;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT);
      const imageData = context.getImageData(0, 0, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT);
      // ~10 fps timelapse; the last frame lingers a moment.
      imageFrames.push({ data: imageData, delayMs: 110 });
    }
    if (imageFrames.length > 0) {
      imageFrames[imageFrames.length - 1].delayMs = 900;
    }
    if (imageFrames.length === 0) {
      return null;
    }

    const worker = getGifWorker();
    if (worker) {
      const jobId = (gifJobSeedRef.current += 1);
      return new Promise((resolve, reject) => {
        const handleMessage = (event) => {
          const message = event.data || {};
          if (message.id !== jobId) {
            return;
          }
          worker.removeEventListener("message", handleMessage);
          worker.removeEventListener("error", handleError);
          if (message.ok) {
            resolve(message.bytes);
          } else {
            reject(new Error(message.error || "GIF worker failed"));
          }
        };
        const handleError = (error) => {
          worker.removeEventListener("message", handleMessage);
          worker.removeEventListener("error", handleError);
          reject(error);
        };
        worker.addEventListener("message", handleMessage);
        worker.addEventListener("error", handleError);
        const payloadFrames = imageFrames.map((frame) => ({
          buffer: frame.data.data.buffer,
          width: frame.data.width,
          height: frame.data.height,
          delayMs: frame.delayMs,
        }));
        worker.postMessage(
          { id: jobId, width: SNAPSHOT_WIDTH, height: SNAPSHOT_HEIGHT, frames: payloadFrames },
          payloadFrames.map((frame) => frame.buffer),
        );
      });
    }
    // Fallback: synchronous encode on the main thread.
    return encodeGif(
      imageFrames.map((frame) => ({ source: frame.data, delayMs: frame.delayMs })),
      { width: SNAPSHOT_WIDTH, height: SNAPSHOT_HEIGHT },
    );
  }, [getGifWorker]);

  const exportTimelapse = useCallback(async () => {
    if (isExportingTimelapse) {
      return;
    }
    setIsExportingTimelapse(true);
    setStatus("Encoding timelapse…");
    try {
      const bytes = await encodeTimelapseBytes();
      if (!bytes) {
        setStatus("No snapshots to export yet");
        return;
      }
      const blob = new Blob([bytes], { type: "image/gif" });
      downloadBlob(blob, `happy-paint-timelapse-${Date.now()}.gif`);
      setStatus("Timelapse exported");
    } catch {
      setStatus("Timelapse export failed");
    } finally {
      setIsExportingTimelapse(false);
    }
  }, [encodeTimelapseBytes, isExportingTimelapse]);

  // ---- Paint Space locker ----

  // Apply an updater to the locker, persist it (IndexedDB, else localStorage),
  // and only commit to React state if the write SUCCEEDS. On failure we surface
  // an honest status and leave the previous state intact (no silent drop).
  const persistPaintSpace = useCallback(async (updater) => {
    const next = updater(paintSpaceAssetsRef.current);
    try {
      await savePaintSpace(next);
    } catch {
      setStatus("Couldn't save to Paint Space — storage full");
      return false;
    }
    paintSpaceAssetsRef.current = next;
    setPaintSpaceAssets(next);
    // Best-effort cloud push (debounced; no-op when signed out / local-only).
    schedulePush();
    return true;
  }, []);

  const saveStickerToSpace = useCallback(async () => {
    commitLayersToFrame();
    const stickerCanvas = await composeCanvas({ transparent: true });
    const thumbCanvas = await composeCanvas({ width: 200, height: 150, transparent: true });
    const asset = createAsset({
      kind: "sticker",
      title: `Sticker ${todayName()}`,
      payload: { image: await canvasToDataUrl(stickerCanvas) },
      thumbnail: await canvasToDataUrl(thumbCanvas),
    });
    if (await persistPaintSpace((current) => addAsset(current, asset))) {
      setStatus("Saved sticker to Paint Space");
    }
  }, [commitLayersToFrame, composeCanvas, persistPaintSpace]);

  const saveTemplateToSpace = useCallback(async () => {
    commitLayersToFrame();
    const fullCanvas = await composeCanvas();
    const thumbCanvas = await composeCanvas({ width: 200, height: 150 });
    const asset = createAsset({
      kind: "template",
      title: `Template ${todayName()}`,
      payload: { image: await canvasToDataUrl(fullCanvas), textureId: selectedTexture },
      thumbnail: await canvasToDataUrl(thumbCanvas),
    });
    if (await persistPaintSpace((current) => addAsset(current, asset))) {
      setStatus("Saved template to Paint Space");
    }
  }, [commitLayersToFrame, composeCanvas, persistPaintSpace, selectedTexture]);

  const savePaletteToSpace = useCallback(async () => {
    // Recent colors first, then current selection, de-duped.
    const colors = [];
    for (const color of [selectedColor, ...recentColors]) {
      if (color && !colors.includes(color)) {
        colors.push(color);
      }
    }
    if (colors.length === 0) {
      setStatus("Pick a color first");
      return;
    }
    const asset = createAsset({
      kind: "palette",
      title: `Palette ${todayName()}`,
      payload: { colors: colors.slice(0, MAX_PALETTE_COLORS) },
    });
    if (await persistPaintSpace((current) => addAsset(current, asset))) {
      setStatus("Saved palette to Paint Space");
    }
  }, [persistPaintSpace, recentColors, selectedColor]);

  const saveLoopToSpace = useCallback(async () => {
    commitLayersToFrame();
    const loopFrames = [];
    for (const frame of framesRef.current) {
      const canvas = compositeFrameToCanvas(frame, { width: 200, height: 150 });
      loopFrames.push({ image: canvas.toDataURL("image/png"), durationMs: frame.durationMs });
    }
    const asset = createAsset({
      kind: "loop",
      title: `Loop ${todayName()}`,
      payload: { frames: loopFrames },
      thumbnail: loopFrames[0]?.image || "",
    });
    if (await persistPaintSpace((current) => addAsset(current, asset))) {
      setStatus(`Saved ${loopFrames.length}-frame loop to Paint Space`);
    }
  }, [commitLayersToFrame, persistPaintSpace]);

  // Save the timelapse GIF as a `loop`-kind Paint Space asset (timelapse asset).
  // Mirrors timelapse_assets: frame_count, format gif, safety_status pending.
  const saveTimelapseToSpace = useCallback(async () => {
    const recorder = replayRecorderRef.current;
    const snaps = recorder ? recorder.getSnapshots() : [];
    if (snaps.length === 0) {
      setStatus("No snapshots to save yet");
      return;
    }
    setIsExportingTimelapse(true);
    setStatus("Saving timelapse…");
    try {
      const bytes = await encodeTimelapseBytes();
      if (!bytes) {
        setStatus("No snapshots to save yet");
        return;
      }
      const blob = new Blob([bytes], { type: "image/gif" });
      const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => resolve("");
        reader.readAsDataURL(blob);
      });
      // Thumbnail = the most recent snapshot.
      const thumb = await createImageFromBlob(snaps[snaps.length - 1].blob).catch(() => null);
      let thumbUrl = "";
      if (thumb) {
        const tCanvas = document.createElement("canvas");
        tCanvas.width = 200;
        tCanvas.height = 150;
        tCanvas.getContext("2d").drawImage(thumb, 0, 0, 200, 150);
        thumbUrl = tCanvas.toDataURL("image/png");
      }
      const asset = createAsset({
        kind: "loop",
        title: `Timelapse ${todayName()}`,
        payload: {
          gif: dataUrl,
          isTimelapse: true,
          format: "gif",
          frame_count: snaps.length,
          safety_status: "pending",
        },
        thumbnail: thumbUrl,
      });
      if (await persistPaintSpace((current) => addAsset(current, asset))) {
        setStatus(`Saved timelapse (${snaps.length} frames) to Paint Space`);
      }
    } catch {
      setStatus("Couldn't save timelapse");
    } finally {
      setIsExportingTimelapse(false);
    }
  }, [encodeTimelapseBytes, persistPaintSpace]);

  // Remix from a replay snapshot: restore that downscaled frame as a fresh
  // single-layer artwork (reuses the gallery/template restore path).
  const remixFromSnapshot = useCallback(
    async (snapshot) => {
      if (!snapshot?.blob) {
        return;
      }
      pushHistory("full");
      const layer = createLayer({ name: "Remix" });
      const image = await createImageFromBlob(snapshot.blob).catch(() => null);
      if (image) {
        // Snapshot is downscaled; draw it scaled up to the full art canvas.
        layer.canvas.getContext("2d").drawImage(image, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      }
      const frame = createFrame({ layers: [layer] });
      framesRef.current = [frame];
      activeFrameIndexRef.current = 0;
      layersRef.current = frame.layers;
      activeLayerIdRef.current = frame.activeLayerId;
      renderDisplay();
      syncLayerState();
      syncFrameState();
      setShowReplay(false);
      markChanged("Remixed from replay");
    },
    [markChanged, pushHistory, renderDisplay, syncFrameState, syncLayerState],
  );

  // ---- AI Assist handlers (local helpers; consent-gated) ----

  const handleAiConsent = useCallback(async ({ profileKind, guardianApproved }) => {
    const saved = await saveAiConsent({ profileKind, guardianApproved });
    setAiConsent(saved);
    setStatus("AI Assist turned on");
  }, []);

  const handleAiRevoke = useCallback(async () => {
    const revoked = await revokeAiConsent();
    setAiConsent(revoked);
    setStatus("AI Assist turned off");
  }, []);

  // Apply an AI palette generation to the studio swatches.
  const handleApplyAiPalette = useCallback((generation) => {
    const colors = generation?.output?.colors || [];
    if (colors.length === 0) {
      return;
    }
    setRecentColors(colors.slice(0, MAX_PALETTE_COLORS));
    setSelectedColor(colors[colors.length - 1]); // a saturated mid-tone, not the light anchor
    setStatus(`Applied AI palette (${generation.input?.rule || "harmony"})`);
  }, []);

  // Apply an AI brush-recipe generation to the current brush settings.
  const handleApplyAiBrushRecipe = useCallback(
    (generation) => {
      const recipe = generation?.output?.brush_recipe;
      if (!recipe) {
        return;
      }
      const settings = recipeToBrushSettings(recipe, { color: selectedColor });
      const brush = brushCatalog.find((item) => item.id === settings.brush);
      if (brush?.tier === "studio" && !studioUnlocked) {
        setShowStore(true);
        setStatus("That recipe uses a studio brush — unlock with the Creator Brushes pack");
        return;
      }
      setSelectedBrush(settings.brush);
      setSelectedTool("brush");
      setBrushSize(settings.size);
      setBrushOpacity(settings.opacity);
      setBrushVariation(settings.variation);
      setStatus("Applied AI brush recipe");
    },
    [selectedColor, studioUnlocked],
  );

  const handleUseAiPrompt = useCallback((generation) => {
    const prompt = generation?.output?.prompt;
    if (prompt) {
      setStatus(`Prompt: ${prompt}`);
    }
  }, []);

  // ---- Brush Studio handlers ----

  // Apply a brush recipe (from the studio or a saved card) to the current brush.
  const handleApplyBrushRecipe = useCallback(
    (recipe) => {
      if (!recipe) {
        return;
      }
      const settings = recipeToBrushSettings(recipe, { color: selectedColor });
      const brush = brushCatalog.find((item) => item.id === settings.brush);
      if (brush?.tier === "studio" && !studioUnlocked) {
        setShowStore(true);
        setStatus("That brush uses a studio base — unlock with the Creator Brushes pack");
        return;
      }
      setSelectedBrush(settings.brush);
      setSelectedTool("brush");
      setBrushSize(settings.size);
      setBrushOpacity(settings.opacity);
      setBrushVariation(settings.variation);
      setStatus("Brush applied");
    },
    [selectedColor, studioUnlocked],
  );

  // Save a brush recipe to the Paint Space locker as a kind: "brush" asset.
  const handleSaveBrushRecipe = useCallback(
    async (recipe, { name, tags }) => {
      const fields = buildBrushAssetFields(recipe, { tags });
      const asset = createAsset({
        kind: "brush",
        title: name || "My Brush",
        payload: fields.payload,
        brush_recipe: fields.brush_recipe,
        visibility: fields.visibility,
        moderation_status: fields.moderation_status,
      });
      if (await persistPaintSpace((current) => addAsset(current, asset))) {
        setStatus("Saved brush to Paint Space");
      }
    },
    [persistPaintSpace],
  );

  // Publish a community brush pack from selected locker assets. Submit-for-review
  // sets the pack status pending + adds an asset_moderation_queue entry (mirrors
  // the schema). Admin approval is a SEPARATE later agent, so the pack will not
  // appear in browse until approved. Local/mock only.
  const handlePublishPack = useCallback((request) => {
    const { pack, queued } = publishPack(request);
    setShowPublishPack(false);
    if (queued) {
      setStatus(`"${pack.title}" submitted for review (pending moderation)`);
    } else {
      setStatus(`"${pack.title}" saved as a private pack`);
    }
  }, []);

  const handleRenameAsset = useCallback(
    async (asset) => {
      const title = window.prompt("Rename asset:", asset.title);
      if (title && title.trim()) {
        await persistPaintSpace((current) =>
          renamePaintSpaceAsset(current, asset.id, title.trim()),
        );
      }
    },
    [persistPaintSpace],
  );

  const handleDeleteAsset = useCallback(
    async (asset) => {
      if (await persistPaintSpace((current) => removeAsset(current, asset.id))) {
        setStatus("Asset deleted");
      }
    },
    [persistPaintSpace],
  );

  // Apply a saved asset back onto the canvas / studio state.
  const handleUseAsset = useCallback(
    async (asset) => {
      if (asset.kind === "sticker") {
        // Stamp the sticker onto the active layer, centered at full size.
        const active = getActiveLayer();
        if (!active || active.locked) {
          setStatus(active ? "Layer is locked" : "No active layer");
          return;
        }
        const image = await createImage(asset.payload?.image).catch(() => null);
        if (image) {
          pushHistory();
          active.canvas.getContext("2d").drawImage(image, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          renderDisplay();
          syncLayerState();
          markChanged("Sticker stamped");
        }
        setShowPaintSpace(false);
        return;
      }

      if (asset.kind === "template") {
        pushHistory();
        setSelectedTexture(asset.payload?.textureId || "linen");
        const layer = createLayer({ name: "Template" });
        const image = await createImage(asset.payload?.image).catch(() => null);
        if (image) {
          layer.canvas.getContext("2d").drawImage(image, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        }
        // Reset to a single frame holding just the template artwork.
        const frame = createFrame({ layers: [layer] });
        framesRef.current = [frame];
        activeFrameIndexRef.current = 0;
        layersRef.current = frame.layers;
        activeLayerIdRef.current = frame.activeLayerId;
        renderDisplay();
        syncLayerState();
        syncFrameState();
        markChanged("Template loaded");
        setShowPaintSpace(false);
        return;
      }

      if (asset.kind === "palette") {
        const colors = asset.payload?.colors || [];
        if (colors.length > 0) {
          setRecentColors(colors);
          setSelectedColor(colors[0]);
          setStatus("Palette loaded");
        }
        setShowPaintSpace(false);
        return;
      }

      if (asset.kind === "brush") {
        const recipe = asset.brush_recipe || asset.payload?.brush_recipe;
        handleApplyBrushRecipe(recipe);
        setShowPaintSpace(false);
        return;
      }

      if (asset.kind === "loop") {
        // Timelapse loops store a baked GIF (payload.gif), not editable frames,
        // so they can't be loaded back into the frame editor.
        if (asset.payload?.isTimelapse) {
          setStatus("Timelapse clips are for viewing/sharing, not editing");
          setShowPaintSpace(false);
          return;
        }
        const savedFrames = asset.payload?.frames || [];
        if (savedFrames.length === 0) {
          return;
        }
        pushHistory();
        const rebuilt = [];
        for (const item of savedFrames) {
          const layer = createLayer({ name: "Frame" });
          const image = await createImage(item.image).catch(() => null);
          if (image) {
            layer.canvas.getContext("2d").drawImage(image, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          }
          rebuilt.push(createFrame({ layers: [layer], durationMs: item.durationMs || DEFAULT_FRAME_DURATION }));
        }
        framesRef.current = rebuilt;
        activeFrameIndexRef.current = 0;
        layersRef.current = rebuilt[0].layers;
        activeLayerIdRef.current = rebuilt[0].activeLayerId;
        renderDisplay();
        syncLayerState();
        syncFrameState();
        markChanged(`Loaded ${rebuilt.length}-frame loop`);
        setShowPaintSpace(false);
      }
    },
    [getActiveLayer, handleApplyBrushRecipe, markChanged, pushHistory, renderDisplay, syncFrameState, syncLayerState],
  );

  // ---- Initialization ----

  // ---- Realtime multiplayer wiring ----------------------------------------

  // The shared friends canvas is created lazily on first remote op so a purely
  // solo session never allocates it.
  // Friends' strokes land on the SAME shared canvas everyone paints on (the base
  // layer), so strokes stack in arrival order and anyone can paint over anyone.
  // Load (or clear) the room's coloring sheet image and re-render.
  const loadSheetImage = useCallback(
    (id) => {
      if (!id) {
        sheetImageRef.current = null;
        sheetRectRef.current = null;
        renderDisplay();
        return;
      }
      fetch(`/api/sheets/${id}`, { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!data?.image) {
            return;
          }
          const img = new Image();
          img.onload = () => {
            const scale = Math.min(CANVAS_WIDTH / img.width, CANVAS_HEIGHT / img.height);
            const w = img.width * scale;
            const h = img.height * scale;
            sheetRectRef.current = { x: (CANVAS_WIDTH - w) / 2, y: (CANVAS_HEIGHT - h) / 2, w, h };
            sheetImageRef.current = img;
            renderDisplay();
          };
          img.src = data.image;
        })
        .catch(() => {});
    },
    [renderDisplay],
  );

  const getRemoteCtx = useCallback(() => {
    const layer = layersRef.current[0];
    return layer ? layer.canvas.getContext("2d") : null;
  }, []);

  // Apply one remote op onto the shared mural. `draw` ops carry incremental points
  // keyed by strokeId (we connect consecutive points per stroke); `shape` / `text`
  // / `image` are one-shot.
  const applyRemoteOp = useCallback(
    (op) => {
      if (!op) {
        return;
      }
      const ctx = getRemoteCtx();
      if (!ctx) {
        return;
      }
      if (op.kind === "draw") {
        const settings = op.settings || {};
        const lastMap = remoteStrokeLastRef.current;
        let last = lastMap.get(op.strokeId);
        for (const point of op.points || []) {
          drawBrushSegment(ctx, last || point, point, settings);
          last = point;
        }
        lastMap.set(op.strokeId, last);
      } else if (op.kind === "shape") {
        drawShape(ctx, op.tool, op.start, op.end, op.opts || {});
      } else if (op.kind === "text") {
        drawText(ctx, op.point, op.text, op.opts || {});
      } else if (op.kind === "image" && op.dataUrl) {
        const image = new Image();
        image.onload = () => {
          ctx.drawImage(image, op.x, op.y, op.w, op.h);
          renderDisplay();
        };
        image.src = op.dataUrl;
      }
    },
    [getRemoteCtx, renderDisplay],
  );

  const handleMpMessage = useCallback(
    (data) => {
      switch (data.type) {
        case "connected": {
          // Re-apply a saved name/colour so the artist keeps their identity
          // across reconnects (and eventually, sign-in).
          const saved = profileRef.current;
          if (saved?.name && saved.name !== data.userName) {
            mpRef.current?.sendRename?.(saved.name, saved.color);
          }
          break;
        }
        case "history":
          // Rebuild the shared mural from scratch (used for join AND for
          // restoring a cleared mural), so always start from a clean slate.
          layersRef.current.forEach((layer) => layer.canvas.getContext("2d").clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT));
          remoteStrokeLastRef.current.clear();
          (data.ops || []).forEach(applyRemoteOp);
          renderDisplay();
          refreshActiveThumbnail();
          if (data.restored) {
            setClearBanner(null);
            setStatus("Canvas brought back 🎉");
          }
          break;
        case "op":
          applyRemoteOp(data.op);
          // Mid-local-stroke, reuse the cheap stroke compositor; otherwise full.
          if (activePointerRef.current != null) {
            scheduleStrokeFrame();
          } else {
            renderDisplay();
          }
          break;
        case "clear":
          layersRef.current.forEach((layer) => layer.canvas.getContext("2d").clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT));
          remoteStrokeLastRef.current.clear();
          renderDisplay();
          refreshActiveThumbnail();
          showClearBanner(data.name || "Someone");
          break;
        case "sheet":
          setSheetId(data.sheetId || null);
          loadSheetImage(data.sheetId || null);
          break;
        case "cursor":
          remoteCursorsRef.current.set(data.userId, {
            x: data.x,
            y: data.y,
            name: data.name,
            color: data.color,
            drawing: data.drawing,
            ts: Date.now(),
          });
          break;
        case "cursor_leave":
        case "userLeft":
          if (data.userId) {
            remoteCursorsRef.current.delete(data.userId);
          }
          break;
        default:
          break;
      }
    },
    [applyRemoteOp, loadSheetImage, refreshActiveThumbnail, renderDisplay, scheduleStrokeFrame, showClearBanner],
  );

  const mp = useMultiplayer(roomId, handleMpMessage);

  // The imperative draw handlers (defined earlier) reach the senders via a ref.
  useEffect(() => {
    mpRef.current = {
      sendOp: mp.sendOp,
      sendCursor: mp.sendCursor,
      sendClear: mp.sendClear,
      sendRestore: mp.sendRestore,
      sendRename: mp.sendRename,
      sendSheet: mp.sendSheet,
    };
  }, [mp.sendOp, mp.sendCursor, mp.sendClear, mp.sendRestore, mp.sendRename, mp.sendSheet]);

  // Re-render when the over/under mode flips, and keep the ref in sync.
  useEffect(() => {
    sheetModeRef.current = sheetMode;
    renderDisplay();
  }, [sheetMode, renderDisplay]);

  // Load available coloring sheets for the picker.
  const loadSheets = useCallback(async () => {
    try {
      const res = await fetch("/api/sheets", { cache: "no-store" });
      const data = await res.json();
      setSheets(Array.isArray(data.sheets) ? data.sheets : []);
    } catch {
      // offline — leave list as-is
    }
  }, []);

  useEffect(() => {
    loadSheets();
  }, [loadSheets]);

  const applySheet = useCallback((id) => {
    mpRef.current?.sendSheet?.(id || null);
  }, []);

  // Load any saved profile (name/colour) once.
  useEffect(() => {
    try {
      profileRef.current = JSON.parse(window.localStorage.getItem(PROFILE_STORAGE_KEY) || "null");
    } catch {
      profileRef.current = null;
    }
  }, []);

  // Ensure an anonymous per-device user key, then load this user's saved art.
  useEffect(() => {
    let key = null;
    try {
      key = window.localStorage.getItem("drawesome:userkey:v1");
    } catch {
      key = null;
    }
    if (!key) {
      key = "u_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      try {
        window.localStorage.setItem("drawesome:userkey:v1", key);
      } catch {
        // ephemeral key if storage is blocked
      }
    }
    userKeyRef.current = key;
    loadMyDrawings();
  }, [loadMyDrawings]);

  // Save the profile and push it to the room.
  const saveProfile = useCallback(
    (name, color) => {
      const clean = (name || "").trim().slice(0, 20) || mp.self?.name || "Artist";
      const nextColor = color || mp.self?.color;
      mp.sendRename(clean, nextColor);
      profileRef.current = { name: clean, color: nextColor };
      try {
        window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profileRef.current));
      } catch {
        // Non-fatal.
      }
      setShowAvatarMenu(false);
      setStatus("Profile updated");
    },
    [mp],
  );

  // Pump remote cursors into React state, dropping any gone quiet (>4s).
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      const { scale, tx, ty } = viewRef.current;
      const live = [];
      remoteCursorsRef.current.forEach((cursor, userId) => {
        if (now - cursor.ts > 4000) {
          remoteCursorsRef.current.delete(userId);
        } else {
          live.push({
            userId,
            name: cursor.name,
            color: cursor.color,
            drawing: cursor.drawing,
            leftPx: cursor.x * CANVAS_WIDTH * scale + tx,
            topPx: cursor.y * CANVAS_HEIGHT * scale + ty,
          });
        }
      });
      setRemoteCursors(live);
    }, 120);
    return () => window.clearInterval(timer);
  }, []);

  // Non-passive wheel listener so zoom can preventDefault page scroll.
  useEffect(() => {
    const el = overlayCanvasRef.current;
    if (!el) {
      return undefined;
    }
    const onWheel = (event) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomAt(factor, event.clientX - rect.left, event.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Spacebar toggles the pan/hand tool — unless you're typing (e.g. chat).
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.code !== "Space" && event.key !== " ") {
        return;
      }
      const target = event.target;
      const tag = (target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) {
        return;
      }
      event.preventDefault();
      if (event.repeat) {
        return;
      }
      setHandTool((on) => {
        handToolRef.current = !on;
        return !on;
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const overlay = overlayCanvasRef.current;
    overlay.width = CANVAS_WIDTH;
    overlay.height = CANVAS_HEIGHT;
    overlayContextRef.current = overlay.getContext("2d", { alpha: true });

    // The 1600x1200 art-resolution document everything composites into.
    const doc = createLayerCanvas();
    docCanvasRef.current = doc;
    docContextRef.current = doc.getContext("2d", { alpha: true });

    // The visible display canvas backing store is sized to CSS box * DPR (W6);
    // resizeDisplayCanvas creates its context and performs the first blit.
    resizeDisplayCanvas();

    const firstFrame = createFrame({ layers: createDefaultLayers() });
    framesRef.current = [firstFrame];
    activeFrameIndexRef.current = 0;
    layersRef.current = firstFrame.layers;
    activeLayerIdRef.current = firstFrame.activeLayerId;
    renderDisplay();
    syncLayerState();
    syncFrameState();

    historyRef.current = [];
    redoRef.current = [];
    updateHistoryCounts();

    // An event CTA can arrive with a prompt (/studio?prompt=…). Surface it so the
    // artist sees what they came to draw.
    if (initialPrompt) {
      setStatus(`Prompt: ${initialPrompt}`);
    }

    // Snapshot-based replay recorder. It paints downscaled composited snapshots
    // (via paintReplayComposite) on a debounced cadence while dirty + on events.
    const recorder = createReplayRecorder({ paintComposite: paintReplayComposite });
    recorder.setOnChange((count) => setReplayCount(count));
    replayRecorderRef.current = recorder;
    loadReplaySnapshots().then((snaps) => {
      if (snaps.length > 0 && replayRecorderRef.current) {
        replayRecorderRef.current.setSnapshots(snaps);
      }
    });

    // AI Assist consent (local; mirrors ai_consent). Gate stays closed until set.
    loadAiConsent().then((consent) => setAiConsent(consent));

    // Economy loads async from IndexedDB. A legacy `studio-pass` boolean (the old
    // Demo Drops toggle) is migrated forward into a mock entitlement: owning the
    // Creator Brushes pack grants the "studio" tier, so studio brushes/paper keep
    // unlocking. The legacy localStorage key is then cleared.
    loadEconomy().then((loaded) => {
      const legacyStudio = readJson(STORAGE_KEYS.studio, false);
      const { state: migrated, changed } = migrateLegacyStudioPass(loaded, Boolean(legacyStudio));
      setEconomy(migrated);
      if (changed) {
        saveEconomy(migrated).catch(() => {});
      }
      if (legacyStudio) {
        try {
          window.localStorage.removeItem(STORAGE_KEYS.studio);
        } catch {
          // Non-fatal.
        }
      }
    });

    // Gallery + Paint Space now load async from IndexedDB (with one-time legacy
    // localStorage migration). The UI briefly shows empty until these resolve.
    // We mirror into the refs so the async save callbacks build on the latest
    // committed array.
    loadGallery().then((items) => {
      galleryRef.current = items;
      setGallery(items);
    });
    loadPaintSpace().then((assets) => {
      paintSpaceAssetsRef.current = assets;
      setPaintSpaceAssets(assets);
    });

    // Restore a saved draft (IndexedDB first, legacy localStorage second). A
    // legacy draft is migrated forward to IndexedDB by marking dirty so the
    // autosave timer rewrites it (W3 back-compat).
    loadDraft().then((draft) => {
      if (!draft?.layers?.length) {
        return;
      }
      restoreLayersFromDraft(draft.layers).then(() => {
        if (draft.activeLayerId && layersRef.current.some((layer) => layer.id === draft.activeLayerId)) {
          activeLayerIdRef.current = draft.activeLayerId;
          syncLayerState();
        }
        if (draft.fromLegacy) {
          dirtyRef.current = true;
        }
        setStatus("Draft restored");
      });
      applyDraftSettings(draft.settings);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Cloud sync lifecycle (optional; no-op in local-only mode) ----
  // Start sync on sign-in, stop on sign-out. startSync() pulls remote rows and
  // merges them into the local stores (last-write-wins); after it resolves we
  // re-read the (now merged) gallery + Paint Space into memory so the UI shows
  // synced pieces. Everything is best-effort and never blocks offline use.
  useEffect(() => {
    let active = true;
    const refreshFromLocal = async () => {
      const [items, assets] = await Promise.all([loadGallery(), loadPaintSpace()]);
      if (!active) {
        return;
      }
      galleryRef.current = items;
      setGallery(items);
      paintSpaceAssetsRef.current = assets;
      setPaintSpaceAssets(assets);
    };
    const handleSession = async (session) => {
      if (session) {
        await startSync(session);
        await refreshFromLocal();
      } else {
        stopSync();
      }
    };
    getSession().then((session) => {
      if (active && session) {
        handleSession(session);
      }
    });
    const unsub = onAuthStateChange((session) => {
      if (active) {
        handleSession(session);
      }
    });
    return () => {
      active = false;
      unsub();
      stopSync();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the display canvas backing store matched to its CSS size and the
  // current device pixel ratio so it stays crisp through window resizes, layout
  // changes, and DPR changes (e.g. dragging the tab between monitors) — W6.
  useEffect(() => {
    let mediaQuery = null;
    const handleDprChange = () => {
      resizeDisplayCanvas();
      // matchMedia('resolution') must be re-armed after each change.
      attachDprListener();
    };
    function attachDprListener() {
      if (typeof window.matchMedia !== "function") {
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      mediaQuery = window.matchMedia(`(resolution: ${dpr}dppx)`);
      if (mediaQuery.addEventListener) {
        mediaQuery.addEventListener("change", handleDprChange, { once: true });
      } else if (mediaQuery.addListener) {
        mediaQuery.addListener(handleDprChange);
      }
    }

    const handleResize = () => resizeDisplayCanvas();
    window.addEventListener("resize", handleResize);
    attachDprListener();
    resizeDisplayCanvas();

    return () => {
      window.removeEventListener("resize", handleResize);
      if (mediaQuery) {
        if (mediaQuery.removeEventListener) {
          mediaQuery.removeEventListener("change", handleDprChange);
        } else if (mediaQuery.removeListener) {
          mediaQuery.removeListener(handleDprChange);
        }
      }
    };
  }, [resizeDisplayCanvas]);

  useEffect(() => {
    autosaveTimerRef.current = window.setInterval(() => {
      if (dirtyRef.current) {
        saveDraft();
      }
    }, 2400);

    return () => {
      window.clearInterval(autosaveTimerRef.current);
    };
  }, [saveDraft]);

  // Stop any running loop preview and tear down the GIF worker on unmount.
  useEffect(() => {
    return () => {
      if (playTimerRef.current) {
        window.cancelAnimationFrame(playTimerRef.current);
        playTimerRef.current = null;
      }
      if (rafPendingRef.current) {
        window.cancelAnimationFrame(rafPendingRef.current);
        rafPendingRef.current = 0;
      }
      if (opacityRafRef.current) {
        window.cancelAnimationFrame(opacityRafRef.current);
        opacityRafRef.current = 0;
      }
      if (gifWorkerRef.current) {
        gifWorkerRef.current.terminate();
        gifWorkerRef.current = null;
      }
      if (replayFlushTimerRef.current) {
        window.clearTimeout(replayFlushTimerRef.current);
        replayFlushTimerRef.current = 0;
      }
      if (replayRecorderRef.current) {
        // Persist the final series before tearing the recorder down.
        replayRecorderRef.current.flush();
        replayRecorderRef.current.destroy();
        replayRecorderRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event) => {
      const command = event.metaKey || event.ctrlKey;

      if (!command) {
        return;
      }

      if (event.key.toLowerCase() === "z" && event.shiftKey) {
        event.preventDefault();
        redo();
      } else if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
      } else if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      } else if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveToGallery();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [redo, saveToGallery, undo]);

  // Economy action handlers. Each applies a pure helper to the current economy
  // state, persists to IndexedDB, and surfaces an honest status. All flows are
  // mock: no real payment or network.
  const persistEconomy = useCallback((next) => {
    setEconomy(next);
    saveEconomy(next).catch(() => setStatus("Couldn't save wallet"));
  }, []);

  const handleBuyDrops = useCallback(
    (product) => {
      if (!economy) {
        return;
      }
      persistEconomy(creditDrops(economy, product));
      setStatus(`Added ${product.drop_amount} Drops (mock)`);
    },
    [economy, persistEconomy],
  );

  const handleBuyItem = useCallback(
    (item) => {
      if (!economy) {
        return;
      }
      const result = spendDrops(economy, item);
      if (!result.ok) {
        setStatus(result.reason === "owned" ? "Already owned" : "Not enough Drops");
        return;
      }
      persistEconomy(result.state);
      setStatus(`Bought ${item.title}`);
    },
    [economy, persistEconomy],
  );

  const handleSendTip = useCallback(
    (amount, meta = {}) => {
      if (!economy) {
        return;
      }
      const result = sendTip(economy, { amount, ...meta });
      if (!result.ok) {
        setStatus("Not enough Drops to tip");
        return;
      }
      persistEconomy(result.state);
      setStatus(`Tipped ${amount} Drops`);
    },
    [economy, persistEconomy],
  );

  const paperStyle = {
    "--paper-bg": selectedTextureMeta.background,
    "--paper-texture": selectedTextureMeta.file ? `url("${selectedTextureMeta.file}")` : "none",
  };

  const showShapeFillOption = selectedTool === "rect" || selectedTool === "ellipse";

  // Remember the last real brush so flipping back from the eraser restores it.
  if (selectedBrush && selectedBrush !== "eraser") {
    lastPaintBrushRef.current = selectedBrush;
  }

  const activatePaint = () => {
    handToolRef.current = false;
    setHandTool(false);
    setSelectedTool("brush");
    if (selectedBrush === "eraser") {
      setSelectedBrush(lastPaintBrushRef.current || "marker");
    }
  };

  const activateEraser = () => {
    handToolRef.current = false;
    setHandTool(false);
    setSelectedTool("brush");
    setSelectedBrush("eraser");
  };

  const isPaintActive = !handTool && selectedTool === "brush" && selectedBrush !== "eraser";
  const isEraserActive = !handTool && selectedTool === "brush" && selectedBrush === "eraser";

  // Tapping Paint flips to the brush; tapping it again (already painting) opens
  // the tools drawer and scrolls to the brush/colour section.
  const onPaintButton = () => {
    const wasPainting = isPaintActive;
    activatePaint();
    if (wasPainting) {
      setToolsOpen(true);
      window.setTimeout(() => brushSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    }
  };

  // Create a fresh private (invite-only) room with a random code and go there.
  const createPrivateRoom = () => {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 6; i += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    window.location.href = `/join/${code}`;
  };

  const submitReport = async () => {
    try {
      await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: roomId, reason: reportReason, reporterName: mp.self?.name || "anonymous" }),
      });
      showToast("Thanks — a moderator will take a look. 🙏");
    } catch {
      showToast("Couldn't send the report — please try again");
    }
    setShowReport(false);
    setReportReason("");
  };

  // Drag the chat window by its header (pointer-based, works with touch).
  const startChatDrag = (event) => {
    if (event.target.closest("button")) {
      return; // let the hide button work
    }
    const chat = event.currentTarget.closest(".mp-chat");
    if (!chat) {
      return;
    }
    const rect = chat.getBoundingClientRect();
    const offX = event.clientX - rect.left;
    const offY = event.clientY - rect.top;
    const onMove = (ev) => {
      const left = Math.max(4, Math.min(window.innerWidth - 60, ev.clientX - offX));
      const top = Math.max(4, Math.min(window.innerHeight - 44, ev.clientY - offY));
      setChatPos({ left, top });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <main className="studio-shell">
      <section className="studio-workspace" aria-label="Drawesome drawing studio">
        <div className="topbar">
          <div>
            <p className="eyebrow">paint together, live ✨</p>
            <h1>Drawesome 🎨</h1>
          </div>
          <div className="topbar-actions">
            <button type="button" onClick={undo} disabled={historyCount === 0}>
              Undo
            </button>
            <button type="button" onClick={redo} disabled={redoCount === 0}>
              Redo
            </button>
            <button type="button" onClick={() => setShowClearConfirm(true)}>
              Clear
            </button>
            <button type="button" onClick={() => imageInputRef.current?.click()} title="Add a GIF or image">
              🖼 GIF
            </button>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*,image/gif"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                importImage(file);
                event.target.value = "";
              }}
            />
            <button type="button" className="primary-action" onClick={saveToServer} disabled={savingArt}>
              {savingArt ? "Saving…" : "💾 Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                loadMyDrawings();
                setShowMyArt(true);
              }}
            >
              📁 My Art
            </button>
            <button type="button" onClick={sharePng}>
              Share
            </button>
            <button type="button" onClick={exportPng}>
              Export
            </button>
            <button type="button" onClick={exportTransparentPng}>
              Export PNG (transparent)
            </button>
          </div>
        </div>

        <div className="mp-bar">
          <span className={mp.connected ? "mp-dot mp-dot-on" : "mp-dot"} aria-hidden="true" />
          <strong className="mp-room">Room {roomId}</strong>
          <span className="mp-count">{mp.connected ? `${mp.users.length} painting together` : "Connecting…"}</span>
          <div className="mp-avatars">
            {mp.users.slice(0, 8).map((u) => (
              <span
                key={u.id}
                className="mp-avatar"
                style={{ background: u.color }}
                title={u.name + (mp.self && u.id === mp.self.id ? " (you)" : "")}
              >
                {u.name.slice(0, 1)}
              </span>
            ))}
          </div>
          <button
            type="button"
            className="mp-invite"
            onClick={() => {
              const link = `${window.location.origin}/join/${roomId}`;
              navigator.clipboard?.writeText(link).then(
                () => setStatus("Invite link copied — send it to a friend!"),
                () => setStatus(link),
              );
            }}
          >
            Invite a friend
          </button>

          <div className="mp-you">
            <button
              type="button"
              className="avatar-btn"
              onClick={() => {
                setNameDraft(mp.self?.name || "");
                setShowAvatarMenu((open) => !open);
              }}
              aria-haspopup="menu"
              aria-expanded={showAvatarMenu}
              title="Your profile"
            >
              <span className="avatar-dot" style={{ background: mp.self?.color || "#9aa6b2" }}>
                {(mp.self?.name || "?").slice(0, 1).toUpperCase()}
              </span>
              <span className="avatar-name">{mp.self?.name || "You"}</span>
            </button>

            {showAvatarMenu ? (
              <div className="avatar-menu" role="menu">
                <p className="avatar-menu-title">You</p>
                <label className="avatar-field">
                  <span>Display name</span>
                  <input
                    type="text"
                    value={nameDraft}
                    maxLength={20}
                    placeholder="Your name"
                    onChange={(event) => setNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        saveProfile(nameDraft, mp.self?.color);
                      }
                    }}
                  />
                </label>
                <span className="avatar-field-label">Color</span>
                <div className="avatar-colors">
                  {AVATAR_COLORS.map((swatch) => (
                    <button
                      key={swatch}
                      type="button"
                      className={`avatar-color ${mp.self?.color === swatch ? "is-active" : ""}`}
                      style={{ background: swatch }}
                      onClick={() => saveProfile(nameDraft, swatch)}
                      aria-label={`Use ${swatch}`}
                    />
                  ))}
                </div>
                <div className="avatar-actions">
                  <button type="button" onClick={() => setShowAvatarMenu(false)}>
                    Cancel
                  </button>
                  <button type="button" className="primary-action" onClick={() => saveProfile(nameDraft, mp.self?.color)}>
                    Save
                  </button>
                </div>
                <p className="avatar-note">Sign in &amp; saved profiles coming soon 🔒</p>
              </div>
            ) : null}
          </div>
        </div>

        <div className="canvas-stage">
          <div className="canvas-paper">
            <canvas ref={displayCanvasRef} className="drawing-canvas display-canvas" aria-label="Drawing canvas" />
            <canvas
              ref={overlayCanvasRef}
              className={handTool ? "drawing-canvas overlay-canvas is-pan" : "drawing-canvas overlay-canvas"}
              aria-hidden="true"
              onPointerDown={handleCanvasPointerDown}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={handleCanvasPointerUp}
              onPointerCancel={handleCanvasPointerUp}
            />
            <div className="remote-cursor-layer" aria-hidden="true">
              {remoteCursors.map((cursor) => (
                <div
                  key={cursor.userId}
                  className={cursor.drawing ? "remote-cursor is-drawing" : "remote-cursor"}
                  style={{ transform: `translate(${cursor.leftPx}px, ${cursor.topPx}px)` }}
                >
                  <span className="remote-cursor-dot" style={{ background: cursor.color }} />
                  <span className="remote-cursor-name" style={{ background: cursor.color }}>
                    {cursor.name}
                  </span>
                </div>
              ))}
            </div>

            <div className="zoom-controls" role="group" aria-label="Zoom and pan">
              <button type="button" onClick={() => zoomByButton(1 / 1.25)} aria-label="Zoom out">
                −
              </button>
              <button type="button" className="zoom-pct" onClick={fitView} title="Fit whole canvas">
                {zoomPct}%
              </button>
              <button type="button" onClick={() => zoomByButton(1.25)} aria-label="Zoom in">
                +
              </button>
              <button
                type="button"
                className={handTool ? "zoom-hand is-active" : "zoom-hand"}
                onClick={toggleHandTool}
                aria-pressed={handTool}
                title="Pan tool (or use two fingers)"
              >
                ✋
              </button>
            </div>

            {clearBanner ? (
              <div className="clear-banner" role="status">
                <span>
                  🧹 {clearBanner.by === "You" ? "You" : clearBanner.by} cleared the canvas.
                </span>
                <button type="button" className="primary-action" onClick={restoreCanvas}>
                  Bring it back
                </button>
                <button type="button" className="clear-banner-dismiss" onClick={() => setClearBanner(null)} aria-label="Dismiss">
                  ✕
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {showClearConfirm ? (
          <div className="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="clear-confirm-title">
            <div className="confirm-card">
              <h2 id="clear-confirm-title">Clear the whole canvas? 😱</h2>
              <p>
                This wipes the shared mural for <strong>everyone</strong> in the room — your friends might be
                mad! You can bring it back with <strong>“Bring it back”</strong> right after, but only for a
                little while.
              </p>
              <div className="confirm-actions">
                <button type="button" onClick={() => setShowClearConfirm(false)}>
                  Never mind
                </button>
                <button
                  type="button"
                  className="confirm-danger"
                  onClick={() => {
                    setShowClearConfirm(false);
                    clearCanvas();
                  }}
                >
                  Yes, clear it
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {toast ? <div className="save-toast" role="status">{toast}</div> : null}

        {showMyArt ? (
          <div className="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="myart-title">
            <div className="myart-card">
              <div className="myart-head">
                <h2 id="myart-title">📁 My Art</h2>
                <span className="myart-count">
                  {myDrawings.length}/{savesMax} saved
                </span>
                <button type="button" onClick={() => setShowMyArt(false)} aria-label="Close">
                  ✕
                </button>
              </div>
              {myDrawings.length === 0 ? (
                <p className="myart-empty">
                  No saved drawings yet. Tap <strong>💾 Save</strong> to keep one here — you can come back
                  and open it anytime on this device.
                </p>
              ) : (
                <div className="myart-grid">
                  {myDrawings.map((art) => (
                    <div key={art.id} className="myart-item">
                      <button type="button" className="myart-open" onClick={() => openDrawing(art.id)} title="Open to keep drawing">
                        {art.thumb ? <img src={art.thumb} alt={art.name} /> : <span className="myart-noimg">🎨</span>}
                        <span>{art.name}</span>
                      </button>
                      <button
                        type="button"
                        className="myart-delete"
                        onClick={() => deleteDrawing(art.id)}
                        aria-label={`Delete ${art.name}`}
                      >
                        🗑
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <p className="myart-note">Saved on the server for this device. Sign-in to sync across devices is coming soon.</p>
            </div>
          </div>
        ) : null}

        {showReport ? (
          <div className="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="report-title">
            <div className="confirm-card">
              <h2 id="report-title">⚠️ Report this room</h2>
              <p>
                Tell a moderator what's wrong in <strong>Room {roomId}</strong> (e.g. mean or inappropriate
                drawings). They'll review it.
              </p>
              <textarea
                className="report-textarea"
                value={reportReason}
                maxLength={300}
                rows={3}
                placeholder="What happened?"
                onChange={(event) => setReportReason(event.target.value)}
              />
              <div className="confirm-actions">
                <button type="button" onClick={() => setShowReport(false)}>
                  Cancel
                </button>
                <button type="button" className="confirm-danger" onClick={submitReport}>
                  Send report
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {showChat ? (
          <div
            className="mp-chat"
            style={chatPos ? { left: chatPos.left, top: chatPos.top, right: "auto", bottom: "auto" } : undefined}
          >
            <div className="mp-chat-head" onPointerDown={startChatDrag}>
              <span>💬 Room chat</span>
              <button type="button" onClick={() => setShowChat(false)} aria-label="Hide chat">
                –
              </button>
            </div>
            <div className="mp-chat-room">
              <span className={mp.connected ? "mp-dot mp-dot-on" : "mp-dot"} aria-hidden="true" />
              <strong>Room {roomId}</strong>
              <span className="mp-chat-room-count">{mp.connected ? `${mp.users.length} painting` : "Connecting…"}</span>
              <button
                type="button"
                className="mp-chat-invite"
                onClick={() => {
                  const link = `${window.location.origin}/join/${roomId}`;
                  navigator.clipboard?.writeText(link).then(
                    () => showToast("Invite link copied — send it to a friend!"),
                    () => setStatus(link),
                  );
                }}
              >
                Invite
              </button>
              <button type="button" className="mp-chat-iconbtn" onClick={createPrivateRoom} title="Create a private room">
                🔒
              </button>
              <button type="button" className="mp-chat-iconbtn" onClick={() => setShowReport(true)} title="Report something">
                ⚠️
              </button>
            </div>
            <div className="mp-chat-log">
              {mp.chat.length === 0 ? (
                <p className="mp-chat-empty">Say hi to your friends! 👋</p>
              ) : (
                mp.chat.map((line, index) => (
                  <p key={index} className="mp-chat-line">
                    <strong style={{ color: line.user?.color }}>{line.user?.name}:</strong> {line.message}
                  </p>
                ))
              )}
            </div>
            <form
              className="mp-chat-form"
              onSubmit={(event) => {
                event.preventDefault();
                const text = chatDraft.trim();
                if (text) {
                  // The server echoes chat back to the sender, so the message
                  // appears once it round-trips — no local push (avoids dupes).
                  mp.sendChat(text);
                  setChatDraft("");
                }
              }}
            >
              <input
                type="text"
                value={chatDraft}
                maxLength={300}
                onChange={(event) => setChatDraft(event.target.value)}
                placeholder="Type a message…"
              />
              <button type="submit">Send</button>
            </form>
          </div>
        ) : (
          <button type="button" className="mp-chat-toggle" onClick={() => setShowChat(true)}>
            💬 Chat{mp.chat.length ? ` (${mp.chat.length})` : ""}
          </button>
        )}

        <div className="gallery-strip" aria-label="Saved artwork">
          <div className="gallery-heading">
            <span>Gallery</span>
            <button type="button" onClick={restoreDraft}>
              Restore Draft
            </button>
          </div>
          {gallery.length === 0 ? (
            <div className="empty-gallery">No saved pieces yet</div>
          ) : (
            gallery.map((item) => (
              <button
                type="button"
                className="gallery-item"
                key={item.id}
                onClick={() => restoreGalleryItem(item)}
                aria-label={`Open ${item.name}`}
              >
                <img src={item.preview} alt="" />
                <span>{item.name}</span>
              </button>
            ))
          )}
        </div>
      </section>

      <aside className={toolsOpen ? "tool-rail is-open" : "tool-rail"} aria-label="Drawing tools">
        <div className="drawer-handle">
          <span className="drawer-grip" aria-hidden="true" />
          <button type="button" className="drawer-done" onClick={() => setToolsOpen(false)}>
            Done
          </button>
        </div>
        <div className="status-line">{status}</div>

        <section className="tool-section mobile-actions">
          <h2>Actions</h2>
          <div className="mobile-actions-grid">
            <button type="button" onClick={undo} disabled={historyCount === 0}>
              ↶ Undo
            </button>
            <button type="button" onClick={redo} disabled={redoCount === 0}>
              ↷ Redo
            </button>
            <button type="button" onClick={() => setShowClearConfirm(true)}>
              Clear
            </button>
            <button type="button" onClick={() => imageInputRef.current?.click()}>
              🖼 GIF
            </button>
            <button type="button" className="primary-action" onClick={saveToServer} disabled={savingArt}>
              {savingArt ? "Saving…" : "💾 Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                loadMyDrawings();
                setShowMyArt(true);
              }}
            >
              📁 My Art
            </button>
            <button type="button" onClick={sharePng}>
              Share
            </button>
            <button type="button" onClick={exportPng}>
              Export
            </button>
          </div>
        </section>

        <section className="tool-section mobile-profile">
          <h2>You</h2>
          <label className="avatar-field">
            <span>Display name</span>
            <input
              type="text"
              value={nameDraft}
              maxLength={20}
              placeholder={mp.self?.name || "Your name"}
              onChange={(event) => setNameDraft(event.target.value)}
            />
          </label>
          <div className="avatar-colors">
            {AVATAR_COLORS.map((swatch) => (
              <button
                key={swatch}
                type="button"
                className={mp.self?.color === swatch ? "avatar-color is-active" : "avatar-color"}
                style={{ background: swatch }}
                onClick={() => saveProfile(nameDraft, swatch)}
                aria-label={`Use ${swatch}`}
              />
            ))}
          </div>
          <button type="button" className="primary-action" onClick={() => saveProfile(nameDraft, mp.self?.color)}>
            Save name
          </button>
        </section>

        <section className="tool-section">
          <h2>Tool</h2>
          <div className="brush-grid">
            {TOOLS.map((tool) => (
              <button
                type="button"
                key={tool.id}
                className={`brush-chip ${selectedTool === tool.id ? "is-active" : ""}`}
                onClick={() => {
                  setSelectedTool(tool.id);
                  handToolRef.current = false;
                  setHandTool(false);
                }}
                aria-pressed={selectedTool === tool.id}
              >
                <span>{tool.name}</span>
              </button>
            ))}
          </div>
          {showShapeFillOption ? (
            <label className="color-picker">
              <span>Fill shape</span>
              <input type="checkbox" checked={fillShape} onChange={(event) => setFillShape(event.target.checked)} />
            </label>
          ) : null}
        </section>

        <LayerPanel
          layers={layers}
          activeLayerId={activeLayerId}
          onSelect={handleSelectLayer}
          onAdd={handleAddLayer}
          onDelete={handleDeleteLayer}
          onDuplicate={handleDuplicateLayer}
          onMergeDown={handleMergeDown}
          onMoveUp={handleMoveUp}
          onMoveDown={handleMoveDown}
          onToggleVisible={handleToggleVisible}
          onToggleLock={handleToggleLock}
          onRename={handleRenameLayer}
          onOpacityChange={handleOpacityChange}
          onOpacityDragStart={handleOpacityDragStart}
          onOpacityDragEnd={handleOpacityDragEnd}
        />

        <FrameStrip
          frames={frames}
          activeFrameIndex={activeFrameIndex}
          thumbnails={frameThumbnails}
          isPlaying={isPlaying}
          onionSkin={onionSkin}
          isExporting={isExportingGif}
          onSelectFrame={handleSelectFrame}
          onAddFrame={handleAddFrame}
          onDuplicateFrame={handleDuplicateFrame}
          onDeleteFrame={handleDeleteFrame}
          onMoveFrame={handleMoveFrame}
          onDurationChange={handleFrameDurationChange}
          onTogglePlay={handleTogglePlay}
          onToggleOnion={handleToggleOnion}
          onExportGif={exportGif}
          onSaveLoop={saveLoopToSpace}
        />

        <section className="tool-section paint-space-actions">
          <div className="section-title-row">
            <h2>Paint Space</h2>
            <button type="button" onClick={() => setShowPaintSpace(true)}>
              Open ({paintSpaceAssets.length})
            </button>
          </div>
          <div className="ps-save-grid">
            <button type="button" onClick={saveStickerToSpace}>
              Save sticker
            </button>
            <button type="button" onClick={saveTemplateToSpace}>
              Save template
            </button>
            <button type="button" onClick={savePaletteToSpace}>
              Save palette
            </button>
            <button type="button" onClick={saveLoopToSpace}>
              Save loop
            </button>
          </div>
        </section>

        <section className="tool-section studio-features">
          <h2>Studio</h2>
          <div className="ps-save-grid">
            <button type="button" onClick={openReplay} title="Replay your process and export a timelapse">
              Replay ({replayCount})
            </button>
            <button
              type="button"
              onClick={() => setShowAiAssist(true)}
              title="AI Assist (local, consent-gated)"
            >
              AI Assist{isAiConsented(aiConsent) ? " ·" : ""}
            </button>
            <button type="button" onClick={() => setShowBrushStudio(true)} title="Create a custom brush recipe">
              Brush Studio
            </button>
          </div>
        </section>

        <section className="tool-section rail-top rail-top-0">
          <div className="section-title-row">
            <h2>Coloring sheet</h2>
            {sheetId ? (
              <button type="button" onClick={() => applySheet(null)}>
                Remove
              </button>
            ) : null}
          </div>
          {sheets.length === 0 ? (
            <p className="economy-note">No coloring sheets yet — a grown-up can add them in the admin.</p>
          ) : (
            <div className="sheet-grid">
              {sheets.map((sheet) => (
                <button
                  type="button"
                  key={sheet.id}
                  className={sheetId === sheet.id ? "sheet-chip is-active" : "sheet-chip"}
                  onClick={() => applySheet(sheet.id)}
                  title={sheet.name}
                >
                  {sheet.thumb ? <img src={sheet.thumb} alt={sheet.name} /> : <span className="sheet-noimg">🎨</span>}
                  <span className="sheet-name">{sheet.name}</span>
                </button>
              ))}
            </div>
          )}
          {sheetId ? (
            <label className="color-picker sheet-toggle">
              <span>Lines on top (colour under)</span>
              <input
                type="checkbox"
                checked={sheetMode === "over"}
                onChange={(event) => setSheetMode(event.target.checked ? "over" : "under")}
              />
            </label>
          ) : null}
        </section>

        <section className="tool-section rail-top rail-top-1" ref={brushSectionRef}>
          <h2>Brushes</h2>
          <div className="brush-grid">
            {brushCatalog.map((brush) => {
              const locked = brush.tier === "studio" && !studioUnlocked;
              return (
                <button
                  type="button"
                  key={brush.id}
                  className={`brush-chip ${selectedTool === "brush" && selectedBrush === brush.id ? "is-active" : ""}`}
                  onClick={() => chooseBrush(brush.id)}
                  aria-pressed={selectedTool === "brush" && selectedBrush === brush.id}
                >
                  <span>{brush.name}</span>
                  {locked ? <small>Studio</small> : null}
                </button>
              );
            })}
          </div>
        </section>

        <section className="tool-section rail-top rail-top-2">
          <h2>Color</h2>
          <div className="palette-grid">
            {activePalette.colors.map((color) => (
              <button
                type="button"
                key={color}
                className={`color-swatch ${selectedColor === color ? "is-active" : ""}`}
                style={{ backgroundColor: color }}
                onClick={() => choosePaletteColor(color)}
                aria-label={`Use ${color}`}
                aria-pressed={selectedColor === color}
              />
            ))}
          </div>
          <label className="color-picker">
            <span>Custom</span>
            <input
              type="color"
              value={selectedColor}
              // Live-preview the colour while dragging in the picker, but only
              // add ONE swatch to recents when the pick is committed (on blur) —
              // otherwise every intermediate shade spawned a duplicate swatch.
              onChange={(event) => setSelectedColor(event.target.value)}
              onBlur={(event) => {
                rememberColor(event.target.value);
                handToolRef.current = false;
                setHandTool(false);
              }}
            />
          </label>
          {recentColors.length > 0 ? (
            <div className="palette-grid recent-colors" aria-label="Recent colors">
              {recentColors.map((color) => (
                <button
                  type="button"
                  key={`recent-${color}`}
                  className={`color-swatch ${selectedColor === color ? "is-active" : ""}`}
                  style={{ backgroundColor: color }}
                  onClick={() => choosePaletteColor(color)}
                  aria-label={`Use recent ${color}`}
                  aria-pressed={selectedColor === color}
                />
              ))}
            </div>
          ) : null}
        </section>

        <section className="tool-section">
          <h2>Paper</h2>
          <div className="texture-grid">
            {paperTextures.map((texture) => {
              const locked = texture.tier === "studio" && !studioUnlocked;
              return (
                <button
                  type="button"
                  key={texture.id}
                  className={`texture-chip ${selectedTexture === texture.id ? "is-active" : ""}`}
                  onClick={() => chooseTexture(texture.id)}
                  aria-pressed={selectedTexture === texture.id}
                >
                  <span>{texture.name}</span>
                  {locked ? <small>Studio</small> : null}
                </button>
              );
            })}
          </div>
        </section>

        <section className="tool-section sliders rail-top rail-top-3">
          <h2>Stroke</h2>
          <label>
            <span>Size</span>
            <input type="range" min="2" max="120" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} />
            <output>{brushSize}</output>
          </label>
          <label>
            <span>Opacity</span>
            <input
              type="range"
              min="8"
              max="100"
              value={Math.round(brushOpacity * 100)}
              onChange={(event) => setBrushOpacity(Number(event.target.value) / 100)}
            />
            <output>{Math.round(brushOpacity * 100)}%</output>
          </label>
          <label>
            <span>Variation</span>
            <input
              type="range"
              min="0"
              max="40"
              value={Math.round(brushVariation * 100)}
              onChange={(event) => setBrushVariation(Number(event.target.value) / 100)}
            />
            <output>{Math.round(brushVariation * 100)}%</output>
          </label>
          {selectedTool === "text" ? (
            <label>
              <span>Text size</span>
              <input type="range" min="12" max="240" value={textSize} onChange={(event) => setTextSize(Number(event.target.value))} />
              <output>{textSize}</output>
            </label>
          ) : null}
        </section>

        <section className="tool-section economy-rail">
          <div className="section-title-row">
            <h2>Economy</h2>
            <span className="economy-balance-chip">{economy ? economy.wallet.drops_balance : 0} Drops</span>
          </div>
          <div className="economy-actions">
            <button type="button" onClick={() => setShowWallet(true)}>
              Wallet
            </button>
            <button type="button" onClick={() => setShowStore(true)}>
              Store
            </button>
            <button type="button" onClick={() => setShowCreator(true)}>
              Creator
            </button>
            <button type="button" onClick={() => setShowAccount(true)}>
              Account
            </button>
          </div>
          <div className="economy-tip-row">
            <span>Tip this artwork</span>
            <div className="economy-tip-presets">
              {TIP_PRESETS.map((amount) => (
                <button
                  type="button"
                  key={amount}
                  className="tip-chip"
                  onClick={() => handleSendTip(amount, { sourceType: "gallery_post", receiverName: "Featured artist" })}
                  title={`Tip ${amount} Drops`}
                >
                  {amount}
                </button>
              ))}
            </div>
          </div>
          {!studioUnlocked ? (
            <p className="economy-note economy-rail-note">
              Studio brushes &amp; paper unlock with the Creator Brushes pack in the Store.
            </p>
          ) : null}
        </section>
      </aside>

      {/* Mobile: an always-on bottom bar to flip paint/eraser/pan and open the
          tools/chat, so the canvas itself can fill the whole screen. */}
      <div className="mobile-quickbar" role="toolbar" aria-label="Quick tools">
        <button
          type="button"
          className={isPaintActive ? "qb-btn is-active" : "qb-btn"}
          onClick={onPaintButton}
          aria-pressed={isPaintActive}
        >
          <span className="qb-ico" aria-hidden="true">✏️</span>
          <span className="qb-label">Paint</span>
        </button>
        <button
          type="button"
          className={isEraserActive ? "qb-btn is-active" : "qb-btn"}
          onClick={activateEraser}
          aria-pressed={isEraserActive}
        >
          <span className="qb-ico" aria-hidden="true">🧽</span>
          <span className="qb-label">Eraser</span>
        </button>
        <button
          type="button"
          className={handTool ? "qb-btn is-active" : "qb-btn"}
          onClick={toggleHandTool}
          aria-pressed={handTool}
        >
          <span className="qb-ico" aria-hidden="true">✋</span>
          <span className="qb-label">Pan</span>
        </button>
        <button
          type="button"
          className={toolsOpen ? "qb-btn is-active" : "qb-btn"}
          onClick={() => setToolsOpen((open) => !open)}
          aria-pressed={toolsOpen}
        >
          <span className="qb-ico" aria-hidden="true">🎨</span>
          <span className="qb-label">Tools</span>
        </button>
        <button
          type="button"
          className={showChat ? "qb-btn is-active" : "qb-btn"}
          onClick={() => setShowChat((open) => !open)}
          aria-pressed={showChat}
        >
          <span className="qb-ico" aria-hidden="true">💬</span>
          <span className="qb-label">Chat{mp.chat.length ? ` ${mp.chat.length}` : ""}</span>
        </button>
      </div>
      {toolsOpen ? <div className="tools-backdrop" onClick={() => setToolsOpen(false)} aria-hidden="true" /> : null}

      {showPaintSpace ? (
        <PaintSpacePanel
          assets={paintSpaceAssets}
          onClose={() => setShowPaintSpace(false)}
          onUse={handleUseAsset}
          onRename={handleRenameAsset}
          onDelete={handleDeleteAsset}
          onPublishPack={() => setShowPublishPack(true)}
        />
      ) : null}

      {showPublishPack ? (
        <PublishPackModal
          assets={paintSpaceAssets}
          onClose={() => setShowPublishPack(false)}
          onPublish={handlePublishPack}
        />
      ) : null}

      {showAccount ? (
        <AccountPanel
          onClose={() => setShowAccount(false)}
          onDeleted={() => {
            // All local stores were wiped — reload so every in-memory locker
            // (draft, gallery, paint space, economy, AI) starts from empty.
            window.setTimeout(() => window.location.reload(), 2500);
          }}
        />
      ) : null}

      {showWallet && economy ? (
        <WalletPanel
          economy={economy}
          onClose={() => setShowWallet(false)}
          onOpenStore={() => {
            setShowWallet(false);
            setShowStore(true);
          }}
        />
      ) : null}

      {showStore && economy ? (
        <StorePanel
          economy={economy}
          onClose={() => setShowStore(false)}
          onBuyDrops={handleBuyDrops}
          onBuyItem={handleBuyItem}
        />
      ) : null}

      {showCreator && economy ? (
        <CreatorDashboard
          economy={economy}
          paintSpaceAssets={paintSpaceAssets}
          onClose={() => setShowCreator(false)}
          onOpenWallet={() => {
            setShowCreator(false);
            setShowWallet(true);
          }}
        />
      ) : null}

      {showReplay ? (
        <ReplayPlayer
          snapshots={replaySnapshots}
          isExporting={isExportingTimelapse}
          onClose={() => setShowReplay(false)}
          onRemixFromHere={remixFromSnapshot}
          onExportTimelapse={exportTimelapse}
          onSaveTimelapse={saveTimelapseToSpace}
        />
      ) : null}

      {showAiAssist ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowAiAssist(false)}>
          <section
            className="studio-modal ai-assist-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-assist-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-title-row">
              <h2 id="ai-assist-title">AI Assist</h2>
              <button type="button" onClick={() => setShowAiAssist(false)}>
                Close
              </button>
            </div>
            <AiAssistPanel
              consent={aiConsent}
              onConsent={handleAiConsent}
              onRevoke={handleAiRevoke}
              onApplyPalette={handleApplyAiPalette}
              onApplyBrushRecipe={handleApplyAiBrushRecipe}
              onUsePrompt={handleUseAiPrompt}
            />
          </section>
        </div>
      ) : null}

      {showBrushStudio ? (
        <BrushStudio
          color={selectedColor}
          savedBrushes={savedBrushAssets}
          onClose={() => setShowBrushStudio(false)}
          onSaveRecipe={handleSaveBrushRecipe}
          onApplyRecipe={handleApplyBrushRecipe}
        />
      ) : null}
    </main>
  );
}

export default function App() {
  const [path, setPath] = useState(() => window.location.pathname);

  const navigate = useCallback((nextPath) => {
    window.history.pushState({}, "", nextPath);
    setPath(window.location.pathname);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const handlePopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  if (path.startsWith("/studio")) {
    return <StudioApp initialPrompt={readPromptParam()} />;
  }

  if (path.startsWith("/join")) {
    const code = normalizePathCode(path);
    return <StudioApp initialJoinCode={code} />;
  }

  if (path.startsWith("/admin")) {
    return <LiveAdmin onNavigate={navigate} />;
  }

  return <MarketingSite onNavigate={navigate} />;
}

function normalizePathCode(path) {
  const [, , code = ""] = path.split("/");
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

// Read an event prompt passed via /studio?prompt=… (the Event Engine "live" CTA).
function readPromptParam() {
  try {
    const value = new URLSearchParams(window.location.search).get("prompt") || "";
    return value.slice(0, 180);
  } catch {
    return "";
  }
}
