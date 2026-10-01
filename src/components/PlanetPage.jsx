// The Painted Planet — Drawesome's community page (replaces the Paint Jar;
// /paintjar still routes here). Three things, all fed by GET /api/planet:
//
//  1. A spinning painterly GLOBE (globe/PainterlyGlobe.jsx): a real
//     orthographic sphere rendered on canvas from Natural Earth lon/lat
//     polygons — washed ocean, brush-glazed countries tinted by recorded
//     activity, wet-edge rims, paint drips hanging off the busiest countries.
//     Drag to spin it, tap a country for its numbers, click to open its FLAG
//     ROOM (/join/FLAGxx); a keyboard country selector keeps the back
//     hemisphere and tiny nations reachable. Pause/play, and all motion stops
//     under prefers-reduced-motion, offscreen, or a hidden tab.
//  2. A still nature painting (globe/NatureScene.jsx) that fills in as the
//     community's recorded strokes pass illustrative milestones. Deliberately
//     static — no animation at all. Labeled illustrative — never a measured
//     saving.
//  3. The honest numbers underneath, same as before.
//
// No fabricated data: everything on screen derives from the API payload, and
// when it can't be reached we show an error, not placeholder numbers.

import { useCallback, useEffect, useMemo, useState } from "react";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import world from "../data/world-geo.json";
import { PaintDefs, PaintedGlobe } from "./planetArt";
import PainterlyGlobe from "./globe/PainterlyGlobe";
import NatureScene from "./globe/NatureScene";
import "../seasonal.css";
import "./planet.css";

const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString() : "0");
const flagEmoji = (code) => String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
const nameOf = (code) => world.names[code] || code;

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
  const total = Math.max(sessions || 0, countries.reduce((s, c) => s + (c.count || 0), 0));
  const openFlag = useCallback((code) => onNavigate(`/join/FLAG${code}`), [onNavigate]);

  // Flag rooms with art on them right now (opCount > 0), busiest first — the
  // "where's the action" strip under the globe.
  const activeFlags = useMemo(() => Object.entries(live)
    .filter(([code, v]) => flags.includes(code) && (v.painting > 0 || v.ops > 0))
    .sort((a, b) => (b[1].painting - a[1].painting) || (b[1].ops - a[1].ops))
    .slice(0, 12), [live, flags]);

  return (
    <div className="jar-page planet-page">
      {/* filters shared by the scene (ids are document-global) */}
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false"><PaintDefs /></svg>
      <SiteNav onNavigate={onNavigate} current="/planet" />
      <main className="jar-main jar-page planet-main" aria-labelledby="planet-title">
        <header className="jar-hero planet-hero">
          <h1 id="planet-title"><PaintedGlobe size={56} /> <span>The Painted Planet</span></h1>
          <p>
            One little planet, painted by everyone who draws here. Spin the globe, tap a country to see how much it has painted,
            <strong> open it to color that country&rsquo;s flag together</strong>, and watch the painting below fill in with every stroke.
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
            <section className="planet-panel" aria-labelledby="planet-globe-title">
              <div className="planet-panel-head">
                <h2 id="planet-globe-title">Every nation, painted</h2>
                <p className="jar-panel-sub">
                  {countries.length > 0
                    ? `${countries.length} country ${countries.length === 1 ? "group has" : "groups have"} painted here (groups under 5 stay private).`
                    : "No country groups to show yet — groups under 5 painters stay private."}
                  {liveTotal > 0 ? ` ${liveTotal} coloring flags right now.` : ""}
                </p>
              </div>
              <PainterlyGlobe countries={countries} flags={flags} live={live} total={total} reduced={reduced} onOpen={openFlag} />
              {activeFlags.length > 0 ? (
                <div className="planet-active" aria-label="Flag rooms with activity">
                  <span className="planet-active-label">Flags being colored:</span>
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
                        <button type="button" className="planet-mini" onClick={() => openFlag(c.code)} aria-label={`Color the ${nameOf(c.code)} flag`}>color flag</button>
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
              <NatureScene strokes={strokes} />
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
                never individual visitors. A country&rsquo;s paint color comes from how many recorded painting sessions
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
