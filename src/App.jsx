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
  createDefaultLayers,
  createLayer,
  cloneLayerCanvas,
  restoreLayersFromSnapshot,
  snapshotLayers,
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
import {
  addAsset,
  createAsset,
  readPaintSpace,
  removeAsset,
  renameAsset as renamePaintSpaceAsset,
  writePaintSpace,
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
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function StudioApp({ initialJoinCode = "" }) {
  const displayCanvasRef = useRef(null);
  const displayContextRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const overlayContextRef = useRef(null);

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
  const activePointerRef = useRef(null);
  const activeCanvasRectRef = useRef(null);
  const dirtyRef = useRef(false);
  const autosaveTimerRef = useRef(null);
  const saveInFlightRef = useRef(false);
  const settingsRef = useRef(null);

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
  // and refresh thumbnails for the strip.
  const syncFrameState = useCallback(() => {
    commitLayersToFrame();
    const snapshot = framesRef.current.map((frame) => ({ id: frame.id, durationMs: frame.durationMs }));
    setFrames(snapshot);
    setActiveFrameIndex(activeFrameIndexRef.current);
    const thumbs = {};
    for (const frame of framesRef.current) {
      thumbs[frame.id] = renderFrameThumbnail(frame);
    }
    setFrameThumbnails(thumbs);
  }, [commitLayersToFrame, renderFrameThumbnail]);

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

  // Recomposite the visible layer stack onto the display canvas. When onion
  // skin is on and we're not previewing playback, the previous and next frame
  // composites are drawn faintly beneath the active frame as editing guides.
  const renderDisplay = useCallback(() => {
    const context = displayContextRef.current;
    if (!context) {
      return;
    }
    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    if (onionSkinRef.current && framesRef.current.length > 1) {
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
    }

    compositeLayers(context, layersRef.current);
  }, []);

  const pushHistory = useCallback(() => {
    historyRef.current.push(snapshotLayers(layersRef.current, activeLayerIdRef.current));

    if (historyRef.current.length > MAX_HISTORY) {
      historyRef.current.shift();
    }

    redoRef.current = [];
    updateHistoryCounts();
  }, [updateHistoryCounts]);

  // Apply a layer snapshot (used by undo/redo). Ensures the active id still
  // points at an existing layer.
  const applySnapshot = useCallback(
    (snapshot) => {
      layersRef.current = restoreLayersFromSnapshot(snapshot);
      const stillExists = layersRef.current.some((layer) => layer.id === snapshot.activeLayerId);
      activeLayerIdRef.current = stillExists
        ? snapshot.activeLayerId
        : layersRef.current[layersRef.current.length - 1]?.id || null;
      renderDisplay();
      syncLayerState();
      updateHistoryCounts();
    },
    [renderDisplay, syncLayerState, updateHistoryCounts],
  );

  const undo = useCallback(() => {
    const previous = historyRef.current.pop();
    if (!previous) {
      return;
    }
    redoRef.current.push(snapshotLayers(layersRef.current, activeLayerIdRef.current));
    applySnapshot(previous);
    markChanged("Undo");
  }, [applySnapshot, markChanged]);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) {
      return;
    }
    historyRef.current.push(snapshotLayers(layersRef.current, activeLayerIdRef.current));
    applySnapshot(next);
    markChanged("Redo");
  }, [applySnapshot, markChanged]);

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

  const saveDraft = useCallback(async () => {
    if (saveInFlightRef.current || layersRef.current.length === 0) {
      return;
    }

    saveInFlightRef.current = true;

    // Persist each layer's pixels plus meta so the full stack restores.
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

    writeJson(STORAGE_KEYS.draft, {
      layers: layerData,
      activeLayerId: activeLayerIdRef.current,
      settings: settingsRef.current,
      savedAt: new Date().toISOString(),
    });
    dirtyRef.current = false;
    saveInFlightRef.current = false;
    setStatus("Autosaved");
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
        if (item.image) {
          const image = await createImage(item.image).catch(() => null);
          if (image) {
            layer.canvas.getContext("2d").drawImage(image, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          }
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
      syncFrameState();
    },
    [renderDisplay, syncFrameState, syncLayerState],
  );

  const restoreDraft = useCallback(async () => {
    const draft = readJson(STORAGE_KEYS.draft, null);

    if (!draft?.layers?.length) {
      setStatus("No saved draft yet");
      return;
    }

    pushHistory();
    await restoreLayersFromDraft(draft.layers);

    if (draft.activeLayerId && layersRef.current.some((layer) => layer.id === draft.activeLayerId)) {
      activeLayerIdRef.current = draft.activeLayerId;
      syncLayerState();
    }

    applyDraftSettings(draft.settings);
    markChanged("Draft restored");
  }, [applyDraftSettings, markChanged, pushHistory, restoreLayersFromDraft, syncLayerState]);

  const saveToGallery = useCallback(async () => {
    if (layersRef.current.length === 0) {
      return;
    }

    const fullCanvas = await composeCanvas();
    const previewCanvas = await composeCanvas({ width: 400, height: 300 });
    const item = {
      id: crypto.randomUUID(),
      name: `Happy Paint ${todayName()}`,
      layer: await canvasToDataUrl(fullCanvas),
      textureId: selectedTexture,
      preview: await canvasToDataUrl(previewCanvas),
      createdAt: new Date().toISOString(),
    };

    setGallery((current) => {
      const next = [item, ...current].slice(0, MAX_GALLERY_ITEMS);
      writeJson(STORAGE_KEYS.gallery, next);
      return next;
    });
    setStatus("Saved to gallery");
  }, [composeCanvas, selectedTexture]);

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
      pushHistory();
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

      renderDisplay();
    },
    [getActiveLayer, getPoint, renderDisplay],
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

  const startStroke = useCallback(
    (event) => {
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

      // Default: brush / eraser stroke.
      lastPointRef.current = getPoint(event.nativeEvent);
      pushHistory();
      drawBrushFromEvent(event);
      markChanged("Drawing");
    },
    [beginInteraction, drawBrushFromEvent, getActiveLayer, getPoint, markChanged, pushHistory, refreshActiveThumbnail, renderDisplay, updateHistoryCounts],
  );

  const continueStroke = useCallback(
    (event) => {
      if (activePointerRef.current !== event.pointerId) {
        return;
      }

      event.preventDefault();
      const tool = settingsRef.current?.tool || "brush";

      if (tool === "rect" || tool === "ellipse" || tool === "line") {
        // Preview shape on the overlay so the active layer stays clean.
        const overlay = overlayContextRef.current;
        const start = shapeStartRef.current;
        if (overlay && start) {
          overlay.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          drawShape(overlay, tool, start, getPoint(event.nativeEvent), {
            color: settingsRef.current.color,
            size: settingsRef.current.size,
            opacity: settingsRef.current.opacity,
            fillShape: settingsRef.current.fillShape,
          });
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
      } else {
        markChanged("Stroke saved");
      }

      activePointerRef.current = null;
      activeCanvasRectRef.current = null;
      lastPointRef.current = null;
      updateHistoryCounts();
      refreshActiveThumbnail();
    },
    [getActiveLayer, getPoint, markChanged, pushHistory, refreshActiveThumbnail, renderDisplay, updateHistoryCounts],
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
    pushHistory();
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
      pushHistory();
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
      pushHistory();
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
      pushHistory();
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
      pushHistory();
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

  const handleOpacityChange = useCallback(
    (id, opacity) => {
      const layer = layersRef.current.find((item) => item.id === id);
      if (!layer) {
        return;
      }
      layer.opacity = opacity;
      renderDisplay();
      syncLayerState();
      dirtyRef.current = true;
    },
    [renderDisplay, syncLayerState],
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
      window.clearTimeout(playTimerRef.current);
      playTimerRef.current = null;
    }
    setIsPlaying(false);
    // Restore the active frame's editable composite.
    renderDisplay();
  }, [renderDisplay]);

  const startPlayback = useCallback(() => {
    if (framesRef.current.length <= 1) {
      return;
    }
    commitLayersToFrame();
    setIsPlaying(true);
    const context = displayContextRef.current;
    let cursor = 0;

    const step = () => {
      const frame = framesRef.current[cursor % framesRef.current.length];
      context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      compositeLayers(context, frame.layers);
      cursor += 1;
      playTimerRef.current = window.setTimeout(step, Math.max(40, frame.durationMs));
    };

    step();
  }, [commitLayersToFrame]);

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

  // ---- GIF export: composite each frame (paper + layers) downscaled, then
  // encode with the self-contained GIF89a encoder. ----

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
      const gifFrames = [];
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
        gifFrames.push({ source: canvas, delayMs: frame.durationMs });
      }

      const bytes = encodeGif(gifFrames, { width: GIF_EXPORT_WIDTH, height: GIF_EXPORT_HEIGHT });
      const blob = new Blob([bytes], { type: "image/gif" });
      downloadBlob(blob, `happy-paint-loop-${Date.now()}.gif`);
      setStatus(`GIF exported (${framesRef.current.length} frames)`);
    } catch {
      setStatus("GIF export failed");
    } finally {
      setIsExportingGif(false);
    }
  }, [commitLayersToFrame, isExportingGif, renderPaper, selectedTexture, stopPlayback]);

  // ---- Paint Space locker ----

  const persistPaintSpace = useCallback((updater) => {
    setPaintSpaceAssets((current) => {
      const next = updater(current);
      writePaintSpace(next);
      return next;
    });
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
    persistPaintSpace((current) => addAsset(current, asset));
    setStatus("Saved sticker to Paint Space");
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
    persistPaintSpace((current) => addAsset(current, asset));
    setStatus("Saved template to Paint Space");
  }, [commitLayersToFrame, composeCanvas, persistPaintSpace, selectedTexture]);

  const savePaletteToSpace = useCallback(() => {
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
    persistPaintSpace((current) => addAsset(current, asset));
    setStatus("Saved palette to Paint Space");
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
    persistPaintSpace((current) => addAsset(current, asset));
    setStatus(`Saved ${loopFrames.length}-frame loop to Paint Space`);
  }, [commitLayersToFrame, persistPaintSpace]);

  const handleRenameAsset = useCallback(
    (asset) => {
      const title = window.prompt("Rename asset:", asset.title);
      if (title && title.trim()) {
        persistPaintSpace((current) => renamePaintSpaceAsset(current, asset.id, title.trim()));
      }
    },
    [persistPaintSpace],
  );

  const handleDeleteAsset = useCallback(
    (asset) => {
      persistPaintSpace((current) => removeAsset(current, asset.id));
      setStatus("Asset deleted");
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
    const display = displayCanvasRef.current;
    const overlay = overlayCanvasRef.current;
    display.width = CANVAS_WIDTH;
    display.height = CANVAS_HEIGHT;
    overlay.width = CANVAS_WIDTH;
    overlay.height = CANVAS_HEIGHT;

    const displayContext = display.getContext("2d", { alpha: true, desynchronized: true });
    displayContext.lineCap = "round";
    displayContext.lineJoin = "round";
    displayContext.imageSmoothingEnabled = true;
    displayContextRef.current = displayContext;
    overlayContextRef.current = overlay.getContext("2d", { alpha: true });

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

    const savedGallery = readJson(STORAGE_KEYS.gallery, []);
    const savedStudio = readJson(STORAGE_KEYS.studio, false);
    setGallery(Array.isArray(savedGallery) ? savedGallery : []);
    setStudioUnlocked(Boolean(savedStudio));
    setPaintSpaceAssets(readPaintSpace());

    const draft = readJson(STORAGE_KEYS.draft, null);
    if (draft?.layers?.length) {
      restoreLayersFromDraft(draft.layers).then(() => {
        if (draft.activeLayerId && layersRef.current.some((layer) => layer.id === draft.activeLayerId)) {
          activeLayerIdRef.current = draft.activeLayerId;
          syncLayerState();
        }
        setStatus("Draft restored");
      });
      applyDraftSettings(draft.settings);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Stop any running loop preview when the studio unmounts.
  useEffect(() => {
    return () => {
      if (playTimerRef.current) {
        window.clearTimeout(playTimerRef.current);
        playTimerRef.current = null;
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
              onPointerLeave={finishStroke}
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
