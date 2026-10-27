import { lazy, Suspense, useEffect, useState } from "react";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import { COMMUNITY_EVENTS, getCommunityEvent } from "../data/communityEvents";
import "./discovery.css";

const LiveRoomCanvas = lazy(() => import("./LiveRoomCanvas"));
export function DiscoveryLink({ onNavigate, href, children, ...props }) {
  return <a {...props} href={href} onClick={(e) => {
    if (!onNavigate || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault(); onNavigate(href);
  }}>{children}</a>;
}
export function DiscoveryTabs({ onNavigate, active }) {
  return <nav className="discovery-tabs" aria-label="Discover">
    {[["artwork", "/gallery", "Artwork"], ["studios", "/studios", "Studios"], ["events", "/events", "Events"]].map(([id, href, label]) =>
      <DiscoveryLink key={id} href={href} onNavigate={onNavigate} aria-current={active === id ? "page" : undefined}>{label}</DiscoveryLink>)}
  </nav>;
}
export function EventInvitations({ onNavigate }) {
  return <div className="discovery-events">{COMMUNITY_EVENTS.map((event) => <article key={event.id} className="discovery-event" data-accent={event.accent}>
    <span className="discovery-eyebrow">{event.eyebrow}</span><h3><DiscoveryLink href={event.path} onNavigate={onNavigate}>{event.title}</DiscoveryLink></h3>
    <p>{event.description}</p><DiscoveryLink className="discovery-text-link" href={event.path} onNavigate={onNavigate}>Explore this invitation <span aria-hidden="true">→</span></DiscoveryLink>
  </article>)}</div>;
}
export function ArtworkCards({ posts, onNavigate }) {
  return <div className="discovery-artwork">{posts.map((post) => <figure key={post.id} className="discovery-art-card">
    <DiscoveryLink href={`/wall/${encodeURIComponent(post.id)}`} onNavigate={onNavigate}>
      <img src={`/api/wall/${encodeURIComponent(post.id)}/frame/0`} alt={post.title || "Community drawing"} loading="lazy" decoding="async" />
    </DiscoveryLink><figcaption><strong>{post.title || "Untitled drawing"}</strong><span>by {post.artist || "a community artist"}</span>
      {getCommunityEvent(post.event) ? <DiscoveryLink href={getCommunityEvent(post.event).path} onNavigate={onNavigate}>{getCommunityEvent(post.event).title}</DiscoveryLink> : null}
      {post.frames > 1 ? <small>Animation · open to view</small> : null}
    </figcaption></figure>)}</div>;
}
export function BookCards({ books, onNavigate }) {
  const [preview, setPreview] = useState(null);
  return <div className="discovery-books">{books.map((book) => <article className="discovery-book" key={book.id}>
    <span className="discovery-eyebrow">Public Inktober sketchbook</span>
    <h3><DiscoveryLink href={`/sketchbook/${encodeURIComponent(book.id)}`} onNavigate={onNavigate}>{book.title || "Inktober sketchbook"}</DiscoveryLink></h3>
    <p>{book.drawnPages} drawn page{book.drawnPages === 1 ? "" : "s"}{book.artistCount > 0 ? ` · ${book.artistCount} artist${book.artistCount === 1 ? "" : "s"}` : ""}</p>
    <p className="discovery-book-days">{(book.days || []).slice(0, 8).map((day) => <span key={day}>Day {day}</span>)}</p>
    {book.coverRoom ? <><button type="button" className="discovery-preview-button" aria-expanded={preview === book.id} onClick={() => setPreview(preview === book.id ? null : book.id)}>{preview === book.id ? "Close preview" : "Preview a page"}</button>
      {preview === book.id ? <div className="discovery-book-preview"><Suspense fallback={<p role="status">Loading the drawing…</p>}><LiveRoomCanvas roomCode={book.coverRoom} snapshotIntervalMs={60000} /></Suspense></div> : null}</> : null}
    <DiscoveryLink className="discovery-text-link" href={`/sketchbook/${encodeURIComponent(book.id)}`} onNavigate={onNavigate}>Flip through the book →</DiscoveryLink>
  </article>)}</div>;
}
export default function DiscoveryPage({ onNavigate, initialTab = "artwork" }) {
  const [data, setData] = useState({ posts: [], books: [] });
  const [status, setStatus] = useState("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (initialTab === "events") return undefined;
    const controller = new AbortController();
    setStatus("loading");
    Promise.all(["/api/wall?sort=new&limit=36", "/api/sketchbooks?event=inktober-2026&limit=12"].map(async (url) => {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error("Could not load artwork");
      return response.json();
    })).then(([wall, books]) => { setData({ posts: wall.posts || [], books: books.books || [] }); setStatus("ready"); })
      .catch((error) => { if (error.name !== "AbortError") setStatus("error"); });
    return () => controller.abort();
  }, [initialTab, attempt]);
  return <div className="site-page discovery-page"><SiteNav onNavigate={onNavigate} current={initialTab === "events" ? "/events" : "/gallery"} />
    <main className="discovery-main"><header className="discovery-heading"><p className="discovery-eyebrow">Made here. Shared by choice.</p><h1>{initialTab === "events" ? "Find a reason to draw." : "A little inspiration goes a long way."}</h1><p>Discover community artwork, peek into a sketchbook, or find an invitation that speaks to you.</p></header>
      <DiscoveryTabs onNavigate={onNavigate} active={initialTab} />
      {initialTab === "events" ? <EventInvitations onNavigate={onNavigate} /> : <>
        {status === "loading" ? <p role="status">Finding community artwork…</p> : null}
        {status === "error" ? <div role="alert"><p>We couldn’t load the artwork just now.</p><button type="button" onClick={() => { setStatus("loading"); setAttempt((n) => n + 1); }}>Try again</button></div> : null}
        {status === "ready" ? <><section aria-labelledby="discovery-art-title"><h2 id="discovery-art-title">On the community wall</h2>{data.posts.length ? <ArtworkCards posts={data.posts} onNavigate={onNavigate} /> : <p>No artwork has been shared here yet. You can draw without publishing anything.</p>}<DiscoveryLink className="discovery-text-link" href="/wall" onNavigate={onNavigate}>Explore the Fridge Wall →</DiscoveryLink></section>
          {data.books.length ? <section aria-labelledby="discovery-books-title"><h2 id="discovery-books-title">Sketchbooks to wander through</h2><BookCards books={data.books} onNavigate={onNavigate} /></section> : null}</> : null}
        <section aria-labelledby="discovery-invite-title"><h2 id="discovery-invite-title">An idea to begin with</h2><EventInvitations onNavigate={onNavigate} /></section>
      </>}
      <aside className="discovery-start"><h2>Your next drawing starts with one line.</h2><DiscoveryLink className="primary-action" href="/draw" onNavigate={onNavigate}>Draw my own →</DiscoveryLink><p>No account needed. Sharing is always your choice.</p></aside>
    </main><SiteFooter onNavigate={onNavigate} /></div>;
}
