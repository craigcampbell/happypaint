import { useEffect, useState } from "react";
import CuratedHeader from './CuratedHeader';
import useCuratorContent from '../hooks/useCuratorContent';
import useHomeDrawingPrompts from '../hooks/useHomeDrawingPrompts';
import { drawingIdeaPath } from '../utils/drawingPrompts';
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import { ArtworkCards, BookCards, DiscoveryLink, EventInvitations } from "./DiscoveryPage";
import "./discovery.css";
import "./artwall-home.css";
import "./print-wall.css";

function FeedNotice({ status, empty, onRetry }) {
  return <div className="artwall-feed-notice" role="status">
    <p>{status === "loading" ? "Opening the community's pages…" : status === "error" ? "We couldn’t load this just now. Your own canvas is still ready." : empty}</p>
    {status === "error" ? <button type="button" onClick={onRetry}>Try again <span aria-hidden="true">↻</span></button> : null}
  </div>;
}

export default function HomePage({ onNavigate }) {
  const content = useCuratorContent('home');
  const prompts = useHomeDrawingPrompts();
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
  const selectedIdea = prompts.ideas[idea] || prompts.ideas[0];
  const needsAccount = prompts.status === 'guest' || prompts.status === 'rejected';
  const roomCode = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  const dailyPrompt = typeof feeds.daily.item?.prompt === "string" ? feeds.daily.item.prompt : "";

  return <div className="site-page discovery-page discovery-home artwall-home">
    <SiteNav onNavigate={onNavigate} current="/" />
    <main className="discovery-main artwall-main" id="main-content">
      <CuratedHeader page="home" content={content} onNavigate={onNavigate}
        promptAccess={prompts.status} />

      <section className="artwall-wall" aria-labelledby="home-art-title">
        <div className="artwall-section-heading">
          <h2 id="home-art-title" tabIndex={-1}>Community wall</h2>
          <DiscoveryLink href="/gallery" onNavigate={onNavigate}>All artwork <span aria-hidden="true">↗</span></DiscoveryLink>
          <p className="print-wall-note">New drawings from our artists.</p>
        </div>
        {feeds.art.status === "ready" && feeds.art.items.length
          ? <ArtworkCards posts={feeds.art.items} onNavigate={onNavigate} />
          : <FeedNotice status={feeds.art.status} onRetry={retry} empty="The wall is quiet for now. Draw something of your own and share it whenever you like." />}
      </section>

      <section className="artwall-idea" aria-labelledby="home-idea-title">
        <div className="artwall-idea-label">
          <span className="artwall-kicker">Drawing prompt</span>
          <h2 id="home-idea-title">What if?</h2>
        </div>
        <div className="artwall-idea-output">
          {selectedIdea ? <>
            <p className="artwall-prompt" aria-live="polite" aria-atomic="true">{selectedIdea.text}</p>
            <div className="artwall-idea-actions">
              <DiscoveryLink href={drawingIdeaPath(selectedIdea.id)} onNavigate={onNavigate}>Draw this idea <span aria-hidden="true">↗</span></DiscoveryLink>
              {prompts.ideas.length > 1 && <button type="button" onClick={() => setIdea((current) => (current + 1 + Math.floor(Math.random() * (prompts.ideas.length - 1))) % prompts.ideas.length)}>Another idea <span aria-hidden="true">↻</span></button>}
            </div>
            <p className="artwall-small-note">Opens your own private canvas.</p>
          </> : needsAccount ? <>
            <p className="artwall-prompt">Pick up a private drawing prompt with a free account.</p>
            <div className="artwall-idea-actions">
              <DiscoveryLink href={drawingIdeaPath('idea-1', prompts.status === 'guest')} onNavigate={onNavigate}>
                {prompts.status === 'rejected' ? 'Sign in again' : 'Sign up for a prompt'} <span aria-hidden="true">↗</span>
              </DiscoveryLink>
            </div>
          </> : <div role="status">
            <p>{prompts.status === 'error' ? 'Drawing prompts couldn’t load.' : 'Opening drawing prompts…'}</p>
            {prompts.status === 'error' && <button type="button" onClick={prompts.retry}>Try again</button>}
          </div>}
        </div>
      </section>

      <section className="artwall-invitations" aria-labelledby="home-events-title">
        <div className="artwall-section-heading">
          <h2 id="home-events-title">Open invitations</h2>
          <DiscoveryLink href="/events" onNavigate={onNavigate}>All events <span aria-hidden="true">↗</span></DiscoveryLink>
        </div>
        <EventInvitations onNavigate={onNavigate} />
      </section>

      {feeds.books.status !== "ready" || feeds.books.items.length ? (
        <section className="artwall-books" aria-labelledby="home-books-title">
          <div className="artwall-section-heading">
            <h2 id="home-books-title">Open sketchbooks</h2>
            <DiscoveryLink href="/inktober" onNavigate={onNavigate}>Explore Inktober <span aria-hidden="true">↗</span></DiscoveryLink>
          </div>
          {feeds.books.status === "ready" && feeds.books.items.length
            ? <BookCards books={feeds.books.items} onNavigate={onNavigate} />
            : <FeedNotice status={feeds.books.status} onRetry={retry} empty="No public sketchbooks here yet." />}
        </section>
      ) : null}

      <section className="artwall-together" aria-labelledby="home-together-title">
        <div className="print-together-intro">
          <h2 id="home-together-title">Draw together</h2>
          <p>Pass a room code to a friend and draw on the same canvas. Younger artists should draw with people they know and an adult present.</p>
          <DiscoveryLink href="/parents" onNavigate={onNavigate}>Activity ideas &amp; parent guide <span aria-hidden="true">↗</span></DiscoveryLink>
        </div>
        <div className="artwall-together-options">
          <form className="artwall-room-form" onSubmit={(event) => {
            event.preventDefault();
            if (!roomCode) return;
            if (onNavigate) onNavigate(`/join/${roomCode}`);
            else window.location.assign(`/join/${roomCode}`);
          }}>
            <label htmlFor="home-room-code">Got a room code?</label>
            <div>
              <input id="home-room-code" value={code} onChange={(event) => setCode(event.target.value)} maxLength={8} placeholder="ROOM CODE" autoCapitalize="characters" autoComplete="off" spellCheck={false} required />
              <button type="submit" disabled={!roomCode}>Join <span aria-hidden="true">↗</span></button>
            </div>
          </form>
          <div className="artwall-daily">
            <h3>Today’s shared canvas</h3>
            {feeds.daily.status === "loading" ? <p role="status">Finding today’s prompt…</p>
              : feeds.daily.status === "error" ? <p role="status">Today’s prompt couldn’t load. <button type="button" onClick={retry}>Try again</button></p>
              : <p>{dailyPrompt || "The shared canvas is open. No daily prompt is listed right now."}</p>}
            <p className="artwall-small-note">In public rooms, others can see artwork and chat.</p>
            <div className="print-room-links">
              <DiscoveryLink href="/join/DAILY" onNavigate={onNavigate}>Daily challenge <span aria-hidden="true">↗</span></DiscoveryLink>
              <DiscoveryLink href="/rooms" onNavigate={onNavigate}>Explore rooms <span aria-hidden="true">↗</span></DiscoveryLink>
            </div>
          </div>
        </div>
      </section>
      <div className="print-wall-signoff">
        <DiscoveryLink href="/draw" onNavigate={onNavigate}>Start a private drawing <span aria-hidden="true">↗</span></DiscoveryLink>
      </div>
    </main>
    <SiteFooter onNavigate={onNavigate} />
  </div>;
}
