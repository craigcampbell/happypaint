// Top navigation shared by the homepage and the supporting site pages.
//
// Links are real <a href> anchors so crawlers can walk the site graph and
// users can middle-click/ctrl-click into new tabs; a plain left-click is
// intercepted and routed through the SPA's pushState navigation instead.

import { useEffect, useId, useRef, useState } from "react";
import BrandMark from "./BrandMark";
import { getSession, isCloudConfigured, onAuthStateChange, sessionLabel } from "../utils/auth";
import { createInviteCode } from "../utils/social";

export default function SiteNav({ onNavigate, current }) {
  const [session, setSession] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [freshRoom] = useState(createInviteCode);
  const headerRef = useRef(null);
  const toggleRef = useRef(null);
  const menuId = useId();

  useEffect(() => {
    if (!menuOpen) return undefined;
    headerRef.current?.querySelector("nav a")?.focus();
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      toggleRef.current?.focus();
    };
    const onOutside = (event) => {
      if (!headerRef.current?.contains(event.target)) setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onOutside);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onOutside);
    };
  }, [menuOpen]);

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
    { href: "/family", label: "Family" },
    { href: "/parents", label: "Parents & teachers" },
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
    <header className="site-nav" ref={headerRef}>
      <a href="/" className="site-brand" onClick={(e) => follow(e, "/")} aria-label="Drawesome home">
        <BrandMark />
      </a>

      <nav id={menuId} className={`site-nav-links${menuOpen ? " is-open" : ""}`} aria-label="Site navigation">
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
        ) : isCloudConfigured ? (
          <a href="/signup" className="site-nav-signup" onClick={(e) => follow(e, "/signup")}>
            Save my art
          </a>
        ) : null}
      </nav>

      <div className="site-nav-actions">
        <a href={`/join/${freshRoom}`} className="site-nav-paint primary-action" onClick={(event) => follow(event, `/join/${freshRoom}`)}>
          <span className="site-nav-paint-dot" aria-hidden="true" />
          Draw now
        </a>
        <button
          ref={toggleRef}
          type="button"
          className="site-nav-toggle"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={menuOpen}
          aria-controls={menuId}
        >
          <span aria-hidden="true">{menuOpen ? "×" : "☰"}</span>
        </button>
      </div>
    </header>
  );
}
