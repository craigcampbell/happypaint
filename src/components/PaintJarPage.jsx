// The Paint Jar — a community paint-o-meter. Every number comes from the real
// aggregate stats API (GET /api/paintjar): recorded strokes, painting sessions
// and country-level groups (server omits groups under 5). No visitor counters,
// no fabricated data: when the API can't be reached we show an honest error
// instead of numbers.
//
// The "sheets of paper" figure is the API's ILLUSTRATIVE equivalent (a fixed
// number of recorded stroke batches per sheet) — it is labelled as such and is
// explicitly NOT a measured saving of paper, paint, water or carbon.
//
// The Earth and the filling jar are pure CSS; both stop animating under
// prefers-reduced-motion.

import { useCallback, useEffect, useState } from "react";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import "../seasonal.css";

const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString() : "0");

export default function PaintJarPage({ onNavigate }) {
  const [stats, setStats] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | error

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const res = await fetch("/api/paintjar", { cache: "no-store" });
      if (!res.ok) throw new Error("paintjar failed");
      const data = await res.json();
      if (!data || !Number.isFinite(data.strokes)) throw new Error("bad paintjar payload");
      setStats(data);
      setStatus("ready");
    } catch {
      setStats(null);
      setStatus("error");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const strokes = stats?.strokes ?? 0;
  const sessions = stats?.sessions ?? 0;
  const perSheet = stats?.paperEquivalent?.strokesPerSheet || 1000;
  const sheets = stats?.paperEquivalent?.sheets ?? Math.floor(strokes / perSheet);
  // The jar fills toward the NEXT illustrative sheet, from real strokes only.
  const towardNext = perSheet > 0 ? strokes % perSheet : 0;
  const fillPct = Math.round((towardNext / perSheet) * 1000) / 10;
  const countries = Array.isArray(stats?.countries) ? stats.countries : [];
  const topCount = countries.reduce((m, c) => Math.max(m, c.count || 0), 0);

  return (
    <div className="jar-page">
      <SiteNav onNavigate={onNavigate} current="/paintjar" />
      <main className="jar-main jar-page" aria-labelledby="jar-title">
        <header className="jar-hero">
          <h1 id="jar-title">🫙 The Paint Jar</h1>
          <p>
            One little planet, one big shared jar of paint. This is Drawesome&rsquo;s real, recorded painting
            activity — every stroke painted together fills the jar a little more.
          </p>
        </header>

        {status === "loading" ? (
          <p className="jar-status" role="status">Dipping the brush…</p>
        ) : null}

        {status === "error" ? (
          <div className="jar-error" role="alert">
            <p>We couldn&rsquo;t reach the paint jar just now — no numbers until it&rsquo;s back.</p>
            <button type="button" onClick={load}>Try again</button>
          </div>
        ) : null}

        {status === "ready" && stats ? (
          <>
            <div className="jar-stage">
              <section className="jar-panel" aria-labelledby="jar-earth-title">
                <h2 id="jar-earth-title">One planet of painters</h2>
                <div className="jar-earth" role="img" aria-label="A stylised spinning Earth — painters from around the world share one jar of paint">
                  <div className="jar-earth-inner" aria-hidden="true" />
                  <div className="jar-earth-shine" aria-hidden="true" />
                </div>
                <p className="jar-panel-sub">
                  {countries.length > 0
                    ? `Recorded activity from ${countries.length} country ${countries.length === 1 ? "group" : "groups"} (groups under 5 aren't shown).`
                    : "No country groups to show yet — groups under 5 painters stay private."}
                </p>
                {countries.length > 0 ? (
                  <ul className="jar-countries" aria-label="Recorded painting activity by country group">
                    {countries.map((c) => (
                      <li key={c.code}>
                        <span className="jar-country-code">{c.code}</span>
                        <span className="jar-country-bar" aria-hidden="true">
                          <i style={{ width: `${topCount > 0 ? Math.max(4, Math.round((c.count / topCount) * 100)) : 0}%` }} />
                        </span>
                        <span className="jar-country-count">{fmt(c.count)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>

              <section className="jar-panel" aria-labelledby="jar-jar-title">
                <h2 id="jar-jar-title">The jar keeps filling</h2>
                <div
                  className="jar-jar"
                  role="img"
                  aria-label={`A paint jar filled to ${fillPct}% of the way toward illustrative sheet number ${sheets + 1}`}
                >
                  <div className="jar-fill" style={{ height: `${fillPct}%` }} aria-hidden="true" />
                  <span className="jar-jar-label">{fillPct}% to sheet #{sheets + 1}</span>
                </div>
                <p className="jar-panel-sub">
                  {fmt(towardNext)} of {fmt(perSheet)} recorded stroke batches toward the next illustrative sheet.
                </p>
              </section>
            </div>

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

            <section className="jar-note" aria-labelledby="jar-note-title">
              <h2 id="jar-note-title">What the numbers mean</h2>
              <p>
                Strokes and sessions are <strong>aggregate recorded painting activity</strong> — not unique
                people, and never individual visitors. The “sheets of paper” figure is an{" "}
                <strong>illustrative equivalent</strong>: every {fmt(perSheet)} recorded stroke batches count
                as one sheet. It is <strong>not a measured saving</strong> of paper, paint, water or carbon —
                just a friendly way to picture how much drawing happens here together.
              </p>
              {stats.disclaimer ? <p>{stats.disclaimer}</p> : null}
              {stats.updatedAt ? (
                <p className="jar-updated">
                  Last updated {new Date(stats.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.
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
