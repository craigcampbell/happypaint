// Top navigation shared by the homepage and the supporting site pages.

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
    { href: "/rooms", label: "Rooms" },
    { href: "/wall", label: "The Wall" },
    { href: "/about", label: "About" },
    { href: "/faq", label: "Safety & FAQ" },
    { href: "/privacy", label: "Privacy" },
  ];

  const navigate = (href) => {
    setMenuOpen(false);
    onNavigate(href);
  };

  return (
    <header className="site-nav">
      <button type="button" className="site-brand" onClick={() => navigate("/")} aria-label="Drawesome home">
        <BrandMark />
      </button>

      <nav className={`site-nav-links${menuOpen ? " is-open" : ""}`} aria-label="Site navigation">
        {links.map((link) => (
          <button
            key={link.href}
            type="button"
            className={current === link.href ? "is-current" : ""}
            onClick={() => navigate(link.href)}
          >
            {link.label}
          </button>
        ))}
        {session ? (
          <button
            type="button"
            className={`site-nav-account${current === "/signup" ? " is-current" : ""}`}
            onClick={() => navigate("/signup")}
            title="Your account"
          >
            {sessionLabel(session)}
          </button>
        ) : (
          <button type="button" className="site-nav-signup" onClick={() => navigate("/signup")}>
            Sign up
          </button>
        )}
      </nav>

      <div className="site-nav-actions">
        <button type="button" className="site-nav-paint primary-action" onClick={() => navigate("/studio")}>
          <span className="site-nav-paint-dot" aria-hidden="true" />
          Paint now
        </button>
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
