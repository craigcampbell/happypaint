// Shared site footer: the crawlable trust-and-navigation graph. Real anchors
// (crawlers + middle-click work), SPA-routed on plain left-click, same
// pattern as SiteNav.

import BrandMark from "./BrandMark";
import { isCloudConfigured } from "../utils/auth";

export default function SiteFooter({ onNavigate }) {
  const follow = (event, href) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onNavigate(href);
  };

  const cols = [
    {
      title: "At the canvas",
      links: [
        { href: "/rooms", label: "Public drawing rooms" },
        { href: "/friends", label: "Friends & room codes" },
        { href: "/draw", label: "Solo drawing" },
        { href: "/join/DAILY", label: "Daily challenge" },
        { href: "/family", label: "Family & art postcards" },
      ],
    },
    {
      title: "Around the studio",
      links: [
        { href: "/gallery", label: "Community gallery" },
        { href: "/wall", label: "The Fridge Wall" },
        { href: "/studios", label: "Artist studios" },
        { href: "/events", label: "Drawing events" },
        { href: "/planet", label: "Painted Planet" },
        { href: "/inktober", label: "Inktober sketchbooks" },
      ],
    },
    {
      title: "Help & accounts",
      links: [
        { href: "/about", label: "About Drawesome" },
        { href: "/parents", label: "Parents & teachers" },
        { href: "/safety", label: "Room safety" },
        { href: "/faq", label: "Common questions" },
        { href: "/privacy", label: "Privacy & data" },
        ...(isCloudConfigured ? [
          { href: "/signup", label: "Sync your gallery" },
          { href: "/signup?mode=login", label: "Log in" },
        ] : []),
      ],
    },
  ];

  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-brand">
          <a href="/" className="footer-wordmark" aria-label="Drawesome home" onClick={event => follow(event, "/")}><BrandMark /></a>
          <p>A shared drawing studio for the friend next door and the family member a time zone away.</p>
        </div>
        {cols.map((col) => (
          <nav key={col.title} className="site-footer-col" aria-label={col.title}>
            <span className="site-footer-title">{col.title}</span>
            {col.links.map((l) => (
              <a key={l.href} href={l.href} onClick={(e) => follow(e, l.href)}>
                {l.label}
              </a>
            ))}
          </nav>
        ))}
      </div>
      <p className="site-footer-note">
        To flag a drawing or chat message, use Report in the studio. For help, email <a href="mailto:safety@drawesome.art">safety@drawesome.art</a>
      </p>
    </footer>
  );
}
