// Top navigation shared by the homepage and the supporting site pages.
//
// Links are real <a href> anchors so crawlers can walk the site graph and
// users can middle-click/ctrl-click into new tabs; a plain left-click is
// intercepted and routed through the SPA's pushState navigation instead.

import { useEffect, useState } from "react";
import BrandMark from "./BrandMark";
import { getSession, onAuthStateChange, sessionLabel } from "../utils/auth";

export default function SiteNav({ onNavigate, current }) {
  const [session, setSession] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let active = true;
    getSession().then((value) => active && setSession(value));
    const unsubscribe = onAuthStateChange((value) => active && setSession(value));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const links = [
    { href: "/rooms", label: "Live rooms" },
    { href: "/wall", label: "Wall" },
    { href: "/about", label: "About" },
    { href: "/faq", label: "Safety" },
    { href: "/privacy", label: "Privacy" },
  ];

  const follow = (event, href) => {
    // Let the browser handle new-tab/download clicks; SPA-route the rest.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    setMenuOpen(false);
    onNavigate(href);
  };

  return (
    <header className="site-nav">
      <a href="/" className="site-brand" onClick={(e) => follow(e, "/")} aria-label="Drawesome home">
        <BrandMark />
      </a>

      <nav className={`site-nav-links${menuOpen ? " is-open" : ""}`} aria-label="Site navigation">
        {links.map((link) => (
          <a
            key={link.href}
            href={link.href}
            className={current === link.href ? "is-current" : ""}
            aria-current={current === link.href ? "page" : undefined}
            onClick={(e) => follow(e, link.href)}
          >
            {link.label}
          </a>
        ))}
        {session ? (
          <a
            href="/signup"
            className={`site-nav-account${current === "/signup" ? " is-current" : ""}`}
            onClick={(e) => follow(e, "/signup")}
            title="Your account"
          >
            {sessionLabel(session)}
          </a>
        ) : (
          <a href="/signup" className="site-nav-signup" onClick={(e) => follow(e, "/signup")}>
            Save my art
          </a>
        )}
      </nav>

      <div className="site-nav-actions">
        <a href="/studio" className="site-nav-paint primary-action" onClick={(e) => follow(e, "/studio")}>
          <span className="site-nav-paint-dot" aria-hidden="true" />
          Create
        </a>
        <button
          type="button"
          className="site-nav-toggle"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={menuOpen}
        >
          <span aria-hidden="true">{menuOpen ? "×" : "☰"}</span>
        </button>
      </div>
    </header>
  );
}
