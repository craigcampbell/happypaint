// Shared site footer: the crawlable trust-and-navigation graph. Real anchors
// (crawlers + middle-click work), SPA-routed on plain left-click — same
// pattern as SiteNav.

export default function SiteFooter({ onNavigate }) {
  const follow = (event, href) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onNavigate(href);
  };

  const cols = [
    {
      title: "Draw",
      links: [
        { href: "/studio", label: "Open the studio" },
        { href: "/rooms", label: "Live rooms" },
        { href: "/join/DAILY", label: "Today's challenge" },
        { href: "/wall", label: "The Fridge Wall" },
      ],
    },
    {
      title: "Trust",
      links: [
        { href: "/parents", label: "Parents & teachers" },
        { href: "/faq", label: "Safety & FAQ" },
        { href: "/privacy", label: "Privacy" },
        { href: "/about", label: "About" },
      ],
    },
    {
      title: "You",
      links: [
        { href: "/family", label: "Drawesome Family" },
        { href: "/signup", label: "Save your art" },
        { href: "/signup?mode=login", label: "Log in" },
      ],
    },
  ];

  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-brand">
          <strong>Drawesome</strong>
          <p>A live drawing hangout. Free to draw; Family spaces are ad-free.</p>
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
        Public rooms are auto-moderated · Report anything with ⚑ · <a href="mailto:safety@drawesome.art">safety@drawesome.art</a>
      </p>
    </footer>
  );
}
