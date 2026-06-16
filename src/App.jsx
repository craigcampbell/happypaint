import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  brushCatalog,
  drawBrushSegment,
  getTexture,
  paletteCatalog,
  paperTextures,
  studioPacks,
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
import {
  addAsset,
  createAsset,
  loadPaintSpace,
  makeId,
  removeAsset,
  renameAsset as renamePaintSpaceAsset,
  savePaintSpace,
} from "./utils/paintSpace";
import LayerPanel from "./components/LayerPanel";
import FrameStrip from "./components/FrameStrip";
import PaintSpacePanel from "./components/PaintSpacePanel";
import MarketingSite from "./components/MarketingSite";
import TogetherPanel from "./components/TogetherPanel";
import AdminConsole from "./components/AdminConsole";
import "./App.css";

const MAX_HISTORY = 18;
const MAX_GALLERY_ITEMS = 10;

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

function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Local storage can fill up with image data. The app keeps running even if a save is skipped.
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

function StudioApp({ initialJoinCode = "" }) {
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
  const [studioUnlocked, setStudioUnlocked] = useState(false);
  const [showStudio, setShowStudio] = useState(false);

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

  // Render a small thumbnail data URL for one frame.
  const renderFrameThumbnail = useCallback((frame) => {
    const canvas = compositeFrameToCanvas(frame, { width: FRAME_THUMB_WIDTH, height: FRAME_THUMB_HEIGHT });
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

  // Blit the 1600x1200 document composite onto the visible display canvas,
  // scaling into its full DPR-sized backing store so the result is crisp on
  // HiDPI screens (W6).
  const blitToDisplay = useCallback(() => {
    const context = displayContextRef.current;
    const doc = docCanvasRef.current;
    const display = displayCanvasRef.current;
    if (!context || !doc || !display) {
      return;
    }
    context.clearRect(0, 0, display.width, display.height);
    context.drawImage(doc, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT, 0, 0, display.width, display.height);
  }, []);

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
  const renderDisplay = useCallback(() => {
    const context = docContextRef.current;
    if (!context) {
      return;
    }
    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    paintOnionSkin(context);
    compositeLayers(context, layersRef.current);
    compositeCacheValidRef.current = false;
    blitToDisplay();
  }, [blitToDisplay, paintOnionSkin]);

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
    context.drawImage(belowCacheRef.current, 0, 0);
    if (active.visible && active.opacity > 0) {
      context.globalAlpha = active.opacity;
      context.drawImage(active.canvas, 0, 0);
      context.globalAlpha = 1;
    }
    context.drawImage(aboveCacheRef.current, 0, 0);
    blitToDisplay();
  }, [blitToDisplay, renderDisplay]);

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

  const clearCanvas = useCallback(() => {
    const active = getActiveLayer();
    if (!active) {
      return;
    }
    pushHistory();
    active.canvas.getContext("2d").clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    renderDisplay();
    refreshActiveThumbnail();
    markChanged("Layer cleared");
  }, [getActiveLayer, markChanged, pushHistory, refreshActiveThumbnail, renderDisplay]);

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

      compositeLayers(context, layersRef.current, { width, height });
      return canvas;
    },
    [renderPaper, selectedTexture],
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
        setShowStudio(true);
        setStatus("Studio brush locked");
        return;
      }

      setSelectedBrush(brushId);
      setSelectedTool("brush");
    },
    [studioUnlocked],
  );

  const chooseTexture = useCallback(
    (textureId) => {
      const texture = paperTextures.find((item) => item.id === textureId);

      if (texture?.tier === "studio" && !studioUnlocked) {
        setShowStudio(true);
        setStatus("Studio paper locked");
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
    },
    [rememberColor],
  );

  const getPoint = useCallback((event) => {
    const canvas = displayCanvasRef.current;
    const rect = activeCanvasRectRef.current || canvas.getBoundingClientRect();
    const pressure = event.pressure && event.pressure > 0 ? event.pressure : event.pointerType === "mouse" ? 0.62 : 0.72;

    return {
      x: ((event.clientX - rect.left) / rect.width) * CANVAS_WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * CANVAS_HEIGHT,
      pressure,
    };
  }, []);

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

      for (const pointerEvent of events) {
        const point = getPoint(pointerEvent);
        const lastPoint = lastPointRef.current || point;
        drawBrushSegment(context, lastPoint, point, settings);
        lastPointRef.current = point;
      }

      // Coalesced, cache-backed display update (W1/W2/W5): at most one
      // below + active + above composite per painted frame.
      scheduleStrokeFrame();
    },
    [getActiveLayer, getPoint, scheduleStrokeFrame],
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
          renderDisplay();
          refreshActiveThumbnail();
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
      drawBrushFromEvent(event);
      markChanged("Drawing");
    },
    [beginInteraction, buildCompositeCache, drawBrushFromEvent, getActiveLayer, getPoint, markChanged, pushHistory, refreshActiveThumbnail, renderDisplay, shouldRejectPointer, updateHistoryCounts],
  );

  const continueStroke = useCallback(
    (event) => {
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
          drawShape(active.canvas.getContext("2d"), tool, start, end, {
            color: settingsRef.current.color,
            size: settingsRef.current.size,
            opacity: settingsRef.current.opacity,
            fillShape: settingsRef.current.fillShape,
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
        // Brush/eraser: flush any pending per-move composite, then do one full
        // recomposite (this also invalidates the per-stroke caches).
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
    },
    [flushStrokeFrame, getActiveLayer, getPoint, invalidateCompositeCache, markChanged, pushHistory, refreshActiveThumbnail, renderDisplay, updateHistoryCounts],
  );

  // ---- Layer actions (mutate refs, snapshot before, then sync state) ----

  const handleSelectLayer = useCallback(
    (id) => {
      activeLayerIdRef.current = id;
      syncLayerState();
    },
    [syncLayerState],
  );

  const handleAddLayer = useCallback(() => {
    pushHistory("full");
    const layer = createLayer({ name: `Layer ${layersRef.current.length + 1}` });
    layersRef.current = [...layersRef.current, layer];
    activeLayerIdRef.current = layer.id;
    renderDisplay();
    syncLayerState();
    markChanged("Layer added");
  }, [markChanged, pushHistory, renderDisplay, syncLayerState]);

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
      markChanged("Layer deleted");
    },
    [markChanged, pushHistory, renderDisplay, syncLayerState],
  );

  const handleDuplicateLayer = useCallback(
    (id) => {
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
    },
    [renderDisplay, syncLayerState, updateHistoryCounts],
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

      if (asset.kind === "loop") {
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
    [getActiveLayer, markChanged, pushHistory, renderDisplay, syncFrameState, syncLayerState],
  );

  // ---- Initialization ----

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

    const savedStudio = readJson(STORAGE_KEYS.studio, false);
    setStudioUnlocked(Boolean(savedStudio));

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

  useEffect(() => {
    writeJson(STORAGE_KEYS.studio, studioUnlocked);
  }, [studioUnlocked]);

  const paperStyle = {
    "--paper-bg": selectedTextureMeta.background,
    "--paper-texture": selectedTextureMeta.file ? `url("${selectedTextureMeta.file}")` : "none",
  };

  const showShapeFillOption = selectedTool === "rect" || selectedTool === "ellipse";

  return (
    <main className="studio-shell">
      <section className="studio-workspace" aria-label="Happy Paint drawing studio">
        <div className="topbar">
          <div>
            <p className="eyebrow">Happy Paint</p>
            <h1>Studio</h1>
          </div>
          <div className="topbar-actions">
            <button type="button" onClick={undo} disabled={historyCount === 0}>
              Undo
            </button>
            <button type="button" onClick={redo} disabled={redoCount === 0}>
              Redo
            </button>
            <button type="button" onClick={clearCanvas}>
              Clear
            </button>
            <button type="button" className="primary-action" onClick={saveToGallery}>
              Save
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

        <div className="canvas-stage">
          <div className="canvas-paper" style={paperStyle}>
            <canvas ref={displayCanvasRef} className="drawing-canvas display-canvas" aria-label="Drawing canvas" />
            <canvas
              ref={overlayCanvasRef}
              className="drawing-canvas overlay-canvas"
              aria-hidden="true"
              onPointerDown={startStroke}
              onPointerMove={continueStroke}
              onPointerUp={finishStroke}
              onPointerCancel={finishStroke}
            />
          </div>
        </div>

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

      <aside className="tool-rail" aria-label="Drawing tools">
        <div className="status-line">{status}</div>

        <section className="tool-section">
          <h2>Tool</h2>
          <div className="brush-grid">
            {TOOLS.map((tool) => (
              <button
                type="button"
                key={tool.id}
                className={`brush-chip ${selectedTool === tool.id ? "is-active" : ""}`}
                onClick={() => setSelectedTool(tool.id)}
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

        <section className="tool-section">
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

        <section className="tool-section">
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
              onChange={(event) => {
                setSelectedColor(event.target.value);
                rememberColor(event.target.value);
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

        <section className="tool-section sliders">
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

        <section className="tool-section studio-pass">
          <div className="section-title-row">
            <h2>Drops Preview</h2>
            <button type="button" onClick={() => setShowStudio(true)}>
              View
            </button>
          </div>
          <button type="button" className="pass-toggle" onClick={() => setStudioUnlocked((value) => !value)}>
            {studioUnlocked ? "Demo Drops On" : "Demo Drops Off"}
          </button>
        </section>

        <TogetherPanel initialJoinCode={initialJoinCode} onStatus={setStatus} />
      </aside>

      {showPaintSpace ? (
        <PaintSpacePanel
          assets={paintSpaceAssets}
          onClose={() => setShowPaintSpace(false)}
          onUse={handleUseAsset}
          onRename={handleRenameAsset}
          onDelete={handleDeleteAsset}
        />
      ) : null}

      {showStudio ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowStudio(false)}>
          <section className="studio-modal" role="dialog" aria-modal="true" aria-labelledby="studio-pass-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-title-row">
              <h2 id="studio-pass-title">Drops Pack Preview</h2>
              <button type="button" onClick={() => setShowStudio(false)}>
                Close
              </button>
            </div>
            <div className="pack-grid">
              {studioPacks.map((pack) => (
                <article className="pack-card" key={pack.id}>
                  <div>
                    <h3>{pack.title}</h3>
                    <p>{pack.price}</p>
                  </div>
                  <ul>
                    {pack.perks.map((perk) => (
                      <li key={perk}>{perk}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
            <button
              type="button"
              className="primary-action full-width"
              onClick={() => {
                setStudioUnlocked(true);
                setShowStudio(false);
                setStatus("Demo Drops packs enabled");
              }}
            >
              Enable Demo Packs
            </button>
          </section>
        </div>
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
    return <StudioApp />;
  }

  if (path.startsWith("/join")) {
    const code = normalizePathCode(path);
    return <StudioApp initialJoinCode={code} />;
  }

  if (path.startsWith("/admin")) {
    return <AdminConsole onNavigate={navigate} />;
  }

  return <MarketingSite onNavigate={navigate} />;
}

function normalizePathCode(path) {
  const [, , code = ""] = path.split("/");
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}
