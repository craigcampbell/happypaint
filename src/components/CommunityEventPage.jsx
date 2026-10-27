import { useEffect, useState } from "react";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import { ArtworkCards, DiscoveryLink, DiscoveryTabs } from "./DiscoveryPage";
import { eventDrawingPath, getCommunityEvent } from "../data/communityEvents";
import EventSharingReceipt from "./EventSharingReceipt";
import "./discovery.css";

export default function CommunityEventPage({ onNavigate, eventId }) {
  const event = getCommunityEvent(eventId);
  const [posts, setPosts] = useState([]);
  const [studios, setStudios] = useState([]);
  const [status, setStatus] = useState("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!event) return undefined;
    const controller = new AbortController();
    setStatus("loading");
    Promise.all([`/api/wall?event=${encodeURIComponent(event.id)}&sort=new&limit=60`, `/api/rooms/gallery?event=${encodeURIComponent(event.id)}&limit=12`].map(async (url) => {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error("load_failed");
      return response.json();
    })).then(([wall, gallery]) => { setPosts(wall.posts || []); setStudios(gallery.rooms || []); setStatus("ready"); })
      .catch((error) => { if (error.name !== "AbortError") setStatus("error"); });
    return () => controller.abort();
  }, [event, attempt]);
  return <div className="site-page discovery-page"><SiteNav onNavigate={onNavigate} current="/events" /><main className="discovery-main">
    <DiscoveryTabs active="events" onNavigate={onNavigate} />
    {!event ? <><h1>This invitation isn’t here.</h1><DiscoveryLink href="/events" onNavigate={onNavigate}>Browse community events</DiscoveryLink></> : <>
      <header className="discovery-event-hero" data-accent={event.accent}><p className="discovery-eyebrow">{event.eyebrow}</p><h1>{event.title}</h1><p className="discovery-lead">{event.description}</p><blockquote>{event.prompt}</blockquote>
        <div className="discovery-actions"><DiscoveryLink className="primary-action" href={eventDrawingPath(event.id)} onNavigate={onNavigate}>Draw my own →</DiscoveryLink><DiscoveryLink href={`/studios?event=${encodeURIComponent(event.id)}&create=1`} onNavigate={onNavigate}>Draw with friends →</DiscoveryLink><a href="#event-studios">Watch studios ↓</a></div>
        <p className="discovery-note">Drawing on your own needs no account. A hosted artist studio needs a verified account; anyone can watch public studios. Only share your work when you want to.</p>
        <p>{event.detail}</p>
        {event.sourceUrl ? <p><a href={event.sourceUrl} target="_blank" rel="noreferrer">{event.sourceLabel} ↗</a></p> : null}
      </header>
      <EventSharingReceipt onRemoved={(id) => setPosts((items) => items.filter((post) => post.id !== id))} />
      {status === "loading" ? <p role="status">Finding shared drawings and studios…</p> : null}
      {status === "error" ? <div role="alert"><p>We couldn’t load the contributions just now.</p><button type="button" onClick={() => setAttempt((n) => n + 1)}>Try again</button></div> : null}
      {status === "ready" ? <><section aria-labelledby="event-artwork-title"><h2 id="event-artwork-title">{event.sensitive ? "Drawings shared with care" : "Community contributions"}</h2><p>{event.sensitive ? "A space for kindness, not competition. Browse at your own pace." : "Each drawing was shared by its artist."}</p>{posts.length ? <ArtworkCards posts={posts} onNavigate={onNavigate} /> : <p>No drawings have been shared here yet. Making something for yourself is welcome too.</p>}</section>
      <section id="event-studios" aria-labelledby="event-studios-title"><h2 id="event-studios-title">Participating studios</h2><p>Anyone can watch a public studio. Drawing is for its artist and approved painters.</p>{studios.length ? <div className="discovery-studios">{studios.map((studio) => <article key={studio.code}><h3>{studio.title || "Artist studio"}</h3><p>{studio.description}</p><DiscoveryLink href={`/${studio.canWatch ? "live" : "join"}/${encodeURIComponent(studio.code)}`} onNavigate={onNavigate}>{studio.canWatch ? "Watch studio" : "Visit studio"} →</DiscoveryLink></article>)}</div> : <p>No participating studios are listed right now.</p>}<DiscoveryLink className="discovery-text-link" href={`/studios?event=${encodeURIComponent(event.id)}`} onNavigate={onNavigate}>Browse event studios →</DiscoveryLink></section></> : null}
    </>}
  </main><SiteFooter onNavigate={onNavigate} /></div>;
}
