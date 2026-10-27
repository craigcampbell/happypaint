import { useEffect, useState } from "react";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import { ArtworkCards, BookCards, DiscoveryLink, EventInvitations } from "./DiscoveryPage";
import "./discovery.css";

export default function HomePage({ onNavigate }) {
  const [posts, setPosts] = useState([]);
  const [books, setBooks] = useState([]);
  const [daily, setDaily] = useState(null);
  const [code, setCode] = useState("");
  const [artStatus, setArtStatus] = useState("loading");
  useEffect(() => {
    const controller = new AbortController();
    const read = async (url) => {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error("load_failed");
      return response.json();
    };
    read("/api/wall?sort=new&limit=6").then((data) => { setPosts(data.posts || []); setArtStatus("ready"); }).catch((error) => { if (error.name !== "AbortError") setArtStatus("error"); });
    read("/api/sketchbooks?event=inktober-2026&limit=3").then((data) => setBooks(data.books || [])).catch(() => {});
    read("/api/daily").then(setDaily).catch(() => {});
    return () => controller.abort();
  }, []);
  const roomCode = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return <div className="site-page discovery-page discovery-home"><SiteNav onNavigate={onNavigate} current="/" />
    <main className="discovery-main">
      <section className="discovery-home-hero" aria-labelledby="home-title"><p className="discovery-eyebrow">Free online drawing studio</p><h1 id="home-title">A small idea.<br /><em>A whole world to draw.</em></h1><p>Draw online for free, find inspiration, and make something that feels like you. Touch, mouse, or pen. No install or account needed to start.</p><div className="discovery-actions"><DiscoveryLink className="primary-action" href="/draw" onNavigate={onNavigate}>Start drawing →</DiscoveryLink><DiscoveryLink href="/rooms" onNavigate={onNavigate}>Draw together</DiscoveryLink></div><p className="discovery-note">Your own canvas, or a shared room. You choose what to share.</p></section>
      <section aria-labelledby="home-art-title"><div className="discovery-section-heading"><div><p className="discovery-eyebrow">Made on Drawesome</p><h2 id="home-art-title">Look what a line can become.</h2></div><DiscoveryLink href="/gallery" onNavigate={onNavigate}>Explore artwork →</DiscoveryLink></div>
        {posts.length ? <ArtworkCards posts={posts} onNavigate={onNavigate} /> : <p role="status">{artStatus === "loading" ? "Finding community artwork…" : artStatus === "error" ? "Community artwork is unavailable just now. You can still start drawing." : "No drawings have been shared here yet. Your own canvas is ready whenever you are."}</p>}
      </section>
      <section aria-labelledby="home-events-title"><div className="discovery-section-heading"><div><p className="discovery-eyebrow">Something to draw for</p><h2 id="home-events-title">An invitation, not an assignment.</h2></div><DiscoveryLink href="/events" onNavigate={onNavigate}>All events →</DiscoveryLink></div><EventInvitations onNavigate={onNavigate} /></section>
      {books.length ? <section aria-labelledby="home-books-title"><h2 id="home-books-title">A peek inside the sketchbooks</h2><BookCards books={books} onNavigate={onNavigate} /></section> : null}
      <section aria-labelledby="home-tools-title"><p className="discovery-eyebrow">A drawing app that opens right here</p><h2 id="home-tools-title">Big tools. No big setup.</h2><div className="discovery-features">
        <article><h3>Make it your way</h3><p>Paint, sketch, add layers, or make a flipbook animation. Natural brushes and coloring pages give every idea a place to start.</p><DiscoveryLink href="/draw" onNavigate={onNavigate}>Open your canvas →</DiscoveryLink></article>
        <article><h3>Make it together</h3><p>Draw with friends on the same canvas in real time. Public rooms are open to everyone; their art and chat can be visible to others.</p><DiscoveryLink href="/rooms" onNavigate={onNavigate}>Find a shared room →</DiscoveryLink></article>
        <article><h3>Try a little prompt</h3><p>{daily?.prompt ? `Today’s challenge: ${daily.prompt}` : "Try the daily drawing challenge, or catch up on an Inktober prompt at your own pace."}</p><DiscoveryLink href="/join/DAILY" onNavigate={onNavigate}>Daily challenge →</DiscoveryLink><br /><DiscoveryLink href="/inktober" onNavigate={onNavigate}>Inktober & catch-up prompts →</DiscoveryLink></article>
      </div></section>
      <form className="discovery-code" onSubmit={(e) => { e.preventDefault(); if (roomCode) onNavigate(`/join/${roomCode}`); }}><label htmlFor="home-room-code">Have a room code?</label><div><input id="home-room-code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={8} placeholder="Enter code" autoCapitalize="characters" autoComplete="off" spellCheck={false} required /><button type="submit" disabled={!roomCode}>Join room →</button></div></form>
      <aside className="discovery-start"><h2>A little art time, together.</h2><p>Families, teachers, and clubs: try a shared creature or a story drawn one panel at a time. Younger artists should start with people they know and an adult present.</p><DiscoveryLink href="/parents" onNavigate={onNavigate}>Free activity ideas & parent guide →</DiscoveryLink></aside>
    </main><SiteFooter onNavigate={onNavigate} /></div>;
}
