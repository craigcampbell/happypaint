// Inktober event page — an anonymous, public, moderated gallery for the
// shared INKTOBER room ("Ink & Pencil"). The event state (phase / day /
// prompt) comes from GET /api/inktober (UTC-rollover, server-stamped — we
// never stamp a day client-side); the gallery is explicit public wall
// submissions filtered by the server-assigned event tag
// (GET /api/wall?event=inktober-2026[&day=N]). The static prompt list in
// src/data/inktober2026.json is only a display fallback for the day selector
// when the API is unreachable — never a source of phase or "today's day".
//
// Independent community participation: prompts are attributed to the official
// rules source; no affiliation/endorsement is claimed and no official logo is
// used. Private art is never auto-published — posting to the wall stays the
// explicit studio action it always was.

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import fallbackPrompts from "../data/inktober2026.json";
import "../seasonal.css";
import "../sketchbook.css";

const LiveRoomCanvas = lazy(() => import("./LiveRoomCanvas"));

const EVENT_ID = "inktober-2026";
const ROOM_CODE = "INKTOBER";

function utcDateLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
}

export default function InktoberPage({ onNavigate }) {
  const [ink, setInk] = useState(null);
  const [inkStatus, setInkStatus] = useState("loading"); // loading | ready | error
  const [posts, setPosts] = useState([]);
  const [galleryStatus, setGalleryStatus] = useState("loading"); // loading | ready | error
  const [studios, setStudios] = useState([]);
  const [studiosStatus, setStudiosStatus] = useState("loading"); // loading | ready | error
  // Sketchbooks: explicit-opt-in multi-page books, paginated with load-more.
  const [books, setBooks] = useState([]);
  const [booksTotal, setBooksTotal] = useState(0);
  const [booksStatus, setBooksStatus] = useState("loading"); // loading | ready | error
  const [booksBusy, setBooksBusy] = useState(false);
  const [day, setDay] = useState("all");
  const [toast, setToast] = useState("");
  const [showLive, setShowLive] = useState(false);
  const [liveNear, setLiveNear] = useState(false);
  const liveRef = useRef(null);
  const toastTimer = useRef(null);
  const seqRef = useRef(0);

  const say = useCallback((text) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2600);
  }, []);

  const follow = (event, href) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onNavigate(href);
  };

  // ---- event state (phase/day/prompt are server truth) ----------------------
  const loadEvent = useCallback(async () => {
    setInkStatus("loading");
    try {
      const res = await fetch("/api/inktober", { cache: "no-store" });
      if (!res.ok) throw new Error("event failed");
      const data = await res.json();
      if (!data || !data.phase) throw new Error("bad event payload");
      setInk(data);
      setInkStatus("ready");
    } catch {
      setInk(null);
      setInkStatus("error");
    }
  }, []);

  useEffect(() => {
    loadEvent();
    return () => window.clearTimeout(toastTimer.current);
  }, [loadEvent]);

  // ---- gallery (explicit public wall submissions for the event) -------------
  const loadGallery = useCallback(async (selectedDay) => {
    const seq = (seqRef.current += 1);
    setGalleryStatus("loading");
    try {
      const params = new URLSearchParams({ event: EVENT_ID, sort: "new", limit: "60" });
      if (selectedDay !== "all") params.set("day", selectedDay);
      const res = await fetch(`/api/wall?${params}`, { cache: "no-store" });
      if (!res.ok) throw new Error("gallery failed");
      const data = await res.json();
      if (seq !== seqRef.current) return;
      setPosts(Array.isArray(data?.posts) ? data.posts : []);
      setGalleryStatus("ready");
    } catch {
      if (seq !== seqRef.current) return;
      setPosts([]);
      setGalleryStatus("error");
    }
  }, []);

  useEffect(() => {
    loadGallery(day);
  }, [day, loadGallery]);

  // ---- participating artist studios (real event-filtered gallery) ------------
  // Same data as /gallery?event=inktober-2026; fail-soft — the browse link
  // below works even if this fetch doesn't.
  useEffect(() => {
    let active = true;
    fetch(`/api/rooms/gallery?event=${EVENT_ID}&limit=12`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("studios failed"))))
      .then((d) => {
        if (!active) return;
        setStudios(Array.isArray(d?.rooms) ? d.rooms : []);
        setStudiosStatus("ready");
      })
      .catch(() => {
        if (!active) return;
        setStudios([]);
        setStudiosStatus("error");
      });
    return () => { active = false; };
  }, []);

  // ---- sketchbooks (explicit-opt-in multi-page books; load-more walks ALL) --
  const loadBooks = useCallback(async (offset, append) => {
    setBooksBusy(true);
    try {
      const res = await fetch(`/api/sketchbooks?event=${EVENT_ID}&offset=${offset}&limit=12`, { cache: "no-store" });
      if (!res.ok) throw new Error("sketchbooks failed");
      const data = await res.json();
      const list = Array.isArray(data?.books) ? data.books : [];
      setBooks((cur) => (append ? [...cur, ...list.filter((b) => !cur.some((c) => c.id === b.id))] : list));
      setBooksTotal(Number.isFinite(data?.total) ? data.total : list.length);
      setBooksStatus("ready");
    } catch {
      if (!append) { setBooks([]); setBooksStatus("error"); }
    } finally {
      setBooksBusy(false);
    }
  }, []);

  useEffect(() => {
    loadBooks(0, false);
  }, [loadBooks]);

  // Gate the optional live-mural spectator: mounted only on explicit opt-in
  // AND while near the viewport (a gallery page shouldn't hold heavy sockets).
  useEffect(() => {
    const node = liveRef.current;
    if (!node || !window.IntersectionObserver) { setLiveNear(true); return undefined; }
    const io = new IntersectionObserver(([entry]) => setLiveNear(entry.isIntersecting), { rootMargin: "150px" });
    io.observe(node);
    return () => io.disconnect();
  }, [showLive]);

  const report = useCallback(async (post) => {
    const ok = window.confirm(`Report "${post.title}" to the moderators?`);
    if (!ok) return;
    try {
      const res = await fetch(`/api/wall/${encodeURIComponent(post.id)}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "reported from the Inktober gallery" }),
      });
      say(res.ok ? "Thanks — a moderator will take a look. 🛡️" : "Couldn't send the report — try again!");
    } catch {
      say("Couldn't send the report — try again!");
    }
  }, [say]);

  const phase = ink?.phase || null;
  const prompts = Array.isArray(ink?.prompts) && ink.prompts.length ? ink.prompts : fallbackPrompts.prompts;
  const rulesSource = ink?.source || fallbackPrompts.source || "https://inktober.com/rules";
  const selectedPrompt = day !== "all" ? prompts.find((p) => String(p.day) === day) : null;

  const emptyMessage = () => {
    if (phase === "upcoming") return "No Inktober art yet — the event hasn't started. Get ready! 🖋️";
    if (day !== "all") return `No art for Day ${day} yet — be the first to draw it!`;
    if (phase === "ended") return "No gallery posts were kept from this year's event.";
    return "No Inktober art yet — be the first to post from the Ink & Pencil room!";
  };

  return (
    <div className="ink-page">
      <SiteNav onNavigate={onNavigate} current="/inktober" />
      <main className="ink-main ink-page" aria-labelledby="ink-title">
        <section className="ink-hero">
          <p className="ink-eyebrow">Community event · October {ink?.year || fallbackPrompts.year}</p>
          <h1 id="ink-title">🖋️ Inktober at Drawesome</h1>
          <p className="ink-hero-sub">
            Your art, your sketchbook: one prompt a day, all October long. Keep your pages private
            or make your book public to share your artwork here. Invite up to five artists to draw
            with you, or drop into the anonymous shared Ink &amp; Pencil room.
          </p>

          {inkStatus === "loading" ? (
            <div className="ink-phase-card"><p className="ink-phase-prompt"><strong>Checking the event…</strong></p></div>
          ) : null}

          {inkStatus === "error" ? (
            <div className="ink-phase-card">
              <p className="ink-phase-prompt">
                <strong>We couldn&rsquo;t check the event just now.</strong>
                <small>The prompt list below is the official list; event timing will be back shortly.</small>
              </p>
              <button type="button" className="ink-join-btn" onClick={loadEvent}>Try again</button>
            </div>
          ) : null}

          {inkStatus === "ready" && phase === "upcoming" ? (
            <div className="ink-phase-card" data-phase="upcoming">
              <p className="ink-phase-prompt">
                <strong>Inktober is coming — get ready</strong>
                <small>
                  Starts {utcDateLabel(ink.nextChangeAt) || "October 1"} · warm-up prompt: “{ink.prompt}”
                </small>
              </p>
              <a className="ink-join-btn" href="#ink-prompts" onClick={(e) => { e.preventDefault(); document.getElementById("ink-day-filter")?.focus(); }}>
                Browse the 31 prompts
              </a>
            </div>
          ) : null}

          {inkStatus === "ready" && phase === "active" ? (
            <div className="ink-phase-card" data-phase="active">
              <p className="ink-phase-prompt">
                <strong>Day {ink.day} of 31: “{ink.prompt}”</strong>
                <small>New prompt {ink.nextChangeAt ? `on ${utcDateLabel(ink.nextChangeAt)}` : "tomorrow"} (UTC)</small>
              </p>
              <a className="ink-join-btn" href="/sketchbook" onClick={(e) => follow(e, "/sketchbook")}>
                Draw today&rsquo;s page in your sketchbook →
              </a>
              <a
                className="ink-card-link"
                href={`/join/${ROOM_CODE}`}
                onClick={(e) => follow(e, `/join/${ROOM_CODE}`)}
              >
                or draw together in the shared Ink &amp; Pencil room →
              </a>
            </div>
          ) : null}

          {inkStatus === "ready" && phase === "ended" ? (
            <div className="ink-phase-card" data-phase="ended">
              <p className="ink-phase-prompt">
                <strong>Inktober {ink.year} has wrapped — thanks for drawing with us!</strong>
                <small>The gallery below keeps the community&rsquo;s pinned pieces.</small>
              </p>
            </div>
          ) : null}

          {phase === "active" ? (
            <div className="ink-live" ref={liveRef}>
              {!showLive ? (
                <button type="button" className="ink-live-toggle" onClick={() => setShowLive(true)}>
                  👀 Peek at the shared mural (live)
                </button>
              ) : (
                <>
                  <button type="button" className="ink-live-toggle" onClick={() => setShowLive(false)}>
                    Hide the live mural
                  </button>
                  {liveNear ? (
                    <div className="ink-live-canvas">
                      <Suspense fallback={<p className="ink-status">Loading the live mural…</p>}>
                        <LiveRoomCanvas roomCode={ROOM_CODE} snapshotIntervalMs={60000} />
                      </Suspense>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </section>

        <section className="ink-studios" aria-labelledby="ink-books-title">
          <h2 id="ink-books-title">Inktober sketchbooks</h2>
          <p>
            Public sketchbooks — one page per daily prompt, with the owner and up to five invited artists.
            Anyone can flip through these public books; private sketchbooks never appear here.
          </p>
          <a className="ink-join-btn" href="/sketchbook" onClick={(e) => follow(e, "/sketchbook")}>
            Start your own sketchbook →
          </a>
          {booksStatus === "loading" ? (
            <p className="ink-status" role="status">Finding sketchbooks…</p>
          ) : null}
          {booksStatus === "error" ? (
            <div className="ink-error" role="alert">
              <p>We couldn&rsquo;t load the sketchbooks just now.</p>
              <button type="button" onClick={() => loadBooks(0, false)}>Try again</button>
            </div>
          ) : null}
          {booksStatus === "ready" && books.length === 0 ? (
            <p className="ink-status">No sketchbooks have artwork yet — yours could be the first.</p>
          ) : null}
          {books.length > 0 ? (
            <>
              <div className="skb-card-grid">
                {books.map((b) => (
                  <button
                    type="button"
                    key={b.id}
                    className="skb-card"
                    onClick={() => onNavigate(`/sketchbook/${b.id}`)}
                    aria-label={`Flip through ${b.title || "an Inktober sketchbook"}`}
                  >
                    <span className="skb-card-title">{b.title || "Inktober sketchbook"}</span>
                    <span className="skb-card-days">
                      {b.days.slice(0, 8).map((d) => <span key={d}>Day {d}</span>)}
                    </span>
                    <span className="skb-card-meta">
                      {b.drawnPages} page{b.drawnPages === 1 ? "" : "s"} drawn · {b.artistCount} artist{b.artistCount === 1 ? "" : "s"}
                    </span>
                  </button>
                ))}
              </div>
              {books.length < booksTotal ? (
                <button
                  type="button"
                  className="ink-join-btn skb-loadmore"
                  disabled={booksBusy}
                  onClick={() => loadBooks(books.length, true)}
                >
                  {booksBusy ? "Loading…" : `Load more sketchbooks (${books.length} of ${booksTotal})`}
                </button>
              ) : null}
            </>
          ) : null}
        </section>

        <section className="ink-studios" aria-labelledby="ink-studios-title">
          <h2 id="ink-studios-title">Artist studios taking part</h2>
          <p>
            Individual artists running Inktober studios — anyone can watch,
            only the artist and their approved painters draw.
          </p>
          {studiosStatus === "loading" ? (
            <p className="ink-status" role="status">Finding participating studios…</p>
          ) : null}
          {studiosStatus === "ready" && studios.length === 0 ? (
            <p className="ink-status">
              No artist studios have joined Inktober yet — yours could be the first.
            </p>
          ) : null}
          {studiosStatus === "ready" && studios.length > 0 ? (
            <div className="ink-studio-list">
              {studios.map((s) => (
                <article className="ink-phase-card ink-studio-card" key={s.code}>
                  <p className="ink-phase-prompt">
                    <strong>{s.title || `Studio ${s.code}`}</strong>
                    {s.description ? <small>{s.description}</small> : null}
                    <small>{s.users > 0 ? `${s.users} watching now` : "Quiet right now"}</small>
                  </p>
                  <a
                    className="ink-join-btn"
                    href={`/join/${s.code}`}
                    onClick={(e) => follow(e, `/join/${s.code}`)}
                  >
                    Visit studio →
                  </a>
                </article>
              ))}
            </div>
          ) : null}
          <a
            className="ink-card-link ink-studios-more"
            href={`/gallery?event=${EVENT_ID}`}
            onClick={(e) => follow(e, `/gallery?event=${EVENT_ID}`)}
          >
            Browse all Inktober artist studios →
          </a>
        </section>

        <section className="ink-gallery" aria-labelledby="ink-gallery-title">
          <div className="ink-controls" id="ink-prompts">
            <h2 id="ink-gallery-title" style={{ margin: 0, fontSize: "1.2rem", flexBasis: "100%" }}>Event gallery</h2>
            <label htmlFor="ink-day-filter">Prompt day</label>
            <select id="ink-day-filter" value={day} onChange={(e) => setDay(e.target.value)}>
              <option value="all">All days</option>
              {prompts.map((p) => (
                <option key={p.day} value={String(p.day)}>
                  Day {p.day} — {p.prompt}
                </option>
              ))}
            </select>
            {selectedPrompt ? (
              <span className="ink-selected-prompt">“{selectedPrompt.prompt}” · {utcDateLabel(selectedPrompt.date)}</span>
            ) : null}
          </div>

          {galleryStatus === "loading" ? (
            <p className="ink-status" role="status">Hanging up the ink…</p>
          ) : null}

          {galleryStatus === "error" ? (
            <div className="ink-error" role="alert">
              <p>We couldn&rsquo;t load the gallery just now.</p>
              <button type="button" onClick={() => loadGallery(day)}>Try again</button>
            </div>
          ) : null}

          {galleryStatus === "ready" && posts.length === 0 ? (
            <div className="ink-status">
              <p>{emptyMessage()}</p>
              <button type="button" onClick={() => onNavigate(`/join/${phase === "active" ? ROOM_CODE : "MAIN"}`)}>
                Start drawing 🖌️
              </button>
            </div>
          ) : null}

          {galleryStatus === "ready" && posts.length > 0 ? (
            <div className="wall-masonry">
              {posts.map((p) => (
                <figure className="wall-card" key={p.id}>
                  <div className="wall-art">
                    <img src={`/api/wall/${p.id}/frame/0`} alt={p.title} loading="lazy" decoding="async" draggable={false} />
                    {p.frames > 1 ? <span className="wall-anim-badge" title="Animated!">🎬</span> : null}
                  </div>
                  <figcaption>
                    <div className="wall-caption-row">
                      <strong className="wall-title">{p.title}</strong>
                      <button
                        type="button"
                        className="wall-report"
                        onClick={() => report(p)}
                        title="Report this post"
                        aria-label={`Report ${p.title}`}
                      >
                        ⚑
                      </button>
                    </div>
                    <div className="wall-meta">
                      <span className="wall-artist">by {p.artist}</span>
                    </div>
                    {p.eventDay ? (
                      <span className="ink-day-badge">Day {p.eventDay}{p.eventPrompt ? ` · ${p.eventPrompt}` : ""}</span>
                    ) : null}
                    <a
                      className="ink-card-link"
                      href={`/wall/${encodeURIComponent(p.id)}`}
                      onClick={(e) => follow(e, `/wall/${encodeURIComponent(p.id)}`)}
                    >
                      View on the Wall →
                    </a>
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : null}
        </section>

        <section className="ink-about" aria-labelledby="ink-about-title">
          <h2 id="ink-about-title">About this event</h2>
          <p>
            The daily prompts come from the official Inktober list — see the{" "}
            <a href={rulesSource} target="_blank" rel="noreferrer">official rules and prompt list</a>.
            Drawesome&rsquo;s Ink &amp; Pencil room is an <strong>independent community event</strong>: it is{" "}
            <strong>not affiliated with or endorsed by Inktober</strong>, and we don&rsquo;t use the official logo.
          </p>
          <p>
            Browsing public artwork and drawing in the shared room need no account. Your own sketchbook
            belongs to your account and starts private. Only books you choose to make public appear here
            automatically; Wall posts are shared separately. Private artwork is never published for you.
            Use the report controls to reach the moderators.
          </p>
        </section>
      </main>
      <SiteFooter onNavigate={onNavigate} />
      {toast ? <div className="wall-toast" role="status">{toast}</div> : null}
    </div>
  );
}
