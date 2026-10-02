// /sketchbook/:id — the sketchbook reader (docs/SKETCHBOOKS-CONTRACT.md).
//
// PUBLIC books: anyone can flip through the pages — the pinned prompt chip
// stays in the top corner, previous/next (or the day strip) turns pages, and
// ONLY the selected page's heavy canvas loads (the spectator LiveRoomCanvas
// is mounted for one room at a time, keyed by page). Every page links to its
// live studio (public watch; drawing stays owner/invite-only). Visitors get
// the start-your-own-sketchbook CTA; the owner gets add-page, invite and
// visibility shortcuts.
//
// PRIVATE books: only the owner and invited artists can open them — the
// server answers everyone else with the same 404 as a missing book (no
// metadata leak), so this page shows an honest "private — or not here"
// card with a sign-in path back for invited artists. Private pages have NO
// anonymous spectator surface, so the reader never mounts the spectate
// canvas for them: the team views/draws through the page studio (member
// joins are book-gated server-side). The owner flips visibility with the
// toggle here (PUBLIC needs an explicit confirm; the downgrade to private
// is immediate).

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import { fetchSketchbook, addSketchbookPage, setSketchbookVisibility } from "../utils/sketchbookApi";
import { getSession, isCloudConfigured, onAuthStateChange } from "../utils/auth";
import "../sketchbook.css";

const LiveRoomCanvas = lazy(() => import("./LiveRoomCanvas"));

export default function SketchbookPage({ bookId, onNavigate }) {
  const [book, setBook] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | missing | error
  const [selected, setSelected] = useState(0); // index into book.pages
  const [session, setSession] = useState(undefined);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const toastTimer = useRef(null);
  const seqRef = useRef(0);

  const say = useCallback((text) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2800);
  }, []);

  useEffect(() => {
    let active = true;
    getSession().then((v) => active && setSession(v));
    const unsub = onAuthStateChange((v) => active && setSession(v));
    return () => { active = false; unsub(); };
  }, []);

  const load = useCallback(async (sess) => {
    const seq = (seqRef.current += 1);
    setStatus("loading");
    const r = await fetchSketchbook(bookId, sess || null);
    if (seq !== seqRef.current) return;
    // 404 is deliberately ambiguous: the book is missing, OR it is private
    // and the caller isn't on the team. The denial card covers both.
    if (r.status === 404) { setBook(null); setStatus("missing"); return; }
    if (!r.ok || !r.json?.book) { setBook(null); setStatus("error"); return; }
    setBook(r.json.book);
    setStatus("ready");
    setSelected((cur) => {
      const pages = r.json.book.pages || [];
      if (!pages.length) return 0;
      if (cur < pages.length) return cur;
      return pages.length - 1;
    });
  }, [bookId]);

  useEffect(() => {
    if (session === undefined) return; // wait for the first auth resolution
    load(session);
    return () => window.clearTimeout(toastTimer.current);
  }, [session, load]);

  // Default to the latest page with real drawing once the book lands.
  useEffect(() => {
    if (status !== "ready" || !book?.pages?.length) return;
    const lastDrawn = book.pages.reduce((acc, p, i) => (p.ops > 0 ? i : acc), 0);
    setSelected(lastDrawn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, book?.id]);

  if (status === "loading" || session === undefined) {
    return (
      <main className="route-status" role="status" aria-live="polite">
        <h1>Opening the sketchbook…</h1>
        <p>One moment while this page loads.</p>
      </main>
    );
  }

  if (status === "missing" || status === "error" || !book) {
    const returnTo = encodeURIComponent(`/sketchbook/${bookId}`);
    return (
      <main className="route-status">
        {status === "error" ? (
          <>
            <h1>We couldn’t open this sketchbook</h1>
            <p>Check your connection, then try again.</p>
            <button type="button" className="primary-action" onClick={() => load(session)}>Try again</button>
          </>
        ) : (
          <>
            <h1>This sketchbook is private — or isn’t here</h1>
            <p>
              Only the owner and invited artists can open a private sketchbook. If you were invited,
              sign in and come straight back — this page will pick up where you left off.
            </p>
            {session === null && isCloudConfigured ? (
              <button
                type="button"
                className="primary-action"
                onClick={() => onNavigate(`/signup?mode=login&return=${returnTo}`)}
              >
                Log in to view this sketchbook
              </button>
            ) : (
              <p>
                {session
                  ? "You’re signed in, so this book either hasn’t invited you or the link is incomplete."
                  : "It may have been removed, or the link is incomplete."}
              </p>
            )}
            <button type="button" onClick={() => onNavigate("/inktober")}>Browse Inktober</button>
          </>
        )}
        <a href="/">Back to Drawesome</a>
      </main>
    );
  }

  const pages = book.pages || [];
  const page = pages[selected] || null;
  const isOwner = book.owner === true;
  const isPublic = book.public === true;

  const addTodayPage = async () => {
    if (busy) return;
    setBusy(true);
    const r = await addSketchbookPage(book.id, null, session);
    setBusy(false);
    if (!r.ok) {
      say(r.json?.message || "Couldn't add a page — pick a day in your studio banner instead.");
      return;
    }
    await load(session);
    say(r.json?.resumed ? "That page already exists." : "Page added!");
  };

  // Owner visibility toggle. Going PUBLIC needs an explicit confirm (the
  // book becomes watchable by anyone with the link and gallery-eligible);
  // the downgrade to private is immediate and sweeps strangers out
  // server-side.
  const toggleVisibility = async () => {
    if (busy) return;
    const goingPublic = !isPublic;
    if (goingPublic) {
      const ok = window.confirm(
        "Make this sketchbook PUBLIC?\n\n"
        + "Anyone with the link will be able to watch every page, and pages with real artwork will "
        + "appear in the public Inktober gallery automatically.\n\n"
        + "Drawing stays limited to you and your invited artists. You can switch back to private anytime.",
      );
      if (!ok) return;
    }
    setBusy(true);
    const r = await setSketchbookVisibility(book.id, goingPublic, session);
    setBusy(false);
    if (!r.ok || !r.json?.book) {
      say(r.json?.message || "Couldn't change visibility — try again.");
      return;
    }
    setBook(r.json.book);
    say(goingPublic
      ? "Your sketchbook is now public — anyone with the link can watch."
      : "Your sketchbook is now private — only you and invited artists can open it.");
  };

  return (
    <div className="skb-reader">
      <SiteNav onNavigate={onNavigate} current="/inktober" />
      <header className="skb-reader-head">
        <span className="skb-prompt-chip">
          <span className="skb-prompt-tag">#inktober 2026</span>
          {page ? (
            <>
              <span>Day {page.day}</span>
              <span className="skb-prompt-text">“{page.prompt}”</span>
            </>
          ) : (
            <span className="skb-prompt-text">a brand-new sketchbook</span>
          )}
        </span>
        <h1 className="skb-reader-title">{book.title || "Inktober sketchbook"}</h1>
        <span
          className={`skb-badge ${isPublic ? "skb-badge-public" : "skb-badge-private"}`}
          title={isPublic
            ? "Public — anyone with the link can watch; drawing stays invite-only"
            : "Private — only the owner and invited artists can open this book"}
        >
          {isPublic ? "🌍 Public" : "🔒 Private"}
        </span>
        <span className="skb-reader-meta">
          {book.artistCount} of {book.maxArtists} artists · {book.pageCount} of {book.maxPages} pages
          {book.moderationHidden ? " · hidden from discovery by moderators" : ""}
        </span>
      </header>
      <p className="skb-reader-visibility-note">
        {isPublic
          ? "Anyone with the link can watch this book; only the owner and invited artists can draw."
          : isOwner
            ? "Private: only you and your invited artists can open this book. Invitation links grant both viewing and drawing."
            : "Private book — you’re viewing as an invited artist."}
      </p>

      {pages.length > 0 ? (
        <>
          <nav className="skb-reader-nav" aria-label="Flip pages">
            <button type="button" disabled={selected <= 0} onClick={() => setSelected(selected - 1)}>‹ Previous page</button>
            <span className="skb-reader-meta">Page {selected + 1} of {pages.length}</span>
            <button type="button" disabled={selected >= pages.length - 1} onClick={() => setSelected(selected + 1)}>Next page ›</button>
          </nav>

          <div className="skb-reader-canvas">
            {page && isPublic ? (
              <Suspense fallback={<div className="skb-reader-empty">Loading this page’s canvas…</div>}>
                {/* ONLY the selected page's room loads a canvas/socket. Spectator
                    sockets are anonymous-only and private books have NO spectator
                    surface (server: room_blocked book_private), so the canvas
                    mounts for public books only. */}
                <LiveRoomCanvas key={page.room} roomCode={page.room} snapshotIntervalMs={60000} />
              </Suspense>
            ) : null}
            {page && !isPublic ? (
              <div className="skb-reader-empty skb-reader-private-note">
                <div>
                  <p>🔒 This page’s canvas stays inside its studio while the book is private.</p>
                  <button type="button" className="primary-action" onClick={() => onNavigate(`/join/${page.room}`)}>
                    Open the page studio to view &amp; draw →
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <div className="skb-days" role="tablist" aria-label="Prompt days">
            {pages.map((p, i) => (
              <button
                type="button"
                key={p.room}
                role="tab"
                aria-current={i === selected ? "true" : "false"}
                title={`Day ${p.day} — ${p.prompt}${p.hidden ? " (hidden by moderators)" : ""}`}
                onClick={() => setSelected(i)}
              >
                {p.ops > 0 ? <span className="skb-day-dot" aria-label="has artwork">●</span> : null} {p.day}
              </button>
            ))}
          </div>

          <div className="skb-reader-actions">
            {page ? (
              <>
                <button type="button" className="ink-join-btn" onClick={() => onNavigate(`/join/${page.room}`)}>
                  Visit this page’s studio →
                </button>
                {isPublic ? (
                  <button type="button" onClick={() => onNavigate(`/live/${page.room}`)}>
                    Watch live
                  </button>
                ) : null}
              </>
            ) : null}
            <button type="button" className="ink-join-btn" onClick={() => onNavigate("/sketchbook")}>
              Start your own sketchbook →
            </button>
            {isOwner && book.pageCount < book.maxPages ? (
              <button type="button" disabled={busy} onClick={addTodayPage}>+ Add today&rsquo;s page</button>
            ) : null}
            {isOwner ? (
              <button
                type="button"
                disabled={busy}
                onClick={toggleVisibility}
                title={isPublic
                  ? "Switch back to private — only you and invited artists can open the book (takes effect immediately)"
                  : "Make the book watchable by anyone with the link (asks for confirmation)"}
              >
                {isPublic ? "Make private" : "Make public…"}
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <div className="skb-reader-empty">
          <div>
            <p>This sketchbook has no pages yet.</p>
            {isOwner ? (
              <>
                <button type="button" className="primary-action" disabled={busy} onClick={addTodayPage}>
                  Add the first page
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={toggleVisibility}
                  style={{ marginLeft: "0.6rem" }}
                >
                  {isPublic ? "Make private" : "Make public…"}
                </button>
              </>
            ) : (
              <button type="button" className="primary-action" onClick={() => onNavigate("/sketchbook")}>
                Start your own sketchbook
              </button>
            )}
          </div>
        </div>
      )}

      <SiteFooter onNavigate={onNavigate} />
      {toast ? <div className="wall-toast" role="status">{toast}</div> : null}
    </div>
  );
}
