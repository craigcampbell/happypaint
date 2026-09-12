// Film timing shared by playback, both video exporters and the storyboard.
//
// Minutes-long films come from TIME, not just from more frames: a frame can
// HOLD for up to 10s, a scene can LOOP up to 20 times (a walk cycle, rain,
// a flickering candle), and a scene can carry a CAMERA move (a slow pan or
// zoom over a still) — none of which costs a single extra canvas.
//
// A "plan" is the flat list of shots the film shows in order. Every consumer
// (studio playback, exportVideo, exportProduction) walks the same plan so what
// you preview is what you export.

export const MAX_FRAME_MS = 10000;
export const MIN_FRAME_MS = 40;
export const MAX_SCENE_LOOPS = 20;

// The hold slider steps through these (a linear 40–10000ms range is unusable:
// the whole "animation" band would sit in the first few pixels).
export const HOLD_STEPS = [40, 60, 80, 100, 120, 160, 200, 250, 330, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000, 7500, 10000];

export const CAMERA_PRESETS = [
  { id: "none", label: "Still", emoji: "🎥" },
  { id: "pan-right", label: "Pan →", emoji: "➡️" },
  { id: "pan-left", label: "Pan ←", emoji: "⬅️" },
  { id: "pan-down", label: "Tilt ↓", emoji: "⬇️" },
  { id: "pan-up", label: "Tilt ↑", emoji: "⬆️" },
  { id: "zoom-in", label: "Zoom in", emoji: "🔍" },
  { id: "zoom-out", label: "Zoom out", emoji: "🔎" },
];
const CAMERA_IDS = new Set(CAMERA_PRESETS.map((c) => c.id));

export function normalizeCamera(id) {
  return CAMERA_IDS.has(id) ? id : "none";
}
export function normalizeLoops(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(1, Math.min(MAX_SCENE_LOOPS, n)) : 1;
}
export function clampHold(ms) {
  const n = Number(ms);
  return Number.isFinite(n) ? Math.max(MIN_FRAME_MS, Math.min(MAX_FRAME_MS, Math.round(n))) : 120;
}

// Nearest slider step for a duration (so an externally-set 333ms lands on 330).
export function holdStepIndex(ms) {
  let best = 0;
  for (let i = 1; i < HOLD_STEPS.length; i += 1) {
    if (Math.abs(HOLD_STEPS[i] - ms) < Math.abs(HOLD_STEPS[best] - ms)) best = i;
  }
  return best;
}

export function formatHold(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(s < 10 ? 2 : 1).replace(/\.?0+$/, "")}s`;
}

export function formatRuntime(ms) {
  if ((ms || 0) < 10000) return `${((ms || 0) / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  const total = Math.round((ms || 0) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

// One pass of a scene's frames, in ms.
export function scenePassMs(scene) {
  return (scene?.frames || []).reduce((sum, f) => sum + clampHold(f.durationMs || 120), 0);
}
// A scene's full runtime including its loops.
export function sceneRuntimeMs(scene) {
  return scenePassMs(scene) * normalizeLoops(scene?.loops);
}
export function filmRuntimeMs(scenes) {
  return (scenes || []).reduce((sum, s) => sum + sceneRuntimeMs(s), 0);
}

// Expand scenes ([{id, name, loops, camera, frames:[{id, durationMs}]}]) into
// the ordered list of shots. `cameraT0`/`cameraT1` are the camera's progress
// (0..1 across the whole looped scene) at the shot's start and end, so a pan
// keeps gliding across every loop instead of snapping back each pass.
export function buildFilmPlan(scenes) {
  const plan = [];
  for (const scene of scenes || []) {
    const frames = scene.frames || [];
    if (!frames.length) continue;
    const loops = normalizeLoops(scene.loops);
    const camera = normalizeCamera(scene.camera);
    const total = scenePassMs(scene) * loops || 1;
    let elapsed = 0;
    for (let pass = 0; pass < loops; pass += 1) {
      for (const meta of frames) {
        const durationMs = clampHold(meta.durationMs || 120);
        plan.push({
          sceneId: scene.id,
          frameId: meta.id,
          durationMs,
          camera,
          cameraT0: elapsed / total,
          cameraT1: (elapsed + durationMs) / total,
        });
        elapsed += durationMs;
      }
    }
  }
  return plan;
}

// Ease so pans/zooms start and end gently (kids' films read as "cinematic").
function ease(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

// The window of the full picture the camera shows at progress t, as fractions
// of the source (x, y, w, h in 0..1). Pans glide a 75% window across; zooms
// go between the full picture and a 55% centre crop.
export function cameraWindow(camera, t) {
  const p = ease(t);
  switch (normalizeCamera(camera)) {
    case "pan-right": return { x: 0.25 * p, y: 0.125, w: 0.75, h: 0.75 };
    case "pan-left": return { x: 0.25 * (1 - p), y: 0.125, w: 0.75, h: 0.75 };
    case "pan-down": return { x: 0.125, y: 0.25 * p, w: 0.75, h: 0.75 };
    case "pan-up": return { x: 0.125, y: 0.25 * (1 - p), w: 0.75, h: 0.75 };
    case "zoom-in": { const s = 1 - 0.45 * p; return { x: (1 - s) / 2, y: (1 - s) / 2, w: s, h: s }; }
    case "zoom-out": { const s = 0.55 + 0.45 * p; return { x: (1 - s) / 2, y: (1 - s) / 2, w: s, h: s }; }
    default: return { x: 0, y: 0, w: 1, h: 1 };
  }
}

// Set `ctx`'s transform so drawing the whole picture at (0,0,width,height)
// shows only the camera's window — lets a layer stack composite straight
// through the camera with no scratch canvas. Reset with ctx.setTransform(1,0,0,1,0,0).
export function applyCameraTransform(ctx, camera, t, width, height) {
  const win = cameraWindow(camera, t);
  if (win.w >= 1 && win.h >= 1) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return;
  }
  ctx.setTransform(1 / win.w, 0, 0, 1 / win.h, (-win.x * width) / win.w, (-win.y * height) / win.h);
}

// Draw `source` (a canvas/bitmap holding the whole picture) into `ctx` at
// (0,0,width,height) through the camera. `t` is the progress across the scene.
export function drawThroughCamera(ctx, source, camera, t, width, height) {
  const win = cameraWindow(camera, t);
  if (win.w >= 1 && win.h >= 1) {
    ctx.drawImage(source, 0, 0, width, height);
    return;
  }
  const sw = source.width;
  const sh = source.height;
  ctx.drawImage(source, win.x * sw, win.y * sh, win.w * sw, win.h * sh, 0, 0, width, height);
}
