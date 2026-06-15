import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  brushCatalog,
  drawBrushSegment,
  getTexture,
  paletteCatalog,
  paperTextures,
  studioPacks,
} from "./utils/brushes";
import MarketingSite from "./components/MarketingSite";
import TogetherPanel from "./components/TogetherPanel";
import AdminConsole from "./components/AdminConsole";
import "./App.css";

const CANVAS_WIDTH = 1600;
const CANVAS_HEIGHT = 1200;
const MAX_HISTORY = 18;
const MAX_GALLERY_ITEMS = 10;

const STORAGE_KEYS = {
  draft: "happypaint:draft:v2",
  gallery: "happypaint:gallery:v2",
  studio: "happypaint:studio-pass:v1",
};

function cloneCanvas(source) {
  const snapshot = document.createElement("canvas");
  snapshot.width = source.width;
  snapshot.height = source.height;
  snapshot.getContext("2d").drawImage(source, 0, 0);
  return snapshot;
}

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
  const canvasRef = useRef(null);
  const contextRef = useRef(null);
  const historyRef = useRef([]);
  const redoRef = useRef([]);
  const lastPointRef = useRef(null);
  const activePointerRef = useRef(null);
  const activeCanvasRectRef = useRef(null);
  const dirtyRef = useRef(false);
  const autosaveTimerRef = useRef(null);
  const saveInFlightRef = useRef(false);
  const settingsRef = useRef(null);

  const [selectedBrush, setSelectedBrush] = useState("marker");
  const [selectedColor, setSelectedColor] = useState("#111827");
  const [selectedTexture, setSelectedTexture] = useState("linen");
  const [brushSize, setBrushSize] = useState(24);
  const [brushOpacity, setBrushOpacity] = useState(0.86);
  const [brushVariation, setBrushVariation] = useState(0.08);
  const [gallery, setGallery] = useState([]);
  const [status, setStatus] = useState("Ready");
  const [historyCount, setHistoryCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const [studioUnlocked, setStudioUnlocked] = useState(false);
  const [showStudio, setShowStudio] = useState(false);

  const selectedTextureMeta = useMemo(() => getTexture(selectedTexture), [selectedTexture]);
  const activePalette = paletteCatalog[studioUnlocked ? 2 : 0];

  useEffect(() => {
    settingsRef.current = {
      brush: selectedBrush,
      color: selectedColor,
      opacity: brushOpacity,
      size: brushSize,
      variation: brushVariation,
      texture: selectedTexture,
      studioUnlocked,
    };
  }, [brushOpacity, brushSize, brushVariation, selectedBrush, selectedColor, selectedTexture, studioUnlocked]);

  const updateHistoryCounts = useCallback(() => {
    setHistoryCount(historyRef.current.length);
    setRedoCount(redoRef.current.length);
  }, []);

  const markChanged = useCallback((message = "Saved locally") => {
    dirtyRef.current = true;
    setStatus(message);
  }, []);

  const captureSnapshot = useCallback(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return null;
    }

    return cloneCanvas(canvas);
  }, []);

  const pushHistory = useCallback(() => {
    const snapshot = captureSnapshot();

    if (!snapshot) {
      return;
    }

    historyRef.current.push(snapshot);

    if (historyRef.current.length > MAX_HISTORY) {
      historyRef.current.shift();
    }

    redoRef.current = [];
    updateHistoryCounts();
  }, [captureSnapshot, updateHistoryCounts]);

  const restoreSnapshot = useCallback((snapshot) => {
    const canvas = canvasRef.current;
    const context = contextRef.current;

    if (!canvas || !context || !snapshot) {
      return;
    }

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(snapshot, 0, 0);
    updateHistoryCounts();
  }, [updateHistoryCounts]);

  const undo = useCallback(() => {
    const canvas = canvasRef.current;
    const context = contextRef.current;
    const previous = historyRef.current.pop();

    if (!canvas || !context || !previous) {
      return;
    }

    redoRef.current.push(cloneCanvas(canvas));
    restoreSnapshot(previous);
    markChanged("Undo");
  }, [markChanged, restoreSnapshot]);

  const redo = useCallback(() => {
    const canvas = canvasRef.current;
    const context = contextRef.current;
    const next = redoRef.current.pop();

    if (!canvas || !context || !next) {
      return;
    }

    historyRef.current.push(cloneCanvas(canvas));
    restoreSnapshot(next);
    markChanged("Redo");
  }, [markChanged, restoreSnapshot]);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const context = contextRef.current;

    if (!canvas || !context) {
      return;
    }

    pushHistory();
    context.clearRect(0, 0, canvas.width, canvas.height);
    markChanged("Canvas cleared");
  }, [markChanged, pushHistory]);

  const composeCanvas = useCallback(async ({ width = CANVAS_WIDTH, height = CANVAS_HEIGHT, textureId = selectedTexture } = {}) => {
    const sourceCanvas = canvasRef.current;
    const texture = getTexture(textureId);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    const scaleX = width / CANVAS_WIDTH;
    const scaleY = height / CANVAS_HEIGHT;

    canvas.width = width;
    canvas.height = height;
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

    if (sourceCanvas) {
      context.drawImage(sourceCanvas, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT, 0, 0, width, height);
    }

    return canvas;
  }, [selectedTexture]);

  const saveDraft = useCallback(async () => {
    const canvas = canvasRef.current;

    if (!canvas || saveInFlightRef.current) {
      return;
    }

    saveInFlightRef.current = true;
    const layer = await canvasToDataUrl(canvas);

    if (!layer) {
      saveInFlightRef.current = false;
      return;
    }

    writeJson(STORAGE_KEYS.draft, {
      layer,
      settings: settingsRef.current,
      savedAt: new Date().toISOString(),
    });
    dirtyRef.current = false;
    saveInFlightRef.current = false;
    setStatus("Autosaved");
  }, []);

  const restoreLayer = useCallback(async (layer) => {
    const canvas = canvasRef.current;
    const context = contextRef.current;

    if (!canvas || !context || !layer) {
      return;
    }

    const image = await createImage(layer);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    markChanged("Artwork restored");
  }, [markChanged]);

  const restoreDraft = useCallback(async () => {
    const draft = readJson(STORAGE_KEYS.draft, null);

    if (!draft?.layer) {
      setStatus("No saved draft yet");
      return;
    }

    pushHistory();
    await restoreLayer(draft.layer);

    if (draft.settings) {
      setSelectedBrush(draft.settings.brush || "marker");
      setSelectedColor(draft.settings.color || "#111827");
      setSelectedTexture(draft.settings.texture || "linen");
      setBrushSize(draft.settings.size || 24);
      setBrushOpacity(draft.settings.opacity || 0.86);
      setBrushVariation(draft.settings.variation || 0.08);
    }
  }, [pushHistory, restoreLayer]);

  const saveToGallery = useCallback(async () => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const layer = await canvasToDataUrl(canvas);

    if (!layer) {
      return;
    }

    const previewCanvas = await composeCanvas({ width: 400, height: 300 });
    const item = {
      id: crypto.randomUUID(),
      name: `Happy Paint ${todayName()}`,
      layer,
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

  const restoreGalleryItem = useCallback(async (item) => {
    pushHistory();
    setSelectedTexture(item.textureId || "linen");
    await restoreLayer(item.layer);
  }, [pushHistory, restoreLayer]);

  const chooseBrush = useCallback((brushId) => {
    const brush = brushCatalog.find((item) => item.id === brushId);

    if (brush?.tier === "studio" && !studioUnlocked) {
      setShowStudio(true);
      setStatus("Studio brush locked");
      return;
    }

    setSelectedBrush(brushId);
  }, [studioUnlocked]);

  const chooseTexture = useCallback((textureId) => {
    const texture = paperTextures.find((item) => item.id === textureId);

    if (texture?.tier === "studio" && !studioUnlocked) {
      setShowStudio(true);
      setStatus("Studio paper locked");
      return;
    }

    setSelectedTexture(textureId);
  }, [studioUnlocked]);

  const choosePaletteColor = useCallback((color) => {
    setSelectedColor(color);
  }, []);

  const getPoint = useCallback((event) => {
    const canvas = canvasRef.current;
    const rect = activeCanvasRectRef.current || canvas.getBoundingClientRect();
    const pressure = event.pressure && event.pressure > 0 ? event.pressure : event.pointerType === "mouse" ? 0.62 : 0.72;

    return {
      x: ((event.clientX - rect.left) / rect.width) * CANVAS_WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * CANVAS_HEIGHT,
      pressure,
    };
  }, []);

  const drawFromEvent = useCallback((event) => {
    const context = contextRef.current;
    const settings = settingsRef.current;

    if (!context || !settings || activePointerRef.current !== event.pointerId) {
      return;
    }

    const nativeEvent = event.nativeEvent;
    const coalescedEvents = typeof nativeEvent.getCoalescedEvents === "function" ? nativeEvent.getCoalescedEvents() : [];
    const events = coalescedEvents.length > 0 ? coalescedEvents : [nativeEvent];

    for (const pointerEvent of events) {
      const point = getPoint(pointerEvent);
      const lastPoint = lastPointRef.current || point;
      drawBrushSegment(context, lastPoint, point, settings);
      lastPointRef.current = point;
    }
  }, [getPoint]);

  const startStroke = useCallback((event) => {
    if (event.button !== undefined && event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    activePointerRef.current = event.pointerId;
    activeCanvasRectRef.current = event.currentTarget.getBoundingClientRect();
    lastPointRef.current = getPoint(event.nativeEvent);
    pushHistory();
    drawFromEvent(event);
    markChanged("Drawing");
  }, [drawFromEvent, getPoint, markChanged, pushHistory]);

  const continueStroke = useCallback((event) => {
    if (activePointerRef.current !== event.pointerId) {
      return;
    }

    event.preventDefault();
    drawFromEvent(event);
  }, [drawFromEvent]);

  const finishStroke = useCallback((event) => {
    if (activePointerRef.current !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    activePointerRef.current = null;
    activeCanvasRectRef.current = null;
    lastPointRef.current = null;
    updateHistoryCounts();
    markChanged("Stroke saved");
  }, [markChanged, updateHistoryCounts]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d", { alpha: true, desynchronized: true });

    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.imageSmoothingEnabled = true;
    contextRef.current = context;
    historyRef.current = [cloneCanvas(canvas)];
    redoRef.current = [];
    updateHistoryCounts();

    const savedGallery = readJson(STORAGE_KEYS.gallery, []);
    const savedStudio = readJson(STORAGE_KEYS.studio, false);
    setGallery(Array.isArray(savedGallery) ? savedGallery : []);
    setStudioUnlocked(Boolean(savedStudio));

    const draft = readJson(STORAGE_KEYS.draft, null);
    if (draft?.layer) {
      restoreLayer(draft.layer).then(() => {
        setStatus("Draft restored");
      });

      if (draft.settings) {
        setSelectedBrush(draft.settings.brush || "marker");
        setSelectedColor(draft.settings.color || "#111827");
        setSelectedTexture(draft.settings.texture || "linen");
        setBrushSize(draft.settings.size || 24);
        setBrushOpacity(draft.settings.opacity || 0.86);
        setBrushVariation(draft.settings.variation || 0.08);
      }
    }
  }, [restoreLayer, updateHistoryCounts]);

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

  return (
    <main className="studio-shell">
      <section className="studio-workspace" aria-label="Happy Paint drawing studio">
        <div className="topbar">
          <div>
            <p className="eyebrow">Happy Paint</p>
            <h1>Studio</h1>
          </div>
          <div className="topbar-actions">
            <button type="button" onClick={undo} disabled={historyCount <= 1}>
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
          </div>
        </div>

        <div className="canvas-stage">
          <div className="canvas-paper" style={paperStyle}>
            <canvas
              ref={canvasRef}
              className="drawing-canvas"
              aria-label="Drawing canvas"
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
          <h2>Brushes</h2>
          <div className="brush-grid">
            {brushCatalog.map((brush) => {
              const locked = brush.tier === "studio" && !studioUnlocked;
              return (
                <button
                  type="button"
                  key={brush.id}
                  className={`brush-chip ${selectedBrush === brush.id ? "is-active" : ""}`}
                  onClick={() => chooseBrush(brush.id)}
                  aria-pressed={selectedBrush === brush.id}
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
            <input type="color" value={selectedColor} onChange={(event) => setSelectedColor(event.target.value)} />
          </label>
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
