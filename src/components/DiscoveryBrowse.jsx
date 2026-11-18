import { useState } from "react";

const TOPICS = [
  { href: "/gallery", label: "All artwork" },
  { href: "/gallery?q=holiday", label: "Holidays" },
  { href: "/gallery?q=birthday", label: "Birthdays" },
  { href: "/gallery?q=halloween", label: "Halloween" },
  { href: "/inktober", label: "Inktober" },
  { href: "/events/little-joys", label: "Little joys" },
];

function BrowseLink({ href, onNavigate, children, ...props }) {
  return <a {...props} href={href} onClick={(event) => {
    if (!onNavigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(href);
  }}>{children}</a>;
}

export function DiscoverySidebar({ onNavigate, current = "/" }) {
  return <aside className="discovery-sidebar" aria-label="Browse drawing community">
    <nav aria-label="Drawing destinations">
      <p className="discovery-sidebar-label">Discover</p>
      {[["/", "Overview"], ["/gallery", "Artwork"], ["/studios", "Artist studios"], ["/gallery?mode=rooms", "Room shuffle"], ["/events", "Events & occasions"], ["/rooms", "Draw together"]].map(([href, label]) =>
        <BrowseLink key={href} href={href} onNavigate={onNavigate} aria-current={current === href ? "page" : undefined}>{label}</BrowseLink>)}
      <p className="discovery-sidebar-label">Find your inspiration</p>
      {TOPICS.slice(1).map((topic) => <BrowseLink key={topic.href} href={topic.href} onNavigate={onNavigate}>{topic.label}</BrowseLink>)}
      <p className="discovery-sidebar-label">Make something</p>
      <BrowseLink href="/draw" onNavigate={onNavigate}>Your own canvas</BrowseLink>
      <BrowseLink href="/join/DAILY" onNavigate={onNavigate}>Daily challenge</BrowseLink>
      <BrowseLink href="/parents" onNavigate={onNavigate}>For families & teachers</BrowseLink>
    </nav>
  </aside>;
}

export function DiscoveryTopics({ onNavigate }) {
  return <nav className="discovery-topics" aria-label="Artwork topics and occasions">
    {TOPICS.map((topic) => <BrowseLink key={topic.href} href={topic.href} onNavigate={onNavigate}>{topic.label}</BrowseLink>)}
  </nav>;
}

export function DiscoverySearch({ onNavigate, initialQuery = "" }) {
  const [query, setQuery] = useState(initialQuery);
  return <form className="discovery-art-search" role="search" onSubmit={(event) => {
    event.preventDefault();
    const value = query.trim().slice(0, 80);
    onNavigate(value ? `/gallery?q=${encodeURIComponent(value)}` : "/gallery");
  }}>
    <input type="search" aria-label="Search artwork" placeholder="Search artwork or artists…" value={query} maxLength={80} onChange={(event) => setQuery(event.target.value)} />
    <button type="submit" aria-label="Search artwork"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg></button>
  </form>;
}
