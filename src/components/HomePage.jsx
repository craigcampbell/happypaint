import { useEffect, useState } from "react";
import CuratedHeader from './CuratedHeader';
import useCuratorContent from '../hooks/useCuratorContent';
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import { ArtworkCards, BookCards, DiscoveryLink, EventInvitations } from "./DiscoveryPage";
import "./discovery.css";
import "./artwall-home.css";

const IDEAS = [
  "A very small creature with a very big idea.",
  "A garden that only grows silly things.",
  "The world's most impractical flying machine.",
  "A party at the bottom of the ocean.",
  "Your favourite sound, but as a picture.",
  "A house for a cloud to live in.",
  "Two colours having a conversation.",
  "A friendly monster on its day off.",
];

function FeedNotice({ status, empty, onRetry }) {
  return <div className="artwall-feed-notice" role="status">
    <p>{status === "loading" ? "Opening the community's pages…" : status === "error" ? "We couldn’t load this just now. Your own canvas is still ready." : empty}</p>
    {status === "error" ? <button type="button" onClick={onRetry}>Try again <span aria-hidden="true">↻</span></button> : null}
  </div>;
}

export default function HomePage({ onNavigate }) {
  const content = useCuratorContent('home');
  const [feeds, setFeeds] = useState({
    art: { status: "loading", items: [] },
    books: { status: "loading", items: [] },
    daily: { status: "loading", item: null },
  });
  const [attempt, setAttempt] = useState(0);
  const [idea, setIdea] = useState(0);
  const [code, setCode] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const sources = [
      ["art", "/api/wall?sort=new&limit=6", "posts"],
      ["books", "/api/sketchbooks?event=inktober-2026&limit=3", "books"],
      ["daily", "/api/daily", null],
    ];
    for (const [key, url, list] of sources) {
      fetch(url, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
        if (!response.ok) throw new Error("load_failed");
        const data = await response.json();
        if (list && !Array.isArray(data?.[list])) throw new Error("invalid_feed");
        setFeeds((current) => ({ ...current, [key]: list ? { status: "ready", items: data[list] } : { status: "ready", item: data } }));
      }).catch((error) => {
        if (error.name !== "AbortError") setFeeds((current) => ({ ...current, [key]: { ...current[key], status: "error" } }));
      });
    }
    return () => controller.abort();
  }, [attempt]);

  const retry = () => {
    setFeeds((current) => Object.fromEntries(Object.entries(current).map(([key, value]) => [key, { ...value, status: "loading" }])));
    setAttempt((value) => value + 1);
  };
  const roomCode = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  const dailyPrompt = typeof feeds.daily.item?.prompt === "string" ? feeds.daily.item.prompt : "";

  return <div className="site-page discovery-page discovery-home artwall-home">
    <SiteNav onNavigate={onNavigate} current="/" />
    <main className="discovery-main artwall-main" id="main-content">
      <CuratedHeader page="home" content={content} onNavigate={onNavigate} />

      <section className="artwall-wall" aria-labelledby="home-art-title">
        <div className="artwall-section-heading"><div><span className="artwall-kicker">Fresh off somebody’s canvas</span><h2 id="home-art-title" tabIndex={-1}>THE COMMUNITY WALL<span aria-hidden="true">↙</span></h2></div><DiscoveryLink href="/gallery" onNavigate={onNavigate}>All artwork <span aria-hidden="true">↗</span></DiscoveryLink></div>
        {feeds.art.status === "ready" && feeds.art.items.length ? <ArtworkCards posts={feeds.art.items} onNavigate={onNavigate} /> : <FeedNotice status={feeds.art.status} onRetry={retry} empty="The wall is quiet for now. Make something for yourself; publish only if you want to." />}
        <p className="artwall-wall-note">Real drawings, shared by the people who made them.</p>
      </section>

      <section className="artwall-idea" aria-labelledby="home-idea-title">
        <div className="artwall-idea-label"><span className="artwall-kicker">The what-if machine</span><h2 id="home-idea-title">STUCK?<br /> START HERE.</h2><span className="artwall-handwritten">One little idea can go anywhere.</span></div>
        <div className="artwall-idea-output"><p className="artwall-prompt" aria-live="polite" aria-atomic="true">{IDEAS[idea]}</p><div className="artwall-idea-actions"><button type="button" onClick={() => setIdea((current) => (current + 1 + Math.floor(Math.random() * (IDEAS.length - 1))) % IDEAS.length)}>Another idea <span aria-hidden="true">↻</span></button><DiscoveryLink href={`/draw?prompt=${encodeURIComponent(IDEAS[idea])}`} onNavigate={onNavigate}>Draw this idea <span aria-hidden="true">↗</span></DiscoveryLink></div><p className="artwall-small-note">Opens your private canvas. Bend the idea, or ignore it entirely.</p></div>
      </section>

      <section className="artwall-invitations" aria-labelledby="home-events-title">
        <div className="artwall-section-heading"><div><span className="artwall-kicker">Different reasons to pick up a brush</span><h2 id="home-events-title">MAKE A LITTLE SPACE.</h2></div><DiscoveryLink href="/events" onNavigate={onNavigate}>All invitations <span aria-hidden="true">↗</span></DiscoveryLink></div>
        <EventInvitations onNavigate={onNavigate} />
      </section>

      {feeds.books.status !== "ready" || feeds.books.items.length ? <section className="artwall-books" aria-labelledby="home-books-title"><div className="artwall-section-heading"><div><span className="artwall-kicker">One page leads to another</span><h2 id="home-books-title">OPEN SKETCHBOOKS.</h2></div><DiscoveryLink href="/inktober" onNavigate={onNavigate}>Explore Inktober <span aria-hidden="true">↗</span></DiscoveryLink></div>
        {feeds.books.status === "ready" && feeds.books.items.length ? <BookCards books={feeds.books.items} onNavigate={onNavigate} /> : <FeedNotice status={feeds.books.status} onRetry={retry} empty="No public sketchbooks here yet. Inktober’s prompts are still yours to explore, at your own pace." />}
      </section> : null}

      <section className="artwall-together" aria-labelledby="home-together-title">
        <div><span className="artwall-kicker">There’s room for your people</span><h2 id="home-together-title">PASS THE<br />IMAGINATION.</h2><p>Make a creature with a friend. Tell a story one drawing at a time. Younger artists should create with people they know and an adult present.</p><DiscoveryLink href="/parents" onNavigate={onNavigate}>Activity ideas & parent guide <span aria-hidden="true">↗</span></DiscoveryLink></div>
        <div className="artwall-together-options"><form className="artwall-room-form" onSubmit={(event) => { event.preventDefault(); if (roomCode) { if (onNavigate) onNavigate(`/join/${roomCode}`); else window.location.assign(`/join/${roomCode}`); } }}><label htmlFor="home-room-code">Got a room code?</label><div><input id="home-room-code" value={code} onChange={(event) => setCode(event.target.value)} maxLength={8} placeholder="ROOM CODE" autoCapitalize="characters" autoComplete="off" spellCheck={false} required aria-describedby="home-room-note" /><button type="submit" disabled={!roomCode}>Join <span aria-hidden="true">↗</span></button></div><p id="home-room-note">Join the people who invited you.</p></form>
          <div className="artwall-daily"><h3>A shared daily canvas</h3>{feeds.daily.status === "loading" ? <p role="status">Finding today’s prompt…</p> : feeds.daily.status === "error" ? <p role="status">Today’s prompt couldn’t load. <button type="button" onClick={retry}>Try again</button></p> : <p>{dailyPrompt || "No daily prompt is listed right now. You can still open the shared canvas."}</p>}<DiscoveryLink href="/join/DAILY" onNavigate={onNavigate}>Daily challenge <span aria-hidden="true">↗</span></DiscoveryLink><p className="artwall-small-note">Public room: artwork and chat may be visible to others.</p></div>
          <DiscoveryLink href="/rooms" onNavigate={onNavigate}>Explore shared rooms <span aria-hidden="true">↗</span></DiscoveryLink>
        </div>
      </section>
      <div className="artwall-signoff"><span aria-hidden="true">GO ON.<br />MAKE YOUR MARK.</span><DiscoveryLink className="artwall-draw" href="/draw" onNavigate={onNavigate}>Your canvas is ready <span aria-hidden="true">↗</span></DiscoveryLink></div>
    </main>
    <SiteFooter onNavigate={onNavigate} />
  </div>;
}
