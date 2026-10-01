// The growing nature scene: a still life the community paints together.
//
// Every recorded stroke on Drawesome unlocks another part of the picture at
// illustrative milestones. The scene is deliberately STATIC — no animation,
// no transitions, under any motion preference — so what you see is a finished
// painting of "how much drawing has happened here so far", and a screenshot
// taken now is pixel-identical to one taken later (until the data changes).
//
// Painterly means: layered pigment (washes under dry-brush over dabs), rough
// warped edges on every silhouette, visible brush pulls, pigment splatter,
// pencil under-drawing, and paper tooth over the whole sheet. All dabs are
// seeded and deterministic. Nothing here is a measured saving — the meter
// below says exactly that in plain words.

import { memo, useMemo } from "react";
import { hashCode, mix, rng } from "../paintUtils.js";
import { SCENE_LAYERS } from "./sceneLayers.js";

const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString() : "0");

// A cluster of paint dabs (leaves, petals, cloud puffs): seeded, so the
// painting never changes between renders.
function dabs(seed, cx, cy, n, spreadX, spreadY, rMin, rMax, palette, oMin = 0.75, oMax = 1) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const ang = r() * Math.PI * 2;
    const dist = Math.sqrt(r());
    out.push({
      x: cx + Math.cos(ang) * dist * spreadX,
      y: cy + Math.sin(ang) * dist * spreadY,
      r: rMin + r() * (rMax - rMin),
      c: palette[Math.floor(r() * palette.length)],
      o: oMin + r() * (oMax - oMin),
    });
  }
  return out;
}

// Short dry-brush pulls along a direction, seeded.
function pulls(seed, x0, y0, x1, y1, n, palette, wMin = 2, wMax = 6) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const t = r();
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t + (r() - 0.5) * 14;
    const len = 14 + r() * 34;
    const rise = (r() - 0.5) * 10;
    out.push({
      d: `M${x.toFixed(1)} ${y.toFixed(1)} q ${(len / 2).toFixed(1)} ${(rise - 3).toFixed(1)} ${len.toFixed(1)} ${rise.toFixed(1)}`,
      c: palette[Math.floor(r() * palette.length)],
      w: wMin + r() * (wMax - wMin),
      o: 0.22 + r() * 0.3,
    });
  }
  return out;
}

function speckle(seed, x0, y0, x1, y1, n, palette, rMax = 1.8) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      x: x0 + r() * (x1 - x0),
      y: y0 + r() * (y1 - y0),
      r: 0.5 + r() * rMax,
      c: palette[Math.floor(r() * palette.length)],
      o: 0.3 + r() * 0.45,
    });
  }
  return out;
}

const TREE_GREENS = ["#3f8d3a", "#4c9f45", "#5cb85c", "#357a33", "#6cc05f"];
const TREE_LIT = ["#8fd07a", "#a9dd8f"];

// A painted tree: trunk with bark pulls + root flare, canopy of dab clusters
// with rim-lit tops and a couple of static drips of excess paint.
function PaintedTree({ seed, x, y, s = 1 }) {
  const canopy = useMemo(() => ([
    ...dabs(seed, 0, -46, 14, 44, 26, 7, 16, TREE_GREENS, 0.8, 1),
    ...dabs(seed + 7, -12, -58, 5, 26, 14, 4, 8, TREE_LIT, 0.5, 0.8),
  ]), [seed]);
  const bark = useMemo(() => pulls(seed + 13, -4, -8, -2, 44, 4, ["#6b4226", "#9a6a4a", "#5a3a24"], 1.2, 2.4), [seed]);
  const drips = useMemo(() => dabs(seed + 29, 6, 8, 2, 18, 4, 1.4, 2.6, [TREE_GREENS[1], TREE_GREENS[2]], 0.7, 0.9), [seed]);
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <ellipse cx="0" cy="48" rx="34" ry="7" fill="#3d2a1f" opacity="0.18" />
      <path d="M-7 46 C-8 20 -5 0 -3 -14 L4 -14 C6 2 8 22 7 46 C2 49 -2 49 -7 46 Z" fill="#8a5a3c" filter="url(#pm-warp)" />
      {bark.map((b, i) => <path key={i} d={b.d} stroke={b.c} strokeWidth={b.w} opacity={b.o} fill="none" strokeLinecap="round" />)}
      <g filter="url(#pm-dry)">
        {canopy.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={d.r} fill={d.c} opacity={d.o} />)}
      </g>
      {drips.map((d, i) => (
        <g key={`dr${i}`}>
          <rect x={d.x - 1.4} y={d.y} width={2.8} height={10 + d.r * 3} rx={1.4} fill={d.c} opacity={d.o} />
          <circle cx={d.x} cy={d.y + 10 + d.r * 3} r={d.r} fill={d.c} opacity={d.o} />
        </g>
      ))}
    </g>
  );
}

const HillBand = memo(function HillBand({ seed, d, fill, clipId }) {
  const strokes = useMemo(() => pulls(seed, 0, 0, 800, 0, 26, [mix(fill, "#ffffff", 0.4), mix(fill, "#2e5d27", 0.35), mix(fill, "#f7d16a", 0.2)], 3, 9), [seed, fill]);
  const bits = useMemo(() => speckle(seed + 3, 0, 250, 800, 450, 40, [mix(fill, "#2e5d27", 0.4), mix(fill, "#ffffff", 0.5)]), [seed, fill]);
  return (
    <g>
      <clipPath id={clipId}><path d={d} /></clipPath>
      <path d={d} fill="none" stroke="#3a2418" strokeWidth="1" opacity="0.4" transform="translate(1.5 2)" filter="url(#pm-sketch)" />
      <path d={d} fill={fill} filter="url(#pm-wc)" />
      <g clipPath={`url(#${clipId})`}>
        <g filter="url(#pm-dry)">
          {strokes.map((s, i) => <path key={i} d={s.d} stroke={s.c} strokeWidth={s.w} opacity={s.o} fill="none" strokeLinecap="round" />)}
        </g>
        {bits.map((b, i) => <circle key={`b${i}`} cx={b.x} cy={b.y} r={b.r} fill={b.c} opacity={b.o} />)}
      </g>
    </g>
  );
});

function NatureSceneArt({ has }) {
  const cloudA = useMemo(() => dabs(101, 155, 84, 9, 52, 20, 10, 24, ["#ffffff", "#fdfdf8", "#f2f6f4"], 0.85, 1), []);
  const cloudB = useMemo(() => dabs(202, 445, 56, 7, 42, 16, 8, 19, ["#ffffff", "#f6f8f2"], 0.85, 1), []);
  const cloudShade = useMemo(() => dabs(303, 155, 96, 5, 44, 10, 6, 12, ["#b9cdd4", "#a7bfc9"], 0.35, 0.55), []);
  const sunRays = useMemo(() => {
    const r = rng(404);
    return Array.from({ length: 10 }, (_, i) => {
      const a = (i / 10) * Math.PI * 2 + r() * 0.3;
      const r0 = 52 + r() * 6;
      const r1 = r0 + 10 + r() * 16;
      return {
        d: `M${(660 + Math.cos(a) * r0).toFixed(1)} ${(92 + Math.sin(a) * r0).toFixed(1)} L${(660 + Math.cos(a) * r1).toFixed(1)} ${(92 + Math.sin(a) * r1).toFixed(1)}`,
        w: 3 + r() * 4,
        o: 0.4 + r() * 0.35,
      };
    });
  }, []);
  const flowers = useMemo(() => {
    const spots = [[60, 415, "#ff6b9d"], [110, 425, "#ffd166"], [230, 418, "#ff8c42"], [370, 430, "#c77dff"], [560, 418, "#ff6b9d"], [720, 425, "#ffd166"], [760, 412, "#ff8c42"]];
    return spots.map(([x, y, c], i) => ({ x, y, c, petals: dabs(500 + i, 0, 0, 5, 6.5, 6.5, 2.6, 4.2, [c, mix(c, "#ffffff", 0.25)], 0.85, 1) }));
  }, []);
  const stars = useMemo(() => speckle(606, 6, 6, 200, 110, 16, ["#ffffff", "#ffe9a8"], 2.2), []);
  const fishWake = useMemo(() => pulls(707, 300, 400, 480, 375, 4, ["#ffffff", "#cdeffd"], 1, 2), []);
  const edgeSplats = useMemo(() => speckle(808, 0, 380, 800, 450, 26, ["#dc4f63", "#f4b71f", "#4c9f45", "#3d9be0"], 2.6), []);

  return (
    <svg
      className="scene"
      viewBox="0 0 800 450"
      role="img"
      aria-label={`A painted nature scene with ${SCENE_LAYERS.filter((l) => has(l.key)).length} of ${SCENE_LAYERS.length} parts filled in by the community's recorded strokes`}
    >
      <defs>
        <linearGradient id="ns-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a9d7f5" />
          <stop offset="0.6" stopColor="#d8edfb" />
          <stop offset="1" stopColor="#eef7ee" />
        </linearGradient>
        <linearGradient id="ns-water" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#8ed0f2" />
          <stop offset="0.5" stopColor="#57aae6" />
          <stop offset="1" stopColor="#3d9be0" />
        </linearGradient>
        <radialGradient id="ns-sun" cx="42%" cy="38%" r="70%">
          <stop offset="0" stopColor="#ffe9a0" />
          <stop offset="0.7" stopColor="#ffd86b" />
          <stop offset="1" stopColor="#f5b93f" />
        </radialGradient>
        <radialGradient id="ns-bloom" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* the sheet */}
      <rect width="800" height="450" fill="#fbf6ea" />
      <rect width="800" height="450" fill="#e9dcc0" opacity="0.35" filter="url(#pm-warp)" />

      {/* sky: wash + blooms + long dry swipes */}
      <g className={`scene-layer ${has("sky") ? "is-on" : "is-off"}`}>
        {has("sky") ? (
          <g>
            <rect width="800" height="450" fill="url(#ns-sky)" />
            <g filter="url(#pm-dry)" opacity="0.5">
              {pulls(11, -20, 60, 820, 120, 8, ["#ffffff", "#d8edfb"], 8, 18).map((s, i) => (
                <path key={i} d={s.d} stroke={s.c} strokeWidth={s.w} opacity={s.o} fill="none" strokeLinecap="round" />
              ))}
            </g>
            <ellipse cx="200" cy="110" rx="170" ry="60" fill="url(#ns-bloom)" />
            <ellipse cx="590" cy="70" rx="150" ry="46" fill="url(#ns-bloom)" />
          </g>
        ) : null}
      </g>

      {/* a starry night edge: indigo corners + dabs */}
      <g className={`scene-layer ${has("stars") ? "is-on" : "is-off"}`}>
        {has("stars") ? (
          <g>
            <path d="M0 0 H210 C140 40 60 70 0 120 Z" fill="#2c3a6b" opacity="0.55" filter="url(#pm-warp)" />
            <path d="M800 0 H590 C660 40 740 70 800 120 Z" fill="#2c3a6b" opacity="0.55" filter="url(#pm-warp)" />
            {stars.map((s, i) => <circle key={i} cx={s.x} cy={s.y} r={s.r} fill={s.c} opacity={s.o} />)}
          </g>
        ) : null}
      </g>

      {/* sun: layered discs + dry rays + splatter */}
      <g className={`scene-layer ${has("sun") ? "is-on" : "is-off"}`}>
        {has("sun") ? (
          <g>
            <circle cx="660" cy="92" r="62" fill="#ffd86b" opacity="0.22" />
            <g filter="url(#pm-dry)">
              {sunRays.map((r, i) => <path key={i} d={r.d} stroke="#f5b93f" strokeWidth={r.w} opacity={r.o} strokeLinecap="round" />)}
            </g>
            <circle cx="660" cy="92" r="44" fill="url(#ns-sun)" filter="url(#pm-wc)" />
            <circle cx="648" cy="80" r="12" fill="#fff3c4" opacity="0.7" />
            {speckle(99, 610, 40, 720, 140, 8, ["#f5b93f", "#ffd86b"], 2).map((s, i) => (
              <circle key={`sp${i}`} cx={s.x} cy={s.y} r={s.r} fill={s.c} opacity={s.o} />
            ))}
          </g>
        ) : null}
      </g>

      {/* rainbow: translucent arcs with a dry, lifted edge */}
      <g className={`scene-layer ${has("rainbow") ? "is-on" : "is-off"}`}>
        {has("rainbow") ? (
          <g fill="none" strokeWidth="10" opacity="0.55" filter="url(#pm-dry)" strokeLinecap="round">
            <path d="M150 300 A 250 250 0 0 1 650 300" stroke="#ef476f" />
            <path d="M163 300 A 237 237 0 0 1 637 300" stroke="#ffb703" />
            <path d="M176 300 A 224 224 0 0 1 624 300" stroke="#ffe66d" />
            <path d="M189 300 A 211 211 0 0 1 611 300" stroke="#8ac926" />
            <path d="M202 300 A 198 198 0 0 1 598 300" stroke="#4cc9f0" />
            <path d="M215 300 A 185 185 0 0 1 585 300" stroke="#9b5de5" />
          </g>
        ) : null}
      </g>

      {/* clouds: dab clusters over a cool under-wash */}
      <g className={`scene-layer ${has("clouds") ? "is-on" : "is-off"}`}>
        {has("clouds") ? (
          <g>
            {cloudShade.map((d, i) => <ellipse key={`s${i}`} cx={d.x} cy={d.y} rx={d.r * 1.6} ry={d.r} fill={d.c} opacity={d.o} />)}
            <g filter="url(#pm-dry)">
              {cloudA.map((d, i) => <circle key={`a${i}`} cx={d.x} cy={d.y} r={d.r} fill={d.c} opacity={d.o} />)}
              {cloudB.map((d, i) => <circle key={`b${i}`} cx={d.x} cy={d.y} r={d.r} fill={d.c} opacity={d.o} />)}
            </g>
          </g>
        ) : null}
      </g>

      {/* birds: quick ink pulls */}
      <g className={`scene-layer ${has("birds") ? "is-on" : "is-off"}`}>
        {has("birds") ? (
          <g fill="none" stroke="#3a4a5a" strokeWidth="3" strokeLinecap="round" filter="url(#pm-sketch)">
            <path d="M300 120 q 12 -12 24 0 q 12 -12 24 0" />
            <path d="M350 100 q 9 -9 18 0 q 9 -9 18 0" />
            <path d="M270 145 q 8 -8 16 0 q 8 -8 16 0" />
          </g>
        ) : null}
      </g>

      {/* hills: three painted bands with dry-brush and speckle */}
      <g className={`scene-layer ${has("hills") ? "is-on" : "is-off"}`}>
        {has("hills") ? (
          <g>
            <HillBand seed={21} clipId="ns-h1" d="M0 300 C 120 230 240 250 360 290 S 600 330 800 260 L 800 450 L 0 450 Z" fill="#9ccf6b" />
            <HillBand seed={22} clipId="ns-h2" d="M0 340 C 160 300 300 330 460 340 S 700 300 800 320 L 800 450 L 0 450 Z" fill="#7fbf58" />
            <HillBand seed={23} clipId="ns-h3" d="M0 400 C 200 370 400 400 800 380 L 800 450 L 0 450 Z" fill="#5fa84a" />
          </g>
        ) : null}
      </g>

      {/* river: pooled wash, dry pulls with the flow, bank shadow */}
      <g className={`scene-layer ${has("river") ? "is-on" : "is-off"}`}>
        {has("river") ? (
          <g>
            <path d="M-20 452 C 120 402 260 422 340 372 S 500 322 560 302 S 700 262 820 282 L 820 322 C 700 302 620 332 560 352 S 470 382 400 402 S 200 442 60 472 Z" fill="#2e5d27" opacity="0.25" transform="translate(2 4)" filter="url(#pm-warp)" />
            <path d="M-20 450 C 120 400 260 420 340 370 S 500 320 560 300 S 700 260 820 280 L 820 320 C 700 300 620 330 560 350 S 470 380 400 400 S 200 440 60 470 Z" fill="url(#ns-water)" filter="url(#pm-wc)" />
            <g filter="url(#pm-dry)">
              {pulls(31, 40, 430, 700, 280, 9, ["#ffffff", "#cdeffd", "#2f7fa6"], 2, 5).map((s, i) => (
                <path key={i} d={s.d} stroke={s.c} strokeWidth={s.w} opacity={s.o + 0.25} fill="none" strokeLinecap="round" />
              ))}
            </g>
          </g>
        ) : null}
      </g>

      {/* fish, with little wakes */}
      <g className={`scene-layer ${has("fish") ? "is-on" : "is-off"}`}>
        {has("fish") ? (
          <g>
            {fishWake.map((s, i) => <path key={`w${i}`} d={s.d} stroke={s.c} strokeWidth={s.w} opacity={s.o} fill="none" strokeLinecap="round" />)}
            <g fill="#ff9f43" filter="url(#pm-warp)">
              <path d="M470 372 l 14 -8 v 16 z M470 372 a 10 6 0 1 0 -20 0 a 10 6 0 1 0 20 0" />
              <path d="M320 405 l 12 -7 v 14 z M320 405 a 9 5 0 1 0 -18 0 a 9 5 0 1 0 18 0" />
            </g>
            <circle cx="456" cy="370" r="1.4" fill="#7a2d12" />
            <circle cx="308" cy="403" r="1.2" fill="#7a2d12" />
          </g>
        ) : null}
      </g>

      {/* forest: a treeline of dab canopies */}
      <g className={`scene-layer ${has("forest") ? "is-on" : "is-off"}`}>
        {has("forest") ? (
          <g>
            {[40, 80, 120, 560, 600, 640, 690, 730, 770].map((x, i) => (
              <g key={x} transform={`translate(${x} ${i % 2 ? 292 : 300})`}>
                <ellipse cx="0" cy="18" rx="20" ry="4" fill="#3d2a1f" opacity="0.15" />
                <rect x="-3.5" y="-4" width="7" height="20" rx="2" fill="#7b4a2d" />
                <g filter="url(#pm-dry)">
                  {dabs(hashCode(`forest-${x}`), 0, -26, 6, 20, 22, 6, 13, ["#3f8d3a", "#4c9f45", "#357a33"], 0.85, 1).map((d, j) => (
                    <circle key={j} cx={d.x} cy={d.y} r={d.r} fill={d.c} opacity={d.o} />
                  ))}
                </g>
              </g>
            ))}
          </g>
        ) : null}
      </g>

      {/* the three hero trees */}
      <g className={`scene-layer ${has("tree1") ? "is-on" : "is-off"}`}>{has("tree1") ? <PaintedTree seed={41} x={160} y={330} s={1.15} /> : null}</g>
      <g className={`scene-layer ${has("tree2") ? "is-on" : "is-off"}`}>{has("tree2") ? <PaintedTree seed={42} x={640} y={345} s={0.95} /> : null}</g>
      <g className={`scene-layer ${has("tree3") ? "is-on" : "is-off"}`}>{has("tree3") ? <PaintedTree seed={43} x={280} y={372} s={0.7} /> : null}</g>

      {/* deer */}
      <g className={`scene-layer ${has("deer") ? "is-on" : "is-off"}`}>
        {has("deer") ? (
          <g transform="translate(480 385)">
            <ellipse cx="2" cy="32" rx="30" ry="5" fill="#3d2a1f" opacity="0.18" />
            <g fill="#b8763f" filter="url(#pm-warp)">
              <ellipse cx="0" cy="0" rx="26" ry="14" />
              <rect x="-20" y="8" width="6" height="22" /><rect x="-8" y="8" width="6" height="22" />
              <rect x="6" y="8" width="6" height="22" /><rect x="16" y="8" width="6" height="22" />
              <path d="M18 -6 l 14 -18 l 10 4 l -6 22 z" />
            </g>
            <path d="M28 -22 l 4 -12 M32 -20 l 8 -8" stroke="#8a5a3c" strokeWidth="3" fill="none" strokeLinecap="round" />
            <circle cx="36" cy="-14" r="2" fill="#222" />
            {[[-8, -4], [2, -6], [10, -2], [-2, 2]].map(([sx, sy], i) => <circle key={i} cx={sx} cy={sy} r="1.6" fill="#f3d9b8" opacity="0.85" />)}
            <path d="M-24 4 q 10 6 22 6" stroke="#8a5a3c" strokeWidth="2" fill="none" opacity="0.5" strokeLinecap="round" />
          </g>
        ) : null}
      </g>

      {/* wildflowers: petal dabs on inked stems */}
      <g className={`scene-layer ${has("flowers") ? "is-on" : "is-off"}`}>
        {has("flowers") ? (
          <g>
            {flowers.map((f) => (
              <g key={`${f.x}-${f.y}`} transform={`translate(${f.x} ${f.y})`}>
                <path d="M0 16 C -2 10 2 6 0 0" stroke="#3f8d3a" strokeWidth="2.5" fill="none" strokeLinecap="round" />
                <path d="M0 10 q -6 -2 -8 -6" stroke="#4c9f45" strokeWidth="2" fill="none" strokeLinecap="round" />
                {f.petals.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={p.r} fill={p.c} opacity={p.o} />)}
                <circle cx="0" cy="0" r="2.6" fill="#fff6c8" />
              </g>
            ))}
          </g>
        ) : null}
      </g>

      {/* flicked paint at the sheet's lower edge + paper tooth over everything */}
      {edgeSplats.map((s, i) => <circle key={`es${i}`} cx={s.x} cy={s.y} r={s.r} fill={s.c} opacity={s.o * 0.7} />)}
      <rect width="800" height="450" filter="url(#pm-bristle-light)" opacity="0.16" pointerEvents="none" />
      <rect width="800" height="450" filter="url(#pm-bristle-dark)" opacity="0.1" pointerEvents="none" style={{ mixBlendMode: "multiply" }} />
      <rect width="800" height="450" filter="url(#pm-paper)" pointerEvents="none" />
    </svg>
  );
}

const NatureSceneArtMemo = memo(NatureSceneArt);

export default function NatureScene({ strokes }) {
  const unlocked = useMemo(() => new Set(SCENE_LAYERS.filter((l) => strokes >= l.at).map((l) => l.key)), [strokes]);
  const next = SCENE_LAYERS.find((l) => strokes < l.at) || null;
  const prev = [...SCENE_LAYERS].reverse().find((l) => strokes >= l.at) || SCENE_LAYERS[0];
  const pct = next ? Math.round(((strokes - prev.at) / (next.at - prev.at)) * 1000) / 10 : 100;
  const has = (k) => unlocked.has(k);
  return (
    <div className="scene-wrap">
      <NatureSceneArtMemo has={has} />
      <div className="scene-meter" aria-live="polite">
        {next ? (
          <>
            <div className="scene-meter-row">
              <span className="scene-meter-end">{fmt(prev.at)}</span>
              <div className="scene-meter-bar" role="progressbar" aria-valuemin={prev.at} aria-valuemax={next.at} aria-valuenow={strokes} aria-label={`Progress from ${prev.label} toward ${next.label}`}>
                <i style={{ width: `${pct}%` }} />
              </div>
              <span className="scene-meter-end">{fmt(next.at)} · {next.label}</span>
            </div>
            <p>
              <strong>{fmt(strokes)}</strong> recorded strokes have painted <strong>{unlocked.size}</strong> of {SCENE_LAYERS.length} parts of the scene.
              Next up: <strong>{next.label}</strong> at {fmt(next.at)} strokes ({fmt(Math.max(0, next.at - strokes))} to go).
            </p>
          </>
        ) : (
          <p><strong>{fmt(strokes)}</strong> recorded strokes — the whole scene is painted. 🌈</p>
        )}
      </div>
    </div>
  );
}
