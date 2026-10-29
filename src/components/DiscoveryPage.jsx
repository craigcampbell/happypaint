import CuratedHeader from './CuratedHeader';
import useCuratorContent from '../hooks/useCuratorContent';
import { lazy, Suspense, useEffect, useState } from "react";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import { COMMUNITY_EVENTS, getCommunityEvent } from "../data/communityEvents";
import "./discovery.css";
import "./discovery-graffiti.css";
import { DiscoverySearch } from "./DiscoveryBrowse";

const LiveRoomCanvas = lazy(() => import("./LiveRoomCanvas"));
const RoomGallery = lazy(() => import("./RoomGallery"));
export function DiscoveryLink({ onNavigate, href, children, ...props }) {
  return <a {...props} href={href} onClick={(e) => {
    if (!onNavigate || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault(); onNavigate(href);
  }}>{children}</a>;
}
export function DiscoveryTabs({ onNavigate, active }) {
  return <nav className="discovery-tabs" aria-label="Discover">
    {[["artwork", "/gallery", "Artwork"], ["studios", "/studios", "Studios"], ["events", "/events", "Events"], ["rooms", "/gallery?mode=rooms", "Room shuffle"]].map(([id, href, label]) =>
      <DiscoveryLink key={id} href={href} onNavigate={onNavigate} aria-current={active === id ? "page" : undefined}>{label}</DiscoveryLink>)}
  </nav>;
}
export function EventInvitations({ onNavigate }) {
  return <div className="discovery-events">{COMMUNITY_EVENTS.map((event) => <article key={event.id} className="discovery-event" data-accent={event.accent} data-sensitive={event.sensitive ? "true" : undefined}>
    <span className="discovery-eyebrow">{event.eyebrow}</span>
    <svg className="discovery-poster-mark" viewBox="0 0 240 130" aria-hidden="true" focusable="false">
      {event.accent === "ink" ? <g fill="currentColor"><path d="M20 105 80 18h30L50 105zM85 112l60-87h30l-60 87zM150 107l59-87h17l-59 87z" /><path d="M15 118h210v5H15z" /></g> : event.accent === "joy" ? <g fill="none" stroke="currentColor" strokeWidth="7"><circle cx="120" cy="65" r="34" /><path d="M120 8v14m0 86v14M63 65H49m142 0h-14M79 24l10 10m62 62 10 10M79 106l10-10m62-62 10-10" /></g> : <g fill="none" stroke="currentColor" strokeWidth="2"><path d="M46 101c24-56 47-56 74 0 28-56 51-56 74 0M35 113h170" /><circle cx="120" cy="34" r="13" /></g>}
    </svg>
    <h3><DiscoveryLink href={event.path} onNavigate={onNavigate}>{event.title}</DiscoveryLink></h3>
    <p>{event.description}</p><DiscoveryLink className="discovery-text-link" href={event.path} onNavigate={onNavigate}>{event.sensitive ? "Read the invitation" : "Explore this invitation"} <span aria-hidden="true">→</span></DiscoveryLink>
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
  const content = useCuratorContent(initialTab === "events" ? "events" : "gallery");
  const query = new URLSearchParams(window.location.search).get("q")?.trim().slice(0, 80) || "";
  const roomMode = initialTab === "artwork" && new URLSearchParams(window.location.search).get("mode") === "rooms";
  const [data, setData] = useState({ posts: [], books: [] });
  const [status, setStatus] = useState("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (initialTab === "events" || roomMode) return undefined;
    const controller = new AbortController();
    setStatus("loading");
    Promise.all([`/api/wall?sort=new&limit=36&q=${encodeURIComponent(query)}`, "/api/sketchbooks?event=inktober-2026&limit=12"].map(async (url) => {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error("Could not load artwork");
      return response.json();
    })).then(([wall, books]) => { setData({ posts: wall.posts || [], books: books.books || [] }); setStatus("ready"); })
      .catch((error) => { if (error.name !== "AbortError") setStatus("error"); });
    return () => controller.abort();
  }, [initialTab, attempt, query, roomMode]);
  return <div className="site-page discovery-page discovery-index"><SiteNav onNavigate={onNavigate} current={initialTab === "events" ? "/events" : "/gallery"} />
    <main className="discovery-main">{roomMode || query ? <header className="discovery-heading"><span className="discovery-eyebrow">Made here. Shared by choice.</span><h1>{roomMode ? "Room shuffle" : `Artwork: ${query}`}</h1><p>{roomMode ? "A different room. A different point of view." : "Search the community’s shared artwork."}</p></header> : <CuratedHeader page={initialTab === "events" ? "events" : "gallery"} content={content} onNavigate={onNavigate} />}
      <DiscoveryTabs onNavigate={onNavigate} active={roomMode ? "rooms" : initialTab} />
      {!roomMode && initialTab !== "events" ? <DiscoverySearch key={query} initialQuery={query} onNavigate={onNavigate} /> : null}
      {roomMode ? <Suspense fallback={<p role="status">Loading room gallery…</p>}><RoomGallery onNavigate={onNavigate} /></Suspense> : initialTab === "events" ? <EventInvitations onNavigate={onNavigate} /> : <>
        {status === "loading" ? <p role="status">Finding community artwork…</p> : null}
        {status === "error" ? <div role="alert"><p>We couldn’t load the artwork just now.</p><button type="button" onClick={() => { setStatus("loading"); setAttempt((n) => n + 1); }}>Try again</button></div> : null}
        {status === "ready" ? <><section aria-labelledby="discovery-art-title"><h2 id="discovery-art-title">On the community wall</h2>{data.posts.length ? <ArtworkCards posts={data.posts} onNavigate={onNavigate} /> : <p>{query ? `No shared artwork matches “${query}” yet. Try another search or draw your own.` : "No artwork has been shared here yet. You can draw without publishing anything."}</p>}<DiscoveryLink className="discovery-text-link" href="/wall" onNavigate={onNavigate}>Explore the Fridge Wall →</DiscoveryLink></section>
          {!query && data.books.length ? <section aria-labelledby="discovery-books-title"><h2 id="discovery-books-title">Sketchbooks to wander through</h2><BookCards books={data.books} onNavigate={onNavigate} /></section> : null}</> : null}
        <section aria-labelledby="discovery-invite-title"><h2 id="discovery-invite-title">An idea to begin with</h2><EventInvitations onNavigate={onNavigate} /></section>
      </>}
      <aside className="discovery-start"><h2>Make something of your own</h2><DiscoveryLink className="primary-action" href="/draw" onNavigate={onNavigate}>Draw my own →</DiscoveryLink><p>No account needed. Sharing is always your choice.</p></aside>
    </main><SiteFooter onNavigate={onNavigate} /></div>;
}
