// The Painted Planet — Drawesome's community page (replaces the Paint Jar;
// /paintjar still routes here). Three things, all fed by GET /api/planet:
//
//  1. A world map where every country is a brush-painted shape. Countries with
//     recorded activity are tinted by how much they've drawn; hovering (or
//     focusing) one names it and shows its numbers; clicking opens that
//     country's FLAG ROOM (/join/FLAGxx) — a shared coloring page of its flag.
//  2. A nature scene that grows with the community's recorded strokes: sky,
//     hills, a river, trees, flowers and critters appear as illustrative
//     milestones are passed. Labelled illustrative — never a measured saving.
//  3. The honest numbers underneath, same as before.
//
// No fabricated data: everything on screen derives from the API payload, and
// when it can't be reached we show an error, not placeholder numbers. All
// motion stops under prefers-reduced-motion.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import world from "../data/world-paths.json";
import "../seasonal.css";
import "./planet.css";

const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString() : "0");
const flagEmoji = (code) => String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
const nameOf = (code) => world.names[code] || code;

// Paint palette for painted countries: warm → hot with activity, on a 4-step
// sqrt ramp so the long tail is still visibly "painted", not one flat colour.
const PAINT = ["#ffd166", "#f4a261", "#ef6f4c", "#d62839"];
const UNPAINTED = "#e6ead9";
function paintFor(count, top) {
  if (!count || !top) return UNPAINTED;
  const t = Math.sqrt(count / top);
  return PAINT[Math.min(PAINT.length - 1, Math.floor(t * PAINT.length))];
}

// ---- The growing scene -----------------------------------------------------
// Each layer unlocks at a stroke milestone. Milestones are illustrative — the
// point is a picture that fills in as the community draws more, so a visitor
// sees the scene the community has earned so far and what's next.
const SCENE_LAYERS = [
  { at: 0, key: "sky", label: "a sky" },
  { at: 500, key: "hills", label: "rolling hills" },
  { at: 2_000, key: "sun", label: "the sun" },
  { at: 5_000, key: "river", label: "a river" },
  { at: 10_000, key: "tree1", label: "the first tree" },
  { at: 20_000, key: "flowers", label: "wildflowers" },
  { at: 30_000, key: "tree2", label: "a second tree" },
  { at: 40_000, key: "clouds", label: "clouds" },
  { at: 60_000, key: "birds", label: "birds" },
  { at: 80_000, key: "tree3", label: "a third tree" },
  { at: 100_000, key: "rainbow", label: "a rainbow" },
  { at: 150_000, key: "deer", label: "a deer" },
  { at: 200_000, key: "fish", label: "fish in the river" },
  { at: 300_000, key: "forest", label: "a whole forest" },
  { at: 500_000, key: "stars", label: "a starry night edge" },
];

function GrowingScene({ strokes, reduced }) {
  const unlocked = useMemo(() => new Set(SCENE_LAYERS.filter((l) => strokes >= l.at).map((l) => l.key)), [strokes]);
  const next = SCENE_LAYERS.find((l) => strokes < l.at) || null;
  const prev = [...SCENE_LAYERS].reverse().find((l) => strokes >= l.at) || SCENE_LAYERS[0];
  const pct = next ? Math.round(((strokes - prev.at) / (next.at - prev.at)) * 1000) / 10 : 100;
  const has = (k) => unlocked.has(k);
  const cls = (k, extra = "") => `scene-layer ${has(k) ? "is-on" : "is-off"} ${extra}`.trim();
  return (
    <div className="scene-wrap">
      <svg
        className={`scene ${reduced ? "scene-still" : ""}`}
        viewBox="0 0 800 450"
        role="img"
        aria-label={`A painted nature scene with ${unlocked.size} of ${SCENE_LAYERS.length} parts filled in by the community's recorded strokes`}
      >
        <defs>
          <linearGradient id="sc-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#bfe3ff" />
            <stop offset="1" stopColor="#eaf6ff" />
          </linearGradient>
          <linearGradient id="sc-water" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#7cc4f5" />
            <stop offset="1" stopColor="#3d9be0" />
          </linearGradient>
          <filter id="sc-paper" x="0" y="0" width="1" height="1">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="4" result="n" />
            <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.08 0" result="g" />
            <feComposite in="SourceGraphic" in2="g" operator="over" />
          </filter>
        </defs>
        <rect className="scene-paper" width="800" height="450" fill="#fbf8f0" />
        {/* sky */}
        <rect className={cls("sky")} width="800" height="450" fill="url(#sc-sky)" />
        {/* sun */}
        <g className={cls("sun", "scene-sun")}>
          <circle cx="660" cy="92" r="46" fill="#ffd86b" />
          <circle cx="660" cy="92" r="60" fill="#ffd86b" opacity="0.25" />
        </g>
        {/* rainbow */}
        <g className={cls("rainbow")} fill="none" strokeWidth="9" opacity="0.7">
          <path d="M150 300 A 250 250 0 0 1 650 300" stroke="#ef476f" />
          <path d="M162 300 A 238 238 0 0 1 638 300" stroke="#ffb703" />
          <path d="M174 300 A 226 226 0 0 1 626 300" stroke="#ffe66d" />
          <path d="M186 300 A 214 214 0 0 1 614 300" stroke="#8ac926" />
          <path d="M198 300 A 202 202 0 0 1 602 300" stroke="#4cc9f0" />
          <path d="M210 300 A 190 190 0 0 1 590 300" stroke="#9b5de5" />
        </g>
        {/* clouds */}
        <g className={cls("clouds", "scene-clouds")} fill="#fff" opacity="0.95">
          <g className="cloud cloud-a">
            <ellipse cx="150" cy="90" rx="52" ry="22" />
            <ellipse cx="185" cy="78" rx="38" ry="26" />
            <ellipse cx="118" cy="82" rx="30" ry="20" />
          </g>
          <g className="cloud cloud-b">
            <ellipse cx="430" cy="60" rx="44" ry="18" />
            <ellipse cx="458" cy="50" rx="30" ry="22" />
          </g>
        </g>
        {/* birds */}
        <g className={cls("birds", "scene-birds")} fill="none" stroke="#3a4a5a" strokeWidth="3" strokeLinecap="round">
          <path d="M300 120 q 12 -12 24 0 q 12 -12 24 0" />
          <path d="M350 100 q 9 -9 18 0 q 9 -9 18 0" />
          <path d="M270 145 q 8 -8 16 0 q 8 -8 16 0" />
        </g>
        {/* stars (night edge) */}
        <g className={cls("stars", "scene-stars")} fill="#fff">
          <circle cx="40" cy="30" r="2.5" /><circle cx="90" cy="18" r="2" /><circle cx="60" cy="70" r="1.8" />
          <circle cx="750" cy="30" r="2" /><circle cx="780" cy="60" r="2.4" /><circle cx="720" cy="14" r="1.6" />
        </g>
        {/* hills */}
        <g className={cls("hills")}>
          <path d="M0 300 C 120 230 240 250 360 290 S 600 330 800 260 L 800 450 L 0 450 Z" fill="#9ccf6b" />
          <path d="M0 340 C 160 300 300 330 460 340 S 700 300 800 320 L 800 450 L 0 450 Z" fill="#7fbf58" />
          <path d="M0 400 C 200 370 400 400 800 380 L 800 450 L 0 450 Z" fill="#5fa84a" />
        </g>
        {/* river */}
        <g className={cls("river", "scene-river")}>
          <path d="M-20 450 C 120 400 260 420 340 370 S 500 320 560 300 S 700 260 820 280 L 820 320 C 700 300 620 330 560 350 S 470 380 400 400 S 200 440 60 470 Z" fill="url(#sc-water)" />
          <path className="river-shine" d="M60 440 C 200 400 300 410 380 380" fill="none" stroke="#fff" strokeWidth="3" opacity="0.6" strokeLinecap="round" />
        </g>
        {/* fish */}
        <g className={cls("fish", "scene-fish")} fill="#ff9f43">
          <path d="M470 372 l 14 -8 v 16 z M470 372 a 10 6 0 1 0 -20 0 a 10 6 0 1 0 20 0" />
          <path d="M320 405 l 12 -7 v 14 z M320 405 a 9 5 0 1 0 -18 0 a 9 5 0 1 0 18 0" />
        </g>
        {/* forest (background trees) */}
        <g className={cls("forest")}>
          {[40, 80, 120, 560, 600, 640, 690, 730, 770].map((x, i) => (
            <g key={x} transform={`translate(${x} ${i % 2 ? 292 : 300})`}>
              <path d="M0 -70 L -22 0 L 22 0 Z" fill="#3f8d3a" />
              <path d="M0 -50 L -18 6 L 18 6 Z" fill="#4c9f45" />
              <rect x="-4" y="4" width="8" height="14" fill="#7b4a2d" />
            </g>
          ))}
        </g>
        {/* the three hero trees */}
        <g className={cls("tree1", "scene-tree")} transform="translate(160 330)">
          <rect x="-9" y="-10" width="18" height="60" rx="4" fill="#8a5a3c" />
          <circle cx="0" cy="-40" r="46" fill="#4fa64a" />
          <circle cx="-30" cy="-20" r="30" fill="#5cb85c" />
          <circle cx="30" cy="-22" r="32" fill="#43944a" />
        </g>
        <g className={cls("tree2", "scene-tree")} transform="translate(640 345)">
          <rect x="-8" y="-6" width="16" height="50" rx="4" fill="#8a5a3c" />
          <circle cx="0" cy="-34" r="38" fill="#57a84c" />
          <circle cx="-26" cy="-18" r="24" fill="#6cc05f" />
          <circle cx="26" cy="-20" r="26" fill="#489a48" />
        </g>
        <g className={cls("tree3", "scene-tree")} transform="translate(280 372)">
          <rect x="-6" y="-4" width="12" height="36" rx="3" fill="#8a5a3c" />
          <circle cx="0" cy="-26" r="28" fill="#5fae50" />
          <circle cx="-18" cy="-14" r="18" fill="#72c463" />
        </g>
        {/* deer */}
        <g className={cls("deer")} transform="translate(480 385)" fill="#b8763f">
          <ellipse cx="0" cy="0" rx="26" ry="14" />
          <rect x="-20" y="8" width="6" height="22" /><rect x="-8" y="8" width="6" height="22" />
          <rect x="6" y="8" width="6" height="22" /><rect x="16" y="8" width="6" height="22" />
          <path d="M18 -6 l 14 -18 l 10 4 l -6 22 z" />
          <path d="M28 -22 l 4 -12 M32 -20 l 8 -8" stroke="#8a5a3c" strokeWidth="3" fill="none" strokeLinecap="round" />
          <circle cx="36" cy="-14" r="2" fill="#222" />
        </g>
        {/* flowers */}
        <g className={cls("flowers", "scene-flowers")}>
          {[[60, 415, "#ff6b9d"], [110, 425, "#ffd166"], [230, 418, "#ff8c42"], [370, 430, "#c77dff"], [560, 418, "#ff6b9d"], [720, 425, "#ffd166"], [760, 412, "#ff8c42"]].map(([x, y, c]) => (
            <g key={`${x}-${y}`} transform={`translate(${x} ${y})`}>
              <line x1="0" y1="0" x2="0" y2="16" stroke="#3f8d3a" strokeWidth="2.5" />
              <circle cx="0" cy="0" r="6" fill={c} />
              <circle cx="0" cy="0" r="2.4" fill="#fff6c8" />
            </g>
          ))}
        </g>
        <rect width="800" height="450" fill="transparent" filter="url(#sc-paper)" pointerEvents="none" />
      </svg>
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

// ---- The map -----------------------------------------------------------------
function PaintedMap({ countries, flags, live, sessions, onOpen }) {
  const [hover, setHover] = useState(null); // { code, x, y }
  const coarsePointer = typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)")?.matches;
  const svgRef = useRef(null);
  const byCode = useMemo(() => new Map(countries.map((c) => [c.code, c.count])), [countries]);
  const top = countries.reduce((m, c) => Math.max(m, c.count || 0), 0);
  const flagSet = useMemo(() => new Set(flags), [flags]);
  const total = Math.max(sessions || 0, countries.reduce((s, c) => s + (c.count || 0), 0));

  const place = useCallback((code, evt) => {
    const svg = svgRef.current;
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    let x; let y;
    if (evt && Number.isFinite(evt.clientX)) {
      x = evt.clientX - box.left; y = evt.clientY - box.top;
    } else {
      const c = world.countries.find((k) => k.code === code)?.c || world.dots.find((k) => k.code === code)?.c;
      if (!c) return;
      x = (c[0] / world.width) * box.width; y = (c[1] / world.height) * box.height;
    }
    setHover({ code, x, y, w: box.width });
  }, []);

  // Touch: the first tap selects (shows the card, since there is no hover);
  // the second tap on the same country opens its flag room. Mouse/keyboard
  // users open on the first click as usual.
  const tap = useCallback((code, clickable, evt) => {
    const coarse = window.matchMedia?.("(pointer: coarse)")?.matches;
    if (coarse && hover?.code !== code) { place(code, evt); return; }
    if (clickable) onOpen(code);
  }, [hover, place, onOpen]);

  const card = hover ? (() => {
    const count = byCode.get(hover.code) || 0;
    const l = live[hover.code];
    const share = total > 0 && count > 0 ? Math.round((count / total) * 1000) / 10 : 0;
    const left = Math.min(Math.max(8, hover.x + 14), Math.max(8, hover.w - 230));
    return (
      <div className="planet-card" style={{ left, top: hover.y + 14 }} role="status">
        <div className="planet-card-title">{flagEmoji(hover.code)} {nameOf(hover.code)}</div>
        {count > 0 ? (
          <div className="planet-card-stat"><strong>{fmt(count)}</strong> recorded painting sessions{share ? ` · ${share}% of all sessions` : ""}</div>
        ) : (
          <div className="planet-card-stat planet-card-muted">Not painted yet — be the first from here!</div>
        )}
        {l && l.painting > 0 ? <div className="planet-card-live">🟢 {l.painting} colouring the flag right now</div> : null}
        {flagSet.has(hover.code) ? <div className="planet-card-cta">{coarsePointer ? "Tap again" : "Click"} to colour the {nameOf(hover.code)} flag →</div> : null}
      </div>
    );
  })() : null;

  return (
    <div className="planet-map-wrap" onMouseLeave={() => setHover(null)}>
      <svg
        ref={svgRef}
        className="planet-map"
        viewBox={`0 0 ${world.width} ${world.height}`}
        role="group"
        aria-label="World map painted by country. Countries with recorded activity are coloured; select one to open its flag colouring room."
      >
        <defs>
          <filter id="pm-brush" x="-5%" y="-5%" width="110%" height="110%">
            <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="3" seed="7" result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="3.5" xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <pattern id="pm-strokes" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(-18)">
            <rect width="10" height="10" fill="transparent" />
            <path d="M0 5 H 10" stroke="#000" strokeOpacity="0.07" strokeWidth="2.6" strokeLinecap="round" />
          </pattern>
        </defs>
        <rect width={world.width} height={world.height} rx="18" fill="#dcefff" />
        <g filter="url(#pm-brush)">
          {world.countries.map((c) => {
            const count = byCode.get(c.code) || 0;
            const fill = paintFor(count, top);
            const clickable = flagSet.has(c.code);
            return (
              <path
                key={c.code}
                d={c.d}
                className={`planet-country ${count > 0 ? "is-painted" : ""} ${clickable ? "is-clickable" : ""} ${hover?.code === c.code ? "is-hover" : ""}`}
                fill={fill}
                tabIndex={clickable ? 0 : -1}
                role={clickable ? "button" : undefined}
                aria-label={`${nameOf(c.code)}${count > 0 ? `, ${fmt(count)} recorded sessions` : ""}${clickable ? ". Open flag colouring room" : ""}`}
                onMouseMove={(e) => place(c.code, e)}
                onMouseEnter={(e) => place(c.code, e)}
                onFocus={() => place(c.code, null)}
                onBlur={() => setHover(null)}
                onClick={(e) => tap(c.code, clickable, e)}
                onKeyDown={(e) => { if (clickable && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(c.code); } }}
              />
            );
          })}
          {world.countries.map((c) => (
            <path key={`s-${c.code}`} d={c.d} fill="url(#pm-strokes)" pointerEvents="none" />
          ))}
        </g>
        {/* tiny nations too small to draw at this scale: painted dots when active */}
        {world.dots.filter((d) => byCode.get(d.code) > 0).map((d) => {
          const count = byCode.get(d.code) || 0;
          const clickable = flagSet.has(d.code);
          return (
            <circle
              key={`d-${d.code}`}
              cx={d.c[0]}
              cy={d.c[1]}
              r={4.5}
              className={`planet-dot ${clickable ? "is-clickable" : ""} ${hover?.code === d.code ? "is-hover" : ""}`}
              fill={paintFor(count, top)}
              tabIndex={clickable ? 0 : -1}
              role={clickable ? "button" : undefined}
              aria-label={`${nameOf(d.code)}, ${fmt(count)} recorded sessions${clickable ? ". Open flag colouring room" : ""}`}
              onMouseMove={(e) => place(d.code, e)}
              onMouseEnter={(e) => place(d.code, e)}
              onFocus={() => place(d.code, null)}
              onBlur={() => setHover(null)}
              onClick={(e) => tap(d.code, clickable, e)}
              onKeyDown={(e) => { if (clickable && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(d.code); } }}
            />
          );
        })}
        {/* live painters: a pulsing brush tip over countries with someone in their flag room */}
        {Object.entries(live).filter(([, v]) => v.painting > 0).map(([code, v]) => {
          const c = world.countries.find((k) => k.code === code)?.c || world.dots.find((k) => k.code === code)?.c;
          if (!c) return null;
          return (
            <g key={`live-${code}`} className="planet-live" transform={`translate(${c[0]} ${c[1]})`} pointerEvents="none">
              <circle r="9" fill="#22c55e" opacity="0.35" className="planet-live-ring" />
              <circle r="4" fill="#16a34a" />
              <title>{v.painting} colouring the {nameOf(code)} flag now</title>
            </g>
          );
        })}
      </svg>
      {card}
      <div className="planet-legend" aria-hidden="true">
        <span><i style={{ background: UNPAINTED }} /> not painted yet</span>
        {PAINT.map((c, i) => <span key={c}><i style={{ background: c }} /> {["a little", "some", "lots", "the most"][i]}</span>)}
        <span><i className="planet-legend-live" /> colouring now</span>
      </div>
    </div>
  );
}

// ---- The page ------------------------------------------------------------------
export default function PlanetPage({ onNavigate }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return undefined;
    const apply = () => setReduced(!!mq.matches);
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  const load = useCallback(async (quiet) => {
    if (!quiet) setStatus("loading");
    try {
      const res = await fetch("/api/planet", { cache: "no-store" });
      if (!res.ok) throw new Error("planet failed");
      const json = await res.json();
      if (!json || !Number.isFinite(json.strokes)) throw new Error("bad planet payload");
      setData(json);
      setStatus("ready");
    } catch {
      if (!quiet) { setData(null); setStatus("error"); }
    }
  }, []);

  useEffect(() => { load(false); }, [load]);
  // Live headcounts change; refresh quietly so the pulsing brush tips are honest.
  useEffect(() => {
    if (status !== "ready") return undefined;
    const t = setInterval(() => load(true), 20_000);
    return () => clearInterval(t);
  }, [status, load]);

  const strokes = data?.strokes ?? 0;
  const sessions = data?.sessions ?? 0;
  const countries = useMemo(() => (Array.isArray(data?.countries) ? data.countries : []), [data]);
  const flags = useMemo(() => (Array.isArray(data?.flags) ? data.flags : []), [data]);
  const live = useMemo(() => (data?.live && typeof data.live === "object" ? data.live : {}), [data]);
  const sheets = data?.milestones?.sheets ?? Math.floor(strokes / 1000);
  const liveTotal = Object.values(live).reduce((s, v) => s + (v.painting || 0), 0);
  const openFlag = useCallback((code) => onNavigate(`/join/FLAG${code}`), [onNavigate]);

  // Flag rooms with art on them right now (opCount > 0), busiest first — the
  // "where's the action" strip under the map.
  const activeFlags = useMemo(() => Object.entries(live)
    .filter(([code, v]) => flags.includes(code) && (v.painting > 0 || v.ops > 0))
    .sort((a, b) => (b[1].painting - a[1].painting) || (b[1].ops - a[1].ops))
    .slice(0, 12), [live, flags]);

  return (
    <div className="jar-page planet-page">
      <SiteNav onNavigate={onNavigate} current="/planet" />
      <main className="jar-main jar-page planet-main" aria-labelledby="planet-title">
        <header className="jar-hero planet-hero">
          <h1 id="planet-title">🌍 The Painted Planet</h1>
          <p>
            One little planet, painted by everyone who draws here. Hover or tap a country to see how much it has painted,
            <strong> open it to colour that country&rsquo;s flag together</strong>, and watch the scene below grow with every stroke.
          </p>
        </header>

        {status === "loading" ? <p className="jar-status" role="status">Mixing the paints…</p> : null}

        {status === "error" ? (
          <div className="jar-error" role="alert">
            <p>We couldn&rsquo;t reach the planet just now — no numbers until it&rsquo;s back.</p>
            <button type="button" onClick={() => load(false)}>Try again</button>
          </div>
        ) : null}

        {status === "ready" && data ? (
          <>
            <section className="planet-panel" aria-labelledby="planet-map-title">
              <div className="planet-panel-head">
                <h2 id="planet-map-title">Every nation, painted</h2>
                <p className="jar-panel-sub">
                  {countries.length > 0
                    ? `${countries.length} country ${countries.length === 1 ? "group has" : "groups have"} painted here (groups under 5 stay private).`
                    : "No country groups to show yet — groups under 5 painters stay private."}
                  {liveTotal > 0 ? ` ${liveTotal} colouring flags right now.` : ""}
                </p>
              </div>
              <PaintedMap countries={countries} flags={flags} live={live} sessions={sessions} onOpen={openFlag} />
              {activeFlags.length > 0 ? (
                <div className="planet-active" aria-label="Flag rooms with activity">
                  <span className="planet-active-label">Flags being coloured:</span>
                  {activeFlags.map(([code, v]) => (
                    <button type="button" key={code} className="planet-chip" onClick={() => openFlag(code)}>
                      {flagEmoji(code)} {nameOf(code)}{v.painting > 0 ? <em> · {v.painting} now</em> : null}
                    </button>
                  ))}
                </div>
              ) : null}
              <details className="planet-list">
                <summary>All painted countries ({countries.length})</summary>
                <ul className="jar-countries" aria-label="Recorded painting activity by country group">
                  {countries.map((c) => (
                    <li key={c.code}>
                      <span className="jar-country-code" title={nameOf(c.code)}>{flagEmoji(c.code)} {c.code}</span>
                      <span className="jar-country-bar" aria-hidden="true">
                        <i style={{ width: `${Math.max(4, Math.round((c.count / Math.max(1, countries[0]?.count || 1)) * 100))}%` }} />
                      </span>
                      <span className="jar-country-count">{fmt(c.count)}</span>
                      {flags.includes(c.code) ? (
                        <button type="button" className="planet-mini" onClick={() => openFlag(c.code)} aria-label={`Colour the ${nameOf(c.code)} flag`}>colour flag</button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </details>
            </section>

            <section className="planet-panel" aria-labelledby="planet-scene-title">
              <div className="planet-panel-head">
                <h2 id="planet-scene-title">The scene we&rsquo;re painting together</h2>
                <p className="jar-panel-sub">
                  Every recorded stroke on Drawesome adds a little paint to this picture. It fills in as the whole community draws —
                  an illustration of how much drawing happens here, not a measured saving of anything.
                </p>
              </div>
              <GrowingScene strokes={strokes} reduced={reduced} />
            </section>

            <div className="jar-stats" aria-label="Recorded painting activity">
              <div className="jar-stat">
                <strong>{fmt(strokes)}</strong>
                <span>recorded strokes</span>
              </div>
              <div className="jar-stat">
                <strong>{fmt(sessions)}</strong>
                <span>painting sessions</span>
              </div>
              <div className="jar-stat">
                <strong>{fmt(sheets)}</strong>
                <span>illustrative sheets of paper</span>
              </div>
            </div>

            <section className="jar-note" aria-labelledby="planet-note-title">
              <h2 id="planet-note-title">What the numbers mean</h2>
              <p>
                Strokes and sessions are <strong>aggregate recorded painting activity</strong> — not unique people, and
                never individual visitors. A country&rsquo;s paint colour comes from how many recorded painting sessions
                started there (coarse, country-level only — nothing more precise is ever kept). The
                &ldquo;sheets of paper&rdquo; figure is an <strong>illustrative equivalent</strong>: every {fmt(data.milestones?.strokesPerSheet || 1000)} recorded
                strokes count as one sheet, and the growing scene above unlocks at illustrative stroke milestones. None of it is a{" "}
                <strong>measured saving</strong> of paper, trees, paint, water or carbon — it&rsquo;s a friendly way to picture how much
                drawing happens here together.
              </p>
              {data.disclaimer ? <p>{data.disclaimer}</p> : null}
              {data.updatedAt ? (
                <p className="jar-updated">
                  Last updated {new Date(data.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.
                </p>
              ) : null}
            </section>

            <p className="jar-cta">
              <button type="button" className="primary-action" onClick={() => onNavigate("/join/MAIN")}>
                Add your strokes — start drawing 🖌️
              </button>
            </p>
          </>
        ) : null}
      </main>
      <SiteFooter onNavigate={onNavigate} />
    </div>
  );
}
