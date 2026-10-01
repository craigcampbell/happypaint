// The spinning painterly globe: a true orthographic sphere painted on a 2D
// canvas — washed ocean, per-country paint coats with brush glazes that rotate
// WITH the land, wet-edge rims, limb shade and paper grain, paint drips
// hanging off the busiest countries onto the paper below.
//
// Interaction: auto-spins (pause/play button), pointer drag with a sensible
// tap-vs-drag threshold (tap selects, drag spins), hover card on fine
// pointers, and a keyboard country <select> so back-hemisphere and tiny
// nations stay reachable. Everything derives from the real /api/planet
// payload. prefers-reduced-motion: no auto-spin, no drip animation, no
// inertia. Motion stops entirely when the canvas is offscreen or the tab is
// hidden.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import geo from "../../data/world-geo.json";
import { hashCode, mix } from "../paintUtils.js";
import { PAINT, UNPAINTED, appendSegToPath2D, buildGlobePrep, clipRing, normalizeLon, paperSplats, project, waveDashes } from "./sphere.js";

const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString() : "0");
const flagEmoji = (code) => String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
const nameOf = (code) => geo.names[code] || code;

const SPIN_DEG_PER_S = 3.0;
const TAP_SLOP = 7; // px: below this a press is a tap, not a drag
const LAT_LIMIT = 62;

// ---- one-off canvas textures (deterministic) --------------------------------
function grainCanvas() {
  const c = document.createElement("canvas");
  c.width = 160; c.height = 160;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(160, 160);
  let a = 991;
  const next = () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; };
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 205 + Math.floor(next() * 50);
    img.data[i] = v; img.data[i + 1] = v - 8; img.data[i + 2] = v - 22;
    img.data[i + 3] = 26 + Math.floor(next() * 30);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
function hatchCanvas() {
  const c = document.createElement("canvas");
  c.width = 9; c.height = 9;
  const ctx = c.getContext("2d");
  ctx.strokeStyle = "rgba(122, 90, 58, 0.4)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-2, 11); ctx.lineTo(11, -2);
  ctx.moveTo(-2, 6.5); ctx.lineTo(6.5, -2);
  ctx.stroke();
  return c;
}

const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - ((-2 * k + 2) ** 3) / 2);

function PainterlyGlobe({ countries, flags, live, total, reduced, onOpen }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const [size, setSize] = useState(0); // css px width of the square-ish canvas
  const [hover, setHover] = useState(null); // { code, x, y }
  const [pinned, setPinned] = useState(null); // { code, x, y }
  const [paused, setPaused] = useState(false);

  const rotRef = useRef({ lon: -24, lat: 20, vel: 0 });
  const dragRef = useRef(null);
  const clockRef = useRef(0); // seconds of drip/live animation time
  const animRef = useRef(null); // rotate-to-country tween
  const rafRef = useRef(0);
  const lastTsRef = useRef(0);
  const runningRef = useRef(false);
  const visibleRef = useRef(true);
  const frameRef = useRef({ hits: [], R: 0, cx: 0, cy: 0, dpr: 1 });
  const texRef = useRef(null);
  const stateRef = useRef(null); // latest render inputs for the draw loop

  const prep = useMemo(() => buildGlobePrep(countries, geo), [countries]);
  const flagSet = useMemo(() => new Set(flags), [flags]);
  const waves = useMemo(waveDashes, []);
  const splats = useMemo(
    () => paperSplats(countries.filter((c) => c.count > 0).map((c) => c.code), (code) => prep.items.get(code)?.fill || "#ee8a3c"),
    [countries, prep],
  );
  const coarsePointer = typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)")?.matches;

  stateRef.current = { prep, flagSet, live, hover, pinned, paused, reduced, size, waves, splats };

  // ---- the painter -----------------------------------------------------------
  const draw = useCallback(() => {
    const s = stateRef.current;
    const canvas = canvasRef.current;
    if (!canvas || !s.size) return;
    const ctx = canvas.getContext("2d");
    const dpr = frameRef.current.dpr || 1;
    const W = s.size;
    const H = Math.round(s.size * 1.14);
    const cx = W / 2;
    const cy = W * 0.47;
    const R = W * 0.415;
    const pxPerDeg = R * (Math.PI / 180);
    const rot = rotRef.current;
    const clock = clockRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    if (!texRef.current) texRef.current = { grain: grainCanvas(), hatch: hatchCanvas() };

    // paint flecks on the paper under the globe
    for (const sp of s.splats) {
      ctx.globalAlpha = sp.opacity;
      ctx.fillStyle = sp.color;
      ctx.beginPath();
      ctx.ellipse(sp.x * W, sp.y * H, sp.rx, sp.ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // grounded shadow under the sphere
    const shadow = ctx.createRadialGradient(cx, cy + R * 0.99, R * 0.2, cx, cy + R * 0.99, R * 0.95);
    shadow.addColorStop(0, "rgba(58, 36, 20, 0.22)");
    shadow.addColorStop(1, "rgba(58, 36, 20, 0)");
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.ellipse(cx, cy + R * 1.0, R * 0.95, R * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();

    const hits = [];
    const lowPts = new Map(); // painted code -> lowest visible screen point

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();

    // ocean wash
    const sea = ctx.createRadialGradient(cx - R * 0.4, cy - R * 0.45, R * 0.1, cx, cy, R * 1.2);
    sea.addColorStop(0, "#e8f5f1");
    sea.addColorStop(0.45, "#a5d6de");
    sea.addColorStop(1, "#5ea8c2");
    ctx.fillStyle = sea;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

    // wave dashes (land covers the strays)
    for (const w of s.waves) {
      const p = project(w.lon, w.lat, rot.lon, rot.lat);
      if (p.z < 0.05) continue;
      const x = cx + p.x * R;
      const y = cy + p.y * R;
      const len = w.len * pxPerDeg;
      const dx = Math.cos(w.drift);
      const dy = Math.sin(w.drift);
      ctx.globalAlpha = w.opacity;
      ctx.strokeStyle = w.color;
      ctx.lineWidth = Math.max(1, R * 0.006);
      ctx.beginPath();
      ctx.moveTo(x - (len / 2) * dx, y - (len / 2) * dy);
      ctx.quadraticCurveTo(x - w.amp * dy * pxPerDeg * 0.4, y + w.amp * dx * pxPerDeg * 0.4, x + (len / 2) * dx, y + (len / 2) * dy);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // countries
    for (const item of s.prep.items.values()) {
      const path = new Path2D();
      let any = false;
      for (const ring of item.rings) {
        const segs = clipRing(ring, rot.lon, rot.lat);
        for (const seg of segs) {
          any = true;
          appendSegToPath2D(path, seg, cx, cy, R); // closes limb cuts along the horizon arc
          for (let i = 1; i < seg.length; i += 1) {
            const y = cy + seg[i][1] * R;
            if (item.drips && seg[i][1] > 0.1 && seg[i][1] < 0.97) {
              const low = lowPts.get(item.code);
              if (!low || y > low.y) lowPts.set(item.code, { x: cx + seg[i][0] * R, y });
            }
          }
        }
      }
      if (!any) continue;
      const cProj = project(item.center[0], item.center[1], rot.lon, rot.lat);
      const hit = { code: item.code, path, cx: cx + cProj.x * R, cy: cy + cProj.y * R, front: cProj.z > 0 };
      hits.push(hit);

      if (item.t > 0) {
        // base coat + brush glazes clipped to the shape
        ctx.globalAlpha = 0.96;
        ctx.fillStyle = item.fill;
        ctx.fill(path);
        ctx.globalAlpha = 1;
        ctx.save();
        ctx.clip(path);
        for (const bucket of item.glazes) {
          ctx.strokeStyle = bucket.color;
          for (const st of bucket.strokes) {
            const a = project(st[0], st[1], rot.lon, rot.lat);
            const b = project(st[2], st[3], rot.lon, rot.lat);
            const c2 = project(st[4], st[5], rot.lon, rot.lat);
            if (a.z < -0.02 || b.z < -0.02 || c2.z < -0.02) continue;
            ctx.globalAlpha = Math.min(0.85, st[7]);
            ctx.lineWidth = Math.min(16, Math.max(1.1, st[6] * pxPerDeg));
            ctx.beginPath();
            ctx.moveTo(cx + a.x * R, cy + a.y * R);
            ctx.quadraticCurveTo(cx + b.x * R, cy + b.y * R, cx + c2.x * R, cy + c2.y * R);
            ctx.stroke();
          }
        }
        ctx.restore();
        ctx.globalAlpha = 1;
      } else {
        // bare paper + pencil hatching for the countries nobody painted yet
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = item.fill;
        ctx.fill(path);
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = ctx.createPattern(texRef.current.hatch, "repeat");
        ctx.fill(path);
        ctx.globalAlpha = 1;
      }
      // wet edge: pigment pools darker at the rim
      ctx.strokeStyle = mix(item.fill, "#3a2418", 0.55);
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = Math.max(0.8, R * 0.004);
      ctx.stroke(path);
      ctx.globalAlpha = 1;
    }

    // active tiny-nation dabs
    for (const d of s.prep.dots) {
      if (!d.count) continue;
      const p = project(d.center[0], d.center[1], rot.lon, rot.lat);
      if (p.z < 0.05) continue;
      const x = cx + p.x * R;
      const y = cy + p.y * R;
      ctx.fillStyle = d.fill;
      ctx.strokeStyle = "rgba(74,31,42,0.75)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(3, R * 0.016), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      hits.push({ code: d.code, dot: { x, y, r: 9 }, cx: x, cy: y, front: true });
    }

    // limb shade + directional light + paper grain
    const limb = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R);
    limb.addColorStop(0, "rgba(20, 42, 62, 0)");
    limb.addColorStop(1, "rgba(20, 42, 62, 0.30)");
    ctx.fillStyle = limb;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    const shade = ctx.createLinearGradient(cx - R, cy - R, cx + R * 0.8, cy + R * 0.9);
    shade.addColorStop(0, "rgba(255, 250, 235, 0.14)");
    shade.addColorStop(0.5, "rgba(0,0,0,0)");
    shade.addColorStop(1, "rgba(64, 34, 22, 0.16)");
    ctx.fillStyle = shade;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    const gloss = ctx.createRadialGradient(cx - R * 0.42, cy - R * 0.48, 0, cx - R * 0.42, cy - R * 0.48, R * 0.6);
    gloss.addColorStop(0, "rgba(255,255,255,0.30)");
    gloss.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gloss;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = ctx.createPattern(texRef.current.grain, "repeat");
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    ctx.globalAlpha = 1;
    ctx.restore();

    // hand-inked rim: one clean line + a few broken brush arcs
    ctx.strokeStyle = "rgba(33, 60, 80, 0.55)";
    ctx.lineWidth = Math.max(1.4, R * 0.007);
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(33, 60, 80, 0.28)";
    ctx.lineWidth = Math.max(2.2, R * 0.012);
    for (const [a0, a1] of [[-0.4, 1.1], [1.6, 2.4], [3.4, 4.6], [5.1, 5.9]]) {
      ctx.beginPath();
      ctx.arc(cx, cy, R + Math.max(1, R * 0.006), a0, a1);
      ctx.stroke();
    }

    // wet drips hanging off the busiest painted countries
    for (const [code, low] of lowPts) {
      const item = s.prep.items.get(code);
      if (!item || !item.drips) continue;
      for (const drip of item.drips) {
        const k = s.reduced ? 0.6 : 0.78 + 0.22 * Math.sin(clock * 0.7 + drip.phase);
        const len = drip.len * (R / 300) * k;
        if (len < 4) continue;
        const w = drip.width * (R / 300);
        const x = low.x + (drip.along - 0.5) * 14;
        const y = low.y;
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = drip.color;
        ctx.beginPath();
        ctx.moveTo(x - w, y);
        ctx.quadraticCurveTo(x - w * 0.9, y + len * 0.55, x - w * 0.32, y + len);
        ctx.quadraticCurveTo(x, y + len + w * 0.9, x + w * 0.32, y + len);
        ctx.quadraticCurveTo(x + w * 0.9, y + len * 0.55, x + w, y);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 0.4;
        ctx.strokeStyle = "#fffbe6";
        ctx.lineWidth = Math.max(0.7, w * 0.22);
        ctx.beginPath();
        ctx.moveTo(x - w * 0.35, y + len * 0.18);
        ctx.quadraticCurveTo(x - w * 0.4, y + len * 0.6, x - w * 0.1, y + len * 0.86);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // live painters: a pulsing brush tip over countries with an active flag room
    for (const [code, v] of Object.entries(s.live)) {
      if (!v || v.painting <= 0) continue;
      const hit = hits.find((h) => h.code === code && h.front);
      if (!hit) continue;
      const phase = s.reduced ? 0.5 : (clock / 1.8 + (hashCode(code) % 100) / 100) % 1;
      ctx.fillStyle = "#16a34a";
      ctx.beginPath();
      ctx.arc(hit.cx, hit.cy, Math.max(3, R * 0.014), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#22c55e";
      ctx.globalAlpha = s.reduced ? 0.35 : 0.55 * (1 - phase);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(hit.cx, hit.cy, 5 + phase * 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // hover / pinned selection ring (dashed ink, drawn over everything)
    const selCode = s.hover?.code || s.pinned?.code;
    if (selCode) {
      const hit = hits.find((h) => h.code === selCode);
      if (hit && hit.path) {
        ctx.strokeStyle = "rgba(255,255,255,0.75)";
        ctx.lineWidth = 3;
        ctx.stroke(hit.path);
        ctx.strokeStyle = "#2a1b12";
        ctx.lineWidth = 1.7;
        ctx.setLineDash([5, 3]);
        ctx.stroke(hit.path);
        ctx.setLineDash([]);
      } else if (hit && hit.dot) {
        ctx.strokeStyle = "#2a1b12";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.arc(hit.dot.x, hit.dot.y, hit.dot.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    frameRef.current.hits = hits;
    frameRef.current.R = R;
    frameRef.current.cx = cx;
    frameRef.current.cy = cy;
  }, []);

  // ---- loop control ----------------------------------------------------------
  const drawRef = useRef(draw);
  drawRef.current = draw;

  const tick = useCallback((ts) => {
    rafRef.current = 0;
    const s = stateRef.current;
    const dt = Math.min(0.1, Math.max(0.001, (ts - (lastTsRef.current || ts)) / 1000));
    lastTsRef.current = ts;
    const rot = rotRef.current;
    const still = s.reduced || s.paused;
    const dragging = !!dragRef.current?.moved;
    const spinFree = !still && !dragging && !s.hover && !s.pinned;

    if (animRef.current) {
      const a = animRef.current;
      // reduced motion / pause mid-tween: settle instantly, don't keep moving
      const k = still ? 1 : easeInOut(Math.min(1, (ts - a.t0) / a.dur));
      rot.lon = a.from.lon + a.dLon * k;
      rot.lat = a.from.lat + (a.to.lat - a.from.lat) * k;
      if (k >= 1) {
        animRef.current = null;
        rot.lon = normalizeLon(rot.lon);
        // park the pinned card over the country now that it faces us
        const item = s.prep.items.get(s.pinned?.code) || s.prep.dots.find((d) => d.code === s.pinned?.code);
        if (item && s.pinned) {
          const p = project(item.center[0], item.center[1], rot.lon, rot.lat);
          const f = frameRef.current;
          setPinned((cur) => (cur ? { ...cur, x: f.cx + p.x * f.R, y: f.cy + p.y * f.R } : cur));
        }
      }
    } else if (spinFree) {
      rot.lon = normalizeLon(rot.lon + (SPIN_DEG_PER_S + rot.vel) * dt);
      rot.vel *= Math.pow(0.12, dt);
      if (Math.abs(rot.vel) < 0.4) rot.vel = 0;
    }
    if (!still) clockRef.current += dt;
    drawRef.current();

    const wantMore = !!animRef.current || spinFree || !still;
    if (wantMore && visibleRef.current && !document.hidden) {
      rafRef.current = requestAnimationFrame(tick);
    } else {
      runningRef.current = false;
    }
  }, []);

  const syncLoop = useCallback(() => {
    const s = stateRef.current;
    const still = s.reduced || s.paused;
    const want = (!!animRef.current || !still) && visibleRef.current && !document.hidden;
    if (want && (!runningRef.current || rafRef.current === 0)) {
      runningRef.current = true;
      lastTsRef.current = 0;
      rafRef.current = requestAnimationFrame(tick);
    } else if (!want && runningRef.current) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      runningRef.current = false;
      drawRef.current(); // one settled static frame
    }
  }, [tick]);

  // redraw / reschedule whenever inputs change
  useEffect(() => {
    syncLoop();
    if (!runningRef.current) drawRef.current();
  });

  // stop motion when offscreen or the tab hides
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const io = new IntersectionObserver((entries) => {
      visibleRef.current = entries[0]?.isIntersecting !== false;
      syncLoop();
    }, { threshold: 0.05 });
    io.observe(el);
    const onVis = () => syncLoop();
    document.addEventListener("visibilitychange", onVis);
    return () => { io.disconnect(); document.removeEventListener("visibilitychange", onVis); };
  }, [syncLoop]);

  // resize: canvas is square-ish, sized by its container
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => {
      const w = Math.min(680, el.clientWidth);
      if (w > 0) setSize((cur) => (Math.abs(cur - w) > 1 ? w : cur));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size) return;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    frameRef.current.dpr = dpr;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * 1.14 * dpr);
    drawRef.current();
  }, [size]);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    runningRef.current = false; // so a StrictMode remount restarts the loop
  }, []);

  // dev-only handle for the verify scripts (never in production bundles)
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    window.__globeDebug = {
      rotRef, runningRef, clockRef, visibleRef, frameRef, animRef,
      redraw: () => drawRef.current(),
    };
    return () => { delete window.__globeDebug; };
  }, []);

  // ---- picking ---------------------------------------------------------------
  const pick = useCallback((x, y) => {
    const f = frameRef.current;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return null;
    // isPointInPath interprets (x, y) in the CURRENT transform, and the ctx
    // keeps the DPR scale from draw() — CSS pointer coords would land dpr×
    // off. Reset to identity so CSS-pixel path coords match CSS-pointer coords.
    ctx.save();
    ctx.resetTransform();
    let found = null;
    for (let i = f.hits.length - 1; i >= 0; i -= 1) {
      const h = f.hits[i];
      if (h.dot) {
        if (Math.hypot(x - h.dot.x, y - h.dot.y) <= h.dot.r) { found = h; break; }
      } else if (h.path && ctx.isPointInPath(h.path, x, y)) {
        found = h;
        break;
      }
    }
    ctx.restore();
    return found;
  }, []);

  const localPoint = (e) => {
    const box = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };

  const onPointerDown = useCallback((e) => {
    if (e.button > 0) return;
    const p = localPoint(e);
    dragRef.current = { x0: p.x, y0: p.y, x: p.x, y: p.y, moved: false, t: performance.now() };
    canvasRef.current.setPointerCapture?.(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e) => {
    const p = localPoint(e);
    const d = dragRef.current;
    if (d) {
      const total = Math.hypot(p.x - d.x0, p.y - d.y0);
      if (!d.moved && total > TAP_SLOP) {
        d.moved = true;
        setHover(null);
      }
      if (d.moved) {
        const f = frameRef.current;
        const now = performance.now();
        const dt = Math.max(8, now - d.t) / 1000;
        const rot = rotRef.current;
        const perPx = 1 / (f.R * (Math.PI / 180));
        // natural drag: content follows the pointer. With the corrected
        // projection (north renders up), dragging down pulls the view north
        // (rot.lat grows) and dragging right spins the view west.
        rot.lon = normalizeLon(rot.lon - (p.x - d.x) * perPx);
        rot.lat = Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, rot.lat + (p.y - d.y) * perPx));
        rot.vel = Math.max(-40, Math.min(40, (-(p.x - d.x) * perPx) / dt));
        d.x = p.x; d.y = p.y; d.t = now;
        if (!runningRef.current) drawRef.current();
      }
      return;
    }
    if (e.pointerType === "touch") return; // touch uses tap, not hover
    const hit = pick(p.x, p.y);
    if (hit) {
      setHover((cur) => (cur?.code === hit.code ? cur : { code: hit.code, x: p.x, y: p.y }));
    } else {
      setHover(null);
    }
  }, [pick]);

  const onPointerUp = useCallback((e) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.moved) { syncLoop(); return; }
    const p = localPoint(e);
    const hit = pick(p.x, p.y);
    if (!hit) { setHover(null); return; }
    const coarse = window.matchMedia?.("(pointer: coarse)")?.matches;
    if (coarse && hover?.code !== hit.code) {
      setHover({ code: hit.code, x: p.x, y: p.y });
      return;
    }
    if (stateRef.current.flagSet.has(hit.code)) onOpen(hit.code);
  }, [hover, pick, syncLoop, onOpen]);

  const onKeyDown = useCallback((e) => {
    const rot = rotRef.current;
    const step = e.shiftKey ? 30 : 12;
    let used = true;
    if (e.key === "ArrowLeft") rot.lon += step;
    else if (e.key === "ArrowRight") rot.lon -= step;
    else if (e.key === "ArrowUp") rot.lat = Math.min(LAT_LIMIT, rot.lat + step / 1.5);
    else if (e.key === "ArrowDown") rot.lat = Math.max(-LAT_LIMIT, rot.lat - step / 1.5);
    else used = false;
    if (used) {
      e.preventDefault();
      rot.lon = normalizeLon(rot.lon);
      setHover(null);
      if (!runningRef.current) drawRef.current();
    }
  }, []);

  // ---- country selector (keyboard path to back hemisphere / tiny nations) ----
  const options = useMemo(() => {
    const painted = countries.filter((c) => c.count > 0);
    const rest = flags.filter((code) => !prep.byCode.has(code)).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    return { painted, rest };
  }, [countries, flags, prep]);

  const selectCountry = useCallback((code) => {
    if (!code) { setPinned(null); return; }
    const item = prep.items.get(code) || prep.dots.find((d) => d.code === code);
    if (!item) {
      // Flag room with no map geometry (EU, UN, ...): never a silent no-op —
      // pin an actionable card over the centroid of the visible land instead.
      const rot = rotRef.current;
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (const it of prep.items.values()) {
        const p = project(it.center[0], it.center[1], rot.lon, rot.lat);
        if (p.z > 0.25) { sx += p.x; sy += p.y; n += 1; }
      }
      const f = frameRef.current;
      setPinned({ code, x: f.cx + (n ? sx / n : 0) * f.R, y: f.cy + (n ? sy / n : 0) * f.R });
      setHover(null);
      return;
    }
    const rot = rotRef.current;
    // shortest way round, and don't tilt past a comfortable viewing angle
    const toLat = Math.max(-55, Math.min(55, item.center[1]));
    const dLon = normalizeLon(item.center[0] - rot.lon);
    if (reduced) {
      rot.lon = normalizeLon(rot.lon + dLon);
      rot.lat = toLat;
      const f = frameRef.current;
      const p = project(item.center[0], item.center[1], rot.lon, rot.lat);
      setPinned({ code, x: f.cx + p.x * f.R, y: f.cy + p.y * f.R });
      drawRef.current();
    } else {
      animRef.current = { from: { lon: rot.lon, lat: rot.lat }, dLon, to: { lat: toLat }, t0: performance.now(), dur: 750 };
      setPinned({ code, x: null, y: null });
      syncLoop();
    }
    setHover(null);
  }, [prep, reduced, syncLoop]);

  const closePinned = useCallback(() => { setPinned(null); }, []);

  const cardFor = (code, x, y, pinnedCard) => {
    const count = prep.byCode.get(code) || 0;
    const l = live[code];
    const share = total > 0 && count > 0 ? Math.round((count / total) * 1000) / 10 : 0;
    const w = size || 320;
    const left = Math.min(Math.max(8, x + 14), Math.max(8, w - 230));
    return (
      <div
        className={`planet-card globe-card${pinnedCard ? " globe-card-pinned" : ""}`}
        style={{ left, top: Math.max(8, y + 14) }}
        role={pinnedCard ? "group" : "status"}
        aria-label={pinnedCard ? `${nameOf(code)} — selected country` : undefined}
      >
        <div className="planet-card-title">
          {flagEmoji(code)} {nameOf(code)}
          {pinnedCard ? <button type="button" className="globe-card-close" onClick={closePinned} aria-label={`Close ${nameOf(code)} card`}>×</button> : null}
        </div>
        {count > 0 ? (
          <div className="planet-card-stat"><strong>{fmt(count)}</strong> recorded painting sessions{share ? ` · ${share}% of all sessions` : ""}</div>
        ) : (
          <div className="planet-card-stat planet-card-muted">Not painted yet — be the first from here!</div>
        )}
        {l && l.painting > 0 ? <div className="planet-card-live">🟢 {l.painting} coloring the flag right now</div> : null}
        {flagSet.has(code) ? (
          pinnedCard ? (
            <button type="button" className="globe-card-open" onClick={() => onOpen(code)}>Color the {nameOf(code)} flag →</button>
          ) : (
            <div className="planet-card-cta">{coarsePointer ? "Tap again" : "Click"} to color the {nameOf(code)} flag →</div>
          )
        ) : null}
      </div>
    );
  };

  const H = Math.round(size * 1.14);
  return (
    <div className="planet-globe-wrap">
      <div className="globe-controls">
        <label className="globe-picker">
          <span className="globe-picker-label">Find a country</span>
          <select
            value={pinned?.code || ""}
            onChange={(e) => selectCountry(e.target.value)}
            aria-label="Choose a country to face it on the globe"
          >
            <option value="">Spin to…</option>
            {options.painted.length > 0 ? (
              <optgroup label="Painted countries">
                {options.painted.map((c) => (
                  <option key={c.code} value={c.code}>{flagEmoji(c.code)} {nameOf(c.code)} — {fmt(c.count)} sessions</option>
                ))}
              </optgroup>
            ) : null}
            <optgroup label="Every flag room">
              {options.rest.map((code) => <option key={code} value={code}>{flagEmoji(code)} {nameOf(code)}</option>)}
            </optgroup>
          </select>
        </label>
        <button
          type="button"
          className="globe-pause"
          aria-pressed={paused}
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? "▶ Play" : "⏸ Pause"}
        </button>
      </div>
      <div className="planet-globe-frame" ref={wrapRef}>
        {size > 0 ? (
          <canvas
            ref={canvasRef}
            className="planet-globe-canvas"
            style={{ width: size, height: H }}
            role="img"
            tabIndex={0}
            aria-label="A spinning globe painted like a watercolor. Countries with recorded painting sessions are colored in. Use the arrow keys to rotate it, or the country list above to pick one."
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => { dragRef.current = null; }}
            onPointerLeave={() => { if (!dragRef.current) setHover(null); }}
            onKeyDown={onKeyDown}
          />
        ) : null}
        {hover && !pinned ? cardFor(hover.code, hover.x, hover.y, false) : null}
        {pinned && pinned.x !== null ? cardFor(pinned.code, pinned.x, pinned.y, true) : null}
      </div>
      <div className="planet-legend" aria-hidden="true">
        <span><i style={{ background: UNPAINTED }} /> not painted yet</span>
        {PAINT.map((c, i) => <span key={c}><i style={{ background: c }} /> {["a little", "some", "lots", "the most"][i]}</span>)}
        <span><i className="planet-legend-live" /> coloring now</span>
      </div>
    </div>
  );
}

export default memo(PainterlyGlobe);
