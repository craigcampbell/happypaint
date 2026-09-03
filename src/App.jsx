import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  brushCatalog,
  drawBrushSegment,
  getAuthoringDab,
  getStrokeDab,
  getTexture,
  makeSmudgeRenderer,
  makeStrokeEntryCore,
  normalizeSmudgeSettings,
  paletteCatalog,
  paperTextures,
  pointRand,
  prebuildBrushSprites,
  preloadBrushStamp,
  isBrushStampReady,
  prepareStrokeCommit,
  releaseBrushSprites,
} from "./utils/brushes";
import { BRUSH_TIP_ALPHA, brushTipExtent, drawBrushTip } from "./utils/brushTip";
import { createMixMap } from "./utils/mixMap";
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
import { encodeAnimationVideo } from "./utils/videoExport";
import { replayFrameOnto } from "./utils/opReplay";
import { idbDelete, idbGet, idbGetKV, idbSet, idbSetKV, isIdbAvailable } from "./utils/idb";
import { getSession, onAuthStateChange, signOut } from "./utils/auth";
import { getRecentRooms, recordRecentRoom } from "./utils/recentRooms";
import { useMentionWatcher } from "./hooks/useMentionWatcher";
import { addNotification, getNotifications, markAllRead, clearNotifications } from "./utils/notifications";
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
  earnDropsForPainting,
  earnDropsForQuest,
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
import BrandMark from "./components/BrandMark";
import FilmStrip from "./components/FilmStrip";
import PaintSpacePanel from "./components/PaintSpacePanel";
import ReplayPlayer from "./components/ReplayPlayer";
import AiAssistPanel from "./components/AiAssistPanel";
import BrushStudio from "./components/BrushStudio";
import Storyboard from "./components/Storyboard";
import PublishPackModal from "./components/PublishPackModal";
import WalletPanel from "./components/WalletPanel";
import StorePanel from "./components/StorePanel";
import CreatorDashboard from "./components/CreatorDashboard";
import HomePage from "./components/HomePage";
import AboutPage from "./components/AboutPage";
import PrivacyPage from "./components/PrivacyPage";
import SignupPage from "./components/SignupPage";
import RoomFinderPage from "./components/RoomFinderPage";
import SafetyPage from "./components/SafetyPage";
import ParentsPage from "./components/ParentsPage";
import FaqPage from "./components/FaqPage";
import LiveAdmin from "./components/LiveAdmin";
import AccountPanel from "./components/AccountPanel";
import HostControlPanel from "./components/HostControlPanel";
import RoomLobby from "./components/RoomLobby";
import StepBackPreview from "./components/StepBackPreview";
import { createNsfwWatcher, isWatcherCapable } from "./utils/nsfwWatcher";
import { classifyImageNsfw } from "./utils/nsfwCheck";
import ColoringSheetModal from "./components/ColoringSheetModal";
import GameHud from "./components/GameHud";
import DrawPhonePanel from "./components/DrawPhonePanel";
import CanvasChat from "./components/CanvasChat";
import { HYPES } from "./utils/hypes";
import { evictPageImage } from "./utils/pageImageCache";
import WallPage from "./components/WallPage";
import WallPostModal from "./components/WallPostModal";
import BrushPreview from "./components/BrushPreview";
import { useMultiplayer } from "./hooks/useMultiplayer";
import { useLayoutTier, resolveLayoutTier } from "./hooks/useLayoutTier";
import {
  isEraserPointer,
  isSecondaryButtonPointer,
  loadPenCalibration,
  mapPenPressure,
  savePenCalibration,
} from "./utils/penInput";
import { extractCanvasPalette, resolvePreviewTheme } from "./utils/artPreview";
import {
  normalizeSymmetry,
  transformPointBySymmetry,
  transformPointsBySymmetry,
} from "./utils/symmetry";
import { createPaintOrchestra } from "./utils/paintOrchestra";
import QuestPanel from "./components/QuestPanel";
import StorybookPanel from "./components/StorybookPanel";
import PaintOrchestraPanel from "./components/PaintOrchestraPanel";
import "./App.css";
import "./drawesome-theme.css";
import "./homepage-redesign.css";
import "./studio-layout.css";

// Undo depth. Each snapshot is a full-resolution canvas (tens of MB at
// 4000x2500), so on memory-constrained touch devices we keep far fewer to stay
// under iOS WebKit's canvas-memory ceiling — past it, WebKit silently purges
// backing stores and drawing stops working until a reallocation. Desktops keep
// the deep stack. (Deeper fix: store history as compressed blobs / dirty rects.)
const IS_TOUCH_DEVICE = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
const MAX_HISTORY = IS_TOUCH_DEVICE ? 8 : 18;
const MAX_GALLERY_ITEMS = 10;
// Cap layers per artist — each is a full-size canvas, so this keeps memory and
// compositing sane on phones/tablets.
const MAX_LAYERS = 6;
// Max concurrent buffered remote strokes (each ≤2048x2048). Stroke #5 while
// four are open falls back to the legacy direct per-segment path.
const REMOTE_BUFFER_CAP = 4;
// Remote strokes whose end-op never arrives (dropped socket, legacy client)
// are committed by the idle sweep after this long without new points.
const REMOTE_STROKE_IDLE_MS = 8000;

// Avatar colour choices for the profile menu.
const AVATAR_COLORS = [
  "#FF6B6B", "#F8961E", "#FEE440", "#8AC926", "#06D6A0",
  "#4ECDC4", "#45B7D1", "#2D6CDF", "#9B5DE5", "#F15BB5",
];

const PROFILE_STORAGE_KEY = "drawesome:profile:v1";

// Drawing streak — device-local (localStorage only; nothing leaves the browser,
// COPPA-clean). Counts LOCAL calendar days on which the user finished at least
// one real stroke. No loss-aversion mechanics on purpose: a missed day just
// resets the count quietly next time.
const STREAK_KEY = "drawesome:streak:v1";
function localDayString(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// Record "drew today". Returns the streak count if this is the FIRST stroke of
// a new day (caller may celebrate), or null when today was already counted.
function bumpDrawingStreak() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STREAK_KEY) || "null"); } catch { /* fresh */ }
  const today = localDayString();
  if (saved && saved.last === today) return null; // already counted today
  // Calendar arithmetic, not epoch-24h: a spring-forward day is 23h long and
  // now-86400000 would land two calendar days back, wrongly resetting a streak.
  const now = new Date();
  const yesterday = localDayString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const count = saved && saved.last === yesterday ? (Number(saved.count) || 0) + 1 : 1;
  try { localStorage.setItem(STREAK_KEY, JSON.stringify({ last: today, count })); } catch { /* private mode */ }
  return count;
}

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

// Some engines (WebKit most reliably) refuse to serialise a Blob into an object
// store — "Error preparing Blob/File data to be stored in object store". The
// autosave retries the same draft as base64 dataURLs, which always store, so the
// artwork is safe and the user sees nothing. Warn ONCE per session: the autosave
// timer fires every few seconds and would otherwise bury the console.
let draftBlobFallbackWarned = false;
// Once an engine has refused to store PNG Blobs it will refuse every tick, so
// remember the verdict for the session: otherwise WebKit pays TWO full PNG
// encodes per autosave (the doomed Blob pass, then the dataURL pass).
let draftBlobStoreUnsupported = false;

function warnDraftBlobFallback(error) {
  draftBlobStoreUnsupported = true;
  if (draftBlobFallbackWarned) {
    return;
  }
  draftBlobFallbackWarned = true;
  console.warn(
    "Draft autosave: this browser wouldn't store PNG Blobs — falling back to dataURLs.",
    error,
  );
}

// The gallery and Paint Space lockers now persist their full arrays in
// IndexedDB (much larger quota than the ~5MB localStorage budget, and a quota
// overflow rejects instead of silently dropping the save). STORAGE_KEYS.gallery
// is kept only for one-time back-compat migration and as the private-mode
// fallback store. Gallery items keep their base64 dataURLs; IDB swallows them
// happily and they stay sync-ready for the backend.
const GALLERY_IDB_KEY = "gallery:v2";

// Downscaled GIF size keeps exports small and quantization fast. The 4000x2500
// canvas is 8:5, so every downscale target keeps that ratio (a 4:3 target was
// silently squashing exports and thumbnails).
const GIF_EXPORT_WIDTH = 320;
const GIF_EXPORT_HEIGHT = 200;
// Fridge Wall posts: same 8:5 ratio, a bit larger so the masonry stays crisp.
const WALL_POST_WIDTH = 384;
const WALL_POST_HEIGHT = 240;
const FRAME_THUMB_WIDTH = 96;
const FRAME_THUMB_HEIGHT = 60;
// Onion-skin neighbour proxies render at half resolution: visually identical at
// 20-28% alpha, but two warm neighbours cost a constant ~20MB instead of a fresh
// full-res (40MB) composite allocation on every recomposite.
const ONION_PROXY_WIDTH = CANVAS_WIDTH / 2;
const ONION_PROXY_HEIGHT = CANVAS_HEIGHT / 2;

// The toddler finger-paint room shows only chunky, wet, smeary brushes — no
// pencils, no tech. Everything else about the studio hides there too.
const FINGER_PAINT_BRUSHES = new Set(["paint", "watercolor", "gouache", "smudge"]);

// Defer non-urgent work (thumbnail PNG encodes) off the stroke-commit path.
// Safari has no requestIdleCallback; a short timeout is close enough there.
// The default 200 ms timeout keeps the deferred work timely on a busy page;
// pass `options` without one for work that must WAIT for a real idle slot
// (the sprite prebuild — forced through a timeout it would land inside a
// stroke's first frames).
const scheduleIdle = (callback, options = { timeout: 200 }) =>
  typeof window.requestIdleCallback === "function"
    ? window.requestIdleCallback(callback, options)
    : window.setTimeout(callback, 32);
const cancelIdle = (handle) => {
  if (typeof window.requestIdleCallback === "function") {
    window.cancelIdleCallback(handle);
  } else {
    window.clearTimeout(handle);
  }
};
const MAX_PALETTE_COLORS = 10;
// Touch contacts are ignored for this long after any pen activity (contact OR
// hover), so a hand resting on a Cintiq / iPad can't paint or pinch while the
// pen is in use, yet fingers work again a moment after the pen is put down.
const PEN_PRIORITY_MS = 1500;
// A touch contact wider/taller than this is a palm or forearm, never a fingertip.
const PALM_CONTACT_PX = 45;
// Desktop tool-rail open/closed preference (desktop tier only; the compact
// tiers always start with the rail closed so the canvas gets the screen).
const RAIL_OPEN_STORAGE_KEY = "happypaint:studio-rail:v1";
const readRailPreference = () => {
  try {
    return window.localStorage.getItem(RAIL_OPEN_STORAGE_KEY) !== "closed";
  } catch {
    return true;
  }
};
const writeRailPreference = (open) => {
  try {
    window.localStorage.setItem(RAIL_OPEN_STORAGE_KEY, open ? "open" : "closed");
  } catch {
    /* private mode / quota — the rail just won't remember */
  }
};

// --- View transform math (pure, so it's testable + closure-safe) -----------
// The view maps WORLD coords (the CANVAS_WIDTH x CANVAS_HEIGHT document) to CSS
// px in the display box as a similarity transform: rotate by `rot`, scale by
// `scale`, then translate by (tx, ty). Rotation is per-user (local view state),
// so a tablet kid can spin the page like a sheet of paper.
//   screen = scale * R(rot) * world + t
function worldToScreen(v, wx, wy) {
  const c = Math.cos(v.rot || 0);
  const s = Math.sin(v.rot || 0);
  return {
    x: v.scale * (c * wx - s * wy) + v.tx,
    y: v.scale * (s * wx + c * wy) + v.ty,
  };
}
function screenToWorld(v, cx, cy) {
  const c = Math.cos(v.rot || 0);
  const s = Math.sin(v.rot || 0);
  const dx = (cx - v.tx) / v.scale;
  const dy = (cy - v.ty) / v.scale;
  // inverse rotation (R(-rot))
  return { x: c * dx + s * dy, y: -s * dx + c * dy };
}

// Centroid + (for 2 fingers) the spread distance and angle of the active touch
// points — the raw signal for pinch-zoom, twist-rotate, and multi-finger pan.
function gestureMetrics(pts) {
  const n = pts.length;
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n || 1;
  cy /= n || 1;
  let dist = 1;
  let angle = 0;
  if (n >= 2) {
    dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
    angle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
  }
  return { cx, cy, dist, angle, n };
}

const TOOLS = [
  { id: "brush", name: "Brush", icon: "🖌️" },
  { id: "fill", name: "Fill", icon: "🪣" },
  { id: "rect", name: "Rectangle", icon: "🟦" },
  { id: "ellipse", name: "Ellipse", icon: "🔵" },
  { id: "line", name: "Line", icon: "📏" },
  { id: "text", name: "Text", icon: "🔤" },
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

function canvasToBlob(canvas, type = "image/png", quality = 0.95) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

// The FileReader read is the one step here that can fail to settle: WebKit
// denies a pending blob read on a document that is navigating away ("Cannot
// load blob: … due to access control checks") and fires NEITHER load nor
// error nor abort — so without a guard the promise hangs forever and any
// in-flight flag the caller holds (saveInFlightRef) stays stuck. A base64 read
// of an in-memory Blob takes milliseconds; anything past the deadline is a
// dead document, and "" is the same answer onerror gives.
const DATA_URL_READ_DEADLINE_MS = 15_000;

// WebKit cancels the old document's loaders the moment a navigation is
// committed — right after `beforeunload`, long before `pagehide` — and a blob
// read caught in flight is what it reports as "access control checks". So on
// `beforeunload` every in-flight reader is aborted (settling "") and the page
// is flagged as leaving, which makes any later read return "" without touching
// the Blob at all. (A beforeunload listener no longer blocks Safari's
// back-forward cache; an `unload` one would.)
const pendingDataUrlReaders = new Set();
let pageIsLeaving = false;
if (typeof window !== "undefined") {
  const leave = () => {
    pageIsLeaving = true;
    for (const reader of pendingDataUrlReaders) {
      try { reader.abort(); } catch { /* already settled */ }
    }
    pendingDataUrlReaders.clear();
  };
  window.addEventListener("beforeunload", leave, { capture: true });
  window.addEventListener("pagehide", leave, { capture: true });
  // A bfcache restore brings the document back alive.
  window.addEventListener("pageshow", () => { pageIsLeaving = false; });
}

async function canvasToDataUrl(canvas) {
  if (pageIsLeaving) {
    return "";
  }
  const blob = await canvasToBlob(canvas);

  if (!blob || pageIsLeaving) {
    return "";
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      pendingDataUrlReaders.delete(reader);
      resolve(value);
    };
    const reader = new FileReader();
    pendingDataUrlReaders.add(reader);
    const deadline = setTimeout(() => {
      try { reader.abort(); } catch { /* already done */ }
      settle("");
    }, DATA_URL_READ_DEADLINE_MS);
    reader.onload = () => settle(String(reader.result || ""));
    reader.onerror = () => settle("");
    reader.onabort = () => settle("");
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

// One-time, per-device migration of the anonymous device gallery into a freshly
// signed-in account. When a signed-out user with `u_…` saves signs in, the
// active gallery key flips to `pb_<id>` (empty) and their device art disappears
// from view. We copy each device artwork into the account, capped by the
// server's MAX_SAVES (stop on HTTP 409), entirely best-effort — it never throws
// and a localStorage guard ensures it runs at most once per device. `token` is
// the account access token; the device GET is intentionally unauthenticated so
// the server resolves the device key, while the account POST carries the token.
async function migrateDeviceArtToAccount(deviceKey, token) {
  if (!deviceKey || !token) return;
  const flag = `drawesome:art-migrated:${deviceKey}`;
  try {
    if (window.localStorage.getItem(flag)) return;
  } catch {
    // storage blocked → can't dedupe safely; skip migration entirely
    return;
  }
  try {
    const listRes = await fetch(`/api/artworks?userKey=${encodeURIComponent(deviceKey)}`, { cache: "no-store" });
    if (!listRes.ok) {
      return; // leave the flag unset so a future sign-in can retry
    }
    const list = await listRes.json();
    const items = Array.isArray(list?.items) ? list.items : [];
    // Oldest first so the account order matches the device order after unshift.
    for (const meta of items.slice().reverse()) {
      const detailRes = await fetch(`/api/artworks/${meta.id}?userKey=${encodeURIComponent(deviceKey)}`, { cache: "no-store" });
      if (!detailRes.ok) continue;
      const detail = await detailRes.json();
      if (typeof detail?.image !== "string") continue;
      const postRes = await fetch("/api/artworks", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: detail.name, image: detail.image, thumb: meta.thumb }),
      });
      if (postRes.status === 409) break; // account hit MAX_SAVES — stop copying
    }
  } catch {
    // network / parse failure — best-effort, leave the flag unset to retry
    return;
  }
  try {
    window.localStorage.setItem(flag, "1");
  } catch {
    // ignore — worst case migration re-runs and re-copies (POST is idempotent-ish)
  }
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

  // rAF coalescing for gesture-driven view repaints (pinch/pan) and for
  // remote-op recomposites — both can otherwise fire several times per frame.
  const viewRafRef = useRef(0);
  const remoteRenderRafRef = useRef(0);

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

  // Onion-skin proxy cache: frameId -> { canvas (half-res composite), stamp }.
  // A frame's stamp bumps on every edit; a proxy is valid while stamps match,
  // so drawing 50 strokes on the active frame recomposites its neighbours zero
  // times (they haven't changed) instead of 40MB-per-recomposite churn.
  const onionCacheRef = useRef(new Map());
  const frameStampRef = useRef(new Map());
  const bumpFrameStamp = useCallback((frameId) => {
    if (frameId) {
      frameStampRef.current.set(frameId, (frameStampRef.current.get(frameId) || 0) + 1);
    }
  }, []);
  // Keep only the active frame's neighbours warm (all onion ever reads) and
  // drop entries for removed frames — bounds the cache at ~2 x 10MB no matter
  // how the user hops around. Runs on every frame switch AND frame CRUD.
  const pruneOnionCache = useCallback(() => {
    const liveIds = new Set(framesRef.current.map((frame) => frame.id));
    const index = activeFrameIndexRef.current;
    const warm = new Set([framesRef.current[index - 1]?.id, framesRef.current[index + 1]?.id]);
    for (const id of onionCacheRef.current.keys()) {
      if (!liveIds.has(id) || !warm.has(id)) {
        onionCacheRef.current.delete(id);
      }
    }
    for (const id of frameStampRef.current.keys()) {
      if (!liveIds.has(id)) {
        frameStampRef.current.delete(id);
      }
    }
  }, []);

  // The frame a remote op belongs to: its frameId tag, or the FIRST frame for
  // legacy untagged ops. In non-animation rooms there is only one frame, so
  // this is exactly the old shared-mural behavior.
  const resolveOpFrame = useCallback((frameId) => {
    if (frameId) {
      const match = framesRef.current.find((frame) => frame.id === frameId);
      if (match) {
        return match;
      }
    }
    return framesRef.current[0] || null;
  }, []);

  // True when the given frame is the one on screen (its pixels are live in
  // layersRef and the wet-mix mirror).
  const isActiveFrame = useCallback((frame) => frame === framesRef.current[activeFrameIndexRef.current], []);

  // Frames hidden LOCALLY via the film-strip eyeball (session-only preview
  // mute: playback + onion skin skip them; never on the wire, never persisted).
  const hiddenFramesRef = useRef(new Set());

  // Film-strip scrub: refs only — zero React state per pointer-move.
  const scrubStateRef = useRef({ active: false, raf: 0, index: -1 });

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
  // Pen prioritization / palm rejection (W14). While a pen is active — or was
  // seen (incl. hovering: Cintiq / M2 Pencil proximity) within the last
  // PEN_PRIORITY_MS — touch contacts are ignored, so a resting hand can't paint
  // or hijack the stroke into a pinch. It's TIME-based, not sticky: a shared
  // iPad can go Pencil → finger and back without a reload. Mouse and a normal
  // lone finger are never rejected; big contact patches are always palms.
  const lastPenAtRef = useRef(0);
  const activePointerTypeRef = useRef(null); // pointerType of the pointer drawing right now
  // Adaptive pen pressure band (see utils/penInput). Loaded once per session,
  // persisted (debounced) whenever the ceiling learns a heavier pen.
  const penCalRef = useRef(null);
  const penCalSaveRef = useRef(0);
  // Stylus eraser-end override: the tool the UI had before the eraser end of
  // the pen touched down, restored at pen-up. Null while no override is live.
  const penEraserOverrideRef = useRef(null);
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
  const legacyDraftPurgedRef = useRef(false); // one-shot cleanup of the migrated legacy blob
  const mobileProfileRef = useRef(null); // scroll target for the mobile notifications/profile
  const mpRef = useRef(null); // { sendOp, sendCursor, sendClear } once the hook mounts
  const strokeNetRef = useRef(null); // outgoing in-progress brush stroke buffer
  const remoteStrokeLastRef = useRef(new Map()); // incoming strokeId -> last point
  const remoteStampQueueRef = useRef(new Map()); // strokeId -> { ops, loading }
  const applyRemoteOpRef = useRef(null);
  const sentStampIdsRef = useRef(new Set()); // imported brush tips already sent with full data this session
  // Stage-1 brush engine (#62): the local in-progress NON-eraser stroke paints
  // into a bbox-capped offscreen buffer and lands on its layer once, at the
  // stroke's opacity, at pen-up. Null while idle / while erasing.
  // { buf, layer, settings, drawSettings, seed, pad }
  const localStrokeRef = useRef(null);
  // Wet-canvas mixing: 1/8-scale CPU mirror of LAYER 0 (see utils/mixMap).
  // Lazily created; commit paths mark it dirty, wet dabs sample it.
  const mixMapRef = useRef(null);
  // Friends' in-progress strokes get the same treatment: strokeId ->
  // { buf, settings, drawSettings, opacity, pad, lastTouch }. `buf` is null for
  // the direct-path fallback once REMOTE_BUFFER_CAP buffers are already open.
  const remoteStrokesRef = useRef(new Map());
  const remoteSweepRef = useRef(0); // idle-commit interval id (runs only while strokes are open)
  // Velocity-synthesized pressure state (#63) for devices with no real pen
  // pressure (mouse/finger). Reset at every stroke start.
  const velocityRef = useRef({ lastX: 0, lastY: 0, lastT: null, ema: null, lastP: 0.65 });
  const remoteCursorsRef = useRef(new Map()); // userId -> { x, y, name, color, drawing, ts }
  const cursorSentAtRef = useRef(0);
  const cursorSigRef = useRef(""); // last pumped-cursor signature (skip idle re-renders)
  // Last-known position per user (normalized), kept longer than the 4s cursor
  // visibility window so "find this friend" still works after they pause.
  const userPosRef = useRef(new Map()); // userId -> { x, y, name, ts }
  const focusedUserIdRef = useRef(null); // a friend we just jumped the canvas to (pulses)
  const focusTimerRef = useRef(null);
  const brushCursorRef = useRef(null); // the brush-size preview ring (DOM-positioned)
  const brushTipCanvasRef = useRef(null); // the ring's inner canvas: one dab of the brush
  const brushTipSigRef = useRef(""); // brush|colour|size the tip was last drawn for
  const brushCursorHideRef = useRef(null);
  // Last known hover point of a mouse/pen over the canvas (client coords), or
  // null when nothing is hovering. Lets a size change ([ / ] or the slider)
  // resize the ring IN PLACE instead of yanking it to the canvas centre.
  const brushHoverPointRef = useRef(null);
  const [remoteCursors, setRemoteCursors] = useState([]);
  const [reactions, setReactions] = useState([]); // transient floating emoji
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const reactionIdRef = useRef(0);
  // Phones start with the chat closed so the canvas gets the whole screen.
  // Canvas Chat: closed = ambient overlay (Twitch mode); open = the panel.
  const [showChat, setShowChat] = useState(false);

  // --- Content moderation (public rooms only) ---
  const nsfwWatcherRef = useRef(null); // in-browser NSFW watcher controller
  const lastOpIdRef = useRef(0); // latest server-assigned opId seen (flag ranges)
  const roomAudienceRef = useRef(null); // 'kid_safe' | 'friends' | 'adult_18'
  const [modAlerts, setModAlerts] = useState([]); // host-only moderation alerts

  // --- Viewport: pan / zoom across the large mural ---
  // World coords are the CANVAS_WIDTH x CANVAS_HEIGHT document. The view maps
  // world -> CSS px in the display box: cssX = worldX * scale + tx.
  const viewRef = useRef({ scale: 1, tx: 0, ty: 0, rot: 0 });
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

  // Saved-to-server artwork ("My Art"). Signed out → keyed by an anonymous
  // per-device id (`u_…`, kept in deviceKeyRef). Signed in → keyed by the
  // account (`pb_<profileId>`); userKeyRef holds whichever is active. tokenRef
  // mirrors the current access token so the gallery fetches authenticate
  // without stale closures.
  const userKeyRef = useRef(null);
  const deviceKeyRef = useRef(null);
  const tokenRef = useRef(null);
  const [myDrawings, setMyDrawings] = useState([]);
  const [savesMax, setSavesMax] = useState(12);
  const [showMyArt, setShowMyArt] = useState(false);
  // Which studio layout we're in (desktop / tablet / phone) — see useLayoutTier.
  // Stamped on the shell as data-layout so the CSS tiers and this state agree.
  const layoutTier = useLayoutTier();
  const layoutTierRef = useRef(layoutTier);
  layoutTierRef.current = layoutTier;
  // The tool rail: desktop = docked column (open by default, remembered);
  // tablet = side sheet; phone = bottom sheet. Compact tiers start closed so
  // the canvas gets the whole screen.
  const [toolsOpen, setToolsOpen] = useState(() => (resolveLayoutTier() === "desktop" ? readRailPreference() : false));
  const [desktopHeaderOpen, setDesktopHeaderOpen] = useState(false);
  // Crossing a tier (window resize, iPad rotation, plugging a Cintiq in):
  // re-apply that tier's default — desktop remembers the rail, the compact
  // tiers drop the sheet so the canvas isn't suddenly half-covered.
  // Desktop-only: remember whether the docked rail is open. (Sheet tiers are
  // transient — opening the phone drawer shouldn't pin the desktop rail.)
  const prevTierRef = useRef(layoutTier);
  useEffect(() => {
    if (prevTierRef.current !== layoutTier) {
      prevTierRef.current = layoutTier;
      setToolsOpen(layoutTier === "desktop" ? readRailPreference() : false);
      return; // the value in hand is the OLD tier's — don't persist it
    }
    if (layoutTier === "desktop") {
      writeRailPreference(toolsOpen);
    }
  }, [layoutTier, toolsOpen]);
  const [stepBackPreview, setStepBackPreview] = useState(null);
  const [isPreparingStepBack, setIsPreparingStepBack] = useState(false);
  const stepBackUrlRef = useRef(null);
  const stepBackBusyRef = useRef(false);
  // Public canvas refresh: { wipeAt, keepVotes, keepNeeded } or null off-cycle.
  const [roomWipe, setRoomWipe] = useState(null);
  const [wipePanelOpen, setWipePanelOpen] = useState(false);
  const [, setWipeTick] = useState(0); // ticks the countdown label
  const [hypes, setHypes] = useState([]); // live big-reaction bursts (capped, ephemeral)
  const hypeIdRef = useRef(0);
  const [showReport, setShowReport] = useState(false);
  const [showLobby, setShowLobby] = useState(false);
  const [showWelcome, setShowWelcome] = useState(() => {
    // Arrived through a friend's invite link: skip the tour, go straight in.
    if (initialJoinCode) {
      return false;
    }
    try {
      return !window.localStorage.getItem("happypaint:welcomed:v1");
    } catch {
      return false;
    }
  });
  const dismissWelcome = () => {
    setShowWelcome(false);
    try {
      window.localStorage.setItem("happypaint:welcomed:v1", "1");
    } catch {
      /* ignore */
    }
  };
  const [reportReason, setReportReason] = useState("");
  // Coloring sheet: a shared, locked line-art overlay artists colour under/over.
  const sheetImageRef = useRef(null);
  const sheetRectRef = useRef(null);
  const sheetModeRef = useRef("over"); // 'over' = lines on top (colour under)
  const [sheetId, setSheetId] = useState(null);
  const [sheetMode, setSheetMode] = useState("over");
  const [, setSheets] = useState([]);
  // Trace-a-photo: upload a photo as the room's traced underlay.
  const tracePhotoInputRef = useRef(null);
  const [traceBusy, setTraceBusy] = useState(false);
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
  const [hiddenFrameIds, setHiddenFrameIds] = useState(() => new Set());

  const [paintSpaceAssets, setPaintSpaceAssets] = useState([]);
  const [showPaintSpace, setShowPaintSpace] = useState(false);
  const [recentColors, setRecentColors] = useState([]);

  const [selectedTool, setSelectedTool] = useState("brush");
  const [selectedBrush, setSelectedBrush] = useState("marker");
  const [activeBrushRecipe, setActiveBrushRecipe] = useState(null);
  const [selectedColor, setSelectedColor] = useState("#111827");
  const [selectedTexture, setSelectedTexture] = useState("linen");
  const [brushSize, setBrushSize] = useState(24);
  const [brushOpacity, setBrushOpacity] = useState(0.86);
  const [brushVariation, setBrushVariation] = useState(0.08);
  // Smudge carries no pigment — it just BLENDS. Its own "strength" (how hard it
  // pulls paint), independent of brush opacity so switching brushes doesn't
  // clobber it. Rides the op so replay is deterministic.
  const [smudgeStrength, setSmudgeStrength] = useState(0.5);
  // Smudge | Blend (brush engine Stage 4): "drag" pushes paint along with
  // the finger and carries colour; "blend" softens in place. Rides the op as
  // settings.smudgeMode (with v: 3) so every consumer renders the same mode.
  // Session-local on purpose — no localStorage.
  const [smudgeMode, setSmudgeMode] = useState("drag");
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
  const economyRef = useRef(null); // latest economy, for the earn-by-painting hook
  const earnPaintDropsRef = useRef(null); // set below; called from deep in endStroke
  const earnQuestDropsRef = useRef(null);
  const bumpStreakRef = useRef(null); // drawing-streak tick; same pattern
  const streakDoneRef = useRef(null); // day string once today's streak is counted
  const lastPaintEarnRef = useRef(0); // throttle: at most one earned Drop / few seconds
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

  // Supabase session (null when signed out / cloud unconfigured), lifted to state
  // so the access token can ride the multiplayer socket and the host UI can read
  // identity. Room ownership/host flags are learned live from the WS server.
  const [session, setSession] = useState(null);
  // Cross-room @mention inbox (shown in the profile menu). Persisted in
  // localStorage so it survives the reload that happens when hopping rooms.
  const [notifications, setNotifications] = useState(() => getNotifications());
  const [isRoomHost, setIsRoomHost] = useState(false);
  const isRoomHostRef = useRef(false); // mirror for reads inside the mp message handler
  const [isRoomOwner, setIsRoomOwner] = useState(false);
  const [roomLocked, setRoomLocked] = useState(false);
  const [roomTitle, setRoomTitle] = useState(null);
  // 'kid_safe' = public room (brush-only tools); anything else = private.
  const [roomAudience, setRoomAudience] = useState(null);
  const [mutedSelf, setMutedSelf] = useState(false);
  // "Hide this painter" — MY mute button, no host needed: locally hides a
  // user's chat, cursor, reactions and hype for this session. Client-only
  // agency (the audit's quick-win): nothing is sent to the server, their
  // strokes still land (that's the host's mute/kick domain).
  const [hiddenPainters, setHiddenPainters] = useState(() => new Set());
  const hiddenPaintersRef = useRef(hiddenPainters);
  hiddenPaintersRef.current = hiddenPainters;
  const toggleHiddenPainter = useCallback((userId) => {
    setHiddenPainters((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
        // Drop any cursor already on screen so they vanish immediately.
        remoteCursorsRef.current.delete(userId);
      }
      return next;
    });
  }, []);
  const [showHostPanel, setShowHostPanel] = useState(false);
  const [kicked, setKicked] = useState(false);
  const [roomFull, setRoomFull] = useState(false); // server said the room is at capacity
  const [roomBlocked, setRoomBlocked] = useState(false); // server refused this room
  // Today's drawing prompt for this room (sent in the 'connected' payload),
  // shown as a dismissible chip over the canvas top.
  const [roomPrompt, setRoomPrompt] = useState(null);
  const [promptDismissed, setPromptDismissed] = useState(false);
  const [privateNoticeDismissed, setPrivateNoticeDismissed] = useState(false);
  const [showSheetModal, setShowSheetModal] = useState(false);
  // Fridge Wall post dialog: null, or {frames: [dataURL...], durationMs}.
  const [wallPostDraft, setWallPostDraft] = useState(null);
  const [remixSource, setRemixSource] = useState(null);
  // Wet canvas (shared paint-mixing mode). The ref mirrors state for the
  // pointer handlers: startStroke captures it INTO the op settings, so a
  // stroke's wetness is frozen at pen-down and replays deterministically.
  const [roomWet, setRoomWet] = useState(false);
  const roomWetRef = useRef(false);
  const [roomSymmetry, setRoomSymmetry] = useState(() => normalizeSymmetry("none"));
  const roomSymmetryRef = useRef(normalizeSymmetry("none"));
  const [roomOrchestra, setRoomOrchestra] = useState(false);
  const [orchestraEnabled, setOrchestraEnabled] = useState(false);
  const [orchestraMuted, setOrchestraMuted] = useState(false);
  const [orchestraVolume, setOrchestraVolume] = useState(0.55);
  const orchestraRef = useRef(null);
  if (!orchestraRef.current) orchestraRef.current = createPaintOrchestra();
  const [roomQuest, setRoomQuest] = useState(null);
  const [storybook, setStorybook] = useState(null);
  useEffect(() => () => {
    void orchestraRef.current?.dispose();
  }, []);
  // Shared animation: whether THIS room has the film strip (the FLIPBOOK
  // public room, or a private room whose host enabled it). When on, frames are
  // shared state — ops carry frameId and frame CRUD relays through the server,
  // so everyone sees the same flipbook and rejoiners catch up like a document.
  const [roomAnimation, setRoomAnimation] = useState(false);
  const roomAnimationRef = useRef(false);
  // Finger-paint room (FINGERS): smudge allowed, always wet, no chat, chunky
  // wet brushes only.
  const [roomFingerPaint, setRoomFingerPaint] = useState(false);
  const roomFingerPaintRef = useRef(false);
  // Draw & Guess: `roomGame` = this room plays the game; `game` = the live
  // public round (phase/drawer/timer/scores, NO word); `myWord` = the secret,
  // present only while I'm the drawer; `gamePop` = a transient "guessed it!"
  // celebration. All ephemeral, server-authoritative.
  const [roomGame, setRoomGame] = useState(false);
  const roomGameRef = useRef(false);
  const [game, setGame] = useState(null);
  const gameRef = useRef(null);
  const [myWord, setMyWord] = useState(null);
  const [gamePop, setGamePop] = useState(null); // { name, points } | { reveal, word }
  const gamePopTimer = useRef(null);
  // Match-over podium: { standings: [{name, score}], rounds } — auto-dismissed.
  const [gamePodium, setGamePodium] = useState(null);
  const gamePodiumTimer = useRef(null);
  // Draw Phone (telephone): whether this room plays it, the public game state,
  // my PRIVATE task this round (draw a prompt / describe a drawing), whether I
  // submitted, my current guess text, and the reveal books once the game ends.
  const [roomPhone, setRoomPhone] = useState(false);
  const roomPhoneRef = useRef(false);
  const [phone, setPhone] = useState(null);
  const phoneRef = useRef(null);
  const [phoneTask, setPhoneTask] = useState(null); // { phase, round, prompt|image, deadline }
  const phoneTaskRef = useRef(null);
  const [phoneSubmitted, setPhoneSubmitted] = useState(false);
  const [phoneGuess, setPhoneGuess] = useState("");
  const [phoneReveal, setPhoneReveal] = useState(null); // [{ ownerName, pages:[...] }]
  const [isExportingVideo, setIsExportingVideo] = useState(false);
  // Multi-scene export pages scenes UNDER the user — freeze drawing + frame/
  // scene navigation while it runs so strokes can't land in scenes the artist
  // never opened (guards read this ref, not state, on the hot paths).
  const isExportingVideoRef = useRef(false);
  // Async op assets (image dataURLs) still decoding when a scene's history
  // finishes replaying — hydration isn't "done" until these settle.
  const pendingAssetLoadsRef = useRef([]);
  // Scenes: a film is pages ("scenes") of up to 8 frames; only the ACTIVE
  // scene's frames are hydrated as canvases — paging swaps them via
  // scene_fetch, so memory stays at one scene's worth (~30s of film per room).
  const [scenes, setScenes] = useState([]); // [{id, name, frames:[{id,durationMs}]}]
  const scenesRef = useRef([]);
  const [activeSceneId, setActiveSceneId] = useState(null);
  const activeSceneIdRef = useRef(null);
  const sceneWaitersRef = useRef(new Map());
  // Our own session id (from the connected handshake) — used to recognise our
  // echoed frame mutations without depending on the mp hook object.
  const myUserIdRef = useRef(null);
  // Production (multi-room film) this room belongs to, + the storyboard modal.
  const [production, setProduction] = useState(null);
  const productionRef = useRef(null);
  const [showStoryboard, setShowStoryboard] = useState(false);
  // Crew presence: which cel each teammate is on (animation rooms). Ref is the
  // source of truth (userId -> {sceneId, frameId, name, color, ts}); the state
  // snapshot drives the pips/chips render (cold path — updated on presence
  // messages + the shared 4s cursor-stale sweep, never in the draw loop).
  const crewPresenceRef = useRef(new Map());
  const [crewPresence, setCrewPresence] = useState([]); // [{userId, sceneId, frameId, name, color}]
  const publishCrewPresence = useCallback(() => {
    setCrewPresence(Array.from(crewPresenceRef.current.entries()).map(([userId, p]) => ({ userId, ...p })));
  }, []);
  // Confetti cheers bursting on a cel: [{ id, frameId, emoji }], auto-removed.
  const [cheers, setCheers] = useState([]);
  const cheerIdRef = useRef(0);
  // "Come look at my frame!" beacon: a friendly tap-to-jump card (auto-dismiss).
  const [beacon, setBeacon] = useState(null); // { name, color, target } | null
  const beaconTimerRef = useRef(0);
  const showBeacon = useCallback((name, color, target) => {
    setBeacon({ name, color, target });
    window.clearTimeout(beaconTimerRef.current);
    beaconTimerRef.current = window.setTimeout(() => setBeacon(null), 9000);
  }, []);
  // Open theme vote: { options, endsAt, counts, myChoice } (null when closed).
  const [roomVote, setRoomVote] = useState(null);
  const [voteSecondsLeft, setVoteSecondsLeft] = useState(0);

  // Saved brush recipes are the kind === "brush" Paint Space assets.
  const savedBrushAssets = useMemo(
    () => paintSpaceAssets.filter((asset) => asset.kind === "brush"),
    [paintSpaceAssets],
  );

  const studioUnlocked = hasEntitlement(economy, "studio");

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
      // Structural changes are a housekeeping moment for the per-frame caches
      // and the eyeball-hidden set (drop ids that no longer exist). In a
      // scene-paged room "exists" means ANY scene's frame — eyeball marks must
      // survive paging away and back.
      pruneOnionCache();
      const liveIds = new Set(framesRef.current.map((frame) => frame.id));
      if (roomAnimationRef.current) {
        for (const scene of scenesRef.current) {
          for (const meta of scene.frames || []) {
            liveIds.add(meta.id);
          }
        }
      }
      if ([...hiddenFramesRef.current].some((id) => !liveIds.has(id))) {
        const pruned = new Set([...hiddenFramesRef.current].filter((id) => liveIds.has(id)));
        hiddenFramesRef.current = pruned;
        setHiddenFrameIds(pruned);
      }
    },
    [commitLayersToFrame, pruneOnionCache, renderFrameThumbnail],
  );

  // Snap the local frame list to the server's authoritative metadata (ids,
  // order, durations) — the Google-Docs invariant: everyone runs the same
  // flipbook. Canvases are preserved for frames whose id survives (reconnects
  // keep pixels; the history replay right after repaints them anyway); frames
  // the server dropped disappear, new ones arrive blank until replayed into.
  const reconcileFrames = useCallback(
    (serverFrames) => {
      if (!Array.isArray(serverFrames) || serverFrames.length === 0) {
        return;
      }
      commitLayersToFrame();
      const currentById = new Map(framesRef.current.map((frame) => [frame.id, frame]));
      const activeId = framesRef.current[activeFrameIndexRef.current]?.id;
      const next = serverFrames.map((meta) => {
        const existing = currentById.get(meta.id);
        if (existing) {
          existing.durationMs = meta.durationMs;
          return existing;
        }
        const frame = createFrame({ layers: createDefaultLayers(), durationMs: meta.durationMs });
        frame.id = meta.id; // server ids are canonical
        return frame;
      });
      framesRef.current = next;
      const keptIndex = next.findIndex((frame) => frame.id === activeId);
      activeFrameIndexRef.current = keptIndex >= 0 ? keptIndex : Math.max(0, Math.min(activeFrameIndexRef.current, next.length - 1));
      const active = next[activeFrameIndexRef.current];
      if (!active.layers.some((layer) => layer.id === active.activeLayerId)) {
        active.activeLayerId = active.layers[active.layers.length - 1].id;
      }
      layersRef.current = active.layers;
      activeLayerIdRef.current = active.activeLayerId;
      syncFrameState();
    },
    [commitLayersToFrame, syncFrameState],
  );

  // Queue a frame's thumbnail regen for idle time. Dirty ids are tracked per
  // FRAME (not "whoever is active when idle fires"), so switching cels inside
  // the idle window can't strand an edited frame's thumbnail; bursts coalesce
  // into one drain (W20).
  const thumbIdleRef = useRef({ pending: false, ids: new Set() });
  const queueThumbnailRefresh = useCallback(
    (frameId) => {
      if (!frameId) {
        return;
      }
      const job = thumbIdleRef.current;
      job.ids.add(frameId);
      if (job.pending) {
        return; // a rapid burst collapses into one drain
      }
      job.pending = true;
      scheduleIdle(() => {
        job.pending = false;
        const ids = [...job.ids];
        job.ids.clear();
        const updates = {};
        for (const id of ids) {
          const frame = framesRef.current.find((item) => item.id === id);
          if (frame) {
            updates[id] = renderFrameThumbnail(frame);
          }
        }
        if (Object.keys(updates).length) {
          setFrameThumbnails((existing) => ({ ...existing, ...updates }));
        }
      });
    },
    [renderFrameThumbnail],
  );

  // Refresh the active frame's thumbnail after an edit. The alias writeback +
  // onion-stamp bump stay synchronous (cheap); the composite + PNG encode is
  // deferred, so pen-up never pays for it. Every local edit signal funnels
  // through here — this is the onion cache's invalidation hook too.
  const refreshActiveThumbnail = useCallback(() => {
    commitLayersToFrame();
    const frame = framesRef.current[activeFrameIndexRef.current];
    if (!frame) {
      return;
    }
    bumpFrameStamp(frame.id);
    queueThumbnailRefresh(frame.id);
  }, [bumpFrameStamp, commitLayersToFrame, queueThumbnailRefresh]);

  // Remote counterpart: a remote mutation landed on some frame — stale-mark
  // its onion proxy and queue its cel thumbnail, whichever frame this client
  // is viewing. Pass the op's frameId (undefined = first frame, legacy).
  const touchFrame = useCallback(
    (frameId) => {
      const frame = resolveOpFrame(frameId);
      if (!frame) {
        return;
      }
      bumpFrameStamp(frame.id);
      queueThumbnailRefresh(frame.id);
    },
    [bumpFrameStamp, queueThumbnailRefresh, resolveOpFrame],
  );

  const getActiveLayer = useCallback(() => {
    return layersRef.current.find((layer) => layer.id === activeLayerIdRef.current) || null;
  }, []);

  // ---- Wet-canvas mix map (1/8-scale LAYER-0 mirror; see utils/mixMap) -----
  // sampleMix is the sampler injected into every makeStrokeRenderer; it only
  // materializes the map once a wet dab actually samples (born fully dirty, so
  // whatever is already on layer 0 is mirrored on first use). The mark* calls
  // below are O(1) bbox unions — the pixel refresh happens lazily in sample().
  const ensureMixMap = useCallback(() => {
    if (!mixMapRef.current) {
      mixMapRef.current = createMixMap(() => layersRef.current[0]?.canvas || null, CANVAS_WIDTH, CANVAS_HEIGHT);
    }
    return mixMapRef.current;
  }, []);
  const sampleMix = useCallback((x, y) => ensureMixMap().sample(x, y), [ensureMixMap]);
  // Idle PREFETCH of the mirror refresh: after a commit dirties layer 0's
  // mirror, re-read it while the pen is up instead of on the first wet dab of
  // the next stroke (that read — a downscaled drawImage + a small
  // getImageData — was the one stroke-start stall the wet path had). Strictly
  // a prefetch: sample() still flushes itself when dirty, so a dab never reads
  // a stale mirror, and a flush that lands mid-stroke (pointer down) is
  // skipped — the lazy path handles it in op order, exactly as before.
  const mixPrefetchRef = useRef(0);
  const scheduleMixPrefetch = useCallback(() => {
    if (mixPrefetchRef.current) {
      return;
    }
    mixPrefetchRef.current = scheduleIdle(() => {
      mixPrefetchRef.current = 0;
      if (activePointerRef.current == null) {
        ensureMixMap().flush();
      }
    });
  }, [ensureMixMap]);
  // A stroke-buffer/image commit landed on `layer` — if that's layer 0, the
  // mix map's mirror of that bbox is stale now (and worth prefetching).
  const markMixDirty = useCallback((layer, bounds) => {
    if (layer && layer === layersRef.current[0]) {
      mixMapRef.current?.markDirty(bounds);
      scheduleMixPrefetch();
    }
  }, [scheduleMixPrefetch]);
  // An UNMARKED write landed on `layer` (eraser / smudge / shape / text /
  // sticker — the paths that draw the layer directly and never markDirty):
  // if that's layer 0, anything the idle prefetch read since the last wet
  // sample may be stale, and history / spectators / the other clients (lazy
  // maps, no prefetch) would re-read it at their next sample. Hand it back
  // to the dirty list so we read it at the same op-order point (P5). O(1);
  // calling it for a write that no prefetch preceded is a no-op.
  const invalidateMixPrefetch = useCallback((layer) => {
    if (layer && layer === layersRef.current[0]) {
      mixMapRef.current?.invalidatePrefetch();
    }
  }, []);
  // The brush sprite atlases (Stage 2) are built in idle time so no first
  // stroke pays for them. The IdleDeadline goes through to the prebuild so
  // it builds one piece per idle slice and re-schedules itself for the rest
  // (undefined on the setTimeout fallback: one synchronous build), and the
  // busy predicate makes it defer a slice while a pointer is down — the
  // build must never land inside a stroke. No timeout on the first schedule
  // either: forced through App's usual 200 ms it fired at mount, exactly
  // when a kid's first stroke starts. Scheduled on mount and again whenever
  // the tab comes back (release on hidden frees the atlases, and without a
  // re-schedule the first dab of each family paid a synchronous lazy build).
  const prebuildIdleRef = useRef(0);
  const schedulePrebuild = useCallback(() => {
    if (prebuildIdleRef.current) {
      cancelIdle(prebuildIdleRef.current);
    }
    prebuildIdleRef.current = scheduleIdle((deadline) => {
      prebuildIdleRef.current = 0;
      prebuildBrushSprites(deadline, () => activePointerRef.current != null);
    }, {});
  }, []);
  const cancelPrebuild = useCallback(() => {
    if (prebuildIdleRef.current) {
      cancelIdle(prebuildIdleRef.current);
      prebuildIdleRef.current = 0;
    }
  }, []);
  // Studio mount: build the wet-mix mirror (born fully dirty) and the sprite
  // atlases in idle time. Released again on unmount / tab hidden (see the
  // effects below).
  useEffect(() => {
    schedulePrebuild();
    const handle = scheduleIdle(() => {
      scheduleMixPrefetch();
    });
    return () => {
      cancelIdle(handle);
      cancelPrebuild();
      if (mixPrefetchRef.current) {
        cancelIdle(mixPrefetchRef.current);
        mixPrefetchRef.current = 0;
      }
    };
  }, [cancelPrebuild, schedulePrebuild, scheduleMixPrefetch]);

  useEffect(() => {
    const recipeSettings = activeBrushRecipe ? recipeToBrushSettings(activeBrushRecipe, { color: selectedColor }) : null;
    settingsRef.current = {
      tool: selectedTool,
      brush: recipeSettings?.brush || selectedBrush,
      color: selectedColor,
      opacity: brushOpacity,
      size: brushSize,
      variation: brushVariation,
      strength: smudgeStrength, // smudge blend strength (ignored by other brushes)
      smudgeMode, // smudge only: "drag" | "blend"
      v: recipeSettings?.v,
      dab: recipeSettings?.dab,
      texture: selectedTexture,
      fillShape,
      textSize,
      studioUnlocked,
    };
  }, [
    activeBrushRecipe,
    brushOpacity,
    brushSize,
    brushVariation,
    fillShape,
    selectedBrush,
    selectedColor,
    selectedTexture,
    selectedTool,
    smudgeMode,
    smudgeStrength,
    studioUnlocked,
    textSize,
  ]);

  useEffect(() => {
    sentStampIdsRef.current.clear();
  }, [roomId]);

  const updateHistoryCounts = useCallback(() => {
    setHistoryCount(historyRef.current.length);
    setRedoCount(redoRef.current.length);
  }, []);

  const markChanged = useCallback((message = "Saved locally") => {
    dirtyRef.current = true;
    // Commit-level signal (never per-frame) — lets the NSFW watcher know the
    // mural changed so it can schedule an idle re-scan. O(1), no-op when inactive.
    nsfwWatcherRef.current?.markDirty();
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

  // The page's four corners in screen space under view `v` (rotation-aware).
  const pageCornersScreen = (v) => {
    return [
      [0, 0],
      [CANVAS_WIDTH, 0],
      [CANVAS_WIDTH, CANVAS_HEIGHT],
      [0, CANVAS_HEIGHT],
    ].map(([x, y]) => worldToScreen(v, x, y));
  };

  const clampScale = (v) => {
    const { w, h } = getViewportSize();
    const fit = fitScaleFor(w, h);
    v.scale = Math.max(fit * 0.9, Math.min(8, v.scale));
    return v;
  };

  // Keep the page framed using its screen-space bounding box (so it works at any
  // rotation): centred on an axis when the page is smaller than the viewport,
  // otherwise pinned so it always covers that axis. tx/ty are a pure screen-space
  // translation, so we can correct by shifting them by a screen delta.
  const clampPan = (v) => {
    const { w, h } = getViewportSize();
    const pts = pageCornersScreen(v);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const bw = maxX - minX;
    const bh = maxY - minY;
    if (bw <= w) {
      v.tx += (w - bw) / 2 - minX; // centre horizontally
    } else if (minX > 0) {
      v.tx -= minX; // pull left edge back to the viewport edge
    } else if (maxX < w) {
      v.tx += w - maxX; // pull right edge back
    }
    if (bh <= h) {
      v.ty += (h - bh) / 2 - minY;
    } else if (minY > 0) {
      v.ty -= minY;
    } else if (maxY < h) {
      v.ty += h - maxY;
    }
    return v;
  };

  // Keep scale in range AND the page framed. (rot is free — it's the user's own
  // orientation.) Split helpers above let zoomAt/rotateAt anchor before reframing.
  const clampView = (v) => {
    clampScale(v);
    clampPan(v);
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
    // "Fit whole canvas" also resets the orientation to upright.
    viewRef.current = {
      scale: fit,
      tx: (w - CANVAS_WIDTH * fit) / 2,
      ty: (h - CANVAS_HEIGHT * fit) / 2,
      rot: 0,
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
      rot: 0,
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
    const v = viewRef.current;
    const { scale, tx, ty } = v;
    const rot = v.rot || 0;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, display.width, display.height);
    context.fillStyle = "#e9eef4";
    context.fillRect(0, 0, display.width, display.height);
    // screen(device px) = scale * R(rot) * world + t, all * dpr.
    context.setTransform(scale * cos * dpr, scale * sin * dpr, -scale * sin * dpr, scale * cos * dpr, tx * dpr, ty * dpr);
    context.imageSmoothingEnabled = scale < 2.5;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    context.drawImage(doc, 0, 0);
    // Page border: stroke the (possibly rotated) page quad in device px so it
    // stays a crisp ~1px line regardless of zoom/rotation.
    context.setTransform(1, 0, 0, 1, 0, 0);
    const corners = [
      [0, 0],
      [CANVAS_WIDTH, 0],
      [CANVAS_WIDTH, CANVAS_HEIGHT],
      [0, CANVAS_HEIGHT],
    ].map(([x, y]) => worldToScreen(v, x, y));
    context.strokeStyle = "rgba(45,108,223,0.35)";
    context.lineWidth = Math.max(1, dpr);
    context.beginPath();
    context.moveTo(corners[0].x * dpr, corners[0].y * dpr);
    for (let i = 1; i < corners.length; i += 1) {
      context.lineTo(corners[i].x * dpr, corners[i].y * dpr);
    }
    context.closePath();
    context.stroke();
  }, []);

  const applyView = () => {
    clampView(viewRef.current);
    syncZoomLabel();
    blitToDisplay();
  };

  // Coalesce gesture-driven repaints (mirrors scheduleStrokeFrame): two moving
  // fingers can fire two pointermoves per frame, and applyView blits the whole
  // mural — so pan/pinch schedules at most ONE applyView per rAF instead.
  const scheduleViewFrame = () => {
    if (viewRafRef.current) {
      return;
    }
    viewRafRef.current = window.requestAnimationFrame(() => {
      viewRafRef.current = 0;
      applyView();
    });
  };

  // Reposition tx/ty so the WORLD point `wp` lands at screen px (fx, fy) under
  // the current scale + rotation. Shared by zoom + rotate so both anchor cleanly.
  const anchorWorldToScreen = (v, wp, fx, fy) => {
    const c = Math.cos(v.rot || 0);
    const s = Math.sin(v.rot || 0);
    v.tx = fx - v.scale * (c * wp.x - s * wp.y);
    v.ty = fy - v.scale * (s * wp.x + c * wp.y);
  };

  // In-place cores (mutate the view, no clamp/blit) so a multi-touch frame can
  // compose pan + zoom + rotate and repaint the canvas exactly ONCE — repainting
  // blits the full mural, so doing it per sub-step would jank the gesture.
  const zoomCore = (v, factor, fx, fy) => {
    const wp = screenToWorld(v, fx, fy); // world point under the focal point
    v.scale = v.scale * factor;
    clampScale(v);
    anchorWorldToScreen(v, wp, fx, fy); // keep that world point under the finger
  };
  const rotateCore = (v, angleDelta, fx, fy) => {
    if (!angleDelta) {
      return;
    }
    const wp = screenToWorld(v, fx, fy);
    v.rot = (v.rot || 0) + angleDelta;
    anchorWorldToScreen(v, wp, fx, fy);
  };

  // Zoom by `factor` about a focal point given in CSS px within the display box.
  const zoomAt = (factor, fx, fy) => {
    zoomCore(viewRef.current, factor, fx, fy);
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
    scheduleViewFrame();
  };

  // Fetch (or lazily build) a frame's half-res onion proxy. Valid while the
  // frame's edit stamp matches; stale entries recomposite once, not per call.
  const getOnionProxy = useCallback((frame) => {
    const stamp = frameStampRef.current.get(frame.id) || 0;
    const cached = onionCacheRef.current.get(frame.id);
    if (cached && cached.stamp === stamp) {
      return cached.canvas;
    }
    const canvas = compositeFrameToCanvas(frame, { width: ONION_PROXY_WIDTH, height: ONION_PROXY_HEIGHT });
    onionCacheRef.current.set(frame.id, { canvas, stamp });
    return canvas;
  }, []);

  // Paint the onion-skin neighbour frames faintly onto the document context.
  // Shared by the full recomposite and the "below" stroke cache so the result
  // is identical whether or not a stroke is in progress. Neighbours hidden via
  // the film-strip eyeball are skipped (local preview mute).
  const paintOnionSkin = useCallback((context) => {
    if (!onionSkinRef.current || framesRef.current.length <= 1) {
      return;
    }
    const index = activeFrameIndexRef.current;
    const hidden = hiddenFramesRef.current;
    const previous = framesRef.current[index - 1];
    const next = framesRef.current[index + 1];
    if (previous && !hidden.has(previous.id)) {
      context.globalAlpha = 0.28;
      context.drawImage(getOnionProxy(previous), 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }
    if (next && !hidden.has(next.id)) {
      context.globalAlpha = 0.2;
      context.drawImage(getOnionProxy(next), 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }
    context.globalAlpha = 1;
  }, [getOnionProxy]);

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

  // Overlay friends' in-progress buffered strokes onto the doc composite, each
  // at its stroke's uniform opacity (#62). Accepted transient (Stage 1): until
  // its end-op commits it into the base layer, a remote stroke renders above
  // the local upper layers. No-op (one size check) when nobody else is drawing.
  const paintRemoteStrokeOverlays = useCallback((context) => {
    const strokes = remoteStrokesRef.current;
    if (strokes.size === 0) {
      return;
    }
    // Only overlay in-progress strokes that belong to the frame ON SCREEN —
    // a friend inking cel 3 shouldn't ghost over your view of cel 5.
    const activeId = framesRef.current[activeFrameIndexRef.current]?.id;
    for (const entry of strokes.values()) {
      const entryFrameId = entry.frameId || framesRef.current[0]?.id;
      if (entryFrameId !== activeId) {
        continue;
      }
      if (entry.buf && entry.buf.has()) {
        // At the stroke's opacity AND its commit composite (entry.composite,
        // from the shared entry core), so the pen-up commit can't "pop".
        context.save();
        context.globalAlpha = entry.opacity;
        context.globalCompositeOperation = entry.composite;
        context.drawImage(entry.buf.canvas, entry.buf.x0, entry.buf.y0);
        context.restore();
      }
    }
  }, []);

  // Drop all in-progress remote stroke buffers WITHOUT committing (history
  // rebuilds and clears repaint/wipe the layers, so the buffered pixels are
  // either re-delivered by the replay or gone with the mural).
  const dropRemoteStrokes = useCallback(() => {
    for (const entry of remoteStrokesRef.current.values()) {
      entry.buf?.dispose();
    }
    remoteStrokesRef.current.clear();
    remoteStampQueueRef.current.clear();
  }, []);

  const renderDisplay = useCallback(() => {
    const context = docContextRef.current;
    if (!context) {
      return;
    }
    // Mid-scrub the display shows a transient frame preview; the editable
    // composite is restored by handleScrubEnd, so skip races from other paths.
    if (scrubStateRef.current.active) {
      return;
    }
    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    paintOnionSkin(context);
    if (sheetModeRef.current === "under") {
      drawSheet(context);
    }
    compositeLayers(context, layersRef.current);
    paintRemoteStrokeOverlays(context);
    if (sheetModeRef.current !== "under") {
      drawSheet(context);
    }
    compositeCacheValidRef.current = false;
    blitToDisplay();
  }, [blitToDisplay, drawSheet, paintOnionSkin, paintRemoteStrokeOverlays]);

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
      // Cache invalidated MID-stroke (a remote clear/history rebuild landed
      // while painting): rebuild the caches once and stay on the cached path.
      // The renderDisplay fallback can't show the live stroke — its buffer
      // isn't in the layer stack until the pen-up commit (#62). One-off cost
      // per invalidation, not per move (the rebuild re-validates the cache).
      const stroke = localStrokeRef.current;
      const rebuilt =
        stroke != null &&
        activePointerRef.current != null &&
        stroke.layer.id === activeLayerIdRef.current &&
        buildCompositeCache();
      if (!rebuilt) {
        renderDisplay();
        return;
      }
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
      // Live preview of the buffered local stroke (#62): the buffer holds the
      // stroke at full opacity, so drawing it here at strokeOpacity x layer
      // opacity, with the stroke's own commit composite, matches exactly what
      // the pen-up commit will look like. Symmetry strokes preview every
      // copy's buffer.
      const stroke = localStrokeRef.current;
      if (stroke) {
        context.save();
        context.globalAlpha = stroke.opacity * active.opacity;
        context.globalCompositeOperation = stroke.composite;
        // Branch instead of allocating a one-element array per frame.
        if (stroke.copies) {
          for (const part of stroke.copies) {
            if (part.buf.has()) {
              context.drawImage(part.buf.canvas, part.buf.x0, part.buf.y0);
            }
          }
        } else if (stroke.buf.has()) {
          context.drawImage(stroke.buf.canvas, stroke.buf.x0, stroke.buf.y0);
        }
        context.restore();
      }
    }
    context.drawImage(aboveCacheRef.current, 0, 0);
    paintRemoteStrokeOverlays(context);
    if (sheetModeRef.current !== "under") {
      drawSheet(context);
    }
    blitToDisplay();
  }, [blitToDisplay, buildCompositeCache, drawSheet, paintRemoteStrokeOverlays, renderDisplay]);

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

  // Coalesce remote-op recomposites: N ops arriving in the same frame trigger
  // ONE full renderDisplay instead of one synchronous recomposite per message.
  const scheduleRemoteRender = useCallback(() => {
    if (remoteRenderRafRef.current) {
      return;
    }
    remoteRenderRafRef.current = window.requestAnimationFrame(() => {
      remoteRenderRafRef.current = 0;
      renderDisplay();
    });
  }, [renderDisplay]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // Undo/redo can swap layer 0's pixels wholesale — re-mirror on next wet sample.
      mixMapRef.current?.markAllDirty();
      // The active frame's pixels changed outside the stroke path — its onion
      // proxy is stale for when it next becomes someone's neighbour.
      bumpFrameStamp(framesRef.current[activeFrameIndexRef.current]?.id);
      invalidateCompositeCache();
      renderDisplay();
      syncLayerState();
      updateHistoryCounts();
    },
    [bumpFrameStamp, invalidateCompositeCache, renderDisplay, syncLayerState, updateHistoryCounts],
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
    // Clear is a shared wipe ON THE LIVE FRAME: clear every layer, snapshot for
    // local undo, and tell the room. On frames 2+ (the local flipbook) it only
    // clears YOUR frame — the room's mural is untouched.
    const animated = roomAnimationRef.current;
    const activeFrame = framesRef.current[activeFrameIndexRef.current];
    const onLiveFrame = activeFrameIndexRef.current === 0;
    pushHistory("full");
    layersRef.current.forEach((layer) => layer.canvas.getContext("2d").clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT));
    // The wet-mix mirror tracks the ACTIVE frame's layer 0 — whichever frame
    // this is, its layer 0 is blank now, so the mirror must empty too.
    mixMapRef.current?.clear();
    if (animated && activeFrame) {
      // Animation rooms: every frame is shared — clear THIS frame for everyone.
      remoteStrokeLastRef.current.clear();
      dropRemoteStrokes(); // in-flight strokes for this frame are wiped with it
      mpRef.current?.sendClear(activeFrame.id);
    } else if (onLiveFrame) {
      remoteStrokeLastRef.current.clear();
      dropRemoteStrokes(); // friends' in-progress strokes are wiped with the mural
      mpRef.current?.sendClear();
    }
    renderDisplay();
    refreshActiveThumbnail();
    markChanged(animated || onLiveFrame ? "Canvas cleared" : "Frame cleared");
    if (animated || onLiveFrame) {
      showClearBanner("You");
    }
  }, [dropRemoteStrokes, markChanged, pushHistory, refreshActiveThumbnail, renderDisplay, showClearBanner]);

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
        let blobPutFailed = draftBlobStoreUnsupported;
        if (!blobPutFailed) {
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

          try {
            await idbSet(`${DRAFT_IDB_KEY}:${roomId}`, {
              version: 4,
              layers: layerData,
              activeLayerId,
              settings,
              savedAt,
            });
          } catch (error) {
            // The Blobs wouldn't serialise (see warnDraftBlobFallback). That's a
            // storage-SHAPE problem, not "out of room", so re-encode the same
            // layers as base64 dataURLs and try once more — restoreLayersFromDraft
            // reads either form. If this throws too, the outer catch reports it.
            warnDraftBlobFallback(error);
            blobPutFailed = true;
          }
        }
        if (blobPutFailed) {
          const fallbackLayers = [];
          for (const layer of layersRef.current) {
            fallbackLayers.push({
              id: layer.id,
              name: layer.name,
              visible: layer.visible,
              opacity: layer.opacity,
              locked: layer.locked,
              image: await canvasToDataUrl(layer.canvas),
            });
          }
          await idbSet(`${DRAFT_IDB_KEY}:${roomId}`, {
            version: 4,
            layers: fallbackLayers,
            activeLayerId,
            settings,
            savedAt,
          });
        }
        // The IndexedDB write is now the source of truth. Drop this room's
        // localStorage fallback (it would only shadow the IDB copy), and for MAIN
        // also drop the pre-per-room global draft that was migrated forward into
        // draft:v4:MAIN — so neither the legacy blob nor a stale fallback lingers.
        try {
          window.localStorage.removeItem(`${STORAGE_KEYS.draft}:${roomId}`);
          if (roomId === "MAIN") {
            window.localStorage.removeItem(STORAGE_KEYS.draft);
          }
        } catch {
          // ignore — removing a stale key failing is non-fatal
        }
        if (roomId === "MAIN" && !legacyDraftPurgedRef.current) {
          legacyDraftPurgedRef.current = true;
          idbDelete(DRAFT_IDB_KEY).catch(() => {}); // drop the migrated legacy blob (once)
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
          `${STORAGE_KEYS.draft}:${roomId}`,
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
  }, [roomId]);

  const applyDraftSettings = useCallback((draftSettings) => {
    if (!draftSettings) {
      return;
    }
    // The studio ALWAYS opens on the brush. Restoring a saved fill/text/shape
    // tool means a kid's first touch does something other than draw — and on a
    // phone there is no hover to tell them why. Brush, colour, size and the rest
    // below still persist; only the tool resets. (handTool is never persisted.)
    setSelectedTool("brush");
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
      // Shared flipbooks are server state — swapping in locally-id'd frames
      // would silently fork this client (nothing drawn after would be shared).
      if (roomAnimationRef.current) {
        setStatus("Drafts can't replace a shared animation — restore in a drawing room instead");
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
      const idbDraft = await idbGet(`${DRAFT_IDB_KEY}:${roomId}`).catch(() => null);
      if (idbDraft?.layers?.length) {
        return idbDraft;
      }
      // MAIN (our default room) inherits the pre-per-room global draft once, so
      // existing users' studio work migrates forward on the next autosave. Other
      // rooms never read the shared global key — that's what stops one room's
      // canvas from bleeding into another.
      if (roomId === "MAIN") {
        const legacyIdb = await idbGet(DRAFT_IDB_KEY).catch(() => null);
        if (legacyIdb?.layers?.length) {
          return { ...legacyIdb, fromLegacy: true };
        }
      }
    }
    // Legacy localStorage draft (base64 layers): the room-scoped key first, then
    // the old un-suffixed global key for MAIN only (one-time migration).
    const legacy =
      readJson(`${STORAGE_KEYS.draft}:${roomId}`, null) ||
      (roomId === "MAIN" ? readJson(STORAGE_KEYS.draft, null) : null);
    if (legacy?.layers?.length) {
      return { ...legacy, fromLegacy: true };
    }
    return null;
  }, [roomId]);

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
      name: `Drawesome ${todayName()}`,
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
      downloadBlob(blob, `drawesome-${Date.now()}.png`);
      setStatus("PNG exported");
    }
  }, [composeCanvas]);

  const exportTransparentPng = useCallback(async () => {
    const exportCanvas = await composeCanvas({ transparent: true });
    const blob = await canvasToBlob(exportCanvas);

    if (blob) {
      downloadBlob(blob, `drawesome-transparent-${Date.now()}.png`);
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

  const closeStepBackPreview = useCallback(() => {
    if (stepBackUrlRef.current) {
      URL.revokeObjectURL(stepBackUrlRef.current);
      stepBackUrlRef.current = null;
    }
    setStepBackPreview(null);
  }, []);

  useEffect(() => () => {
    if (stepBackUrlRef.current) {
      URL.revokeObjectURL(stepBackUrlRef.current);
    }
  }, []);

  // "Step back" uses one downscaled WebP snapshot, not another full-size
  // canvas. The live editable layers stay exactly where they are underneath.
  const openStepBackPreview = useCallback(async () => {
    if (stepBackBusyRef.current || layersRef.current.length === 0) {
      return;
    }

    stepBackBusyRef.current = true;
    setIsPreparingStepBack(true);
    try {
      const canvas = await composeCanvas({ width: 1280, height: 800 });
      const palette = extractCanvasPalette(canvas);
      const blob = await canvasToBlob(canvas, "image/webp", 0.9);
      if (!blob) {
        throw new Error("Preview encoding failed");
      }

      if (stepBackUrlRef.current) {
        URL.revokeObjectURL(stepBackUrlRef.current);
      }
      const src = URL.createObjectURL(blob);
      stepBackUrlRef.current = src;
      setStepBackPreview({
        src,
        palette,
        roomTitle,
        roomPrompt,
        theme: resolvePreviewTheme({ roomId, roomTitle, roomPrompt }),
      });
      setDesktopHeaderOpen(false);
      setToolsOpen(false);
    } catch {
      showToast("Couldn't open the full-art view");
    } finally {
      stepBackBusyRef.current = false;
      setIsPreparingStepBack(false);
    }
  }, [composeCanvas, roomId, roomPrompt, roomTitle, showToast]);

  // Jump OUR canvas to a friend's last cursor position and pulse it for a moment.
  // Wired to the tappable participant chips in chat. Each person keeps their own
  // orientation/zoom — we only move our own view to find them.
  const focusUser = (userId) => {
    if (!userId) {
      return;
    }
    const pos = userPosRef.current.get(userId);
    if (!pos) {
      showToast("Can't see them on the canvas yet — ask them to draw! ✏️");
      return;
    }
    const { w, h } = getViewportSize();
    const v = viewRef.current;
    const wx = pos.x * CANVAS_WIDTH;
    const wy = pos.y * CANVAS_HEIGHT;
    const c = Math.cos(v.rot || 0);
    const s = Math.sin(v.rot || 0);
    // Centre their world point in our viewport (keeping our own scale + rotation).
    v.tx = w / 2 - v.scale * (c * wx - s * wy);
    v.ty = h / 2 - v.scale * (s * wx + c * wy);
    clampPan(v);
    syncZoomLabel();
    blitToDisplay();
    focusedUserIdRef.current = userId;
    if (focusTimerRef.current) {
      window.clearTimeout(focusTimerRef.current);
    }
    focusTimerRef.current = window.setTimeout(() => {
      focusedUserIdRef.current = null;
    }, 2600);
    showToast(`Found ${pos.name || "your friend"} ✨`);
  };
  // Stable wrapper for CanvasChat (its Bubbles are memoized; a fresh closure
  // per render would defeat that). Reads focusUser via a ref.
  const focusUserRef = useRef(focusUser);
  focusUserRef.current = focusUser;
  const focusChatUser = useCallback((userId) => {
    if (userId && userId !== "system") focusUserRef.current(userId);
  }, []);

  const loadMyDrawings = useCallback(async () => {
    const key = userKeyRef.current;
    if (!key) {
      return;
    }
    try {
      const token = tokenRef.current;
      const res = await fetch(`/api/artworks?userKey=${encodeURIComponent(key)}`, {
        cache: "no-store",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
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
      const token = tokenRef.current;
      const res = await fetch("/api/artworks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ userKey: key, name: `Drawing ${todayName()}`, image, thumb }),
      });
      if (res.status === 409) {
        const data = await res.json().catch(() => ({ max: savesMax }));
        showToast(`You've saved the max (${data.max}). Open 🖼️ Gallery and delete one first.`);
        return;
      }
      if (!res.ok) {
        throw new Error("save failed");
      }
      const data = await res.json();
      showToast(`Saved! 🎉 (${data.count}/${data.max}) — find it in 🖼️ Gallery`);
      await loadMyDrawings();
    } catch {
      showToast("Couldn't save — please try again");
    } finally {
      setSavingArt(false);
    }
  }, [composeCanvas, loadMyDrawings, savesMax, savingArt, showToast]);

  // Capture what's on the easel as Fridge Wall frames: one composed PNG for a
  // drawing (coloring sheet included), or up to 8 frame PNGs for an animation
  // so the wall can play it. Capture happens here (not in the modal) because
  // only the studio owns the layer/frame refs.
  const openWallPost = useCallback(async () => {
    commitLayersToFrame();
    try {
      let frames;
      let durationMs = 400;
      if (roomAnimationRef.current && framesRef.current.length > 1) {
        frames = [];
        for (const f of framesRef.current.slice(0, 8)) {
          const canvas = document.createElement("canvas");
          canvas.width = WALL_POST_WIDTH;
          canvas.height = WALL_POST_HEIGHT;
          const context = canvas.getContext("2d");
          await renderPaper(context, { width: WALL_POST_WIDTH, height: WALL_POST_HEIGHT, textureId: selectedTexture });
          compositeLayers(context, f.layers, { width: WALL_POST_WIDTH, height: WALL_POST_HEIGHT });
          frames.push(await canvasToDataUrl(canvas));
        }
        durationMs = framesRef.current[0]?.durationMs || 400;
      } else {
        const canvas = await composeCanvas({ width: WALL_POST_WIDTH, height: WALL_POST_HEIGHT });
        frames = [await canvasToDataUrl(canvas)];
      }
      setWallPostDraft({ frames, durationMs });
    } catch {
      showToast("Couldn't get your art ready for the wall — try again");
    }
  }, [commitLayersToFrame, composeCanvas, renderPaper, selectedTexture, showToast]);

  const openDrawing = useCallback(
    async (id) => {
      const key = userKeyRef.current;
      if (!key) {
        return;
      }
      try {
        const token = tokenRef.current;
        const res = await fetch(`/api/artworks/${id}?userKey=${encodeURIComponent(key)}`, {
          cache: "no-store",
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!res.ok) {
          throw new Error("not found");
        }
        const data = await res.json();
        const image = await createImage(data.image).catch(() => null);
        if (!image) {
          throw new Error("decode failed");
        }
        if (roomAnimationRef.current) {
          showToast("Open saved art in a drawing room — this room is a shared animation");
          setShowMyArt(false);
          return;
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
    [markChanged, pushHistory, renderDisplay, showToast, syncFrameState, syncLayerState],
  );

  const deleteDrawing = useCallback(
    async (id) => {
      const key = userKeyRef.current;
      if (!key) {
        return;
      }
      try {
        const token = tokenRef.current;
        await fetch(`/api/artworks/${id}?userKey=${encodeURIComponent(key)}`, {
          method: "DELETE",
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
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
      const vs = getViewportSize();
      const center = screenToWorld(viewRef.current, vs.w / 2, vs.h / 2);
      const x = Math.round(center.x - w / 2);
      const y = Math.round(center.y - h / 2);
      pushHistory();
      active.canvas.getContext("2d").drawImage(image, x, y, w, h);
      markMixDirty(active, { x0: x, y0: y, w, h }); // wet-mix mirror (layer 0 only)
      renderDisplay();
      refreshActiveThumbnail();
      if (roomAnimationRef.current) {
        mpRef.current?.sendOp({ kind: "image", dataUrl, x, y, w, h, frameId: framesRef.current[activeFrameIndexRef.current]?.id });
      } else if (activeFrameIndexRef.current === 0) {
        mpRef.current?.sendOp({ kind: "image", dataUrl, x, y, w, h });
      }
      markChanged("Image added");
    },
    [getActiveLayer, markChanged, markMixDirty, pushHistory, refreshActiveThumbnail, renderDisplay],
  );

  const shareRoomLink = useCallback(async () => {
    const joinUrl = `${window.location.origin}/join/${encodeURIComponent(roomId)}`;
    const title = roomTitle || `Drawesome room ${roomId}`;
    const text = `Come paint with me on Drawesome! 🎨 ${joinUrl}`;

    // Call the native share sheet directly from the button tap. In particular,
    // iPadOS can drop a URL when a file is shared alongside it, so Share is
    // deliberately link-only; Export remains available for the artwork itself.
    if (navigator.share) {
      try {
        await navigator.share({ title, text, url: joinUrl });
        showToast("Invite shared! 🎨");
        return;
      } catch (err) {
        if (err?.name === "AbortError") return;
        // If the share sheet fails, fall through and copy the same link.
      }
    }

    try {
      await navigator.clipboard.writeText(joinUrl);
      showToast("Invite link copied — paste it into a text or social post!");
    } catch {
      window.prompt("Copy this invite link:", joinUrl);
    }
  }, [roomId, roomTitle, showToast]);

  // Restore a flattened gallery item onto a fresh single layer.
  const restoreGalleryItem = useCallback(
    async (item) => {
      if (roomAnimationRef.current) {
        setStatus("Open gallery art in a drawing room — this room is a shared animation");
        return;
      }
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

      // Private-room-only brushes (smudge) are ghosted in public rooms; the
      // picker routes their taps to a toast, but guard here too. The
      // finger-paint room is the exception — smearing is the toy there.
      if (brush?.privateOnly && roomAudienceRef.current === "kid_safe" && !roomFingerPaintRef.current) {
        showToast("Smudge works in private rooms — start one from Rooms!");
        return;
      }

      setSelectedBrush(brushId);
      setActiveBrushRecipe(null);
      setSelectedTool("brush");
      // Picking a brush means you want to draw — drop out of the pan/hand tool.
      handToolRef.current = false;
      setHandTool(false);
    },
    [showToast, studioUnlocked],
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
    const cssX = event.clientX - rect.left;
    const cssY = event.clientY - rect.top;

    // Screen (CSS px) -> world coords through the current view (incl. rotation).
    const world = screenToWorld(viewRef.current, cssX, cssY);

    let rawPressure;
    if (event.pointerType === "pen" && event.pressure > 0) {
      // Real pen pressure, stretched to the band THIS stylus actually reports
      // (utils/penInput): Apple Pencil floors near ~0.03 and rarely passes
      // ~0.75 in normal drawing; a Wacom Cintiq fills the band to 1.0. The
      // ceiling starts on the Pencil band and learns upward from sustained
      // heavier pressure, then sticks per device. Without the stretch a hard
      // press only reached ~3/4 of the brush's size range and felt dead; with
      // a fixed Pencil band a Wacom would max out at three-quarter pressure.
      if (!penCalRef.current) {
        penCalRef.current = loadPenCalibration();
      }
      const cal = penCalRef.current;
      rawPressure = mapPenPressure(cal, event.pressure);
      if (cal.dirty && !penCalSaveRef.current) {
        penCalSaveRef.current = window.setTimeout(() => {
          penCalSaveRef.current = 0;
          savePenCalibration(penCalRef.current);
        }, 1200);
      }
    } else {
      // No real pressure (mouse reports a UA-constant 0.5/0, fingers a
      // constant too — the old hardcoded 0.62/0.72 fallbacks): synthesize it
      // from stroke speed (#63) — slow, deliberate = heavy; fast flicks =
      // light. EMA-smoothed so width breathes instead of flickering.
      const vel = velocityRef.current;
      const t = event.timeStamp || performance.now();
      if (vel.lastT == null || t > vel.lastT) {
        if (vel.lastT == null) {
          vel.lastP = 0.65; // first point of a stroke: neutral baseline
        } else {
          const speed = Math.hypot(world.x - vel.lastX, world.y - vel.lastY) / Math.max(1, t - vel.lastT);
          vel.ema = vel.ema == null ? speed : vel.ema * 0.7 + speed * 0.3;
          vel.lastP = Math.min(0.9, Math.max(0.3, 0.9 - vel.ema * 0.055));
        }
        vel.lastX = world.x;
        vel.lastY = world.y;
        vel.lastT = t;
      }
      // t <= lastT: the same event seen twice (cursor relay + coalesced draw
      // replay) or an older coalesced sibling — reuse the last synthesis
      // rather than poisoning the EMA with zero/negative dt samples.
      rawPressure = vel.lastP;
    }
    // Quantize to 2 decimals: plenty for brush dynamics, smaller op payloads.
    const pressure = Math.round(rawPressure * 100) / 100;

    return { x: world.x, y: world.y, pressure };
  }, []);

  // Send the buffered points of the in-progress stroke to the room. Throttled
  // to ~40ms mid-stroke so volume stays sane while feeling live. `end = true`
  // (pen-up) bypasses the throttle AND always sends — even with zero pending
  // points — because the end marker is what tells every peer to commit their
  // buffered copy of this stroke at its uniform opacity (#62).
  const flushStrokeNet = useCallback((end = false) => {
    const net = strokeNetRef.current;
    const mp = mpRef.current;
    if (!net || !mp) {
      return;
    }
    if (!end) {
      if (net.pending.length === 0) {
        return;
      }
      const now = Date.now();
      if (now - net.lastSent < 40) {
        return;
      }
      net.lastSent = now;
    }
    const points = net.pending;
    net.pending = [];
    // Animation rooms share EVERY frame: the op is tagged with its frame so
    // peers ink the right cel. Elsewhere only the first frame (the mural) is
    // shared — extra frames shouldn't exist there, but never leak them.
    // (activateFrame aborts in-flight strokes, so the frame is stroke-stable.)
    const animated = roomAnimationRef.current;
    if (!animated && activeFrameIndexRef.current !== 0) {
      return;
    }
    const stampId = net.settings?.dab?.stampId;
    const hasInlineStamp = !!net.settings?.dab?.stampDataUrl && !!stampId;
    // Scene histories are fetched independently — someone who pages into
    // scene 3 never replays scene 1's ops, so the full tip pixels must ride
    // at least once PER SCENE (not per session) or their replay of this
    // brush bakes a plain line into the cel.
    const stampScope = hasInlineStamp ? `${stampId}::${(animated && activeSceneIdRef.current) || "main"}` : null;
    const sendFullStamp = hasInlineStamp && !sentStampIdsRef.current.has(stampScope);
    const settingsOnce = hasInlineStamp;
    const op = { kind: "draw", strokeId: net.id, points };
    if (!settingsOnce || !net.sentSettings) {
      op.settings = sendFullStamp
        ? net.settings
        : hasInlineStamp
          ? { ...net.settings, dab: { ...net.settings.dab, stampDataUrl: undefined } }
          : net.settings;
      net.sentSettings = true;
      if (sendFullStamp) {
        sentStampIdsRef.current.add(stampScope);
      }
    }
    if (animated) {
      op.frameId = framesRef.current[activeFrameIndexRef.current]?.id;
    }
    if (end) {
      op.end = true;
    }
    mp.sendOp(op);
  }, []);

  // Land the local buffered stroke on its layer ONCE at the stroke's opacity
  // (the #62 fix), then drop the buffer. Safe to call when nothing is open.
  const commitLocalStroke = useCallback(() => {
    const stroke = localStrokeRef.current;
    if (!stroke) {
      return;
    }
    localStrokeRef.current = null;
    if (stroke.copies) {
      for (const copy of stroke.copies) {
        if (copy.buf.has()) {
          prepareStrokeCommit(copy.buf, copy.renderer, copy.fx);
          copy.buf.commit(stroke.layer.canvas.getContext("2d"), stroke.opacity);
          markMixDirty(stroke.layer, copy.buf.bounds());
        }
        copy.buf.dispose();
      }
      return;
    }
    if (stroke.buf.has()) {
      // Stage-2/3: flush the dab renderer + run the brush's commit passes
      // (wet edge / impasto / paper grain) INSIDE the buffer, then stamp once
      // at the stroke's opacity with the buffer's own composite (legacy
      // strokes: no-op passes, source-over).
      prepareStrokeCommit(stroke.buf, stroke.renderer, stroke.fx);
      stroke.buf.commit(stroke.layer.canvas.getContext("2d"), stroke.opacity);
      markMixDirty(stroke.layer, stroke.buf.bounds()); // wet-mix mirror (layer 0 only)
      if (stroke.layer.id !== activeLayerIdRef.current) {
        // A smudge lands on layer 0 while another layer is active: its
        // pixels now sit inside the "below" composite cache — invalidate so
        // the next frame recomposites (same cost remote ops already pay).
        invalidateCompositeCache();
      }
    }
    stroke.buf.dispose();
  }, [invalidateCompositeCache, markMixDirty]);

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
      // Non-eraser strokes paint into the offscreen stroke buffer at FULL
      // opacity with coordinate-seeded randomness (#62); the eraser stays on
      // the legacy direct destination-out path (stroke === null). A v3
      // smudge is a buffered stroke too — its renderer samples layer 0 and
      // its buffer commits to layer 0 (see startStroke).
      const stroke = localStrokeRef.current;
      // Dab walks (makeStrokeRenderer / makeSmudgeRenderer) must see EXACTLY
      // the point sequence the wire carries — see wirePoint below.
      const dabWalk = stroke ? (stroke.copies ? stroke.copies[0].renderer : stroke.renderer) != null : false;
      for (const pointerEvent of events) {
        const point = getPoint(pointerEvent);
        const lastPoint = lastPointRef.current || point;
        // The WIRE point is computed FIRST: quarter-px quantized (dab
        // placement integrates spacing along the path, so sub-px fidelity is
        // visible) and deduped against the previous sent point (a point that
        // quantizes onto it with the same pressure repaints nothing on replay,
        // so it costs no op bytes). `wirePoint` IS the object pushed to
        // net.pending — and it is the object the dab renderers, buf.ensure()
        // and the symmetry expansion are fed below, so the local dab walk,
        // buffer-grow history and copy paths are byte-identical to what every
        // remote / spectator / replay consumer derives from the op. A point
        // the dedupe drops is not fed at all (remotes never see it; the walk
        // would skip it as stationary anyway). Legacy drawBrushSegment
        // strokes (spray / eraser / custom) keep the raw point as they always
        // have; lastPointRef, the orchestra and the cursor relay stay raw.
        let wirePoint = null;
        const nx = Math.round(point.x * 4) / 4;
        const ny = Math.round(point.y * 4) / 4;
        const prev = net ? net.last : null;
        if (!prev || prev.x !== nx || prev.y !== ny || Math.abs(prev.pressure - point.pressure) >= 0.01) {
          wirePoint = { x: nx, y: ny, pressure: point.pressure };
          // Pen tilt rides the wire as small ints (Stage 3 dynamics will
          // read them; harmless for Stage-2 rendering).
          if (nativeEvent.pointerType === "pen") {
            const tx = Math.round(pointerEvent.tiltX || 0);
            const ty = Math.round(pointerEvent.tiltY || 0);
            if (tx !== 0 || ty !== 0) {
              wirePoint.tx = tx;
              wirePoint.ty = ty;
            }
          }
          if (net) {
            net.pending.push(wirePoint);
            net.last = wirePoint;
          }
        }
        // What the painter is fed: the wire object for dab walks, the raw
        // point for legacy segments. Null = deduped, nothing to paint.
        const walkPoint = dabWalk ? wirePoint : point;
        if (walkPoint) {
          const activeSymmetry = normalizeSymmetry(net?.settings?.symmetry || "none");
          const symmetricPoints = transformPointBySymmetry(walkPoint, activeSymmetry, CANVAS_WIDTH, CANVAS_HEIGHT);
          const symmetricLastPoints = transformPointBySymmetry(lastPoint, activeSymmetry, CANVAS_WIDTH, CANVAS_HEIGHT);
          if (stroke?.copies) {
            stroke.copies.forEach((copy, copyIndex) => {
              const copyPoint = symmetricPoints[copyIndex];
              const copyLast = symmetricLastPoints[copyIndex] || copyPoint;
              if (copy.buf.ensure(copyPoint.x, copyPoint.y, stroke.pad).overflow) {
                prepareStrokeCommit(copy.buf, copy.renderer, copy.fx, false); // overflow chunk: no end(), ink bbox restarts
                copy.buf.commit(stroke.layer.canvas.getContext("2d"), stroke.opacity);
                markMixDirty(stroke.layer, copy.buf.bounds());
                copy.buf.reset();
                copy.buf.ensure(copyPoint.x, copyPoint.y, stroke.pad);
              }
              if (copy.renderer) {
                copy.renderer.addPoints(copy.buf.getCtx(), [copyPoint], copy.buf.base());
              } else {
                drawBrushSegment(copy.buf.getCtx(), copyLast, copyPoint, stroke.drawSettings, pointRand(stroke.seed + copyIndex, copyPoint.x, copyPoint.y));
              }
            });
          } else if (stroke) {
            if (stroke.buf.ensure(walkPoint.x, walkPoint.y, stroke.pad).overflow) {
              // The stroke outgrew the 2048² buffer cap: bank what we have into
              // the layer and restart the buffer here (a rare, visually-minor
              // opacity seam on giant strokes — intended). Commit passes (wet
              // edge / impasto / grain) run per committed chunk; final = false
              // skips the renderer's end() so the dab walk state
              // (residual/lastPoint) stays alive across the restart, and
              // restarts its ink bbox with the buffer.
              prepareStrokeCommit(stroke.buf, stroke.renderer, stroke.fx, false);
              stroke.buf.commit(stroke.layer.canvas.getContext("2d"), stroke.opacity);
              markMixDirty(stroke.layer, stroke.buf.bounds()); // overflow chunk landed on the layer
              stroke.buf.reset();
              stroke.buf.ensure(walkPoint.x, walkPoint.y, stroke.pad);
            }
            if (stroke.renderer) {
              // Stage-2 dab path: the renderer interpolates spaced stamps from
              // its OWN per-stroke lastPoint/residual — feed one point at a time
              // (matching how remote batches are unpacked per point).
              stroke.renderer.addPoints(stroke.buf.getCtx(), [walkPoint], stroke.buf.base());
            } else {
              drawBrushSegment(stroke.buf.getCtx(), lastPoint, walkPoint, stroke.drawSettings, pointRand(stroke.seed, walkPoint.x, walkPoint.y));
            }
          } else {
            symmetricPoints.forEach((copyPoint, copyIndex) => {
              drawBrushSegment(context, symmetricLastPoints[copyIndex] || copyPoint, copyPoint, settings);
            });
            invalidateMixPrefetch(active); // eraser / spray / custom draw the layer directly
          }
        }
        if (roomOrchestra) {
          orchestraRef.current?.playStroke({
            x: point.x / CANVAS_WIDTH,
            y: point.y / CANVAS_HEIGHT,
            velocity: point.velocity || 0.45,
            pressure: point.pressure,
            brushId: net?.settings?.brush || settings.brush,
            sourceId: "local",
          });
        }
        lastPointRef.current = point;
      }

      // Stream the buffered points to the room (throttled), so friends see the
      // stroke grow live rather than only on pen-up.
      flushStrokeNet(false);

      // Coalesced, cache-backed display update (W1/W2/W5): at most one
      // below + active + above composite per painted frame.
      scheduleStrokeFrame();
    },
    [flushStrokeNet, getActiveLayer, getPoint, invalidateMixPrefetch, markMixDirty, roomOrchestra, scheduleStrokeFrame],
  );

  // ---- Pointer lifecycle. Branches by tool but shares capture/setup. ----

  const beginInteraction = useCallback(
    (event) => {
      // Pen tip (0) or the stylus eraser end (5) may stroke; barrel / mouse
      // secondary buttons were already routed to a pan drag upstream.
      if (event.button !== undefined && event.button !== 0 && !isEraserPointer(event)) {
        return false;
      }

      // A host locked the room: nobody but a host may draw. (The server also
      // drops these ops — this is just immediate feedback so strokes don't appear
      // and then vanish on the next history replay.)
      if (roomLocked && !isRoomHost) {
        setStatus("🔒 A host locked the canvas");
        return false;
      }
      const storyPage = storybook?.pages?.find((page) => page.sceneId === activeSceneIdRef.current);
      if (storyPage?.locked && !isRoomHost) {
        setStatus("🔒 This story page is finished");
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
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        /* capture is best-effort (synthetic / already-released pointer) */
      }
      activePointerRef.current = event.pointerId;
      activePointerTypeRef.current = event.pointerType || null;
      activeCanvasRectRef.current = event.currentTarget.getBoundingClientRect();
      return true;
    },
    [getActiveLayer, roomLocked, isRoomHost, storybook],
  );

  // Decide whether to ignore a touch contact for palm rejection / pen priority
  // (W14). The pen always wins: while a pen stroke is live, or for
  // PEN_PRIORITY_MS after any pen activity (contact or hover — a Cintiq and an
  // M2 iPad report the pen in proximity before it lands), touch contacts are
  // ignored, so the resting hand can't paint or pinch. Any touch with a large
  // contact patch is a palm regardless. Mouse and a lone fingertip are never
  // rejected, and fingers come back a moment after the pen is put down.
  const shouldRejectPointer = useCallback((event) => {
    const type = event.pointerType;
    if (type === "pen") {
      lastPenAtRef.current = event.timeStamp || performance.now();
      return false;
    }
    if (type === "touch") {
      if (activePointerRef.current != null && activePointerTypeRef.current === "pen") {
        return true; // a pen stroke is in progress — this is the hand
      }
      const now = event.timeStamp || performance.now();
      if (now - lastPenAtRef.current < PEN_PRIORITY_MS) {
        return true; // pen was just here; ignore resting-hand / second-finger touches
      }
      // Palm heuristic: real fingertips report a small contact patch. A large
      // width/height is almost certainly a palm or forearm resting on a tablet.
      if ((event.width || 0) > PALM_CONTACT_PX || (event.height || 0) > PALM_CONTACT_PX) {
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
      let settings = settingsRef.current;
      // Stylus eraser end (Wacom / Surface / any pen reporting button 5): erase
      // with whatever is in hand, whatever tool the rail shows. The rail flips
      // to the eraser for the stroke so the UI agrees with the pen, and
      // finishStroke / abortActiveStroke put the previous tool back at pen-up.
      if (
        settings &&
        isEraserPointer(event) &&
        !roomFingerPaintRef.current &&
        !(settings.tool === "brush" && settings.brush === "eraser")
      ) {
        penEraserOverrideRef.current = { tool: settings.tool, brush: settings.brush };
        settings = { ...settings, tool: "brush", brush: "eraser" };
        settingsRef.current = settings;
        handToolRef.current = false;
        setHandTool(false);
        setSelectedTool("brush");
        setSelectedBrush("eraser");
      }
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
          // Flood fill has no cheap bbox — if it touched layer 0, re-mirror
          // the whole wet-mix map on next sample (fills are rare).
          if (active === layersRef.current[0]) {
            mixMapRef.current?.markAllDirty();
          }
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
          invalidateMixPrefetch(active); // direct, unmarked layer write
          if (roomAnimationRef.current || activeFrameIndexRef.current === 0) {
            const textOp = {
              kind: "text",
              point: { x: point.x, y: point.y },
              text,
              opts: { color: settings.color, opacity: settings.opacity, fontSize: settings.textSize },
            };
            if (roomAnimationRef.current) {
              textOp.frameId = framesRef.current[activeFrameIndexRef.current]?.id;
            }
            mpRef.current?.sendOp(textOp);
          }
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
      // Safety net: if a dropped pointerup ever orphaned a stroke buffer,
      // commit it before opening a new one (no-op in the normal flow).
      commitLocalStroke();
      // Smudge is private-room only EXCEPT the finger-paint room, where smearing
      // is the toy. The picker ghosts it in other kid_safe rooms; this fallback
      // guards restored drafts / audience races — without the fingerPaint
      // exception it would silently turn FINGERS smudge into a colored marker.
      const smudgeBlocked = roomAudienceRef.current === "kid_safe" && !roomFingerPaintRef.current;
      const brushId = settings.brush === "smudge" && smudgeBlocked ? "marker" : settings.brush;
      if (roomAudienceRef.current === "kid_safe" && settings.dab?.shape === "stamp") {
        setStatus("Imported brushes work in private rooms");
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        activePointerRef.current = null;
        activeCanvasRectRef.current = null;
        return;
      }
      const authoringDab = settings.v >= 3 && settings.dab
        ? { version: 3, dab: settings.dab }
        : brushId === "eraser" || brushId === "smudge" ? null : getAuthoringDab(brushId);
      const dab = authoringDab?.dab || null;
      if (dab?.shape === "stamp" && !isBrushStampReady(dab)) {
        setStatus("Brush tip is still loading");
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        activePointerRef.current = null;
        activeCanvasRectRef.current = null;
        return;
      }
      // Velocity-pressure synthesis (#63) starts fresh on every stroke.
      velocityRef.current.lastT = null;
      velocityRef.current.ema = null;
      lastPointRef.current = getPoint(event.nativeEvent);
      // Smudge edits LAYER 0 even when another layer is active — snapshot the
      // full stack in that case so undo restores the right layer's pixels.
      pushHistory(brushId === "smudge" && activeLayerIdRef.current !== layersRef.current[0]?.id ? "full" : "active");
      buildCompositeCache();
      // Per-stroke randomness seed: rides the wire so every client renders the
      // exact same jitter/scatter for this stroke (see pointRand in brushes).
      const seed = Math.floor(Math.random() * 2 ** 31);
      // Stage-2 routing: brushes with dab params mark their ops settings.v = 2
      // (rides the wire), so every consumer — local, live remote, spectator,
      // history replay — picks the makeStrokeRenderer path for this stroke.
      // Spray/eraser/anything without dab params stays legacy, and legacy
      // history ops (no v) replay pixel-stable forever. (Smudge is routed BY
      // BRUSH ID in every consumer, not via the dab table.)
      const netSettings = {
        brush: brushId,
        color: settings.color,
        size: settings.size,
        opacity: settings.opacity,
        variation: settings.variation,
        seed,
      };
      const strokeSymmetry = brushId === "smudge"
        ? normalizeSymmetry("none")
        : normalizeSymmetry(roomSymmetryRef.current);
      if (strokeSymmetry.copies > 1) {
        netSettings.symmetry = strokeSymmetry;
      }
      // Smudge's Strength (per-dab blend alpha) rides the wire so the local
      // renderer honours the slider AND every remote/replay/spectator client
      // smears with the identical alpha — deterministic parity. Only smudge
      // reads it, so we don't bloat every other brush's op.
      if (brushId === "smudge") {
        netSettings.opacity = 1; // Strength IS smudge's strength — the opacity slider is hidden for it
        netSettings.strength = settings.strength;
        // Stage 4: v:3 + the Smudge | Blend mode ride the wire too, read
        // through the engine's one normalizer (anything but "blend" is
        // "drag"). Every consumer — this walker included — builds its
        // renderer from these settings, and ops without v keep the legacy
        // square renderer everywhere, so old history never repaints.
        netSettings.v = 3;
        netSettings.smudgeMode = normalizeSmudgeSettings({ v: 3, smudgeMode: settings.smudgeMode }).mode;
      }
      if (authoringDab) {
        netSettings.v = authoringDab.version;
        if (authoringDab.version >= 3) {
          netSettings.dab = authoringDab.dab;
        }
        // The room's wet state is captured INTO the op at pen-down: replay
        // stays deterministic no matter how the toggle flips later.
        if (roomWetRef.current) {
          netSettings.wet = true;
        }
      }
      // Open an outgoing network stroke so each painted point streams to friends.
      strokeNetRef.current = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        settings: netSettings,
        pending: [],
        lastSent: 0,
        sentSettings: false,
        last: null, // last appended net point (wire-level dedupe)
      };
      // Stage-1 buffered stroke (#62) for everything but the eraser. A
      // buffered eraser preview would appear to punch holes through LOWER
      // layers mid-stroke, so erasing keeps the direct destination-out path.
      // Smudge (Stage 4) buffers like every brush but samples AND commits
      // LAYER 0 whatever layer is active: ops carry no layer, every peer
      // replays smudge against layer 0, and a smudge that sampled a
      // different layer than its peers would smear different paint. (Its
      // preview draws above the active layer; paint on higher layers over
      // the smear pops under it at pen-up — the documented multi-layer
      // divergence class, see makeStrokeEntryCore.)
      if (brushId !== "eraser") {
        // ONE shared entry core (buffer / dab renderer / commit passes / pad /
        // opacity / commit composite) — the same builder applyRemoteOp and
        // opReplay start from, so nothing about this stroke is decided
        // differently on the local side. Symmetry: one core per copy (each
        // copy has its own buffer + walk state); the shared fields ride on
        // the stroke.
        const layer0 = layersRef.current[0];
        const core = makeStrokeEntryCore(netSettings, sampleMix, { smudgeSource: brushId === "smudge" && layer0 ? layer0.canvas : null });
        if (!core) {
          // A v3 dab that can't normalize draws nowhere (remotes drop it too).
          setStatus("That brush can't be used here");
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          activePointerRef.current = null;
          activeCanvasRectRef.current = null;
          strokeNetRef.current = null;
          return;
        }
        const sharedStroke = {
          layer: brushId === "smudge" ? layer0 : getActiveLayer(),
          settings: netSettings,
          seed,
          drawSettings: core.drawSettings,
          opacity: core.opacity,
          composite: core.composite,
          pad: core.pad,
        };
        localStrokeRef.current = strokeSymmetry.copies > 1
          ? {
            ...sharedStroke,
            copies: [core, ...Array.from({ length: strokeSymmetry.copies - 1 }, () => makeStrokeEntryCore(netSettings, sampleMix))],
          }
          : { ...sharedStroke, ...core };
      } else {
        localStrokeRef.current = null;
      }
      drawBrushFromEvent(event);
      // Flag the draft dirty WITHOUT the setStatus re-render markChanged does —
      // a full component render mid-pointerdown stalls the first stroke frames.
      // finishStroke's markChanged("Stroke saved") covers the status update.
      dirtyRef.current = true;
    },
    [beginInteraction, buildCompositeCache, commitLocalStroke, drawBrushFromEvent, getActiveLayer, getPoint, invalidateMixPrefetch, markChanged, pushHistory, recordReplay, refreshActiveThumbnail, renderDisplay, sampleMix, shouldRejectPointer, updateHistoryCounts],
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
    [drawBrushFromEvent, getPoint, sendCursorThrottled],
  );

  // Pen-up after an eraser-end stroke: hand the rail back the tool it showed
  // before the stylus was flipped (see startStroke).
  const restorePenEraserOverride = useCallback(() => {
    const prev = penEraserOverrideRef.current;
    if (!prev) {
      return;
    }
    penEraserOverrideRef.current = null;
    setSelectedTool(prev.tool);
    setSelectedBrush(prev.brush);
  }, []);

  const finishStroke = useCallback(
    (event) => {
      if (activePointerRef.current !== event.pointerId) {
        return;
      }

      event.preventDefault();
      try {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      } catch {
        /* pointer already inactive (interrupted pen sequence) — never strand the stroke */
      }

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
          invalidateMixPrefetch(active); // direct, unmarked layer write
          if (roomAnimationRef.current || activeFrameIndexRef.current === 0) {
            const shapeOp = {
              kind: "shape",
              tool,
              start: { x: start.x, y: start.y },
              end: { x: end.x, y: end.y },
              opts: shapeOpts,
            };
            if (roomAnimationRef.current) {
              shapeOp.frameId = framesRef.current[activeFrameIndexRef.current]?.id;
            }
            mpRef.current?.sendOp(shapeOp);
          }
          renderDisplay();
          markChanged("Shape added");
        }
        if (overlay) {
          overlay.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        }
        shapeStartRef.current = null;
        shapePreviewRectRef.current = null;
      } else {
        // Brush/eraser: push the tail of the stroke (+ the end marker peers
        // commit on) to the room, land the buffered stroke on its layer ONCE
        // at the stroke's opacity (#62 — a single pen-down/up tap commits its
        // one dab here too), then flush any pending per-move composite and do
        // one full recomposite (this also invalidates the per-stroke caches).
        flushStrokeNet(true);
        strokeNetRef.current = null;
        commitLocalStroke();
        flushStrokeFrame();
        renderDisplay();
        markChanged("Stroke saved");
      }

      activePointerRef.current = null;
      activePointerTypeRef.current = null;
      activeCanvasRectRef.current = null;
      lastPointRef.current = null;
      activeStrokeLayerIdRef.current = null;
      invalidateCompositeCache();
      updateHistoryCounts();
      refreshActiveThumbnail();
      restorePenEraserOverride();
      // Stroke-batch end: mark the recorder dirty so a timed keyframe is taken.
      recordReplay(false);
      // Play-money reward: a finished stroke earns a Drop (throttled internally).
      earnPaintDropsRef.current?.();
      // Drawing streak: the first real stroke of the day ticks it (day-guarded).
      bumpStreakRef.current?.();
    },
    [commitLocalStroke, flushStrokeFrame, flushStrokeNet, getActiveLayer, getPoint, invalidateCompositeCache, invalidateMixPrefetch, markChanged, pushHistory, recordReplay, refreshActiveThumbnail, renderDisplay, restorePenEraserOverride, updateHistoryCounts],
  );

  // ---- Pointer routing: draw vs. pan/zoom ----------------------------------
  // One finger / mouse draws (unless the hand tool is on); two fingers pan and
  // pinch-zoom; the wheel zooms about the cursor. We track every active pointer
  // so a second finger can take over a stroke as a gesture.

  const abortActiveStroke = useCallback(() => {
    if (activePointerRef.current != null) {
      // Release the first finger's capture so it doesn't stay captured for the
      // rest of the pinch (which would suppress its later events / leak state).
      try {
        overlayCanvasRef.current?.releasePointerCapture?.(activePointerRef.current);
      } catch {
        /* already released */
      }
      flushStrokeFrame();
      // Termination path: keep what was painted so far (legacy parity — the
      // direct path had already inked the layer). Send the end marker so
      // peers commit their copy, then land the local buffer.
      flushStrokeNet(true);
      strokeNetRef.current = null;
      commitLocalStroke();
      activePointerRef.current = null;
      activePointerTypeRef.current = null;
      lastPointRef.current = null;
      activeStrokeLayerIdRef.current = null;
      invalidateCompositeCache();
      renderDisplay();
      restorePenEraserOverride();
    }
  }, [commitLocalStroke, flushStrokeFrame, flushStrokeNet, invalidateCompositeCache, renderDisplay, restorePenEraserOverride]);

  // ---- Brush-size preview ring --------------------------------------------
  // A hollow circle sized to the brush (brushSize x current zoom) + tinted with
  // the colour, so you can see how big/what colour the paint will be BEFORE you
  // commit. Follows the pointer on hover (desktop) and under the finger while
  // drawing (touch); also flashed at canvas centre when the size/brush changes.
  // Positioned by direct style mutation (no React state) to stay off the draw
  // hot path. Hidden for non-painting tools and while panning/pinching.
  const hideBrushCursor = () => {
    brushCursorRef.current?.classList.remove("is-visible");
  };

  // Stamp one dab of the current brush into the ring's canvas at the ring's
  // on-screen size. Called ONLY when brush / colour / size / zoom change (see
  // the signature check in updateBrushCursor) — never per pointer move.
  const renderBrushTip = (d) => {
    const tip = brushTipCanvasRef.current;
    if (!tip) {
      return;
    }
    const extent = brushTipExtent(selectedBrush, selectedTool);
    const box = Math.ceil(d * extent) + 8; // slack for glow halos + flecks
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.ceil(box * dpr);
    if (tip.width !== px || tip.height !== px) {
      tip.width = px;
      tip.height = px;
    }
    tip.style.width = `${box}px`;
    tip.style.height = `${box}px`;
    // Centred on the ring (50% = the ring's padding box, inside its border).
    tip.style.left = `calc(50% - ${box / 2}px)`;
    tip.style.top = `calc(50% - ${box / 2}px)`;
    // Translucent tip: the engine stamps the dab at its own flow alpha, the
    // element's opacity keeps the paint underneath readable.
    tip.style.opacity = String(BRUSH_TIP_ALPHA);
    const ctx = tip.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box, box);
    drawBrushTip(ctx, { brush: selectedBrush, tool: selectedTool, size: d, color: selectedColor, box, smudgeMode });
  };

  const updateBrushCursor = (clientX, clientY) => {
    const ring = brushCursorRef.current;
    const canvas = overlayCanvasRef.current;
    if (!ring || !canvas) {
      return;
    }
    if (handToolRef.current || selectedTool === "fill" || selectedTool === "text") {
      hideBrushCursor();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const scale = viewRef.current.scale || 1;
    const d = Math.max(8, Math.min(brushSize * scale, Math.min(rect.width, rect.height)));
    ring.style.width = `${d}px`;
    ring.style.height = `${d}px`;
    ring.style.setProperty("--bc-color", selectedColor);
    // data-brush picks the ring style (eraser = dashed; shape tools = plain
    // ring); the tip canvas inside shows the brush's actual dab shape.
    const brushKey = selectedTool === "brush" ? selectedBrush : "shape";
    ring.dataset.brush = brushKey;
    // Re-stamp the tip only when what it shows has changed; a plain pointer
    // move just translates the ring (the draw hot path stays clean). The
    // smudge tip differs per mode (streak vs soft pad), so the mode is part
    // of the signature for that brush only.
    const sig = `${brushKey}|${selectedColor}|${Math.round(d * 4)}|${brushKey === "smudge" ? smudgeMode : ""}`;
    if (sig !== brushTipSigRef.current) {
      brushTipSigRef.current = sig;
      renderBrushTip(d);
    }
    ring.style.transform = `translate(${clientX - rect.left - d / 2}px, ${clientY - rect.top - d / 2}px)`;
    ring.classList.add("is-visible");
    if (brushCursorHideRef.current) {
      window.clearTimeout(brushCursorHideRef.current);
      brushCursorHideRef.current = null;
    }
  };

  // Flash the ring at the canvas centre for a moment — the "before you paint"
  // size preview that works even on touch (no hover). Re-armed on size changes.
  // If a mouse/pen is hovering the canvas, the ring is resized under the
  // pointer instead (and stays put) — the cursor must never jump away from
  // where the user is holding it.
  const flashBrushCursor = () => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) {
      return;
    }
    const hover = brushHoverPointRef.current;
    if (hover) {
      updateBrushCursor(hover.x, hover.y);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    // Upper-centre, so the mobile tools drawer (bottom sheet) doesn't cover it
    // while the size slider is being dragged.
    updateBrushCursor(rect.left + rect.width / 2, rect.top + rect.height * 0.22);
    if (brushCursorHideRef.current) {
      window.clearTimeout(brushCursorHideRef.current);
    }
    brushCursorHideRef.current = window.setTimeout(() => {
      hideBrushCursor();
      brushCursorHideRef.current = null;
    }, 900);
  };

  const handleCanvasPointerLeave = (event) => {
    // Mouse left the canvas → drop the hover ring. (Touch has no hover-leave.)
    if (event.pointerType !== "touch") {
      brushHoverPointRef.current = null;
      hideBrushCursor();
    }
  };

  const handleCanvasPointerDown = (event) => {
    if (isExportingVideoRef.current) {
      return; // film export is paging scenes — don't stroke into them
    }
    // Capture EVERY pointer — draw, pan, AND pinch fingers — so the browser
    // guarantees its pointerup/pointercancel comes back here even if the finger
    // slides off-canvas or a system gesture interrupts. Without this, a lost
    // touch-up on iOS strands a stale entry in pointersRef, and the next single
    // touch is misread as a 2nd pinch finger — so it silently refuses to draw.
    // Best-effort: a capture failure must never abort the pointerdown.
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* capture unavailable — pointer tracking + the safety nets still apply */
    }
    // Palm / pen-priority filtering happens HERE, before the contact is
    // registered as a pointer. Two hard rejections: a big contact patch is a
    // palm, and while a pen stroke is actually IN PROGRESS nothing touch may
    // interfere (a palm used to land in pointersRef, read as a 2nd "finger",
    // and abort the pen stroke into a pinch). But fingers while the pen is
    // merely NEAR (hovering / just lifted) DO register — as gesture-only
    // contacts: two of them pinch/pan/twist like Procreate, they just can't
    // paint (the pen-priority window in startStroke keeps single touches
    // inert). Rejected touches are still captured so their up/cancel returns.
    if (event.pointerType === "touch") {
      const palm = (event.width || 0) > PALM_CONTACT_PX || (event.height || 0) > PALM_CONTACT_PX;
      if (palm || (activePointerRef.current != null && activePointerTypeRef.current === "pen")) {
        return;
      }
    }
    if (event.pointerType === "pen") {
      lastPenAtRef.current = event.timeStamp || performance.now();
    }
    // Defensive prune: a fresh first contact with no live stroke/gesture/pan means
    // any lingering pointersRef entries are stale (a prior touch's up/cancel was
    // dropped by iOS). Clear them so this touch isn't misread as a 2nd pinch finger.
    // EXCEPT inside the pen-priority window: there, a tracked finger with no
    // stroke is a live GESTURE CANDIDATE (it deliberately doesn't paint) — the
    // second finger landing next to it is exactly how a pinch starts.
    if (
      activePointerRef.current == null &&
      gestureRef.current == null &&
      panPointerRef.current == null &&
      pointersRef.current.size > 0 &&
      (event.timeStamp || performance.now()) - lastPenAtRef.current >= PEN_PRIORITY_MS
    ) {
      pointersRef.current.clear();
    }
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewRectRef.current = event.currentTarget.getBoundingClientRect();

    // Only touch contacts form a gesture — a pen (iPad Pencil) with a resting palm
    // must still draw, not be hijacked into pan/zoom/rotate. Two fingers pinch +
    // twist + pan; three or more pan. Baselined here and on every finger change.
    if (pointersRef.current.size >= 2 && event.pointerType === "touch") {
      abortActiveStroke();
      hideBrushCursor();
      const m = gestureMetrics([...pointersRef.current.values()]);
      gestureRef.current = { lastMid: { x: m.cx, y: m.cy }, lastDist: m.dist, lastAngle: m.angle, count: m.n };
      return;
    }

    // Hand tool, OR a secondary button held — pen barrel button, mouse right /
    // middle — pans for the length of the drag without changing the tool (the
    // Wacom / Krita / Photoshop habit). Never starts a stroke mid-stroke.
    const buttonPan = !handToolRef.current && activePointerRef.current == null && isSecondaryButtonPointer(event);
    if (handToolRef.current || buttonPan) {
      event.preventDefault();
      hideBrushCursor();
      panPointerRef.current = event.pointerId;
      panLastRef.current = { x: event.clientX, y: event.clientY };
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        /* capture is best-effort */
      }
      return;
    }

    // A lone finger inside the pen-priority window stays a silent gesture
    // candidate — no ring, no stroke (startStroke would reject it anyway, but
    // the ring hopping to a resting finger looks broken).
    if (
      event.pointerType === "touch" &&
      (event.timeStamp || performance.now()) - lastPenAtRef.current < PEN_PRIORITY_MS
    ) {
      return;
    }

    updateBrushCursor(event.clientX, event.clientY);
    startStroke(event);
  };

  const handleCanvasPointerMove = (event) => {
    if (event.pointerType === "pen") {
      // Hover counts: a Cintiq / M2 Pencil in proximity keeps palm touches out.
      lastPenAtRef.current = event.timeStamp || performance.now();
    } else if (event.pointerType === "touch" && !pointersRef.current.has(event.pointerId)) {
      return; // a rejected palm (or a contact that began off-canvas): no ring, no cursor relay
    }
    if (pointersRef.current.has(event.pointerId)) {
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    if (gestureRef.current) {
      hideBrushCursor();
      const pts = [...pointersRef.current.values()];
      if (pts.length < 2) {
        return;
      }
      const rect = viewRectRef.current || event.currentTarget.getBoundingClientRect();
      const m = gestureMetrics(pts);
      const g = gestureRef.current;
      // Finger count changed (e.g. 2->3): rebaseline and skip a frame so the view
      // doesn't jump from the new centroid/spread.
      if (m.n !== g.count) {
        g.lastMid = { x: m.cx, y: m.cy };
        g.lastDist = m.dist;
        g.lastAngle = m.angle;
        g.count = m.n;
        return;
      }
      // Compose pan (+ for 2 fingers, zoom + rotate about the pinch centre) into
      // the view, then repaint at most once per frame via scheduleViewFrame.
      const v = viewRef.current;
      v.tx += m.cx - g.lastMid.x; // pan follows the centroid for any finger count
      v.ty += m.cy - g.lastMid.y;
      if (m.n === 2) {
        const fx = m.cx - rect.left;
        const fy = m.cy - rect.top;
        zoomCore(v, m.dist / g.lastDist, fx, fy);
        let dA = m.angle - g.lastAngle;
        if (dA > Math.PI) dA -= 2 * Math.PI;
        else if (dA < -Math.PI) dA += 2 * Math.PI;
        rotateCore(v, dA, fx, fy);
      }
      scheduleViewFrame();
      g.lastMid = { x: m.cx, y: m.cy };
      g.lastDist = m.dist;
      g.lastAngle = m.angle;
      g.count = m.n;
      return;
    }

    if (panPointerRef.current === event.pointerId) {
      hideBrushCursor();
      panBy(event.clientX - panLastRef.current.x, event.clientY - panLastRef.current.y);
      panLastRef.current = { x: event.clientX, y: event.clientY };
      return;
    }

    // A lone gesture-candidate finger inside the pen-priority window: tracked
    // above (it may become a pinch), but it owns neither the ring nor the
    // cursor relay — those follow the pen.
    if (
      event.pointerType === "touch" &&
      (event.timeStamp || performance.now()) - lastPenAtRef.current < PEN_PRIORITY_MS
    ) {
      return;
    }

    if (event.pointerType !== "touch") {
      brushHoverPointRef.current = { x: event.clientX, y: event.clientY };
    }
    updateBrushCursor(event.clientX, event.clientY);
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
    // Touch has no hover, so drop the ring when the finger lifts; a mouse keeps
    // its hover ring (the next move re-positions it).
    if (event.pointerType === "touch") {
      hideBrushCursor();
    }
    finishStroke(event);
  };

  // A pen barrel button / mouse right-click must never pop the browser context
  // menu over the canvas (Windows fires it on pen long-press and barrel press;
  // the secondary button is a pan drag here instead).
  const handleCanvasContextMenu = (event) => {
    event.preventDefault();
  };

  // Final safety net: when capture is released (after up/cancel, or force-released
  // by the browser during an interrupting gesture) make sure the pointer can never
  // linger as a stale gesture finger.
  const handleCanvasLostPointerCapture = (event) => {
    pointersRef.current.delete(event.pointerId);
    if (gestureRef.current && pointersRef.current.size < 2) {
      gestureRef.current = null;
    }
    if (panPointerRef.current === event.pointerId) {
      panPointerRef.current = null;
    }
  };

  const toggleHandTool = () => {
    setHandTool((on) => {
      handToolRef.current = !on;
      return !on;
    });
  };

  // Flash the brush-size preview ring whenever the size or brush changes (skipping
  // the first render) — the "know how big before you paint" hint that works on
  // touch where there's no hover. Dragging the size slider re-arms it live.
  const brushPreviewInitRef = useRef(false);
  useEffect(() => {
    if (!brushPreviewInitRef.current) {
      brushPreviewInitRef.current = true;
      return;
    }
    flashBrushCursor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brushSize, selectedBrush]);

  // Clear any pending brush-ring hide timer on unmount.
  useEffect(
    () => () => {
      if (brushCursorHideRef.current) {
        window.clearTimeout(brushCursorHideRef.current);
      }
    },
    [],
  );

  // Mobile safety net: if the tab is backgrounded or the window loses focus (an
  // app switch, a notification, an interrupting system gesture), iOS may never
  // deliver the pending pointerup/cancel — stranding stale pointers that break the
  // next touch. Reset all pointer + gesture state on those signals.
  useEffect(() => {
    const reset = () => {
      pointersRef.current.clear();
      gestureRef.current = null;
      panPointerRef.current = null;
      if (activePointerRef.current != null) {
        // Termination path: the pointerup will never arrive, so end the
        // stroke properly — tell peers to commit (end marker) and land the
        // local buffer on its layer before dropping the stroke state.
        flushStrokeNet(true);
        commitLocalStroke();
        activePointerRef.current = null;
        strokeNetRef.current = null;
        lastPointRef.current = null;
        activeStrokeLayerIdRef.current = null;
        renderDisplay();
      }
    };
    // Window-level backstop: if iOS drops the canvas element's pointerup/cancel
    // (a re-render or system gesture stole it), still prune that pointer here so
    // it can never linger as a phantom finger. Idempotent with the element handler.
    const onWindowPointerEnd = (event) => {
      pointersRef.current.delete(event.pointerId);
      if (gestureRef.current && pointersRef.current.size < 2) {
        gestureRef.current = null;
      }
      if (panPointerRef.current === event.pointerId) {
        panPointerRef.current = null;
      }
    };
    const onVisibility = () => {
      if (typeof document === "undefined") {
        return;
      }
      if (document.visibilityState === "hidden") {
        reset();
        cancelPrebuild(); // a pending first slice would rebuild what release frees
        releaseBrushSprites(); // backgrounded: give iOS its canvas memory back (rebuilt lazily)
      } else if (document.visibilityState === "visible") {
        schedulePrebuild(); // back in front: rebuild the atlases in idle time, not on the next dab
      }
    };
    window.addEventListener("blur", reset);
    window.addEventListener("pointerup", onWindowPointerEnd);
    window.addEventListener("pointercancel", onWindowPointerEnd);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", reset);
      window.removeEventListener("pointerup", onWindowPointerEnd);
      window.removeEventListener("pointercancel", onWindowPointerEnd);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [cancelPrebuild, commitLocalStroke, flushStrokeNet, renderDisplay, schedulePrebuild]);

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
      refreshActiveThumbnail(); // composite changed — stamp + thumb (idle)
      recordReplay(true);
      markChanged("Layer deleted");
    },
    [markChanged, pushHistory, recordReplay, refreshActiveThumbnail, renderDisplay, syncLayerState],
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
      refreshActiveThumbnail(); // composite order changed — stamp + thumb (idle)
      markChanged("Layer reordered");
    },
    [markChanged, pushHistory, refreshActiveThumbnail, renderDisplay, syncLayerState],
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
      refreshActiveThumbnail(); // composite changed — stamp + thumb (idle)
      markChanged(layer.visible ? "Layer shown" : "Layer hidden");
    },
    [markChanged, refreshActiveThumbnail, renderDisplay, syncLayerState],
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
      refreshActiveThumbnail(); // stamp bump is O(1); thumb regen coalesces at idle
      dirtyRef.current = true;
      if (!opacityRafRef.current) {
        opacityRafRef.current = window.requestAnimationFrame(() => {
          opacityRafRef.current = 0;
          renderDisplay();
        });
      }
    },
    [handleOpacityDragStart, refreshActiveThumbnail, renderDisplay, syncLayerState],
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
      // Eyeball-hidden frames sit out of playback (local preview mute). If
      // everything is hidden, play as if nothing were — never a blank loop.
      const all = framesRef.current;
      const hidden = hiddenFramesRef.current;
      const visible = hidden.size > 0 && hidden.size < all.length ? all.filter((frame) => !hidden.has(frame.id)) : all;
      const frames = visible.length > 0 ? visible : all;
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
      // A second finger can tap the film strip MID-STROKE on touch devices —
      // terminate the stroke BEFORE the frame swap, while activeFrameIndexRef
      // still points at the pen-down frame, so the wire gate sends the end
      // marker (or correctly stays silent) and the buffer lands on the right
      // frame instead of splitting across two.
      abortActiveStroke();
      const clamped = Math.max(0, Math.min(index, framesRef.current.length - 1));
      activeFrameIndexRef.current = clamped;
      pruneOnionCache(); // keep only the NEW neighbours' proxies warm
      const frame = framesRef.current[clamped];
      layersRef.current = frame.layers;
      activeLayerIdRef.current = frame.activeLayerId;
      // The wet-mix mirror follows layersRef[0], which just changed identity —
      // and the LIVE frame may have taken remote edits/clears while we were
      // away. Re-mirror lazily on the next wet sample (O(1) here).
      mixMapRef.current?.markAllDirty();
      // History is per-frame editing context; clear so undo never crosses frames.
      historyRef.current = [];
      redoRef.current = [];
      updateHistoryCounts();
      renderDisplay();
      syncLayerState();
      setActiveFrameIndex(clamped);
      recordReplay(true);
    },
    [abortActiveStroke, pruneOnionCache, recordReplay, renderDisplay, syncLayerState, updateHistoryCounts],
  );

  // Tell the room which cel we're on (cold path: frame-select / scene-switch /
  // join). Guarded to animation rooms; server rate-limits + relays. Reads only
  // refs, so it's declared here (ahead of handleSelectFrame's deps).
  const announcePresence = useCallback(() => {
    if (!roomAnimationRef.current) return;
    const frameId = framesRef.current[activeFrameIndexRef.current]?.id;
    mpRef.current?.sendFramePresence?.(activeSceneIdRef.current, frameId);
  }, []);

  const handleSelectFrame = useCallback(
    (index) => {
      if (isExportingVideoRef.current) {
        return; // navigation is frozen while the film renders
      }
      if (index === activeFrameIndexRef.current) {
        return;
      }
      if (playTimerRef.current) {
        stopPlayback();
      }
      activateFrame(index);
      announcePresence(); // tell the crew which cel we hopped to
      markChanged(`Frame ${index + 1}`);
    },
    [activateFrame, announcePresence, markChanged, stopPlayback],
  );

  // Page to another scene: ask the server for its frames+ops; the history
  // handler swaps the flipbook when it lands. Old canvases are dropped by
  // reconcileFrames, so memory stays at one scene's worth.
  const switchScene = useCallback(
    (sceneId) => {
      if (!sceneId) {
        return Promise.resolve(false);
      }
      if (sceneId === activeSceneIdRef.current) {
        return Promise.resolve(true);
      }
      abortActiveStroke();
      if (playTimerRef.current) {
        stopPlayback();
      }
      commitLayersToFrame();
      return new Promise((resolve) => {
        const waiters = sceneWaitersRef.current;
        const done = () => resolve(true); // hydrated
        const list = waiters.get(sceneId) || [];
        list.push(done);
        waiters.set(sceneId, list);
        mpRef.current?.sendSceneFetch?.(sceneId);
        // Never wedge an awaiting export if the socket drops mid-switch — but
        // report the timeout as FAILURE (and drop the stale waiter) so the
        // exporter aborts instead of silently encoding blank scenes.
        window.setTimeout(() => {
          const current = waiters.get(sceneId);
          if (current) {
            const index = current.indexOf(done);
            if (index >= 0) current.splice(index, 1);
            if (current.length === 0) waiters.delete(sceneId);
          }
          resolve(false);
        }, 8000);
      });
    },
    [abortActiveStroke, commitLayersToFrame, stopPlayback],
  );

  const handleSelectScene = useCallback(
    (sceneId) => {
      if (isExportingVideoRef.current) {
        return; // navigation is frozen while the film renders
      }
      switchScene(sceneId);
      const index = scenesRef.current.findIndex((scene) => scene.id === sceneId);
      if (index >= 0) {
        setStatus(`Scene ${index + 1}`);
      }
    },
    [switchScene],
  );

  // Frame structure edits: in an animation room these are SHARED mutations.
  // The request goes to the server, which validates caps/locks and echoes it.
  const handleAddFrame = useCallback(() => {
    if (isExportingVideoRef.current) {
      return;
    }
    if (roomAnimationRef.current) {
      commitLayersToFrame();
      // The anchor frame could have raced a delete server-side — the sceneId
      // makes the server fall back to OUR scene, never scenes[0].
      mpRef.current?.sendFrameAdd?.(framesRef.current[activeFrameIndexRef.current]?.id, null, activeSceneIdRef.current);
      return; // applied on the server echo
    }
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
      if (isExportingVideoRef.current) {
        return;
      }
      const source = framesRef.current[index];
      if (!source) {
        return;
      }
      if (roomAnimationRef.current) {
        commitLayersToFrame();
        mpRef.current?.sendFrameAdd?.(source.id, source.id, activeSceneIdRef.current);
        return; // applied on the server echo (pixel-cloned there)
      }
      if (framesRef.current.length >= MAX_FRAMES) {
        setStatus(`Loops are capped at ${MAX_FRAMES} frames`);
        return;
      }
      commitLayersToFrame();
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
      if (isExportingVideoRef.current || framesRef.current.length <= 1) {
        return;
      }
      if (roomAnimationRef.current) {
        mpRef.current?.sendFrameDel?.(framesRef.current[index]?.id);
        return; // applied on the server echo
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
      if (isExportingVideoRef.current) {
        return;
      }
      const target = index + direction;
      if (target < 0 || target >= framesRef.current.length) {
        return;
      }
      if (roomAnimationRef.current) {
        mpRef.current?.sendFrameMove?.(framesRef.current[index]?.id, target);
        return; // applied on the server echo
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

  // Per-frame debounce timers: editing two frames' timings back-to-back must
  // send BOTH updates (a single shared timer would drop the first one).
  const frameDurationSendRef = useRef(new Map());
  const handleFrameDurationChange = useCallback(
    (index, durationMs) => {
      const frame = framesRef.current[index];
      if (!frame) {
        return;
      }
      frame.durationMs = durationMs;
      setFrames(framesRef.current.map((item) => ({ id: item.id, durationMs: item.durationMs })));
      dirtyRef.current = true;
      // Shared timing: debounce the relay so slider drags send one message.
      if (roomAnimationRef.current) {
        const timers = frameDurationSendRef.current;
        window.clearTimeout(timers.get(frame.id));
        timers.set(
          frame.id,
          window.setTimeout(() => {
            timers.delete(frame.id);
            mpRef.current?.sendFrameDuration?.(frame.id, frame.durationMs);
          }, 250),
        );
      }
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

  // Film-strip eyeball: hide/show a frame LOCALLY (playback + onion skip it).
  const handleToggleFrameHidden = useCallback(
    (frameId) => {
      const next = new Set(hiddenFramesRef.current);
      if (next.has(frameId)) {
        next.delete(frameId);
      } else {
        next.add(frameId);
      }
      hiddenFramesRef.current = next;
      setHiddenFrameIds(next);
      // A neighbour may have joined/left the onion sandwich.
      invalidateCompositeCache();
      renderDisplay();
    },
    [invalidateCompositeCache, renderDisplay],
  );

  // Film-strip scrub: paint transient frame previews driven entirely by refs —
  // one rAF in flight, zero React state per pointer-move (the same cost profile
  // playback already proved at 25fps). pointer-up lands on handleScrubEnd.
  const handleScrub = useCallback(
    (index) => {
      if (isExportingVideoRef.current) {
        return; // the film renderer owns the display while encoding
      }
      const scrub = scrubStateRef.current;
      if (!scrub.active) {
        // A second finger can start scrubbing mid-stroke — terminate the
        // stroke first (same reasoning as activateFrame).
        abortActiveStroke();
        if (playTimerRef.current) {
          stopPlayback();
        }
        commitLayersToFrame();
        scrub.active = true;
      }
      scrub.index = index;
      if (scrub.raf) {
        return; // coalesce: latest index wins on the next frame
      }
      scrub.raf = window.requestAnimationFrame(() => {
        scrub.raf = 0;
        if (!scrub.active) {
          return;
        }
        const frame = framesRef.current[scrub.index];
        const context = docContextRef.current;
        if (!frame || !context) {
          return;
        }
        context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        compositeLayers(context, frame.layers);
        blitToDisplay();
      });
    },
    [abortActiveStroke, blitToDisplay, commitLayersToFrame, stopPlayback],
  );

  const handleScrubEnd = useCallback(
    (index) => {
      const scrub = scrubStateRef.current;
      scrub.active = false;
      if (scrub.raf) {
        window.cancelAnimationFrame(scrub.raf);
        scrub.raf = 0;
      }
      if (index !== activeFrameIndexRef.current) {
        handleSelectFrame(index); // activates + restores the editable composite
      } else {
        renderDisplay(); // back to the editable view (onion, sheet, overlays)
      }
    },
    [handleSelectFrame, renderDisplay],
  );

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
      downloadBlob(blob, `drawesome-loop-${Date.now()}.gif`);
      setStatus(`GIF exported (${frameCount} frames)`);
    } catch {
      setStatus("GIF export failed");
    } finally {
      setIsExportingGif(false);
    }
  }, [commitLayersToFrame, getGifWorker, isExportingGif, renderPaper, selectedTexture, stopPlayback]);

  // Real video export — MP4 where the browser can (H.264 plays everywhere:
  // iMessage, Discord, camera roll), WebM otherwise. Free for everyone.
  // Frames are composited on demand at 1600x1000 (8:5) into the encoder's
  // reusable canvas, so long flipbooks never pile up snapshots in memory.
  const exportVideo = useCallback(async () => {
    if (isExportingVideo) {
      return;
    }
    if (playTimerRef.current) {
      stopPlayback();
    }
    commitLayersToFrame();
    // Multi-scene films stitch EVERY scene into one video: the draw callback
    // pages scenes in via switchScene (memory stays at a scene's worth) and
    // frames resolve by id after each hydration. Single-scene exports snapshot
    // the frame list so remote edits mid-export can't shrink or reorder it.
    // (The real-time MediaRecorder fallback can't pause for scene switches, so
    // browsers without WebCodecs export the current scene only.)
    const multiScene =
      roomAnimationRef.current && scenesRef.current.length > 1 && typeof window.VideoEncoder === "function";
    const originalSceneId = activeSceneIdRef.current;
    let plan;
    if (multiScene) {
      plan = [];
      for (const scene of scenesRef.current) {
        for (const meta of scene.frames || []) {
          plan.push({ sceneId: scene.id, frameId: meta.id, durationMs: meta.durationMs });
        }
      }
    } else {
      plan = framesRef.current
        .slice()
        .map((frame) => ({ sceneId: activeSceneIdRef.current, frameId: frame.id, durationMs: frame.durationMs, frame }));
    }
    if (plan.length === 0) {
      return;
    }
    setIsExportingVideo(true);
    isExportingVideoRef.current = true;
    setStatus("Encoding video…");
    try {
      const width = 1600;
      const height = 1000;
      const { blob, ext } = await encodeAnimationVideo({
        width,
        height,
        count: plan.length,
        durationMsAt: (i) => plan[i]?.durationMs || DEFAULT_FRAME_DURATION,
        draw: async (context, i) => {
          const item = plan[i];
          if (!item) {
            return;
          }
          if (multiScene && item.sceneId !== activeSceneIdRef.current) {
            const hydrated = await switchScene(item.sceneId);
            if (!hydrated || activeSceneIdRef.current !== item.sceneId) {
              // A failed/hijacked hydration must ABORT the export — never
              // report "Film exported 🎬" with silently blank scenes.
              throw new Error("scene hydration failed");
            }
          }
          const frame = item.frame || framesRef.current.find((f) => f.id === item.frameId);
          if (multiScene && !frame) {
            throw new Error("frame missing after scene switch");
          }
          await renderPaper(context, { width, height, textureId: selectedTexture });
          if (frame) {
            compositeLayers(context, frame.layers, { width, height });
          }
        },
        onProgress: (pct) => setStatus(`Encoding film… ${Math.round(pct * 100)}%`),
      });
      downloadBlob(blob, `drawesome-${Date.now()}.${ext}`);
      if (!multiScene && roomAnimationRef.current && scenesRef.current.length > 1) {
        setStatus(`Exported this scene (.${ext}) — full-film export needs a newer browser`);
      } else {
        setStatus(`Film exported (.${ext}) 🎬`);
      }
    } catch {
      setStatus("Video export failed on this browser — try Export GIF");
    } finally {
      setIsExportingVideo(false);
      isExportingVideoRef.current = false;
      if (multiScene && originalSceneId && originalSceneId !== activeSceneIdRef.current) {
        switchScene(originalSceneId); // land back where the artist was working
      }
    }
  }, [commitLayersToFrame, isExportingVideo, renderPaper, selectedTexture, stopPlayback, switchScene]);

  const exportStorybook = useCallback(async () => {
    if (!storybook || isExportingVideo) return;
    const preview = window.open("", "_blank", "noopener");
    if (!preview) {
      showToast("Allow pop-ups to open the printable storybook.");
      return;
    }
    preview.document.title = storybook.title || "Our Story";
    preview.document.body.textContent = "Building your storybook…";
    setIsExportingVideo(true);
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/film`, { cache: "no-store" });
      if (!response.ok) throw new Error("book fetch failed");
      const film = await response.json();
      const firstFrameId = film.scenes?.[0]?.frames?.[0]?.id;
      const opsByFrame = new Map();
      for (const op of film.ops || []) {
        const frameId = op.frameId || firstFrameId;
        const list = opsByFrame.get(frameId) || [];
        list.push(op);
        opsByFrame.set(frameId, list);
      }
      const world = document.createElement("canvas");
      world.width = CANVAS_WIDTH;
      world.height = CANVAS_HEIGHT;
      const pages = [];
      for (const page of storybook.pages) {
        const scene = (film.scenes || []).find((item) => item.id === page.sceneId);
        const frameId = scene?.frames?.[0]?.id;
        await replayFrameOnto(world, frameId ? (opsByFrame.get(frameId) || []) : []);
        const output = document.createElement("canvas");
        output.width = 1200;
        output.height = 750;
        const context = output.getContext("2d");
        await renderPaper(context, { width: output.width, height: output.height, textureId: selectedTexture });
        context.drawImage(world, 0, 0, output.width, output.height);
        pages.push({ image: output.toDataURL("image/jpeg", 0.88), caption: page.caption || "", title: page.title || "" });
      }
      world.width = 1;
      world.height = 1;
      const doc = preview.document;
      doc.body.textContent = "";
      const style = doc.createElement("style");
      style.textContent = "body{font-family:system-ui;margin:24px;color:#30140a}h1{text-align:center}.page{break-after:page;margin:0 auto 28px;max-width:900px}.page img{width:100%;border-radius:16px}.page h2,.page p{text-align:center}@media print{button{display:none}.page{break-after:page}}";
      doc.head.appendChild(style);
      const heading = doc.createElement("h1");
      heading.textContent = storybook.title || "Our Story";
      doc.body.appendChild(heading);
      pages.forEach((page, index) => {
        const section = doc.createElement("section");
        section.className = "page";
        const title = doc.createElement("h2");
        title.textContent = `Page ${index + 1}: ${page.title}`;
        const image = doc.createElement("img");
        image.src = page.image;
        image.alt = title.textContent;
        const caption = doc.createElement("p");
        caption.textContent = page.caption;
        section.append(title, image, caption);
        doc.body.appendChild(section);
      });
      const print = doc.createElement("button");
      print.textContent = "Print or save as PDF";
      print.onclick = () => preview.print();
      doc.body.appendChild(print);
      setStatus("Storybook ready to print");
    } catch {
      preview.document.body.textContent = "Couldn't build this storybook. Close this tab and try again.";
      setStatus("Storybook export failed");
    } finally {
      setIsExportingVideo(false);
    }
  }, [isExportingVideo, renderPaper, roomId, selectedTexture, showToast, storybook]);

  // Export the WHOLE production — every part, in order, as one movie. Fully
  // offline: each segment's ops come from /api/rooms/:code/film and replay
  // through the shared op interpreter into ONE reusable world canvas, so a
  // 2-minute film renders memory-flat and never touches the artist's view
  // (you can keep painting while it renders — edits after the fetch just
  // aren't in this cut).
  const exportProduction = useCallback(async () => {
    const activeProduction = productionRef.current;
    if (!activeProduction || isExportingVideo) {
      return;
    }
    if (typeof window.VideoEncoder !== "function") {
      setStatus("Full-film export needs a newer browser (Chrome, Edge, or Safari 16.4+)");
      return;
    }
    setIsExportingVideo(true);
    setStatus("🎬 Gathering the parts…");
    try {
      const width = 1600;
      const height = 1000;
      // 1) Fetch every segment's frame plan + complete visible op log.
      const plan = [];
      for (const segment of activeProduction.segments) {
        const response = await fetch(`/api/rooms/${encodeURIComponent(segment.code)}/film`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error("segment fetch failed");
        }
        const film = await response.json();
        // Warm the module-level stamp cache from this segment's pixel-bearing
        // ops BEFORE any frame renders. Export replays frames in index order,
        // not draw order, so a "reuse" op (stampDataUrl compressed out) can
        // otherwise render before the tip-pixel op and drop the stroke.
        await Promise.all(
          (film.ops || [])
            .filter((op) => op.settings?.dab?.stampDataUrl)
            .map((op) => preloadBrushStamp(op.settings.dab)),
        );
        const firstFrameId = film.scenes?.[0]?.frames?.[0]?.id;
        const opsByFrame = new Map();
        for (const op of film.ops || []) {
          const frameId = op.frameId || firstFrameId;
          const list = opsByFrame.get(frameId) || [];
          list.push(op);
          opsByFrame.set(frameId, list);
        }
        for (const scene of film.scenes || []) {
          for (const meta of scene.frames || []) {
            plan.push({ ops: opsByFrame.get(meta.id) || [], durationMs: meta.durationMs });
          }
        }
      }
      if (plan.length === 0) {
        setStatus("Nothing to render yet — draw some frames first!");
        return;
      }
      // 2) Offline-replay each frame into a reusable world canvas and encode.
      const world = document.createElement("canvas");
      world.width = CANVAS_WIDTH;
      world.height = CANVAS_HEIGHT;
      const { blob, ext } = await encodeAnimationVideo({
        width,
        height,
        count: plan.length,
        durationMsAt: (i) => plan[i]?.durationMs || DEFAULT_FRAME_DURATION,
        draw: async (context, i) => {
          await replayFrameOnto(world, plan[i]?.ops || []);
          await renderPaper(context, { width, height, textureId: selectedTexture });
          context.drawImage(world, 0, 0, width, height);
        },
        onProgress: (pct) => setStatus(`🎬 Rendering "${activeProduction.title}"… ${Math.round(pct * 100)}%`),
      });
      const slug = (activeProduction.title || "film").replace(/[^\w-]+/g, "-").toLowerCase();
      downloadBlob(blob, `${slug}-${Date.now()}.${ext}`);
      setStatus(`🎬 "${activeProduction.title}" exported (.${ext}) — premiere time! 🍿`);
    } catch {
      setStatus("Film export hit a snag — try again in a moment");
    } finally {
      setIsExportingVideo(false);
    }
  }, [isExportingVideo, renderPaper, selectedTexture]);

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
      downloadBlob(blob, `drawesome-timelapse-${Date.now()}.gif`);
      setStatus("Timelapse exported");
    } catch {
      setStatus("Timelapse export failed");
    } finally {
      setIsExportingTimelapse(false);
    }
  }, [encodeTimelapseBytes, isExportingTimelapse]);

  // Share the timelapse GIF straight to the OS share sheet (socials, iMessage,
  // etc.) — the shareable "watch it draw" artifact is the growth loop. Falls
  // back to a plain download where file-sharing isn't supported (most desktops).
  const shareTimelapse = useCallback(async () => {
    if (isExportingTimelapse) return;
    setIsExportingTimelapse(true);
    setStatus("Making your timelapse…");
    try {
      const bytes = await encodeTimelapseBytes();
      if (!bytes) {
        setStatus("Draw a bit first — no timelapse yet!");
        return;
      }
      const blob = new Blob([bytes], { type: "image/gif" });
      const file = new File([blob], "drawesome-timelapse.gif", { type: "image/gif" });
      const shareData = {
        files: [file],
        title: "Watch my drawing come together! 🎨",
        text: "I made this on Drawesome — watch it draw itself!",
        url: `${window.location.origin}/join/${roomId}`,
      };
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share(shareData);
        setStatus("Shared your timelapse! 🎉");
      } else {
        // Desktop / unsupported: download the GIF so it can still be shared.
        downloadBlob(blob, `drawesome-timelapse-${Date.now()}.gif`);
        setStatus("Saved your timelapse GIF — share it anywhere!");
      }
    } catch (err) {
      // AbortError = the user dismissed the share sheet; not a failure.
      if (err?.name !== "AbortError") setStatus("Couldn't make the timelapse — try again");
    } finally {
      setIsExportingTimelapse(false);
    }
  }, [encodeTimelapseBytes, isExportingTimelapse, roomId]);

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
      // 200x125 keeps the canvas's 8:5 ratio (200x150 squashed the art).
      const canvas = compositeFrameToCanvas(frame, { width: 200, height: 125 });
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
      if (roomAnimationRef.current) {
        setStatus("Remix in a drawing room — this room is a shared animation");
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
      setActiveBrushRecipe(null);
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
    async (recipe) => {
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
      if (settings.dab?.shape === "stamp") {
        setStatus("Loading brush tip...");
        const ready = await preloadBrushStamp(settings.dab);
        if (!ready) {
          setStatus("Couldn't load that brush tip");
          return;
        }
        setActiveBrushRecipe(recipe);
      } else {
        setActiveBrushRecipe(null);
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

  const handleSaveImportedBrushes = useCallback(
    async (tips, { fileName } = {}) => {
      const baseName = (fileName || "ABR Brushes").replace(/\.[^.]+$/i, "");
      const assets = tips.map((tip, index) => {
        const recipe = {
          baseBrush: "stamp",
          size: 36,
          opacity: 0.9,
          variation: 0.12,
          glow: false,
          textured: true,
          tipDataUrl: tip.tipDataUrl,
          tipId: "",
        };
        const fields = buildBrushAssetFields(recipe, { tags: ["ABR", tip.source || "Photoshop"] });
        return createAsset({
          kind: "brush",
          title: tips.length === 1 ? baseName : `${baseName} ${index + 1}`,
          payload: fields.payload,
          brush_recipe: fields.brush_recipe,
          visibility: fields.visibility,
          moderation_status: fields.moderation_status,
        });
      });
      if (assets.length === 0) {
        return 0;
      }
      if (await persistPaintSpace((current) => [...assets, ...current])) {
        setStatus(`Imported ${assets.length} ABR brush tip${assets.length === 1 ? "" : "s"} to Paint Space`);
        return assets.length;
      }
      return 0;
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
          invalidateMixPrefetch(active); // direct, unmarked layer write
          renderDisplay();
          syncLayerState();
          markChanged("Sticker stamped");
        }
        setShowPaintSpace(false);
        return;
      }

      if (asset.kind === "template") {
        if (roomAnimationRef.current) {
          setStatus("Templates can't replace a shared animation — use them in a drawing room");
          setShowPaintSpace(false);
          return;
        }
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
        // Shared frames are server state now: locally swapping in a saved loop
        // would fork this client from the room. Loop editing returns once
        // "load a loop INTO the shared timeline" exists as a relayed action.
        if (roomAnimationRef.current) {
          setStatus("Saved loops can't be loaded into a shared animation room (yet!)");
          setShowPaintSpace(false);
          return;
        }
        if (framesRef.current.length <= 1 && (asset.payload?.frames || []).length > 1) {
          setStatus("Multi-frame loops need an animation room — try the 🎬 Animation Studio!");
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
    [getActiveLayer, handleApplyBrushRecipe, invalidateMixPrefetch, markChanged, pushHistory, renderDisplay, syncFrameState, syncLayerState],
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
      const applySrc = (src) => {
        const img = new Image();
        img.crossOrigin = "anonymous"; // keep the export canvas untainted
        img.onload = () => {
          const scale = Math.min(CANVAS_WIDTH / img.width, CANVAS_HEIGHT / img.height);
          const w = img.width * scale;
          const h = img.height * scale;
          sheetRectRef.current = { x: (CANVAS_WIDTH - w) / 2, y: (CANVAS_HEIGHT - h) / 2, w, h };
          sheetImageRef.current = img;
          renderDisplay();
        };
        img.src = src;
      };
      // Library sheets (id is "lib:<filename>") are served as a static PNG.
      if (id.startsWith("lib:")) {
        applySrc(`/coloring-sheets/full/${encodeURIComponent(id.slice(4))}.png`);
        return;
      }
      if (id.startsWith("remix:")) {
        const postId = id.slice(6);
        if (/^wp_[a-z0-9]{1,40}$/i.test(postId)) {
          setSheetMode("under");
          applySrc(`/api/wall/${encodeURIComponent(postId)}/frame/0`);
        }
        return;
      }
      // Custom admin uploads AND user trace photos come back as a data URL.
      fetch(`/api/sheets/${id}`, { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.image) applySrc(data.image);
        })
        .catch(() => {});
    },
    [renderDisplay],
  );

  // Trace-a-photo: read a chosen photo, downscale it, run a best-effort NSFW
  // pre-check, then hand it to the server (which host-gates + validates it) as
  // the room's traced underlay. Defaults the overlay to "under" (trace on top).
  const handleTracePhotoFile = useCallback(
    async (file) => {
      if (!file || !file.type.startsWith("image/")) return;
      setTraceBusy(true);
      try {
        // Downscale to a sane max so the WS payload + everyone's decode stay light.
        const bmp = await createImageBitmap(file).catch(() => null);
        if (!bmp) { showToast("Couldn't read that photo — try another."); return; }
        const maxDim = 1400;
        const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
        const w = Math.max(1, Math.round(bmp.width * scale));
        const h = Math.max(1, Math.round(bmp.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
        bmp.close?.();
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        // Best-effort content check before it ever leaves this device. The
        // server host-gate is the real control; this catches obvious mistakes.
        const score = await classifyImageNsfw(dataUrl);
        if (score != null && score >= 0.5) {
          showToast("🚫 That photo can't be used here. Try a different one.");
          return;
        }
        setSheetMode("under"); // a photo is a tracing underlay, not line-art on top
        mpRef.current?.sendTracePhoto?.(dataUrl);
        showToast("📷 Photo added — trace away! Everyone can draw over it.");
      } catch {
        showToast("Couldn't add that photo — try again.");
      } finally {
        setTraceBusy(false);
      }
    },
    [showToast],
  );

  // Remote ops land on the frame they were DRAWN on (op.frameId; untagged =
  // first frame). In non-animation rooms there's only one frame, so this is
  // the classic shared-mural behavior; in animation rooms every frame is
  // shared state and two people can ink different cels simultaneously.
  const frameBaseCtx = useCallback((frame) => {
    const layer = frame?.layers?.[0];
    return layer ? layer.canvas.getContext("2d") : null;
  }, []);

  // Land a remote in-progress stroke on ITS frame's base layer ONCE at its
  // stroke opacity (#62) and forget it — including its last-point entry, which
  // previously leaked one point per stroke forever.
  const commitRemoteStroke = useCallback(
    (strokeId, entry) => {
      if (entry.buf) {
        // Strict resolve: if the stroke's frame raced a delete, drop the
        // buffer rather than smearing it onto whichever frame is first now.
        const frame = entry.frameId
          ? framesRef.current.find((item) => item.id === entry.frameId) || null
          : framesRef.current[0] || null;
        const ctx = frameBaseCtx(frame);
        if (ctx && entry.buf.has()) {
          // Stage-2/3: flush the dab renderer + run the commit passes (wet
          // edge / impasto / paper grain), then the single opacity-stamped
          // commit (legacy strokes: no-op).
          prepareStrokeCommit(entry.buf, entry.renderer, entry.fx);
          entry.buf.commit(ctx, entry.opacity);
          // The wet-mix mirror only tracks the frame on screen.
          if (frame && isActiveFrame(frame)) {
            markMixDirty(frame.layers[0], entry.buf.bounds());
          }
          touchFrame(entry.frameId); // that cel's proxy/thumb are stale
        }
        entry.buf.dispose();
      }
      remoteStrokesRef.current.delete(strokeId);
      remoteStrokeLastRef.current.delete(strokeId);
    },
    [frameBaseCtx, isActiveFrame, markMixDirty, touchFrame],
  );

  // Idle sweep: while any remote stroke is open, check every 2s and commit
  // strokes that stopped receiving points (their end-op was lost — a dropped
  // socket or a legacy client). Clears itself once the map empties.
  const ensureRemoteSweep = useCallback(() => {
    if (remoteSweepRef.current) {
      return;
    }
    remoteSweepRef.current = window.setInterval(() => {
      const strokes = remoteStrokesRef.current;
      const now = Date.now();
      let committed = false;
      for (const [strokeId, entry] of strokes) {
        if (now - entry.lastTouch > REMOTE_STROKE_IDLE_MS) {
          commitRemoteStroke(strokeId, entry);
          committed = true;
        }
      }
      if (strokes.size === 0) {
        window.clearInterval(remoteSweepRef.current);
        remoteSweepRef.current = 0;
      }
      if (committed) {
        nsfwWatcherRef.current?.markDirty();
        scheduleRemoteRender();
      }
    }, 2000);
  }, [commitRemoteStroke, scheduleRemoteRender]);

  // Commit every open remote stroke (history replay leaves legacy strokes —
  // ops with no end marker — open; deleting entries mid-iteration is safe).
  const commitAllRemoteStrokes = useCallback(() => {
    for (const [strokeId, entry] of remoteStrokesRef.current) {
      commitRemoteStroke(strokeId, entry);
    }
  }, [commitRemoteStroke]);

  // Apply one remote op onto the shared mural. `draw` ops carry incremental points
  // keyed by strokeId (we connect consecutive points per stroke); `shape` / `text`
  // / `image` are one-shot. Non-eraser draw ops build in a per-stroke buffer and
  // land on the base layer at their end-op (uniform stroke opacity, #62).
  const applyRemoteOp = useCallback(
    (op) => {
      if (!op) {
        return;
      }
      // Route the op to ITS frame (op.frameId; untagged = first frame). Ops
      // for a frame that no longer exists (raced a delete) are dropped —
      // resolveOpFrame only falls back for untagged legacy ops.
      const frame = op.frameId
        ? framesRef.current.find((item) => item.id === op.frameId) || null
        : framesRef.current[0] || null;
      const ctx = frameBaseCtx(frame);
      if (!frame || !ctx) {
        return;
      }
      if (op.kind === "draw") {
        const strokes = remoteStrokesRef.current;
        let entry = strokes.get(op.strokeId);
        const settings = op.settings || entry?.settings || {};
        const opSymmetry = normalizeSymmetry(settings.symmetry || "none");
        if (!op.symmetryExpanded && opSymmetry.copies > 1) {
          const paths = transformPointsBySymmetry(op.points || [], opSymmetry, CANVAS_WIDTH, CANVAS_HEIGHT);
          paths.forEach((points, copyIndex) => {
            applyRemoteOpRef.current?.({
              ...op,
              strokeId: `${op.strokeId}:sym${copyIndex}`,
              points,
              settings: { ...settings, symmetry: normalizeSymmetry("none") },
              symmetryExpanded: true,
            });
          });
          return;
        }
        if (!op.settings && !entry) {
          const queued = remoteStampQueueRef.current.get(op.strokeId);
          if (queued) {
            queued.ops.push(op);
          }
          return;
        }
        const pendingDab = settings.v >= 3 ? getStrokeDab(settings) : null;
        if (pendingDab?.shape === "stamp" && !isBrushStampReady(pendingDab)) {
          let queued = remoteStampQueueRef.current.get(op.strokeId);
          if (!queued) {
            queued = { ops: [], loading: false };
            remoteStampQueueRef.current.set(op.strokeId, queued);
          }
          queued.ops.push(op);
          if (!queued.loading) {
            queued.loading = true;
            preloadBrushStamp(pendingDab).then((ok) => {
              const readyQueue = remoteStampQueueRef.current.get(op.strokeId);
              remoteStampQueueRef.current.delete(op.strokeId);
              if (!ok || !readyQueue) {
                return;
              }
              for (const queuedOp of readyQueue.ops) {
                applyRemoteOpRef.current?.(queuedOp);
              }
              scheduleRemoteRender();
            });
          }
          return;
        }
        const lastMap = remoteStrokeLastRef.current;
        let last = lastMap.get(op.strokeId);
        if (settings.brush === "eraser") {
          // Erasing must keep cutting the real layer live (a buffered
          // destination-out can't preview holes through committed art).
          for (const point of op.points || []) {
            drawBrushSegment(ctx, last || point, point, settings);
            last = point;
          }
          invalidateMixPrefetch(frame.layers[0]); // direct, unmarked layer-0 write
          touchFrame(frame.id); // pixels landed directly — proxy/thumb are stale
          if (op.end) {
            lastMap.delete(op.strokeId);
          } else {
            lastMap.set(op.strokeId, last);
          }
          return;
        }
        if (settings.brush === "smudge") {
          // Ignore smudge in public rooms (the server drops these too — this
          // is belt-and-braces against a hacked/stale client). The finger-
          // paint room is the exception: smearing is the whole toy there.
          if (roomAudienceRef.current === "kid_safe" && !roomFingerPaintRef.current) {
            return;
          }
          // Legacy smudge ops (no `v`) edit LAYER 0 directly — no stroke
          // buffer; everyone replays them against layer 0 in server op
          // order, so history replay is deterministic and live overlap
          // divergence self-heals on the next history frame. v3 ops (Stage
          // 4) fall through to the buffered path below like every brush:
          // makeStrokeEntryCore builds their drag / blend renderer over this
          // frame's layer 0 (smudgeSource) and the buffer commits there —
          // the same normalizer decides in every consumer.
          if (!normalizeSmudgeSettings(settings).v3) {
            const strokes = remoteStrokesRef.current;
            let entry = strokes.get(op.strokeId);
            if (!entry) {
              entry = {
                buf: null, // nothing to buffer / commit — end just cleans up
                opacity: 1,
                lastTouch: 0,
                renderer: null,
                fx: null,
                frameId: frame.id,
                smudge: makeSmudgeRenderer(settings, ctx.canvas),
              };
              strokes.set(op.strokeId, entry);
              ensureRemoteSweep();
            }
            entry.lastTouch = Date.now();
            for (const point of op.points || []) {
              entry.smudge.addPoints(ctx, [point]); // one at a time — batching-proof
            }
            invalidateMixPrefetch(frame.layers[0]); // direct, unmarked layer-0 write
            touchFrame(frame.id); // smudge drags layer 0 directly — proxy/thumb stale
            if (op.end) {
              commitRemoteStroke(op.strokeId, entry); // buf is null: pure cleanup
            }
            return;
          }
        }
        if (!entry) {
          let buffered = 0;
          for (const open of strokes.values()) {
            if (open.buf) {
              buffered += 1;
            }
          }
          // The shared entry core (buffer / dab renderer / commit passes / pad
          // / opacity / commit composite) — the same builder the local stroke
          // and opReplay start from, so nothing is decided differently here.
          // Past the cap (buffered: false) the stroke is flagged (buf: null)
          // onto the legacy direct per-segment path — its end-op then has
          // nothing to commit. Null = a v3 op whose inline dab can't render.
          const core = makeStrokeEntryCore(settings, sampleMix, { buffered: buffered < REMOTE_BUFFER_CAP, smudgeSource: ctx.canvas });
          if (!core) {
            return;
          }
          entry = {
            ...core,
            settings,
            lastTouch: 0,
            frameId: frame.id, // the stroke's home frame — commit + overlays use it
          };
          strokes.set(op.strokeId, entry);
          ensureRemoteSweep();
        }
        entry.lastTouch = Date.now();
        const seeded = settings.seed != null; // legacy ops carry no seed
        if (entry.buf) {
          for (const point of op.points || []) {
            if (entry.buf.ensure(point.x, point.y, entry.pad).overflow) {
              // Outgrew the 2048² cap: bank the buffer into the layer and
              // restart it here (rare, visually-minor opacity seam). Commit
              // passes run per chunk; final = false keeps the dab walk
              // state alive across the restart (no end()) and restarts the
              // renderer's ink bbox with the buffer.
              prepareStrokeCommit(entry.buf, entry.renderer, entry.fx, false);
              entry.buf.commit(ctx, entry.opacity);
              if (isActiveFrame(frame)) {
                markMixDirty(frame.layers[0], entry.buf.bounds());
              }
              touchFrame(frame.id); // chunk banked into the layer early
              entry.buf.reset();
              entry.buf.ensure(point.x, point.y, entry.pad);
            }
            if (entry.renderer) {
              // One point at a time so batch boundaries can never matter.
              entry.renderer.addPoints(entry.buf.getCtx(), [point], entry.buf.base());
            } else {
              drawBrushSegment(entry.buf.getCtx(), last || point, point, entry.drawSettings, seeded ? pointRand(settings.seed, point.x, point.y) : Math.random);
            }
            last = point;
          }
        } else if (!entry.skip) {
          for (const point of op.points || []) {
            drawBrushSegment(ctx, last || point, point, settings, seeded ? pointRand(settings.seed, point.x, point.y) : Math.random);
            last = point;
          }
          invalidateMixPrefetch(frame.layers[0]); // direct, unmarked layer-0 write
          touchFrame(frame.id); // over-cap legacy path draws the layer directly
        }
        if (op.end) {
          commitRemoteStroke(op.strokeId, entry);
        } else {
          lastMap.set(op.strokeId, last);
        }
      } else if (op.kind === "shape") {
        drawShape(ctx, op.tool, op.start, op.end, op.opts || {});
        invalidateMixPrefetch(frame.layers[0]); // direct, unmarked layer-0 write
        touchFrame(frame.id);
      } else if (op.kind === "text") {
        drawText(ctx, op.point, op.text, op.opts || {});
        invalidateMixPrefetch(frame.layers[0]); // direct, unmarked layer-0 write
        touchFrame(frame.id);
      } else if (op.kind === "image" && op.dataUrl) {
        const image = new Image();
        // Track the decode: a scene hydration (and the film exporter waiting
        // on it) isn't complete until embedded images have actually landed.
        const settled = new Promise((resolve) => {
          image.onload = () => {
            ctx.drawImage(image, op.x, op.y, op.w, op.h);
            touchFrame(frame.id);
            if (isActiveFrame(frame)) {
              markMixDirty(frame.layers[0], { x0: op.x, y0: op.y, w: op.w, h: op.h });
              renderDisplay();
            }
            resolve();
          };
          image.onerror = () => resolve();
        });
        pendingAssetLoadsRef.current.push(settled);
        image.src = op.dataUrl;
      }
    },
    [commitRemoteStroke, ensureRemoteSweep, frameBaseCtx, invalidateMixPrefetch, isActiveFrame, markMixDirty, renderDisplay, sampleMix, scheduleRemoteRender, touchFrame],
  );

  useEffect(() => {
    applyRemoteOpRef.current = applyRemoteOp;
  }, [applyRemoteOp]);

  // Buffers are transient: drop the idle sweep and every open stroke buffer
  // (local + remote) when the studio unmounts (room hop / route change).
  useEffect(
    () => () => {
      if (remoteSweepRef.current) {
        window.clearInterval(remoteSweepRef.current);
        remoteSweepRef.current = 0;
      }
      for (const entry of remoteStrokesRef.current.values()) {
        entry.buf?.dispose();
      }
      remoteStrokesRef.current.clear();
      remoteStampQueueRef.current.clear();
      localStrokeRef.current?.buf?.dispose();
      for (const copy of localStrokeRef.current?.copies || []) copy.buf?.dispose();
      localStrokeRef.current = null;
      releaseBrushSprites(); // sprite atlases / tint ring: rebuilt lazily by the next studio
    },
    [],
  );

  const handleMpMessage = useCallback(
    (data) => {
      switch (data.type) {
        case "connected": {
          myUserIdRef.current = data.userId;
          // Re-apply a saved name/colour so the artist keeps their identity
          // across reconnects (and eventually, sign-in).
          const saved = profileRef.current;
          if (saved?.name && saved.name !== data.userName) {
            mpRef.current?.sendRename?.(saved.name, saved.color);
          }
          // Does this room have the film strip? (FLIPBOOK, or a private room
          // whose host enabled it.) Frames arrive in the history frame next.
          roomAnimationRef.current = !!data.animation;
          setRoomAnimation(!!data.animation);
          productionRef.current = data.production || null;
          setProduction(data.production || null);
          // Learn our ownership/host standing for this room from the server.
          isRoomHostRef.current = !!data.isHost;
          setIsRoomHost(!!data.isHost);
          setIsRoomOwner(!!data.isOwner);
          setRoomLocked(!!data.locked);
          setRoomTitle(data.roomTitle || null);
          // Today's drawing prompt for this room (public prompt rooms / the
          // last theme-vote winner).
          setRoomPrompt(data.prompt || null);
          // Wet-canvas state + any theme vote already running ride the
          // handshake, so late joiners (and reconnects) sync both.
          roomWetRef.current = !!data.wetCanvas;
          setRoomWet(!!data.wetCanvas);
          roomSymmetryRef.current = normalizeSymmetry(data.symmetry || "none");
          setRoomSymmetry(roomSymmetryRef.current);
          setRoomOrchestra(!!data.orchestra);
          setRoomQuest(data.quests || null);
          setStorybook(data.storybook || null);
          setRemixSource(data.remixSource || null);
          setRoomVote(data.vote ? { options: data.vote.options || [], endsAt: data.vote.endsAt || 0, counts: data.vote.counts || [0, 0, 0], myChoice: null } : null);
          // Remember this room (with its friendly title) so it shows up under
          // "Your rooms" in the switcher for quick hopping back — plus the
          // mention-watch capability (our name here + the server-issued key)
          // so the notify socket can subscribe to @mentions later.
          recordRecentRoom(
            roomId,
            data.roomTitle || null,
            Date.now(),
            data.mentionKey ? { name: data.userName, key: data.mentionKey } : undefined,
          );
          // Mute is re-applied by the server on (re)connect for signed-in users,
          // so trust the handshake rather than optimistically clearing it.
          setMutedSelf(!!data.muted);
          roomAudienceRef.current = data.audience || null;
          setRoomAudience(data.audience || null);
          roomFingerPaintRef.current = !!data.fingerPaint;
          setRoomFingerPaint(!!data.fingerPaint);
          // Draw & Guess room? Reset any stale round from a previous room; the
          // live game_state (if a round is running) arrives right after.
          roomGameRef.current = !!data.game;
          setRoomGame(!!data.game);
          gameRef.current = null;
          setGame(null);
          setMyWord(null);
          setRoomWipe(data.wipe || null);
          setWipePanelOpen(false);
          // Draw Phone room? Reset any stale telephone state from a prior room;
          // the live phone_state / phone_task (if any) arrive right after.
          roomPhoneRef.current = !!data.phone;
          setRoomPhone(!!data.phone);
          phoneRef.current = null;
          setPhone(null);
          phoneTaskRef.current = null;
          setPhoneTask(null);
          setPhoneSubmitted(false);
          setPhoneGuess("");
          setPhoneReveal(null);
          if (data.fingerPaint) {
            // Toddler room: land on a big wet paint brush, fingers-first.
            setSelectedTool("brush");
            setSelectedBrush((prev) => (FINGER_PAINT_BRUSHES.has(prev) ? prev : "paint"));
            setBrushSize((prev) => Math.max(prev, 56));
          } else if (data.audience === "kid_safe") {
            // Public rooms are brush-only (fill/shape/text hidden) — snap back
            // if one of the hidden tools was selected before the audience arrived.
            setSelectedTool((prev) => (prev === "brush" ? prev : "brush"));
            // Private-only brushes (smudge) fall back too (a restored draft
            // could carry one into a public room before the audience arrived).
            setSelectedBrush((prev) => (brushCatalog.find((b) => b.id === prev)?.privateOnly ? "marker" : prev));
          }
          // Offer to be a watcher in EVERY room (the server elects who scans).
          // Private rooms elect watchers too now — a flag there goes to the
          // room's host instead of nobody (the audit's biggest gap).
          if (isWatcherCapable()) {
            mpRef.current?.sendWatcherAck?.(true);
          }
          break;
        }
        case "room_state":
          setRoomLocked(!!data.locked);
          setStatus(data.locked ? "🔒 A host locked the canvas" : "🔓 Canvas unlocked");
          break;
        case "room_renamed":
          setRoomTitle(data.title || null);
          break;
        case "role_changed":
          isRoomHostRef.current = !!data.isHost;
          setIsRoomHost(!!data.isHost);
          if (data.isHost) setStatus("⭐ You're a co-host now");
          break;
        case "muted":
          setMutedSelf(!!data.muted);
          setStatus(data.muted ? "🔇 A host muted you in chat" : "🔈 You can chat again");
          break;
        case "kicked":
          // Tear the socket down for good so the auto-reconnect can't slip us
          // back into the room a second later.
          mpRef.current?.disconnect?.();
          setKicked(true);
          break;
        case "history": {
          // The server's history (even when empty) is the authoritative shared
          // state — local drafts never auto-restore over it. `frames` rides
          // along: the whole flipbook rebuilds, so leaving and coming back
          // shows everything friends did in the meantime (Google-Docs model).
          const incomingOps = data.ops || [];
          // Scene bookkeeping: a history frame may be one SCENE's slice of the
          // film (join, page, resync). Track which scene we now hold.
          if (data.scenes) {
            scenesRef.current = data.scenes;
            setScenes(data.scenes);
          }
          if (data.sceneId) {
            activeSceneIdRef.current = data.sceneId;
            setActiveSceneId(data.sceneId);
          }
          if (data.frames) {
            reconcileFrames(data.frames);
          }
          // Rebuild EVERY frame from a clean slate (join, moderation rebuilds,
          // undo-clear restores). Open live buffers are stale — the replay
          // re-delivers their points.
          framesRef.current.forEach((frame) =>
            frame.layers.forEach((layer) => layer.canvas.getContext("2d").clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)),
          );
          dropRemoteStrokes();
          remoteStrokeLastRef.current.clear();
          // Only a BUFFERED local stroke is skipped below; an in-flight eraser
          // has no buffer, so the replayed copy is its only restoration.
          const liveLocalStrokeId = localStrokeRef.current ? strokeNetRef.current?.id : null;
          incomingOps.forEach((op) => {
            // Our OWN in-flight stroke echoes back in the history; skip it —
            // its single source of truth is the local buffer, which commits at
            // pen-up (replaying it too would double-composite the overlap).
            if (!(op?.kind === "draw" && liveLocalStrokeId && op.strokeId === liveLocalStrokeId)) {
              applyRemoteOp(op);
            }
            if (typeof op?.opId === "number" && op.opId > lastOpIdRef.current) lastOpIdRef.current = op.opId;
          });
          // Replayed strokes with no end marker (legacy clients, strokes cut
          // off by the snapshot) stay open above — commit them all now.
          commitAllRemoteStrokes();
          // Every cel was rebuilt wholesale: stale-mark all proxies + thumbs.
          framesRef.current.forEach((frame) => touchFrame(frame.id));
          nsfwWatcherRef.current?.markDirty();
          // The active frame's layer 0 was rebuilt — re-mirror the wet-mix map
          // on its next sample, and repaint the visible composite.
          mixMapRef.current?.markAllDirty();
          renderDisplay();
          if (data.restored) {
            setClearBanner(null);
            setStatus("Canvas brought back 🎉");
          }
          // Now that a scene is hydrated (join or scene-switch), let the crew
          // know which cel we're parked on so their pips include us.
          announcePresence();
          // Wake anything awaiting this scene's hydration (export stitching) —
          // but only after embedded image ops finish decoding, or the exporter
          // would encode frames whose pictures haven't landed yet.
          if (data.sceneId) {
            const waiters = sceneWaitersRef.current.get(data.sceneId);
            if (waiters) {
              sceneWaitersRef.current.delete(data.sceneId);
              const pendingLoads = pendingAssetLoadsRef.current.splice(0);
              Promise.allSettled(pendingLoads).then(() => {
                renderDisplay();
                waiters.forEach((resolve) => resolve());
              });
            }
          }
          break;
        }
        case "resync": {
          // Shared history changed in a way that can't be patched incrementally
          // (moderation hide/restore, undo-clear) — refetch OUR scene. If a
          // scene SWITCH is already in flight, refetch its target instead:
          // re-requesting the old scene would answer LAST and revert the hop.
          if (roomAnimationRef.current) {
            const pending = [...sceneWaitersRef.current.keys()];
            const target = pending.length ? pending[pending.length - 1] : activeSceneIdRef.current;
            if (target) {
              mpRef.current?.sendSceneFetch?.(target);
            }
          }
          if (data.restored) {
            setClearBanner(null);
            setStatus("Canvas brought back 🎉");
          }
          break;
        }
        case "scene_add": {
          if (data.scenes) {
            scenesRef.current = data.scenes;
            setScenes(data.scenes);
          }
          if (data.byUserId === myUserIdRef.current && data.scene?.id) {
            switchScene(data.scene.id); // the host lands in their new scene
          }
          break;
        }
        case "scene_del": {
          if (data.scenes) {
            scenesRef.current = data.scenes;
            setScenes(data.scenes);
          }
          if (data.sceneId === activeSceneIdRef.current) {
            // Our scene was deleted under us — hop to the first surviving one.
            const fallback = (data.scenes || [])[0];
            if (fallback) {
              activeSceneIdRef.current = null; // force the switch
              switchScene(fallback.id);
            }
          }
          break;
        }
        case "production_state": {
          const previous = productionRef.current;
          productionRef.current = data.production || null;
          setProduction(data.production || null);
          // A new part opening is a MOMENT — announce it to the whole crew.
          if (data.production && previous && data.production.segments.length > previous.segments.length) {
            const newest = data.production.segments[data.production.segments.length - 1];
            showToast(`🎬 ${newest.title} is open — places, everyone!`);
          } else if (data.production && !previous) {
            showToast(`🎬 "${data.production.title}" is now in production!`);
            // Only the host who started it gets the storyboard flung open —
            // everyone else keeps painting and can open it from the strip.
            if (isRoomHostRef.current) setShowStoryboard(true);
          }
          break;
        }
        case "op": {
          if (roomOrchestra && data.op?.kind === "draw" && data.op.points?.length) {
            const point = data.op.points[data.op.points.length - 1];
            orchestraRef.current?.playStroke({
              x: point.x / CANVAS_WIDTH,
              y: point.y / CANVAS_HEIGHT,
              velocity: 0.45,
              pressure: point.pressure,
              brushId: data.op.settings?.brush || "marker",
              sourceId: data.op.userId || "remote",
            });
          }
          applyRemoteOp(data.op);
          if (typeof data.op?.opId === "number" && data.op.opId > lastOpIdRef.current) {
            lastOpIdRef.current = data.op.opId;
          }
          nsfwWatcherRef.current?.markDirty();
          // Repainting only matters if the op's frame is on screen.
          // Mid-local-stroke, reuse the cheap stroke compositor; otherwise a
          // rAF-coalesced full recomposite.
          const opFrameIdIn = data.op?.frameId || framesRef.current[0]?.id;
          if (opFrameIdIn === framesRef.current[activeFrameIndexRef.current]?.id) {
            if (activePointerRef.current != null) {
              scheduleStrokeFrame();
            } else {
              scheduleRemoteRender();
            }
          }
          break;
        }
        case "symmetry_state":
          roomSymmetryRef.current = normalizeSymmetry(data.symmetry || "none");
          setRoomSymmetry(roomSymmetryRef.current);
          showToast(`🌀 Symmetry: ${roomSymmetryRef.current.mode}`);
          break;
        case "quest_state":
          setRoomQuest(data.quest || null);
          if (data.justCompleted) {
            earnQuestDropsRef.current?.(data.quest?.setId, data.justCompleted);
            showToast("🧭 Quest complete! Everyone earned 3 play Drops.");
          }
          break;
        case "storybook_state":
          setStorybook(data.storybook || null);
          if (data.scenes) {
            scenesRef.current = data.scenes;
            setScenes(data.scenes);
          }
          break;
        case "storybook_rejected":
          showToast("That caption needs a kinder rewrite.");
          break;
        case "clear": {
          // A room clear wipes the shared frame it names. Without a frameId it
          // is a FULL wipe: every frame in an animation room (admin clears the
          // whole movie), just the first frame elsewhere (frames 2+ shouldn't
          // exist there, but never nuke a local flipbook by accident).
          const clearedFrames = data.frameId
            ? framesRef.current.filter((frame) => frame.id === data.frameId)
            : roomAnimationRef.current
              ? [...framesRef.current]
              : framesRef.current.slice(0, 1);
          if (!clearedFrames.length) {
            break;
          }
          const clearedIds = new Set(clearedFrames.map((frame) => frame.id));
          clearedFrames.forEach((frame) =>
            frame.layers.forEach((layer) => layer.canvas.getContext("2d").clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)),
          );
          // In-progress remote strokes on cleared frames are wiped with them;
          // strokes on surviving frames keep buffering. A live LOCAL stroke
          // keeps drawing — only its pre-clear part drops.
          for (const [sid, entry] of [...remoteStrokesRef.current]) {
            if (clearedIds.has(entry.frameId || framesRef.current[0]?.id)) {
              entry.buf?.dispose();
              remoteStrokesRef.current.delete(sid);
              remoteStrokeLastRef.current.delete(sid);
            }
          }
          clearedFrames.forEach((frame) => touchFrame(frame.id));
          if (clearedFrames.some((frame) => isActiveFrame(frame))) {
            mixMapRef.current?.clear(); // layer 0 is blank — empty the wet-mix mirror
            // The in-progress local stroke loses what it painted so far: drop
            // the buffer(s) (a symmetry stroke keeps one per copy — `buf` is
            // on the copies, not the shared entry) and the renderer's ink
            // bbox with them, so the commit passes at pen-up cover only what
            // gets painted from here on.
            const local = localStrokeRef.current;
            if (local) {
              for (const entry of local.copies || [local]) {
                entry.buf.reset();
                entry.renderer?.resetInk();
              }
            }
            renderDisplay();
            refreshActiveThumbnail();
          }
          // A Draw & Guess round clears the canvas every turn — that's expected,
          // so skip the "Someone cleared" banner (the HUD already narrates it).
          if (data.wipeRefresh) {
            // Not blame-worthy and not a surprise — say what happened, which
            // also covers FINGERS, where there's no chat to read it in.
            showToast("🧽 Fresh canvas! This room starts over every 3 days.");
          } else if (!data.gameRound) {
            showClearBanner(data.name || "Someone");
          }
          break;
        }
        // Private-room host toggled Draw & Guess on/off.
        case "room_game": {
          roomGameRef.current = !!data.enabled;
          setRoomGame(!!data.enabled);
          if (!data.enabled) { gameRef.current = null; setGame(null); setMyWord(null); }
          break;
        }
        case "room_phone": {
          roomPhoneRef.current = !!data.enabled;
          setRoomPhone(!!data.enabled);
          if (!data.enabled) {
            phoneRef.current = null; setPhone(null);
            phoneTaskRef.current = null; setPhoneTask(null);
            setPhoneSubmitted(false); setPhoneGuess(""); setPhoneReveal(null);
          }
          break;
        }
        // ---- Shared animation frames (server-ordered; echoed to sender too) --
        case "room_animation": {
          roomAnimationRef.current = !!data.enabled;
          setRoomAnimation(!!data.enabled);
          if (!data.enabled) {
            // The strip is about to unmount: stop anything it was driving, or
            // a live scrub leaves renderDisplay suppressed forever and a rAF
            // playback loop keeps running with no pause control.
            const scrub = scrubStateRef.current;
            const wasScrubbing = scrub.active;
            scrub.active = false;
            if (scrub.raf) {
              window.cancelAnimationFrame(scrub.raf);
              scrub.raf = 0;
            }
            if (playTimerRef.current) {
              stopPlayback();
            }
            if (activeFrameIndexRef.current !== 0) {
              activateFrame(0); // land back on the visible frame
            } else if (wasScrubbing) {
              renderDisplay(); // the doc canvas still holds the scrub preview
            }
          }
          showToast(data.enabled ? "🎬 Animation ON — film strip unlocked!" : "🎬 Animation off");
          break;
        }
        case "frame_add": {
          if (!data.frame?.id) break;
          if (data.scenes) {
            scenesRef.current = data.scenes;
            setScenes(data.scenes);
          }
          // A frame added to a scene we're NOT viewing only updates the pager
          // meta — its canvas hydrates when we page there.
          if (data.sceneId && roomAnimationRef.current && data.sceneId !== activeSceneIdRef.current) {
            break;
          }
          commitLayersToFrame();
          const afterIndex = data.afterFrameId ? framesRef.current.findIndex((f) => f.id === data.afterFrameId) : framesRef.current.length - 1;
          const frame = createFrame({ layers: createDefaultLayers(), durationMs: data.frame.durationMs || DEFAULT_FRAME_DURATION });
          frame.id = data.frame.id; // server ids are canonical
          if (data.duplicateOf) {
            // Pixel-clone the source's visible composite; the server copied the
            // ops, so rejoiners replay to the same pixels (deterministic engine).
            commitAllRemoteStrokes();
            const source = framesRef.current.find((f) => f.id === data.duplicateOf);
            if (source) {
              frame.layers[0].canvas.getContext("2d").drawImage(compositeFrameToCanvas(source), 0, 0);
            }
          }
          const insertIndex = afterIndex >= 0 ? afterIndex + 1 : framesRef.current.length;
          framesRef.current.splice(insertIndex, 0, frame);
          if (data.byUserId === myUserIdRef.current) {
            activateFrame(framesRef.current.indexOf(frame)); // the actor lands on their new frame
            announcePresence(); // ...and tells the crew they're on the new cel
          } else if (insertIndex <= activeFrameIndexRef.current) {
            // Someone inserted before our spot — keep pointing at OUR frame or
            // every subsequent local op mistags onto a neighbour.
            activeFrameIndexRef.current += 1;
          }
          // activateFrame doesn't mirror the frame LIST into React — always sync.
          syncFrameState();
          break;
        }
        case "frame_del": {
          if (data.scenes) {
            scenesRef.current = data.scenes;
            setScenes(data.scenes);
          }
          if (data.sceneId && roomAnimationRef.current && data.sceneId !== activeSceneIdRef.current) {
            break; // another scene's frame — meta update only
          }
          const delIndex = framesRef.current.findIndex((f) => f.id === data.frameId);
          if (delIndex < 0 || framesRef.current.length <= 1) break;
          const wasActive = delIndex === activeFrameIndexRef.current;
          if (wasActive) {
            // Terminate any in-flight stroke while the index still points at
            // the dying frame — the end marker goes out tagged with its id
            // (harmlessly rejected server-side) instead of a neighbour's.
            abortActiveStroke();
          }
          framesRef.current.splice(delIndex, 1);
          onionCacheRef.current.delete(data.frameId);
          if (wasActive) {
            activateFrame(Math.max(0, delIndex - 1));
            announcePresence(); // our cel changed under us — re-announce
          } else if (activeFrameIndexRef.current > delIndex) {
            activeFrameIndexRef.current -= 1;
          }
          // activateFrame doesn't mirror the frame LIST into React — always sync.
          syncFrameState();
          break;
        }
        case "frame_move": {
          if (data.scenes) {
            scenesRef.current = data.scenes;
            setScenes(data.scenes);
          }
          if (data.sceneId && roomAnimationRef.current && data.sceneId !== activeSceneIdRef.current) {
            break; // another scene's ordering — meta update only
          }
          const fromIndex = framesRef.current.findIndex((f) => f.id === data.frameId);
          if (fromIndex < 0) break;
          commitLayersToFrame();
          const activeId = framesRef.current[activeFrameIndexRef.current]?.id;
          const [moved] = framesRef.current.splice(fromIndex, 1);
          framesRef.current.splice(Math.max(0, Math.min(framesRef.current.length, data.toIndex)), 0, moved);
          const keptIndex = framesRef.current.findIndex((f) => f.id === activeId);
          if (keptIndex >= 0) activeFrameIndexRef.current = keptIndex;
          syncFrameState();
          break;
        }
        case "frame_duration": {
          if (data.scenes) {
            scenesRef.current = data.scenes;
            setScenes(data.scenes);
          }
          const durFrame = framesRef.current.find((f) => f.id === data.frameId);
          if (!durFrame) break; // another scene's frame — meta update only
          durFrame.durationMs = data.durationMs;
          setFrames(framesRef.current.map((item) => ({ id: item.id, durationMs: item.durationMs })));
          break;
        }
        case "frame_full":
          setStatus("🎞️ This frame is full — start the next one!");
          break;
        case "frame_denied":
          setStatus(data.reason || "Can't add more frames here");
          break;
        case "sheet":
          setSheetId(data.sheetId || null);
          loadSheetImage(data.sheetId || null);
          // A newly-set underlay (esp. a user trace photo) becomes part of the
          // composited canvas — nudge the ambient NSFW watcher to sample it.
          nsfwWatcherRef.current?.markDirty();
          break;
        case "trace_rejected":
          // Server refused the uploaded photo (not a valid image, or too big).
          setTraceBusy(false);
          showToast("Couldn't add that photo — try a different one.");
          break;
        case "cursor":
          if (hiddenPaintersRef.current.has(data.userId)) break; // locally hidden painter
          remoteCursorsRef.current.set(data.userId, {
            x: data.x,
            y: data.y,
            name: data.name,
            color: data.color,
            drawing: data.drawing,
            ts: Date.now(),
          });
          userPosRef.current.set(data.userId, { x: data.x, y: data.y, name: data.name, ts: Date.now() });
          break;
        case "cursor_leave":
        case "userLeft":
          if (data.userId) {
            remoteCursorsRef.current.delete(data.userId);
            userPosRef.current.delete(data.userId); // bound growth: drop their saved position too
            if (crewPresenceRef.current.delete(data.userId)) {
              publishCrewPresence(); // their cel-pip vanishes with them
            }
          }
          break;
        case "frame_presence":
          // A teammate moved to a cel (cold path). Overwrites their single
          // entry (Map keyed by userId → self-heals on hop); pips re-derive.
          if (data.userId) {
            crewPresenceRef.current.set(data.userId, {
              sceneId: data.sceneId || null,
              frameId: data.frameId || null,
              name: data.name,
              color: data.color,
              ts: Date.now(),
            });
            publishCrewPresence();
          }
          break;
        case "presence_snapshot":
          // Join catch-up: where everyone already is. Seed all at once.
          for (const p of data.entries || []) {
            crewPresenceRef.current.set(p.userId, {
              sceneId: p.sceneId || null,
              frameId: p.frameId || null,
              name: p.name,
              color: p.color,
              ts: Date.now(),
            });
          }
          publishCrewPresence();
          break;
        case "beacon": {
          // "Come look at my frame!" — a friendly, tappable summon (never a
          // forced view-yank). Lands the tapper on the exact Part+scene+frame.
          if (hiddenPaintersRef.current.has(data.fromUserId)) break; // locally hidden painter
          const target = { roomCode: data.roomCode, sceneId: data.sceneId, frameId: data.frameId };
          showBeacon(data.name || "A friend", data.color, target);
          break;
        }
        case "cheer": {
          // Confetti pops on a cel — echoed to the cheerer too. Auto-removed.
          if (!data.frameId || !data.emoji) break;
          const cid = `ch${Date.now()}_${(cheerIdRef.current += 1)}`;
          setCheers((list) => [...list.slice(-11), { id: cid, frameId: data.frameId, emoji: data.emoji }]);
          window.setTimeout(() => setCheers((list) => list.filter((c) => c.id !== cid)), 1600);
          break;
        }
        // ---- Draw & Guess ------------------------------------------------
        case "game_state": {
          // The public round snapshot (never carries the word). null = stopped.
          gameRef.current = data.game || null;
          setGame(data.game || null);
          if (!data.game || data.game.drawerId !== myUserIdRef.current) {
            setMyWord(null); // I'm not the drawer (or the game ended)
          }
          break;
        }
        case "game_role": {
          // Delivered to ME only: the secret word if I'm this round's drawer.
          setMyWord(data.role === "drawer" ? data.word || null : null);
          break;
        }
        case "game_correct": {
          // Someone (maybe me) guessed it — celebratory pop + a confetti burst.
          const mine = data.userId === myUserIdRef.current;
          setGamePop({ kind: "correct", name: mine ? "You" : data.name, points: data.points, mine });
          window.clearTimeout(gamePopTimer.current);
          gamePopTimer.current = window.setTimeout(() => setGamePop(null), 2600);
          break;
        }
        case "game_end": {
          // Round over — reveal the word for the intermission, drop my drawer word.
          setMyWord(null);
          setGamePop({ kind: "reveal", word: data.word });
          window.clearTimeout(gamePopTimer.current);
          gamePopTimer.current = window.setTimeout(() => setGamePop(null), 4200);
          break;
        }
        case "game_spoiler":
          showToast("🤫 No spoilers — you already know the word!");
          break;
        case "game_podium": {
          // Match over — celebrate the top three, then get out of the way
          // before the next match's first round begins.
          setGamePodium({ standings: data.standings || [], rounds: data.rounds || 0 });
          window.clearTimeout(gamePodiumTimer.current);
          gamePodiumTimer.current = window.setTimeout(() => setGamePodium(null), 9500);
          break;
        }
        // ---- Draw Phone (telephone) ----------------------------------------
        case "phone_state": {
          // Public game snapshot (phase/round/roster/timer) — no page contents.
          phoneRef.current = data.phone || null;
          setPhone(data.phone || null);
          if (!data.phone) {
            phoneTaskRef.current = null; setPhoneTask(null);
            setPhoneReveal(null); setPhoneSubmitted(false);
          } else if (data.phone.phase !== "reveal") {
            // Any non-reveal phase means the reveal is over — clear it so a
            // spectator (who never gets a phone_task) isn't stuck behind the
            // previous game's full-screen reveal for the whole next game.
            setPhoneReveal(null);
            if (data.phone.phase === "waiting") { phoneTaskRef.current = null; setPhoneTask(null); }
          }
          break;
        }
        case "phone_task": {
          // Delivered to ME only: my private job this round (draw the prompt, or
          // describe the drawing). A fresh round → clear my last submission/guess.
          const task = { phase: data.phase, round: data.round, totalRounds: data.totalRounds, deadline: data.deadline, prompt: data.prompt || null, image: data.image || null };
          phoneTaskRef.current = task;
          setPhoneTask(task);
          setPhoneSubmitted(false);
          setPhoneGuess("");
          setPhoneReveal(null);
          break;
        }
        case "phone_reveal": {
          setPhoneReveal(Array.isArray(data.books) ? data.books : []);
          phoneTaskRef.current = null;
          setPhoneTask(null);
          setPhoneSubmitted(false);
          break;
        }
        case "phone_rejected": {
          showToast(data.reason === "text" ? "Let's keep it kind — try another word." : "Couldn't use that drawing — try again.");
          setPhoneSubmitted(false);
          break;
        }
        case "reaction": {
          // Ephemeral floating emoji from someone (or our own echo). Placed at the
          // world point, mapped to screen once; it floats up + fades via CSS.
          if (hiddenPaintersRef.current.has(data.userId)) break; // locally hidden painter
          const p = worldToScreen(viewRef.current, (data.x || 0) * CANVAS_WIDTH, (data.y || 0) * CANVAS_HEIGHT);
          const rid = `rx${Date.now()}_${(reactionIdRef.current += 1)}`;
          setReactions((list) => [
            ...list.slice(-29),
            { id: rid, emoji: data.emoji, name: data.name, leftPx: p.x, topPx: p.y },
          ]);
          window.setTimeout(() => setReactions((list) => list.filter((r) => r.id !== rid)), 1500);
          break;
        }
        case "hype": {
          // Big animated celebration over the canvas (curated kinds; the server
          // rate-limits + allowlists). Hard cap of 3 on screen — extras drop so
          // a hype pile-on can never bury the art or the frame rate.
          if (hiddenPaintersRef.current.has(data.userId)) break; // locally hidden painter
          const meta = HYPES.find((h) => h.kind === data.kind);
          if (!meta) break;
          const hid = `hy${Date.now()}_${(hypeIdRef.current += 1)}`;
          setHypes((list) => {
            if (list.length >= 3) return list; // dropped — no timer, no re-render later
            window.setTimeout(() => {
              setHypes((cur) => (cur.some((h) => h.id === hid) ? cur.filter((h) => h.id !== hid) : cur));
            }, 2400);
            return [...list, { id: hid, kind: data.kind, emoji: meta.emoji, name: data.name }];
          });
          break;
        }
        case "wet_state":
          // The room's wet toggle flipped. Strokes already in flight keep the
          // wetness captured in their op settings (replay determinism).
          roomWetRef.current = !!data.wet;
          setRoomWet(!!data.wet);
          showToast(data.wet ? "💧 Wet canvas ON — paints mix and smear!" : "☀️ Canvas dried — paints stay put.");
          break;
        case "vote_open":
          setRoomVote({ options: data.options || [], endsAt: data.endsAt || 0, counts: [0, 0, 0], myChoice: null });
          // The vote card lives in the chat panel — announce it so people with
          // the panel closed know a 45s vote just started (a floating card also
          // renders for them; see the cc-vote-floating block).
          showToast("🗳️ Theme vote started — pick the next theme!");
          break;
        case "vote_tally":
          setRoomVote((vote) => (vote ? { ...vote, counts: data.counts || vote.counts } : vote));
          break;
        case "vote_result":
          setRoomVote(null);
          if (data.prompt) {
            setRoomPrompt(data.prompt);
            setPromptDismissed(false); // a fresh theme un-hides the chip
            showToast(`🎨 New theme: ${data.prompt}`);
          }
          break;
        case "vote_denied":
          showToast(data.reason ? `🗳️ ${data.reason}` : "🗳️ Can't start a vote right now.");
          break;
        case "watcher_role":
          // The server elected (or stood down) this client as an NSFW watcher.
          nsfwWatcherRef.current?.setActive(!!data.active);
          break;
        case "mention_key":
          // A rename minted a fresh mention-watch capability for our new name —
          // store it so cross-room @mention pings keep following us.
          if (data.room && data.name && data.key) {
            recordRecentRoom(data.room, null, Date.now(), { name: data.name, key: data.key });
          }
          break;
        case "mod_alert":
          // Host-only — the server only sends these to a room's hosts.
          setModAlerts((list) => [{ ...data, id: `ma_${Date.now()}_${list.length}`, ts: Date.now() }, ...list].slice(0, 50));
          showToast(data.hidden ? "🛡️ Auto-hid a flagged drawing — see Host controls" : "🛡️ A drawing was flagged — see Host controls");
          break;
        case "chat_blocked":
          // Honest feedback per cause — a rate-limited kid shouldn't be told
          // the safety filter caught them.
          if (data.reason === "slow_down") showToast("Whoa, slow down a little — try again in a moment! 🐢");
          else if (data.reason === "doodle") showToast("That doodle couldn't be sent — try drawing it again!");
          else showToast("That message was blocked by the room's safety filter.");
          break;
        case "wipe_state":
          setRoomWipe(data.wipe || null);
          break;
        case "wipe_denied":
          showToast(
            data.reason === "already_voted" ? "You already voted to keep this one! 🗳️"
              : data.reason === "already_extended" ? "This canvas is already booked for a while — enjoy it! 🎉"
                : data.reason === "muted" ? "You're muted by a host right now."
                  : "Give it a moment and try again.",
          );
          break;
        case "fork_denied":
          showToast(
            data.reason === "empty" ? "Draw something first, then you can take it private! ✏️"
              : data.reason === "too_big" ? "This canvas is too big to copy — pin it to the Wall instead. 🧲"
                : data.reason === "locked" ? "A host locked this room."
                  : data.reason === "muted" ? "You're muted by a host right now."
                    : data.reason === "not_forkable" ? "This room doesn't refresh, so there's nothing to rescue."
                      : "Couldn't make your copy — try again in a bit.",
          );
          break;
        case "fork_ready":
          // Our private copy is ready — hand over the room, don't teleport the
          // user mid-stroke.
          setWipePanelOpen(false);
          showToast(`Your private copy is ready — room ${data.code} 🔒`);
          window.setTimeout(() => { window.location.href = `/join/${data.code}`; }, 900);
          break;
        case "chat_doodle_removed":
          // Admin takedown: the hook already stripped chat state; drop the
          // cached image too so nothing can re-render it.
          evictPageImage(data.doodle);
          break;
        case "room_full":
          // The server closes the socket right after this — stop the auto-
          // reconnect loop and show a way forward instead of "Connecting…".
          mpRef.current?.disconnect?.();
          setRoomFull(true);
          break;
        case "room_blocked":
          mpRef.current?.disconnect?.();
          setRoomBlocked(true);
          setStatus("This room isn't available.");
          break;
        case "room_closed":
          // A moderator deleted this room (or it auto-closed). Stop reconnecting
          // and send the painter back to the main hall.
          mpRef.current?.disconnect?.();
          showToast("This room was closed. Taking you to the main room…");
          window.setTimeout(() => {
            window.location.href = "/studio";
          }, 1600);
          break;
        default:
          break;
      }
    },
    [abortActiveStroke, activateFrame, announcePresence, applyRemoteOp, commitAllRemoteStrokes, commitLayersToFrame, dropRemoteStrokes, isActiveFrame, loadSheetImage, publishCrewPresence, reconcileFrames, refreshActiveThumbnail, renderDisplay, roomId, roomOrchestra, scheduleRemoteRender, scheduleStrokeFrame, showBeacon, showClearBanner, showToast, stopPlayback, switchScene, syncFrameState, touchFrame],
  );

  const mp = useMultiplayer(roomId, handleMpMessage, session?.access_token);

  // Chat with locally-hidden painters filtered out (see toggleHiddenPainter).
  const visibleChat = useMemo(
    () => (hiddenPainters.size ? mp.chat.filter((m) => !m.user || !hiddenPainters.has(m.user.id)) : mp.chat),
    [mp.chat, hiddenPainters],
  );

  // Watch our OTHER recent rooms for @mentions of us and collect them in the
  // profile-menu inbox (the current room's chat is already live here, so it's
  // excluded). Each watch presents the room's stored mention-key capability —
  // rooms visited before keys existed (or where the handshake didn't issue one)
  // simply aren't watchable until the next visit.
  const selfName = mp.self?.name || null;
  const watchList = useMemo(
    () =>
      getRecentRooms()
        .filter((r) => r.code && r.code !== roomId && r.watchName && r.mentionKey)
        .map((r) => ({ code: r.code, name: r.watchName, key: r.mentionKey })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selfName re-reads storage after joins/renames land new keys
    [roomId, selfName],
  );
  useMentionWatcher(watchList, (mention) => {
    setNotifications(addNotification(mention));
  });
  const unreadNotifs = notifications.filter((n) => !n.read).length;

  // On mobile the notifications inbox lives in the tools drawer's "You" panel, so
  // clear the unread badge whenever that drawer opens (desktop clears on menu open).
  useEffect(() => {
    if (toolsOpen) {
      setNotifications((prev) => (prev.some((n) => !n.read) ? markAllRead() : prev));
    }
  }, [toolsOpen]);

  // Sign out from the profile menu without leaving the studio.
  const handleSignOut = useCallback(async () => {
    await signOut();
    setSession(null);
    setShowAvatarMenu(false);
    showToast("Signed out.");
  }, [showToast]);

  // Shared notifications inbox, used in both the desktop profile menu and the
  // mobile "You" section (the desktop bar is hidden on tablets/phones).
  const notificationsPanel = (
    <div className="avatar-notifs">
      <div className="avatar-notifs-head">
        <span>🔔 Notifications</span>
        {notifications.length ? (
          <button
            type="button"
            className="avatar-notifs-clear"
            onClick={() => setNotifications(clearNotifications())}
          >
            Clear
          </button>
        ) : null}
      </div>
      {notifications.length === 0 ? (
        <p className="avatar-notifs-empty">
          No updates yet. When someone @mentions you in another room you&apos;re in, it shows up here.
        </p>
      ) : (
        <ul className="avatar-notifs-list">
          {notifications.slice(0, 12).map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className="avatar-notif"
                onClick={() => {
                  window.location.href = `/join/${n.room}`;
                }}
                title={`Go to ${n.roomTitle || `Room ${n.room}`}`}
              >
                <span className="avatar-notif-main">
                  <strong>{n.from}</strong> · {n.roomTitle || `Room ${n.room}`}
                </span>
                <span className="avatar-notif-text">{n.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  // Draw Phone suppresses op relay while a game runs (drawing is private); this
  // gate wraps the raw sender so every draw call site respects it. The server
  // also drops these ops — this just saves the wire.
  const relayOp = useCallback((op) => {
    const ph = phoneRef.current;
    if (ph && (ph.phase === "starting" || ph.phase === "drawing" || ph.phase === "guessing")) return;
    mp.sendOp(op);
    // mp.sendOp is a stable useCallback; the plugin over-broadly wants `mp`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mp.sendOp]);

  // The imperative draw handlers (defined earlier) reach the senders via a ref.
  useEffect(() => {
    mpRef.current = {
      sendOp: relayOp,
      sendCursor: mp.sendCursor,
      sendClear: mp.sendClear,
      sendRestore: mp.sendRestore,
      sendRename: mp.sendRename,
      sendSheet: mp.sendSheet,
      sendTracePhoto: mp.sendTracePhoto,
      disconnect: mp.disconnect,
      sendWatcherAck: mp.sendWatcherAck,
      sendFlag: mp.sendFlag,
      sendModHide: mp.sendModHide,
      sendModRestore: mp.sendModRestore,
      sendModRemove: mp.sendModRemove,
      sendSetWet: mp.sendSetWet,
      sendVoteStart: mp.sendVoteStart,
      sendVote: mp.sendVote,
      sendReaction: mp.sendReaction,
      sendSetSymmetry: mp.sendSetSymmetry,
      sendQuestNominate: mp.sendQuestNominate,
      sendQuestReset: mp.sendQuestReset,
      sendStorybookCaption: mp.sendStorybookCaption,
      sendStorybookLock: mp.sendStorybookLock,
      sendStorybookMove: mp.sendStorybookMove,
      sendSetAnimation: mp.sendSetAnimation,
      sendFrameAdd: mp.sendFrameAdd,
      sendFrameDel: mp.sendFrameDel,
      sendFrameMove: mp.sendFrameMove,
      sendFrameDuration: mp.sendFrameDuration,
      sendSceneFetch: mp.sendSceneFetch,
      sendSceneAdd: mp.sendSceneAdd,
      sendSceneDel: mp.sendSceneDel,
      sendProductionCreate: mp.sendProductionCreate,
      sendProductionAddSegment: mp.sendProductionAddSegment,
      sendProductionRename: mp.sendProductionRename,
      sendFramePresence: mp.sendFramePresence,
      sendBeacon: mp.sendBeacon,
      sendCheer: mp.sendCheer,
      sendGameSkip: mp.sendGameSkip,
      sendSetGame: mp.sendSetGame,
      sendWipeKeep: mp.sendWipeKeep,
      sendForkPrivate: mp.sendForkPrivate,
      sendSetPhone: mp.sendSetPhone,
      sendPhoneStart: mp.sendPhoneStart,
      sendPhoneSubmit: mp.sendPhoneSubmit,
      sendPhoneSkip: mp.sendPhoneSkip,
    };
  }, [relayOp, mp.sendCursor, mp.sendClear, mp.sendRestore, mp.sendRename, mp.sendSheet, mp.sendTracePhoto, mp.disconnect, mp.sendWatcherAck, mp.sendFlag, mp.sendModHide, mp.sendModRestore, mp.sendModRemove, mp.sendSetWet, mp.sendVoteStart, mp.sendVote, mp.sendReaction, mp.sendSetSymmetry, mp.sendQuestNominate, mp.sendQuestReset, mp.sendStorybookCaption, mp.sendStorybookLock, mp.sendStorybookMove, mp.sendSetAnimation, mp.sendFrameAdd, mp.sendFrameDel, mp.sendFrameMove, mp.sendFrameDuration, mp.sendSceneFetch, mp.sendSceneAdd, mp.sendSceneDel, mp.sendProductionCreate, mp.sendProductionAddSegment, mp.sendProductionRename, mp.sendFramePresence, mp.sendBeacon, mp.sendCheer, mp.sendGameSkip, mp.sendSetGame, mp.sendSetPhone, mp.sendPhoneStart, mp.sendPhoneSubmit, mp.sendPhoneSkip, mp.sendWipeKeep, mp.sendForkPrivate]);


  // Draw Phone: submit my drawn page. Grab the current canvas as a downscaled
  // JPEG (private — never relayed as ops) and send it as this round's page.
  const submitPhoneDrawing = useCallback(async () => {
    const task = phoneTaskRef.current;
    if (!task || task.phase !== "drawing" || phoneSubmitted) return;
    setPhoneSubmitted(true); // optimistic; a phone_rejected flips it back
    try {
      const canvas = await composeCanvas({ width: 800, height: 500 });
      const image = canvas.toDataURL("image/jpeg", 0.82);
      mpRef.current?.sendPhoneSubmit?.({ round: task.round, image });
      showToast("Sent! Waiting for the others… ✏️");
    } catch {
      setPhoneSubmitted(false);
      showToast("Couldn't send your drawing — try again");
    }
  }, [composeCanvas, phoneSubmitted, showToast]);

  // Draw Phone: submit my text guess for the drawing I was handed.
  const submitPhoneGuess = useCallback(() => {
    const task = phoneTaskRef.current;
    if (!task || task.phase !== "guessing" || phoneSubmitted) return;
    setPhoneSubmitted(true);
    mpRef.current?.sendPhoneSubmit?.({ round: task.round, text: phoneGuess.trim() || "(no guess)" });
  }, [phoneGuess, phoneSubmitted]);

  // Countdown label for the public canvas refresh. Ticks once a minute (only
  // while a room is actually on the cycle) — this is a "2d 4h" label, not a
  // stopwatch, so per-second work would be pure waste on the drawing path.
  useEffect(() => {
    if (!roomWipe || !roomWipe.wipeAt) return undefined;
    const t = window.setInterval(() => setWipeTick((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, [roomWipe]);
  const wipeMsLeft = roomWipe && roomWipe.wipeAt ? Math.max(0, roomWipe.wipeAt - Date.now()) : 0;
  const wipeUrgent = Boolean(roomWipe && roomWipe.wipeAt) && wipeMsLeft < 6 * 3600_000;
  const wipeCountdown = (() => {
    if (!roomWipe || !roomWipe.wipeAt) return "";
    const mins = Math.floor(wipeMsLeft / 60_000);
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  })();

  // Drop an ephemeral emoji reaction at the center of the current view. The
  // server echoes it to everyone (including us) so it renders exactly once.
  // Plain function (only used from an onClick) so it never churns hook deps.
  const dropReaction = (emoji) => {
    const vs = getViewportSize();
    const c = screenToWorld(viewRef.current, vs.w / 2, vs.h / 2);
    mpRef.current?.sendReaction?.(emoji, c.x / CANVAS_WIDTH, c.y / CANVAS_HEIGHT);
    setReactionPickerOpen(false);
  };

  // Live countdown for the open theme vote. Ticks twice a second while a vote
  // card is showing; the server's vote_result is what actually closes it.
  useEffect(() => {
    if (!roomVote?.endsAt) {
      return undefined;
    }
    const tick = () => setVoteSecondsLeft(Math.max(0, Math.ceil((roomVote.endsAt - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [roomVote?.endsAt]);

  // Create the in-browser NSFW watcher once. It is completely inert until the
  // server elects this client (watcher_role) and never touches the drawing path:
  // it samples the composited canvas on idle, off the main thread, in a Worker.
  useEffect(() => {
    const watcher = createNsfwWatcher({
      getCanvas: () => docContextRef.current?.canvas || null,
      isDrawing: () => activePointerRef.current != null,
      getLastOpId: () => lastOpIdRef.current,
      onFlag: (flag) => mpRef.current?.sendFlag?.(flag),
    });
    nsfwWatcherRef.current = watcher;
    return () => {
      watcher.destroy();
      nsfwWatcherRef.current = null;
    };
  }, []);

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
    mpRef.current?.sendSheet?.(id || null); // clears room-wide if you're a host / unowned room
    if (!id) {
      // Always remove the sheet from YOUR OWN view immediately, even if the
      // server (host-gated in owned rooms) doesn't clear it for everyone — so a
      // joiner can never get stuck staring at a coloring sheet they can't dismiss.
      setSheetId(null);
      loadSheetImage(null);
      showToast("Coloring sheet removed");
    }
  }, [loadSheetImage, showToast]);

  // Apply a library sheet from the modal. Picking a sheet starts a fresh page,
  // so if there's existing art (or a sheet) we confirm, then wipe + set.
  const applyLibrarySheet = useCallback(
    (sheet) => {
      if (!sheet?.id) return;
      const hasContent = Boolean(sheetId) || historyCount > 0;
      if (hasContent && !window.confirm("Start a fresh page with this coloring sheet? It clears the canvas for everyone in the room.")) {
        return;
      }
      if (hasContent) mpRef.current?.sendClear?.();
      mpRef.current?.sendSheet?.(`lib:${sheet.id}`);
      setShowSheetModal(false);
      showToast(`Coloring sheet: ${sheet.title}`);
    },
    [sheetId, historyCount, showToast],
  );

  // Load any saved profile (name/colour) once.
  useEffect(() => {
    try {
      profileRef.current = JSON.parse(window.localStorage.getItem(PROFILE_STORAGE_KEY) || "null");
    } catch {
      profileRef.current = null;
    }
  }, []);

  // Ensure an anonymous per-device user key exists. This is the signed-out
  // gallery key and the source for the one-time sign-in migration below; the
  // session effect picks the active key (device vs. account) and loads.
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
    deviceKeyRef.current = key;
  }, []);

  // Flip the active gallery key on sign-in/out and load that user's art.
  // Signed in → the account key `pb_<profileId>` (server forces this from the
  // token anyway); signed out → the anonymous device key. The token is mirrored
  // into tokenRef so the gallery fetches authenticate without stale closures.
  //
  // One-time per-device migration: the first time a signed-out user with
  // device-key art signs in, their device saves would vanish from view (the key
  // flips to an empty `pb_<id>`). So we copy the device gallery into the account
  // (best-effort, capped, never throws) and set a localStorage guard so it runs
  // at most once per device.
  useEffect(() => {
    const profileId = session?.user?.id || null;
    const token = session?.access_token || null;
    tokenRef.current = token;
    const deviceKey = deviceKeyRef.current;
    const accountKey = profileId ? `pb_${profileId}` : null;
    userKeyRef.current = accountKey || deviceKey;

    let cancelled = false;
    (async () => {
      if (accountKey && deviceKey && token) {
        await migrateDeviceArtToAccount(deviceKey, token);
      }
      if (!cancelled) {
        await loadMyDrawings();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, loadMyDrawings]);

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
      const v = viewRef.current;
      const live = [];
      remoteCursorsRef.current.forEach((cursor, userId) => {
        if (now - cursor.ts > 4000) {
          remoteCursorsRef.current.delete(userId);
        } else {
          // normalized 0..1 -> world -> screen (rotation-aware).
          const p = worldToScreen(v, cursor.x * CANVAS_WIDTH, cursor.y * CANVAS_HEIGHT);
          live.push({
            userId,
            name: cursor.name,
            color: cursor.color,
            drawing: cursor.drawing,
            focused: userId === focusedUserIdRef.current,
            leftPx: p.x,
            topPx: p.y,
          });
        }
      });
      // Change-signature bailout: an identical cursor set (including the idle
      // empty one) means no re-render — without it this interval re-renders
      // the whole component ~8x/sec forever.
      const sig = live
        .map((c) => `${c.userId}:${c.leftPx}:${c.topPx}:${c.drawing ? 1 : 0}:${c.focused ? 1 : 0}`)
        .join("|");
      if (sig === cursorSigRef.current) {
        return;
      }
      cursorSigRef.current = sig;
      setRemoteCursors(live);
    }, 120);
    return () => window.clearInterval(timer);
  }, []);

  // Keep crew presence honest against the roster: presence is a COLD signal
  // (sent once per cel change, not refreshed), so a TTL would wrongly drop a
  // teammate who's sitting still. Instead, whenever the room roster changes,
  // drop presence for anyone no longer present — robust even if a leave
  // message was missed.
  useEffect(() => {
    if (crewPresenceRef.current.size === 0) {
      return;
    }
    const liveIds = new Set(mp.users.map((u) => u.id));
    let changed = false;
    for (const userId of crewPresenceRef.current.keys()) {
      if (!liveIds.has(userId)) {
        crewPresenceRef.current.delete(userId);
        changed = true;
      }
    }
    if (changed) {
      publishCrewPresence();
    }
  }, [mp.users, publishCrewPresence]);

  // Derive cel pips (frameId -> people on it, CURRENT scene only) + a count of
  // crew off in other scenes for the pager. Recomputes only when presence or
  // the active scene changes — never on the draw path.
  const celPresence = useMemo(() => {
    const map = {};
    for (const p of crewPresence) {
      const sameScene = !p.sceneId || !activeSceneId || p.sceneId === activeSceneId;
      if (sameScene && p.frameId) {
        (map[p.frameId] = map[p.frameId] || []).push({ name: p.name, color: p.color });
      }
    }
    return map;
  }, [crewPresence, activeSceneId]);
  const otherSceneCrew = useMemo(
    () => crewPresence.filter((p) => p.sceneId && activeSceneId && p.sceneId !== activeSceneId).length,
    [crewPresence, activeSceneId],
  );

  // Accept a "come look!" beacon: land on the exact Part + scene + frame.
  const acceptBeacon = useCallback(
    async (target) => {
      setBeacon(null);
      if (!target) {
        return;
      }
      if (target.roomCode && target.roomCode !== roomId) {
        window.location.href = `/join/${target.roomCode}`; // another Part — hop rooms
        return;
      }
      if (target.sceneId && target.sceneId !== activeSceneIdRef.current) {
        await switchScene(target.sceneId);
      }
      const index = framesRef.current.findIndex((f) => f.id === target.frameId);
      if (index >= 0) {
        handleSelectFrame(index);
      }
    },
    [roomId, switchScene, handleSelectFrame],
  );

  // Clear any pending "focused friend" highlight timer on unmount.
  useEffect(() => () => {
    if (focusTimerRef.current) {
      window.clearTimeout(focusTimerRef.current);
    }
    window.clearTimeout(beaconTimerRef.current);
  }, []);

  // Non-passive wheel listener (so it can preventDefault page scroll/zoom).
  // "Hands on the trackpad" navigation: two-finger scroll PANS, a trackpad
  // pinch (which browsers deliver as ctrlKey+wheel) or ⌘/Ctrl+scroll ZOOMS
  // smoothly at the cursor, and a classic mouse-wheel notch keeps the familiar
  // 12% zoom step. On a Mac, Wacom Cintiq touch is translated by the driver
  // into these same trackpad gestures — the browser never sees real touches —
  // so this is exactly what makes pan/zoom-by-hand work on a Cintiq + Mac.
  useEffect(() => {
    const el = overlayCanvasRef.current;
    if (!el) {
      return undefined;
    }
    const onWheel = (event) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;
      if (event.ctrlKey || event.metaKey) {
        // Pinch / modifier zoom: exponential so the zoom tracks finger travel
        // (many tiny deltas), capped per event so a modifier+mouse-notch (one
        // big delta) steps instead of leaping.
        const factor = Math.min(1.3, Math.max(1 / 1.3, Math.exp(-dy * 0.01)));
        zoomAt(factor, event.clientX - rect.left, event.clientY - rect.top);
        return;
      }
      // A classic mouse notch is a big, whole-number, vertical-only delta —
      // keep its zoom-per-click. Everything else (trackpad two-finger scroll,
      // Cintiq touch ring: small and/or two-axis deltas) pans the view, the
      // pro-drawing-app convention.
      if (dx === 0 && Math.abs(dy) >= 100 && Number.isInteger(event.deltaY)) {
        zoomAt(dy < 0 ? 1.12 : 1 / 1.12, event.clientX - rect.left, event.clientY - rect.top);
        return;
      }
      panBy(-dx, -dy);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving the studio: flush a learned pen-pressure band that's still waiting
  // on its debounce so the next session starts calibrated.
  useEffect(
    () => () => {
      if (penCalSaveRef.current) {
        window.clearTimeout(penCalSaveRef.current);
        penCalSaveRef.current = 0;
      }
      savePenCalibration(penCalRef.current);
    },
    [],
  );

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

  // Painting keyboard shortcuts (when not typing): [ / ] resize the brush,
  // Backspace = eraser, B = brush, Tab = open the brush menu. (Spacebar = pan is
  // handled above; Cmd/Ctrl Z/Y/S below.) Uses functional updates + refs so the
  // listener can be installed once. Tab only acts when focus isn't on a control,
  // so keyboard focus-navigation through the tool rail still works.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return; // leave modifier combos to the undo/redo/save handler
      }
      const target = event.target;
      const tag = (target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) {
        return;
      }
      switch (event.key) {
        case "[":
          event.preventDefault();
          setBrushSize((s) => Math.max(2, Math.min(s - 1, Math.round(s * 0.85))));
          break;
        case "]":
          event.preventDefault();
          setBrushSize((s) => Math.min(120, Math.max(s + 1, Math.round(s * 1.18))));
          break;
        case "Backspace":
          event.preventDefault();
          if (roomFingerPaintRef.current) break; // toddler room: no eraser
          handToolRef.current = false;
          setHandTool(false);
          setSelectedTool("brush");
          setSelectedBrush("eraser");
          break;
        case "b":
        case "B":
          event.preventDefault();
          handToolRef.current = false;
          setHandTool(false);
          setSelectedTool("brush");
          setSelectedBrush((prev) => (prev === "eraser" ? lastPaintBrushRef.current || "marker" : prev));
          break;
        case "Tab":
          if (tag !== "button" && tag !== "a") {
            event.preventDefault();
            setToolsOpen(true);
            window.setTimeout(
              () => brushSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
              80,
            );
          }
          break;
        case "t":
        case "T":
          // Toggle the tool rail / sheet — the "give me the whole canvas" key
          // (Cintiq ExpressKeys map nicely to it).
          event.preventDefault();
          setToolsOpen((open) => !open);
          break;
        default:
          break;
      }
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

    // NOTE: drafts are never auto-restored. Multiplayer rooms are server-
    // authoritative — every join receives a 'history' frame (even when empty)
    // that rebuilds the shared mural, and a stale local draft painted over it
    // reappeared as ghost drawings. The manual "Restore last draft" button
    // (restoreDraft) is still available.
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
      // Lift the session so the access token can ride the multiplayer socket and
      // the host UI can read identity. Re-running the socket connect on token
      // change reconnects us with our verified identity.
      if (active) setSession(session || null);
      if (session) {
        await startSync(session);
        await refreshFromLocal();
      } else {
        stopSync();
      }
    };
    getSession().then((session) => {
      if (active) {
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
    let resizeRaf = 0;
    const scheduleResize = () => {
      if (resizeRaf) {
        return;
      }
      resizeRaf = window.requestAnimationFrame(() => {
        resizeRaf = 0;
        resizeDisplayCanvas();
      });
    };
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

    // The film strip is inserted after the websocket handshake, shrinking the
    // canvas without a window resize. Observe the canvas box so pointer math and
    // the backing store stay aligned with in-flow UI changes.
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleResize) : null;
    if (resizeObserver) {
      const display = displayCanvasRef.current;
      if (display) {
        resizeObserver.observe(display);
        if (display.parentElement) {
          resizeObserver.observe(display.parentElement);
        }
      }
    }

    return () => {
      if (resizeRaf) {
        window.cancelAnimationFrame(resizeRaf);
      }
      resizeObserver?.disconnect();
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
    let frame = window.requestAnimationFrame(() => {
      frame = 0;
      resizeDisplayCanvas();
    });
    const settleTimer = window.setTimeout(() => {
      resizeDisplayCanvas();
    }, 150);
    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      window.clearTimeout(settleTimer);
    };
  }, [resizeDisplayCanvas, roomAnimation]);

  useEffect(() => {
    autosaveTimerRef.current = window.setInterval(() => {
      // Never snapshot mid-stroke or mid-pinch — saveDraft serializes every
      // layer and would stall the pointer stream. dirtyRef stays true, so the
      // next tick retries once the hands are off the canvas.
      if (activePointerRef.current != null || gestureRef.current != null) {
        return;
      }
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
      if (viewRafRef.current) {
        window.cancelAnimationFrame(viewRafRef.current);
        viewRafRef.current = 0;
      }
      if (remoteRenderRafRef.current) {
        window.cancelAnimationFrame(remoteRenderRafRef.current);
        remoteRenderRafRef.current = 0;
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
    economyRef.current = next;
    setEconomy(next);
    saveEconomy(next).catch(() => setStatus("Couldn't save wallet"));
  }, []);

  // Earn-by-painting (play-money): a completed stroke earns a Drop, throttled so
  // the reward stays gentle and the ledger small. Exposed via a ref so the deep
  // endStroke handler can call it without a forward dependency.
  const earnPaintDrops = useCallback(() => {
    const current = economyRef.current;
    if (!current) return;
    const now = Date.now();
    if (now - lastPaintEarnRef.current < 4000) return;
    lastPaintEarnRef.current = now;
    persistEconomy(earnDropsForPainting(current, 1));
  }, [persistEconomy]);
  earnPaintDropsRef.current = earnPaintDrops;

  const earnQuestDrops = useCallback((setId, missionId) => {
    const current = economyRef.current;
    if (!current || !setId || !missionId) return;
    const next = earnDropsForQuest(current, setId, missionId, 3);
    if (next !== current) persistEconomy(next);
  }, [persistEconomy]);
  earnQuestDropsRef.current = earnQuestDrops;

  // Drawing streak: the day's FIRST finished stroke ticks it (device-local).
  // Session-guarded so the localStorage read happens once per day, not per
  // stroke — nothing rides the drawing hot path. Celebrate day 2+ only.
  const bumpStreak = useCallback(() => {
    if (streakDoneRef.current === localDayString()) return;
    streakDoneRef.current = localDayString();
    const count = bumpDrawingStreak();
    if (count && count >= 2) showToast(`🔥 Day ${count} of your drawing streak!`);
  }, [showToast]);
  bumpStreakRef.current = bumpStreak;

  // Keep the economy ref authoritative even for the async initial load.
  useEffect(() => {
    economyRef.current = economy;
  }, [economy]);

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
    if (roomFingerPaintRef.current) {
      return; // toddler room: chunky wet brushes only — no eraser
    }
    handToolRef.current = false;
    setHandTool(false);
    setSelectedTool("brush");
    setSelectedBrush("eraser");
  };

  const isPaintActive = !handTool && selectedTool === "brush" && selectedBrush !== "eraser";
  const isEraserActive = !handTool && selectedTool === "brush" && selectedBrush === "eraser";
  // Smudge blends the paint already on the canvas — it carries no pigment, so it
  // shows a Strength control instead of a colour + opacity + variation. The
  // eraser likewise ignores colour (it cuts to transparent).
  const isSmudgeActive = selectedTool === "brush" && selectedBrush === "smudge";
  const noColorBrush = selectedTool === "brush" && (selectedBrush === "smudge" || selectedBrush === "eraser");

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

  const inviteFriends = shareRoomLink;

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
  const toggleOrchestra = async (enabled) => {
    const ok = await orchestraRef.current?.setEnabled(enabled);
    setOrchestraEnabled(Boolean(enabled && ok));
    if (enabled && !ok) showToast("Sound isn't available in this browser, but painting still works.");
  };

  const changeOrchestraMute = (muted) => {
    orchestraRef.current?.setMuted(muted);
    setOrchestraMuted(muted);
  };

  const changeOrchestraVolume = (volume) => {
    orchestraRef.current?.setVolume(volume);
    setOrchestraVolume(volume);
  };

  return (
    <main
      className={`studio-shell${toolsOpen ? " rail-open" : ""}${layoutTier === "desktop" && !toolsOpen ? " rail-collapsed" : ""}`}
      data-layout={layoutTier}
      translate="no"
    >
      <section className="studio-workspace" aria-label="Drawesome drawing studio">
        <button
          type="button"
          className="desktop-studio-toggle"
          onClick={() => setDesktopHeaderOpen((open) => !open)}
          aria-expanded={desktopHeaderOpen}
          aria-controls="desktop-studio-menu"
          title="Open studio actions"
        >
          <BrandMark showName={false} />
          <span>Studio</span>
          <span className="desktop-studio-toggle-icon" aria-hidden="true">&#8942;</span>
        </button>
        <div
          id="desktop-studio-menu"
          className={`topbar${desktopHeaderOpen ? " is-open" : ""}`}
          aria-hidden={!desktopHeaderOpen}
        >
          <div className="topbar-brand">
            <p className="eyebrow">Open studio / live</p>
            <h1><BrandMark /></h1>
          </div>
          <div className="topbar-actions">
            <button type="button" onClick={undo} disabled={historyCount === 0}>
              Undo
            </button>
            <button type="button" onClick={redo} disabled={redoCount === 0}>
              Redo
            </button>
            <button type="button" onClick={openStepBackPreview} disabled={isPreparingStepBack}>
              {isPreparingStepBack ? "Framing..." : "Step back"}
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
              🖼️ Gallery
            </button>
            <button type="button" onClick={openWallPost} title="Pin your art on the community Fridge Wall">
              🧲 Wall
            </button>
            <button type="button" onClick={shareRoomLink} title="Share a link to this room">
              📤 Share
            </button>
            <button type="button" onClick={openReplay} title="Watch it draw + share a timelapse GIF">
              🎬 Timelapse
            </button>
            <button type="button" onClick={exportPng}>
              Export
            </button>
            <button type="button" className="topbar-transparent-export" onClick={exportTransparentPng}>
              Export PNG (transparent)
            </button>
            <button
              type="button"
              className="topbar-close"
              onClick={() => setDesktopHeaderOpen(false)}
              aria-label="Close studio actions"
              title="Close"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Always visible on mobile (the desktop room bar is hidden there): one
            tap to leave to the front page or open the room switcher. */}
        <div className="studio-rooms-fab">
          <button
            type="button"
            onClick={() => { window.location.href = "/"; }}
            title="Leave this room — back to the front page"
            aria-label="Home"
          >
            🏠
          </button>
          <button type="button" onClick={() => setShowLobby(true)} title="Switch or browse rooms">
            🚪 Rooms
          </button>
          <button
            type="button"
            className="fab-step-back"
            onClick={openStepBackPreview}
            disabled={isPreparingStepBack}
            title="Step back and view the whole artwork"
            aria-label="Step back and view the whole artwork"
          >
            <span aria-hidden="true">&#9635;</span>
          </button>
          <button
            type="button"
            className="fab-bell"
            title="Notifications"
            onClick={() => {
              setToolsOpen(true);
              if (unreadNotifs > 0) setNotifications(markAllRead());
              window.setTimeout(() => mobileProfileRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 90);
            }}
          >
            🔔
            {unreadNotifs > 0 ? (
              <span className="avatar-badge" aria-label={`${unreadNotifs} new`}>
                {unreadNotifs > 9 ? "9+" : unreadNotifs}
              </span>
            ) : null}
          </button>
        </div>

        {/* Desktop, rail collapsed: an edge tab brings the tools back. */}
        {layoutTier === "desktop" && !toolsOpen ? (
          <button
            type="button"
            className="rail-reopen"
            onClick={() => setToolsOpen(true)}
            title="Show the tools (T)"
            aria-label="Show tools"
          >
            <span aria-hidden="true">🎨</span>
            <span className="rail-reopen-label">Tools</span>
          </button>
        ) : null}

        <div className="mp-bar">
          <button
            type="button"
            className="mp-home"
            onClick={() => { window.location.href = "/"; }}
            title="Leave this room — back to the front page"
          >
            🏠 Home
          </button>
          <span className={mp.connected ? "mp-dot mp-dot-on" : "mp-dot"} aria-hidden="true" />
          <button
            type="button"
            className="mp-room mp-room-switch"
            onClick={() => setShowLobby(true)}
            title="Switch rooms — hop between your rooms, browse, or start a new one"
          >
            {roomTitle ? roomTitle : `Room ${roomId}`} <span aria-hidden="true">⌄</span>
          </button>
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
          <button type="button" className="mp-invite" onClick={inviteFriends}>
            Invite friends
          </button>

          {roomAudience && roomAudience !== "kid_safe" && isRoomHost && !storybook ? (
            <button
              type="button"
              className={`mp-wet-toggle mp-anim-toggle${roomAnimation ? " is-on" : ""}`}
              onClick={() => mpRef.current?.sendSetAnimation?.(!roomAnimation)}
              aria-pressed={roomAnimation}
              title={
                roomAnimation
                  ? "Animation is ON — the film strip is unlocked for this room. Tap to turn off."
                  : "Animation — unlock the shared film strip for this room"
              }
            >
              🎬
            </button>
          ) : null}

          {roomAudience && roomAudience !== "kid_safe" && isRoomHost ? (
            <button
              type="button"
              className={`mp-wet-toggle mp-phone-toggle${roomPhone ? " is-on" : ""}`}
              onClick={() => mpRef.current?.sendSetPhone?.(!roomPhone)}
              aria-pressed={roomPhone}
              title={
                roomPhone
                  ? "Draw Phone is ON — the telephone game for this room. Tap to turn off."
                  : "Draw Phone — play telephone: draw a prompt, pass it on, watch it drift"
              }
            >
              📞
            </button>
          ) : null}

          <button
            type="button"
            className={`mp-wet-toggle${roomWet ? " is-on" : ""}`}
            onClick={() => mpRef.current?.sendSetWet?.(!roomWet)}
            disabled={roomAudience === "kid_safe" && !isRoomHost}
            aria-pressed={roomWet}
            title={
              roomAudience === "kid_safe" && !isRoomHost
                ? "Wet canvas — only a host can switch this in public rooms"
                : roomWet
                  ? "Wet canvas is ON — paints mix and smear. Tap to dry."
                  : "Wet canvas — make paints mix and smear into each other"
            }
          >
            💧
          </button>

          {isRoomHost ? (
            <button type="button" className="mp-host-btn" onClick={() => setShowHostPanel(true)}>
              ⭐ Host{roomLocked ? " · 🔒" : ""}
            </button>
          ) : roomLocked ? (
            <span className="mp-lock-chip" title="A host locked the canvas">🔒 Locked</span>
          ) : null}

          <div className="mp-you">
            <button
              type="button"
              className="avatar-btn"
              onClick={() => {
                setNameDraft(mp.self?.name || "");
                const willOpen = !showAvatarMenu;
                setShowAvatarMenu(willOpen);
                if (willOpen && unreadNotifs > 0) setNotifications(markAllRead());
              }}
              aria-haspopup="menu"
              aria-expanded={showAvatarMenu}
              title="Your profile & notifications"
            >
              <span className="avatar-dot" style={{ background: mp.self?.color || "#9aa6b2" }}>
                {(mp.self?.name || "?").slice(0, 1).toUpperCase()}
              </span>
              <span className="avatar-name">{mp.self?.name || "You"}</span>
              {unreadNotifs > 0 ? (
                <span className="avatar-badge" aria-label={`${unreadNotifs} new notifications`}>
                  {unreadNotifs > 9 ? "9+" : unreadNotifs}
                </span>
              ) : null}
            </button>

            {showAvatarMenu ? (
              <div className="avatar-menu" role="menu">
                <p className="avatar-menu-title">You</p>

                {notificationsPanel}

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
                <div className="avatar-signin">
                  {session ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setShowAvatarMenu(false);
                          setShowAccount(true);
                        }}
                      >
                        ✅ Signed in · Account
                      </button>
                      <button type="button" className="avatar-signout" onClick={handleSignOut}>
                        🚪 Sign out
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="primary-action"
                      onClick={() => {
                        setShowAvatarMenu(false);
                        setShowAccount(true);
                      }}
                    >
                      🔑 Sign in to save your gallery
                    </button>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="canvas-stage">
          <div className={`canvas-paper${roomSymmetry.copies > 1 ? " is-symmetry" : ""}`}>
            <canvas ref={displayCanvasRef} className="drawing-canvas display-canvas" aria-label="Drawing canvas" />
            <canvas
              ref={overlayCanvasRef}
              className={`drawing-canvas overlay-canvas${handTool ? " is-pan" : ""}${
                !handTool && selectedTool !== "fill" && selectedTool !== "text" ? " ring-active" : ""
              }`}
              aria-hidden="true"
              onPointerDown={handleCanvasPointerDown}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={handleCanvasPointerUp}
              onPointerCancel={handleCanvasPointerUp}
              onPointerLeave={handleCanvasPointerLeave}
              onLostPointerCapture={handleCanvasLostPointerCapture}
              onContextMenu={handleCanvasContextMenu}
            />
            {/* Brush-size preview ring — sized to brushSize x zoom, tinted with the
                colour, following the pointer (and flashed when size/brush changes). */}
            <div ref={brushCursorRef} className="brush-cursor" aria-hidden="true">
              <canvas ref={brushTipCanvasRef} className="brush-cursor-tip" width={1} height={1} />
            </div>
            <div className="remote-cursor-layer" aria-hidden="true">
              {remoteCursors.map((cursor) => (
                <div
                  key={cursor.userId}
                  className={`remote-cursor${cursor.drawing ? " is-drawing" : ""}${cursor.focused ? " is-focused" : ""}`}
                  style={{ transform: `translate(${cursor.leftPx}px, ${cursor.topPx}px)` }}
                >
                  <span className="remote-cursor-dot" style={{ background: cursor.color }} />
                  <span className="remote-cursor-name" style={{ background: cursor.color }}>
                    {cursor.name}
                  </span>
                </div>
              ))}
            </div>

            {/* Ephemeral floating emoji reactions (never touch the canvas). */}
            <div className="reaction-layer" aria-hidden="true">
              {reactions.map((r) => (
                <span
                  key={r.id}
                  className="reaction-float"
                  style={{ transform: `translate(${r.leftPx}px, ${r.topPx}px)` }}
                >
                  {r.emoji}
                </span>
              ))}
            </div>

            {/* Big "hype" celebration bursts from the chat tray (Twitch-alert
                energy, curated + capped). Pure transform/opacity animation. */}
            {hypes.length > 0 ? (
              <div className="hype-layer" aria-hidden="true">
                {hypes.map((h, i) => (
                  <div key={h.id} className={`hype-burst hype-${h.kind}`} style={{ "--lane": i }}>
                    <span className="hype-emoji">{h.emoji}</span>
                    <span className="hype-bits">
                      <i /><i /><i /><i /><i /><i />
                    </span>
                    {h.name ? <span className="hype-name">{h.name}</span> : null}
                  </div>
                ))}
              </div>
            ) : null}

            {/* "Come look at my frame!" beacon — a friendly tap-to-jump card. */}
            {beacon ? (
              <div className="beacon-card" role="alert">
                <span className="beacon-dot" style={{ background: beacon.color || "#2d6cdf" }} aria-hidden="true" />
                <span className="beacon-text">
                  🔎 <strong>{beacon.name}</strong> wants you on their frame!
                </span>
                <button type="button" className="primary-action beacon-go" onClick={() => acceptBeacon(beacon.target)}>
                  Take me!
                </button>
                <button type="button" className="beacon-dismiss" onClick={() => setBeacon(null)} aria-label="Dismiss">
                  ✕
                </button>
              </div>
            ) : null}

            {/* Reaction picker — cheer on your friends. In paint rooms the
                canvas reaches the viewport bottom, so the fixed mobile
                quickbar (z 70) covered this button; qb-clear lifts it above
                the bar. Animation rooms keep bottom:12 — the film strip
                already holds the canvas clear of the bar. */}
            <div className={`reaction-picker${roomAnimation ? "" : " qb-clear"}`}>
              <button
                type="button"
                className="reaction-toggle"
                onClick={() => setReactionPickerOpen((o) => !o)}
                aria-label="Send a reaction"
                title="Send a reaction"
              >
                😀
              </button>
              {reactionPickerOpen ? (
                <div className="reaction-menu" role="menu">
                  {["👍", "🔥", "❤️", "😂", "🎨", "⭐", "👏", "🌈"].map((e) => (
                    <button key={e} type="button" onClick={() => dropReaction(e)} aria-label={`React ${e}`}>
                      {e}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="zoom-controls" role="group" aria-label="Zoom, pan and quick tools">
              <button type="button" onClick={() => zoomByButton(1 / 1.25)} aria-label="Zoom out">
                −
              </button>
              <button type="button" className="zoom-pct" onClick={fitView} title="Fit whole canvas">
                {zoomPct}%
              </button>
              <button type="button" onClick={() => zoomByButton(1.25)} aria-label="Zoom in">
                +
              </button>
              {/* Quick paint / eraser beside the hand, so hopping out of a pan
                  never means a trip to the tool rail. (Desktop only — the
                  compact tiers already have these on the quick bar.) */}
              <span className="zoom-sep" aria-hidden="true" />
              <button
                type="button"
                className={isPaintActive ? "zoom-tool is-active" : "zoom-tool"}
                onClick={activatePaint}
                aria-pressed={isPaintActive}
                title="Paint (B)"
                aria-label="Paint"
              >
                ✏️
              </button>
              {roomFingerPaint ? null : (
                <button
                  type="button"
                  className={isEraserActive ? "zoom-tool is-active" : "zoom-tool"}
                  onClick={activateEraser}
                  aria-pressed={isEraserActive}
                  title="Eraser (Backspace, or the pen's eraser end)"
                  aria-label="Eraser"
                >
                  🧽
                </button>
              )}
              <button
                type="button"
                className={handTool ? "zoom-hand is-active" : "zoom-hand"}
                onClick={toggleHandTool}
                aria-pressed={handTool}
                title="Pan (Space, hold the pen's barrel button, or scroll — pinch zooms)"
              >
                ✋
              </button>
            </div>

            {roomPrompt && !promptDismissed && !(roomGame && game) && !(roomPhone && phone) ? (
              <div className="room-prompt-chip" role="note">
                <span>🎯 {roomPrompt}</span>
                <button type="button" onClick={() => setPromptDismissed(true)} aria-label="Dismiss prompt">
                  ✕
                </button>
              </div>
            ) : null}

            {/* Public canvas refresh: a live countdown so the reset is never a
                surprise, and two ways out — vote to keep it, or fork it into
                your own private room. */}
            {roomWipe && roomWipe.wipeAt ? (
              <>
                <button
                  type="button"
                  className={`wipe-chip${wipeUrgent ? " is-urgent" : ""}`}
                  onClick={() => setWipePanelOpen((v) => !v)}
                  aria-expanded={wipePanelOpen}
                  title="This public canvas refreshes on a 3-day cycle"
                >
                  🧽 Fresh canvas in <strong>{wipeCountdown}</strong>
                </button>
                {wipePanelOpen ? (
                  <div className="wipe-panel" role="dialog" aria-label="Canvas refresh">
                    <div className="wipe-panel-head">
                      <strong>🧽 Fresh canvas in {wipeCountdown}</strong>
                      <button type="button" onClick={() => setWipePanelOpen(false)} aria-label="Close">✕</button>
                    </div>
                    <p className="wipe-panel-why">
                      Public rooms start over every 3 days so there&rsquo;s always space to draw.
                      Pin anything you love to the <strong>Fridge Wall</strong> to keep it forever.
                    </p>
                    <button
                      type="button"
                      className="wipe-keep-btn"
                      onClick={() => mpRef.current?.sendWipeKeep?.()}
                    >
                      🗳️ Keep this canvas
                      <span className="wipe-keep-count">
                        {roomWipe.keepVotes}/{roomWipe.keepNeeded} votes
                      </span>
                    </button>
                    <button
                      type="button"
                      className="wipe-fork-btn"
                      onClick={() => mpRef.current?.sendForkPrivate?.()}
                    >
                      🔒 Continue in a private room
                      <span className="wipe-fork-sub">Copies this art to a room that&rsquo;s just yours</span>
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}

            {(roomId === "KALEIDO" || (roomAudience && roomAudience !== "kid_safe" && isRoomHost)) ? (
              <div className="symmetry-panel" aria-label="Kaleido symmetry">
                <span aria-hidden="true">🌀</span>
                <select
                  value={roomSymmetry.mode}
                  disabled={roomAudience === "kid_safe"}
                  onChange={(event) => mpRef.current?.sendSetSymmetry?.(event.target.value)}
                  aria-label="Symmetry mode"
                  title={roomAudience === "kid_safe" ? "Kaleido Jam uses four-way symmetry" : "Choose symmetry mode"}
                >
                  <option value="none">Normal</option>
                  <option value="mirror">Mirror</option>
                  <option value="quad">Four-way</option>
                  <option value="radial">Eight-way</option>
                </select>
              </div>
            ) : null}

            {roomQuest ? (
              <QuestPanel
                quest={roomQuest}
                onNominate={(missionId) => mpRef.current?.sendQuestNominate?.(missionId)}
              />
            ) : null}

            {roomOrchestra ? (
              <PaintOrchestraPanel
                enabled={orchestraEnabled}
                muted={orchestraMuted}
                volume={orchestraVolume}
                supported={orchestraRef.current?.isSupported() !== false}
                onEnabledChange={toggleOrchestra}
                onMutedChange={changeOrchestraMute}
                onVolumeChange={changeOrchestraVolume}
              />
            ) : null}

            {roomAudience && roomAudience !== "kid_safe" && !privateNoticeDismissed ? (
              <div
                className="room-prompt-chip"
                role="note"
                style={{ background: "#fff7ed", color: "#9a3412" }}
              >
                <span>🔓 Private room — not auto-moderated like public rooms. Only invite people you know.</span>
                <button type="button" onClick={() => setPrivateNoticeDismissed(true)} aria-label="Dismiss">
                  ✕
                </button>
              </div>
            ) : null}

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

            {/* Draw & Guess HUD — word/timer/scoreboard over the canvas. */}
            {roomGame && game ? (
              <GameHud
                game={game}
                myWord={myWord}
                myId={myUserIdRef.current}
                isHost={isRoomHost}
                pop={gamePop}
                onSkip={() => mpRef.current?.sendGameSkip?.()}
              />
            ) : null}
            {gamePodium ? (
              <div className="game-podium" role="status" aria-label="Match results">
                <div className="game-podium-card">
                  <span className="game-podium-title">🏆 Match over!</span>
                  <ol className="game-podium-list">
                    {gamePodium.standings.map((s, i) => (
                      <li key={`${s.name}-${i}`} className={`game-podium-place is-${i + 1}`}>
                        <span className="game-podium-medal" aria-hidden="true">{["🥇", "🥈", "🥉"][i]}</span>
                        <span className="game-podium-name">{s.name}</span>
                        <span className="game-podium-score">{s.score}</span>
                      </li>
                    ))}
                  </ol>
                  <span className="game-podium-next">New match starting…</span>
                </div>
              </div>
            ) : null}
            {roomPhone && (phone || phoneReveal) ? (
              <DrawPhonePanel
                phone={phone}
                task={phoneTask}
                submitted={phoneSubmitted}
                reveal={phoneReveal}
                isHost={isRoomHost}
                guess={phoneGuess}
                setGuess={setPhoneGuess}
                onSubmitDrawing={submitPhoneDrawing}
                onSubmitGuess={submitPhoneGuess}
                onStart={() => mpRef.current?.sendPhoneStart?.()}
                onSkip={() => mpRef.current?.sendPhoneSkip?.()}
              />
            ) : null}
          </div>

          {storybook ? (
            <StorybookPanel
              storybook={storybook}
              scenes={scenes}
              activeSceneId={activeSceneId}
              isHost={isRoomHost}
              onSelectPage={handleSelectScene}
              onCaption={(sceneId, caption) => mpRef.current?.sendStorybookCaption?.(sceneId, caption)}
              onToggleLock={(sceneId, locked) => mpRef.current?.sendStorybookLock?.(sceneId, locked)}
              onMove={(sceneId, toIndex) => mpRef.current?.sendStorybookMove?.(sceneId, toIndex)}
              onExport={exportStorybook}
            />
          ) : null}

          {roomAnimation && !storybook ? (
            <FilmStrip
              frames={frames}
              activeFrameIndex={activeFrameIndex}
              thumbnails={frameThumbnails}
              isPlaying={isPlaying}
              onionSkin={onionSkin}
              isExporting={isExportingGif}
              isExportingVideo={isExportingVideo}
              hiddenFrameIds={hiddenFrameIds}
              maxFrames={MAX_FRAMES}
              scenes={scenes}
              activeSceneId={activeSceneId}
              canManageScenes={isRoomHost}
              onSelectScene={handleSelectScene}
              onAddScene={() => mpRef.current?.sendSceneAdd?.()}
              onDeleteScene={(sceneId) => mpRef.current?.sendSceneDel?.(sceneId)}
              onSelectFrame={handleSelectFrame}
              onAddFrame={handleAddFrame}
              onDuplicateFrame={handleDuplicateFrame}
              onDeleteFrame={handleDeleteFrame}
              onMoveFrame={handleMoveFrame}
              onDurationChange={handleFrameDurationChange}
              onTogglePlay={handleTogglePlay}
              onToggleOnion={handleToggleOnion}
              onToggleFrameHidden={handleToggleFrameHidden}
              onScrub={handleScrub}
              onScrubEnd={handleScrubEnd}
              onExportGif={exportGif}
              onExportVideo={exportVideo}
              onSaveLoop={saveLoopToSpace}
              onOpenStoryboard={roomAudience !== "kid_safe" ? () => setShowStoryboard(true) : null}
              inProduction={!!production}
              celPresence={celPresence}
              otherSceneCrew={otherSceneCrew}
              onBeacon={() => mpRef.current?.sendBeacon?.(activeSceneIdRef.current, framesRef.current[activeFrameIndexRef.current]?.id)}
              cheers={cheers}
              onCheer={(emoji) => mpRef.current?.sendCheer?.(framesRef.current[activeFrameIndexRef.current]?.id, emoji)}
            />
          ) : null}
        </div>

        {showStoryboard ? (
          <Storyboard
            production={production}
            roomId={roomId}
            isRoomHost={isRoomHost}
            isExportingVideo={isExportingVideo}
            onClose={() => setShowStoryboard(false)}
            onCreate={() => mpRef.current?.sendProductionCreate?.()}
            onAddPart={() => mpRef.current?.sendProductionAddSegment?.()}
            onRename={(title) => mpRef.current?.sendProductionRename?.(title)}
            onJoinPart={(code) => {
              window.location.href = `/join/${code}`;
            }}
            onExportFilm={exportProduction}
          />
        ) : null}

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
                <h2 id="myart-title">
                  🖼️{" "}
                  {session && (session.user?.name || session.user?.email)
                    ? `${session.user.name || session.user.email.split("@")[0]}’s gallery`
                    : "My gallery"}
                </h2>
                <span className="myart-count">
                  {myDrawings.length}/{savesMax} saved
                </span>
                <button type="button" onClick={() => setShowMyArt(false)} aria-label="Close">
                  ✕
                </button>
              </div>

              {session ? (
                <p className="myart-synced">
                  ✅ Signed in — new art you save is kept in your account gallery, so you can sign in
                  on another device to find it.
                </p>
              ) : (
                <div className="gallery-gate">
                  <span className="gallery-gate-emoji" aria-hidden="true">🔒</span>
                  <div className="gallery-gate-body">
                    <strong>Sign up to save your gallery — or it could be lost!</strong>
                    <span>
                      Right now your art only lives on this device. Make a free account so the art you
                      save is kept in your own gallery.
                    </span>
                  </div>
                  <button
                    type="button"
                    className="primary-action gallery-gate-btn"
                    onClick={() => {
                      setShowMyArt(false);
                      setShowAccount(true);
                    }}
                  >
                    Sign up to save →
                  </button>
                </div>
              )}

              {myDrawings.length === 0 ? (
                <p className="myart-empty">
                  No saved drawings yet. Tap <strong>💾 Save</strong> to keep one here — you can come back
                  and open it anytime{session ? ", on any device" : " on this device"}.
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

              {gallery.length > 0 ? (
                <div className="myart-quicksaves">
                  <p className="myart-subhead">Quick saves on this device</p>
                  <div className="myart-quick-grid">
                    {gallery.map((item) => (
                      <button
                        type="button"
                        className="myart-quick-item"
                        key={item.id}
                        onClick={() => {
                          restoreGalleryItem(item);
                          setShowMyArt(false);
                        }}
                        title={`Open ${item.name}`}
                      >
                        <img src={item.preview} alt="" />
                        <span>{item.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="myart-foot">
                <button
                  type="button"
                  onClick={() => {
                    restoreDraft();
                    setShowMyArt(false);
                  }}
                  title="Bring back your last unsaved drawing"
                >
                  ↩︎ Restore last draft
                </button>
                <p className="myart-note">
                  {session
                    ? "New saves are kept in your account gallery."
                    : "Saved on this device only — sign up to keep your gallery safe."}
                </p>
              </div>
            </div>
          </div>
        ) : null}

        {showWelcome ? (
          <div className="modal-backdrop welcome-backdrop" role="presentation" onClick={dismissWelcome}>
            <section
              className="studio-modal welcome-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="welcome-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="welcome-art"><BrandMark showName={false} /></div>
              <h2 id="welcome-title">Welcome to Drawesome!</h2>
              <ol className="welcome-steps">
                <li>
                  <span>1</span> Pick a color
                </li>
                <li>
                  <span>2</span> Draw right on the canvas
                </li>
                <li>
                  <span>3</span> Invite friends to draw live
                </li>
              </ol>
              <button type="button" className="primary-action welcome-go" onClick={dismissWelcome}>
                Start drawing 🎨
              </button>
            </section>
          </div>
        ) : null}

        {showLobby ? (
          <RoomLobby
            token={session?.access_token}
            signedIn={Boolean(session)}
            currentRoom={roomId}
            onJoin={(code) => {
              window.location.href = `/join/${code}`;
            }}
            onHome={() => {
              window.location.href = "/";
            }}
            onToast={showToast}
            onClose={() => setShowLobby(false)}
          />
        ) : null}

        {showReport ? (
          <div className="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="report-title">
            <div className="confirm-card">
              <h2 id="report-title">⚠️ Report this room</h2>
              <p>
                Tell a moderator what&apos;s wrong in <strong>Room {roomId}</strong> (e.g. mean or inappropriate
                drawings). They&apos;ll review it.
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

        {/* Canvas Chat — Twitch × iMessage overlay (finger-paint room: none —
            its audience can't read yet). Ambient bubbles float over the art;
            the open panel carries the room row, votes, and participants. */}
        {roomFingerPaint ? null : (
          <CanvasChat
            open={showChat}
            onOpenChange={setShowChat}
            messages={visibleChat}
            self={mp.self}
            disabled={mutedSelf}
            onSend={mp.sendChat}
            onReact={mp.sendChatReact}
            onHype={mp.sendHype}
            onNameTap={focusChatUser}
            panelExtras={
              <>
                <div className="mp-chat-room">
                  <span className={mp.connected ? "mp-dot mp-dot-on" : "mp-dot"} aria-hidden="true" />
                  <button type="button" className="mp-chat-room-switch" onClick={() => setShowLobby(true)} title="Switch rooms">
                    {roomTitle ? roomTitle : `Room ${roomId}`} <span aria-hidden="true">⌄</span>
                  </button>
                  <span className="mp-chat-room-count">{mp.connected ? `${mp.users.length} painting` : "Connecting…"}</span>
                  <button type="button" className="mp-chat-invite" onClick={inviteFriends}>
                    Invite friends
                  </button>
                  <button type="button" className="mp-chat-iconbtn" onClick={createPrivateRoom} title="Create a private room">
                    🔒
                  </button>
                  <button type="button" className="mp-chat-iconbtn" onClick={() => setShowReport(true)} title="Report something">
                    ⚠️
                  </button>
                  <button
                    type="button"
                    className={`mp-chat-iconbtn mp-wet-toggle${roomWet ? " is-on" : ""}`}
                    onClick={() => mpRef.current?.sendSetWet?.(!roomWet)}
                    disabled={roomAudience === "kid_safe" && !isRoomHost}
                    aria-pressed={roomWet}
                    title={
                      roomAudience === "kid_safe" && !isRoomHost
                        ? "Wet canvas — only a host can switch this in public rooms"
                        : roomWet
                          ? "Wet canvas is ON — paints mix and smear. Tap to dry."
                          : "Wet canvas — make paints mix and smear into each other"
                    }
                  >
                    💧
                  </button>
                  {roomAudience === "kid_safe" && !isRoomHost ? null : (
                    <button
                      type="button"
                      className="mp-chat-iconbtn"
                      onClick={() => mpRef.current?.sendVoteStart?.()}
                      disabled={Boolean(roomVote)}
                      title="Start a 45-second room vote on the next drawing theme"
                    >
                      🗳️
                    </button>
                  )}
                  {isRoomHost ? (
                    <button type="button" className="mp-chat-iconbtn" onClick={() => setShowHostPanel(true)} title="Host controls">
                      ⭐
                    </button>
                  ) : null}
                </div>
                {roomVote ? (
                  <div className="vote-card" role="group" aria-label="Theme vote">
                    <div className="vote-card-head">
                      <span>🗳️ Pick the next theme!</span>
                      <span className="vote-countdown" aria-live="polite">{voteSecondsLeft}s</span>
                    </div>
                    {roomVote.options.map((option, index) => (
                      <button
                        key={option}
                        type="button"
                        className={`vote-option${roomVote.myChoice === index ? " is-picked" : ""}`}
                        onClick={() => {
                          // Optimistic highlight; counts come back via vote_tally.
                          mpRef.current?.sendVote?.(index);
                          setRoomVote((vote) => (vote ? { ...vote, myChoice: index } : vote));
                        }}
                      >
                        <span className="vote-option-text">{option}</span>
                        <span className="vote-option-count">{roomVote.counts?.[index] || 0}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {mp.users.length > 0 ? (
                  <div className="mp-participants" aria-label="People in this room — tap to find them on the canvas">
                    {mp.users.map((u) => {
                      const isSelf = u.id === mp.self?.id;
                      const isHidden = hiddenPainters.has(u.id);
                      return (
                        <span key={u.id} className="mp-participant-row">
                          <button
                            type="button"
                            className={`mp-participant${isSelf ? " is-self" : ""}${isHidden ? " is-hidden" : ""}`}
                            onClick={() => focusUser(u.id)}
                            disabled={isSelf}
                            title={isSelf ? "That's you" : `Find ${u.name} on the canvas`}
                          >
                            <span className="mp-participant-dot" style={{ background: u.color }}>
                              {(u.name || "?").slice(0, 1).toUpperCase()}
                            </span>
                            <span className="mp-participant-name">{isSelf ? "You" : u.name}</span>
                          </button>
                          {!isSelf ? (
                            <button
                              type="button"
                              className={`mp-hide-toggle${isHidden ? " is-on" : ""}`}
                              onClick={() => toggleHiddenPainter(u.id)}
                              title={isHidden ? `Show ${u.name}'s messages again` : `Hide ${u.name}'s messages + cursor (just for you)`}
                              aria-pressed={isHidden}
                              aria-label={isHidden ? `Show ${u.name} again` : `Hide ${u.name} for me`}
                            >
                              {isHidden ? "🙈" : "👁"}
                            </button>
                          ) : null}
                        </span>
                      );
                    })}
                  </div>
                ) : null}
              </>
            }
          />
        )}

        {/* A live theme vote must be visible even with the chat panel closed —
            the same card floats over the canvas until the vote resolves. */}
        {roomVote && !showChat && !roomFingerPaint ? (
          <div className="vote-card cc-vote-floating" role="group" aria-label="Theme vote">
            <div className="vote-card-head">
              <span>🗳️ Pick the next theme!</span>
              <span className="vote-countdown" aria-live="polite">{voteSecondsLeft}s</span>
            </div>
            {roomVote.options.map((option, index) => (
              <button
                key={option}
                type="button"
                className={`vote-option${roomVote.myChoice === index ? " is-picked" : ""}`}
                onClick={() => {
                  mpRef.current?.sendVote?.(index);
                  setRoomVote((vote) => (vote ? { ...vote, myChoice: index } : vote));
                }}
              >
                <span className="vote-option-text">{option}</span>
                <span className="vote-option-count">{roomVote.counts?.[index] || 0}</span>
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <aside
        className={toolsOpen ? "tool-rail is-open" : "tool-rail"}
        aria-label="Drawing tools"
        aria-hidden={layoutTier === "desktop" && !toolsOpen ? true : undefined}
      >
        {/* Desktop: the docked rail's own header with the collapse control.
            (The compact tiers show .drawer-handle instead — CSS swaps them.) */}
        <div className="rail-head">
          <span className="rail-head-title">Tools</span>
          <button
            type="button"
            className="rail-collapse"
            onClick={() => setToolsOpen(false)}
            title="Hide the tools for more canvas (T)"
            aria-label="Hide tools"
          >
            Hide <span aria-hidden="true">›</span>
          </button>
        </div>
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
            <button type="button" onClick={() => { window.location.href = "/"; }}>
              🏠 Home
            </button>
            <button type="button" onClick={() => setShowLobby(true)}>
              🚪 Rooms
            </button>
            <button type="button" onClick={undo} disabled={historyCount === 0}>
              ↶ Undo
            </button>
            <button type="button" onClick={redo} disabled={redoCount === 0}>
              ↷ Redo
            </button>
            <button type="button" onClick={openStepBackPreview} disabled={isPreparingStepBack}>
              {isPreparingStepBack ? "Framing..." : "Preview"}
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
              🖼️ Gallery
            </button>
            <button type="button" onClick={openWallPost} title="Pin your art on the community Fridge Wall">
              🧲 Wall
            </button>
            <button type="button" onClick={shareRoomLink} title="Share a link to this room">
              📤 Share
            </button>
            <button type="button" onClick={openReplay} title="Watch it draw + share a timelapse GIF">
              🎬 Timelapse
            </button>
            <button type="button" onClick={exportPng}>
              Export
            </button>
          </div>
        </section>

        <section className="tool-section mobile-profile" ref={mobileProfileRef}>
          <h2>You</h2>
          {notificationsPanel}
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
          {session ? (
            <button type="button" className="avatar-signout mobile-signout" onClick={handleSignOut}>
              🚪 Sign out
            </button>
          ) : null}
        </section>

        {roomAudience === "kid_safe" ? null : (
          /* Public (kid_safe) rooms are brush-only — with a single forced chip the
             whole section is pointless, so it's hidden there entirely. */
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
                  <span className="chip-ico" aria-hidden="true">{tool.icon}</span>
                  <span className="chip-name">{tool.name}</span>
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
        )}

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
          <button type="button" className="sheet-browse-btn" onClick={() => setShowSheetModal(true)}>
            🎨 {sheetId ? "Change coloring sheet" : "Browse 6,000+ coloring sheets"}
          </button>
          {/* Trace-a-photo: private rooms (friends) or the host of an owned
              public room. The hostless public drawing rooms never see it — a
              photo shows on every screen instantly, so it needs an accountable
              uploader. */}
          {roomAudience !== "kid_safe" || isRoomHost ? (
            <>
              <button
                type="button"
                className="sheet-browse-btn sheet-trace-btn"
                onClick={() => tracePhotoInputRef.current?.click()}
                disabled={traceBusy}
              >
                {traceBusy ? "Checking photo…" : "📷 Trace a photo"}
              </button>
              <input
                ref={tracePhotoInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) handleTracePhotoFile(file);
                  event.target.value = "";
                }}
              />
            </>
          ) : null}
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
            {(roomFingerPaint ? brushCatalog.filter((b) => FINGER_PAINT_BRUSHES.has(b.id)) : brushCatalog).map((brush) => {
              const locked = brush.tier === "studio" && !studioUnlocked;
              // Private-room-only brushes (smudge) render ghosted in public
              // rooms: not selectable, tap explains where they DO work — except
              // the finger-paint room, where smudge is a headline toy.
              const privateGated = Boolean(brush.privateOnly) && roomAudience === "kid_safe" && !roomFingerPaint;
              return (
                <button
                  type="button"
                  key={brush.id}
                  className={`brush-chip ${selectedTool === "brush" && selectedBrush === brush.id ? "is-active" : ""}${privateGated ? " is-private-gated" : ""}`}
                  onClick={() =>
                    privateGated
                      ? showToast("Smudge works in private rooms — start one from Rooms!")
                      : chooseBrush(brush.id)
                  }
                  aria-disabled={privateGated}
                  aria-pressed={selectedTool === "brush" && selectedBrush === brush.id}
                >
                  <BrushPreview brush={brush.id} color={selectedColor} />
                  <span className="chip-name">{brush.name}</span>
                  {locked ? <small>Studio</small> : null}
                  {privateGated ? <small className="chip-private-note">🔒 Private rooms</small> : null}
                </button>
              );
            })}
          </div>
        </section>

        {noColorBrush ? (
          <section className="tool-section rail-top rail-top-2 no-color-note">
            <h2>Color</h2>
            <p className="tool-hint">
              {isSmudgeActive
                ? "👉 Smudge works with the paint that's already on the canvas — no colour needed. Pick Smudge or Blend and set how hard it pushes with Strength below."
                : "🧽 The eraser clears back to paper — no colour needed."}
            </p>
          </section>
        ) : (
          <section className="tool-section rail-top rail-top-2">
            <h2>Color</h2>
            <div className={`palette-grid ${selectedTool === "brush" && selectedBrush === "crayon" ? "crayons-mode" : ""}`}>
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
        )}

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
                  <span className="chip-ico" aria-hidden="true">{texture.icon}</span>
                  <span className="chip-name">{texture.name}</span>
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
            <input
              type="range"
              min="2"
              max="120"
              value={brushSize}
              aria-label="Brush size"
              aria-valuetext={`${brushSize} pixels`}
              onChange={(event) => setBrushSize(Number(event.target.value))}
            />
            <output>{brushSize}</output>
          </label>
          {isSmudgeActive ? (
            <div className="smudge-mode" role="group" aria-label="Smudge mode">
              <div className="seg-toggle">
                <button
                  type="button"
                  className={smudgeMode === "drag" ? "is-on" : ""}
                  aria-pressed={smudgeMode === "drag"}
                  onClick={() => setSmudgeMode("drag")}
                >
                  Smudge
                </button>
                <button
                  type="button"
                  className={smudgeMode === "blend" ? "is-on" : ""}
                  aria-pressed={smudgeMode === "blend"}
                  onClick={() => setSmudgeMode("blend")}
                >
                  Blend
                </button>
              </div>
              <p className="tool-hint">
                {smudgeMode === "drag"
                  ? "Smudge pulls paint along with your finger — colours travel and fade out."
                  : "Blend softens the paint where you rub — edges melt without moving."}
              </p>
            </div>
          ) : null}
          {isSmudgeActive ? (
            <label>
              <span>Strength</span>
              <input
                type="range"
                min="5"
                max="95"
                value={Math.round(smudgeStrength * 100)}
                aria-label="Smudge strength"
                aria-valuetext={`${Math.round(smudgeStrength * 100)} percent`}
                onChange={(event) => setSmudgeStrength(Number(event.target.value) / 100)}
              />
              <output>{Math.round(smudgeStrength * 100)}%</output>
            </label>
          ) : (
            <label>
              <span>Opacity</span>
              <input
                type="range"
                min="8"
                max="100"
                value={Math.round(brushOpacity * 100)}
                aria-label="Brush opacity"
                aria-valuetext={`${Math.round(brushOpacity * 100)} percent`}
                onChange={(event) => setBrushOpacity(Number(event.target.value) / 100)}
              />
              <output>{Math.round(brushOpacity * 100)}%</output>
            </label>
          )}
          {isSmudgeActive ? null : (
            <label>
              <span>Variation</span>
              <input
                type="range"
                min="0"
                max="40"
                value={Math.round(brushVariation * 100)}
                aria-label="Brush variation"
                aria-valuetext={`${Math.round(brushVariation * 100)} percent`}
                onChange={(event) => setBrushVariation(Number(event.target.value) / 100)}
              />
              <output>{Math.round(brushVariation * 100)}%</output>
            </label>
          )}
          {selectedTool === "text" ? (
            <label>
              <span>Text size</span>
              <input
                type="range"
                min="12"
                max="240"
                value={textSize}
                aria-label="Text size"
                aria-valuetext={`${textSize} pixels`}
                onChange={(event) => setTextSize(Number(event.target.value))}
              />
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
        {roomFingerPaint ? null : (
          <button
            type="button"
            className={isEraserActive ? "qb-btn is-active" : "qb-btn"}
            onClick={activateEraser}
            aria-pressed={isEraserActive}
          >
            <span className="qb-ico" aria-hidden="true">🧽</span>
            <span className="qb-label">Eraser</span>
          </button>
        )}
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
        {roomFingerPaint ? null : (
          <button
            type="button"
            className={showChat ? "qb-btn is-active" : "qb-btn"}
            onClick={() => setShowChat((open) => !open)}
            aria-pressed={showChat}
          >
            <span className="qb-ico" aria-hidden="true">💬</span>
            <span className="qb-label">Chat</span>
          </button>
        )}
      </div>
      {toolsOpen ? <div className="tools-backdrop" onClick={() => setToolsOpen(false)} aria-hidden="true" /> : null}

      {stepBackPreview ? <StepBackPreview preview={stepBackPreview} onClose={closeStepBackPreview} /> : null}

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

      {showHostPanel && isRoomHost ? (
        <HostControlPanel
          roomId={roomId}
          roomTitle={roomTitle}
          locked={roomLocked}
          isOwner={isRoomOwner}
          users={mp.users}
          selfId={mp.self?.id}
          onLock={mp.sendLock}
          onUnlock={mp.sendUnlock}
          onRenameRoom={(name) => mp.sendRenameRoom(name)}
          onClear={() => {
            if (window.confirm("Clear the whole canvas for everyone in this room?")) mp.sendClear();
          }}
          onMute={(id, muted) => mp.sendMute(id, muted)}
          onKick={(id) => {
            if (window.confirm("Remove this painter from the room?")) mp.sendKick(id);
          }}
          onPromote={(id) => mp.sendPromote(id)}
          onDemote={(id) => mp.sendDemote(id)}
          alerts={modAlerts}
          onHide={(opIds) => mp.sendModHide(opIds)}
          onRestore={(opIds) => mp.sendModRestore(opIds)}
          onRemove={(opIds) => mp.sendModRemove(opIds)}
          onDismissAlert={(id) => setModAlerts((list) => list.filter((a) => a.id !== id))}
          onClose={() => setShowHostPanel(false)}
        />
      ) : null}

      {kicked ? (
        <div className="modal-backdrop" role="presentation">
          <section className="studio-modal" role="dialog" aria-modal="true">
            <h2>You were removed</h2>
            <p className="account-note">A host removed you from this room.</p>
            <div className="account-actions">
              <button type="button" className="primary-action" onClick={() => { window.location.href = "/"; }}>
                Back to home
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {roomFull || roomBlocked ? (
        <div className="modal-backdrop" role="presentation">
          <section className="studio-modal" role="dialog" aria-modal="true">
            <h2>{roomFull ? "This room is packed! 🎨" : "This room isn't available"}</h2>
            <p className="account-note">
              {roomFull
                ? "Too many artists are painting in here right now — grab a spot somewhere else."
                : "This room isn't available. Find another one or start your own."}
            </p>
            <div className="account-actions">
              <button
                type="button"
                className="primary-action"
                onClick={() => {
                  setRoomFull(false);
                  setRoomBlocked(false);
                  setShowLobby(true);
                }}
              >
                Find another room
              </button>
              <button type="button" onClick={createPrivateRoom}>
                Start my own room
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {showSheetModal ? (
        <ColoringSheetModal onClose={() => setShowSheetModal(false)} onApply={applyLibrarySheet} />
      ) : null}

      {wallPostDraft ? (
        <WallPostModal
          draft={wallPostDraft}
          defaultArtist={nameDraft || mp.self?.name || ""}
          room={roomId}
          remixSource={remixSource}
          onClose={() => setWallPostDraft(null)}
          onPosted={() => {
            setWallPostDraft(null);
            showToast(roomId === "DAILY" ? "In today's gallery! 🗓️ It's on the homepage" : "On the wall! 🧲 See it at drawesome.art/wall");
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
          onShareTimelapse={shareTimelapse}
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
          onSaveImportedBrushes={handleSaveImportedBrushes}
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
    // Key by room so switching rooms always remounts StudioApp with a fresh
    // canvas/socket instead of reusing the previous room's instance.
    return <StudioApp key="room-MAIN" initialPrompt={readPromptParam()} />;
  }

  if (path.startsWith("/join")) {
    const code = normalizePathCode(path) || "MAIN";
    return <StudioApp key={`room-${code}`} initialJoinCode={code} />;
  }

  if (path.startsWith("/admin")) {
    return <LiveAdmin onNavigate={navigate} />;
  }

  if (path.startsWith("/safety")) {
    return <SafetyPage onNavigate={navigate} />;
  }

  if (path.startsWith("/parents")) {
    return <ParentsPage onNavigate={navigate} />;
  }

  if (path.startsWith("/faq")) {
    return <FaqPage onNavigate={navigate} />;
  }

  if (path.startsWith("/about")) {
    return <AboutPage onNavigate={navigate} />;
  }

  if (path.startsWith("/privacy")) {
    return <PrivacyPage onNavigate={navigate} />;
  }

  if (path.startsWith("/signup")) {
    return <SignupPage onNavigate={navigate} />;
  }

  if (path.startsWith("/rooms")) {
    return <RoomFinderPage onNavigate={navigate} />;
  }

  if (path.startsWith("/wall")) {
    // /wall/:id deep-links open the wall with that post spotlighted — the URL
    // every wall share button hands out.
    const [, , postId = ""] = path.split("/");
    return <WallPage onNavigate={navigate} initialPostId={postId.slice(0, 64)} />;
  }

  return <HomePage onNavigate={navigate} />;
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
