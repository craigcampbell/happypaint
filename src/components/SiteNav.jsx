// Top navigation shared by the homepage and the About/Privacy/Sign-up/Room-finder
// pages. `current` highlights the active link.

export default function SiteNav({ onNavigate, current }) {
  const links = [
    { href: "/rooms", label: "Rooms" },
    { href: "/about", label: "About" },
    { href: "/privacy", label: "Privacy" },
  ];
  return (
    <header className="site-nav">
      <button type="button" className="site-brand" onClick={() => onNavigate("/")}>
        Drawesome <span aria-hidden="true">🎨</span>
      </button>
      <nav className="site-nav-links" aria-label="Site navigation">
        {links.map((l) => (
          <button
            key={l.href}
            type="button"
            className={current === l.href ? "is-current" : ""}
            onClick={() => onNavigate(l.href)}
          >
            {l.label}
          </button>
        ))}
        <button type="button" className="site-nav-signup" onClick={() => onNavigate("/signup")}>
          Sign up
        </button>
        <button type="button" className="site-nav-paint primary-action" onClick={() => onNavigate("/studio")}>
          🎨 Paint now
        </button>
      </nav>
    </header>
  );
}
