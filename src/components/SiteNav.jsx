// Top navigation shared by the homepage, the gallery and the supporting site pages.
//
// Mobile/tablet first. Two things always sit in the bar: the brand and the
// two actions people actually come for (Sign in, Draw now). Everything else
// lives behind ONE menu button below 900px (a full-width sheet with grouped,
// thumb-sized links) and, from 900px up, becomes an inline row: the two
// primary destinations plus two small dropdowns ("Explore", "For parents").
//
// Links are real <a href> anchors so crawlers can walk the site graph and
// users can middle-click/ctrl-click into new tabs; a plain left-click is
// intercepted and routed through the SPA's pushState navigation instead.
// Styles: src/site-nav.css (loaded last from main.jsx).

import { useCallback, useEffect, useId, useRef, useState } from "react";
import BrandMark from "./BrandMark";
import { getSession, isCloudConfigured, onAuthStateChange } from "../utils/auth";
import "../seasonal.css";

// Always-visible destinations (top level at desktop, first rows in the sheet).
const PRIMARY = [
  { href: "/rooms", label: "Live rooms" },
  { href: "/gallery", label: "Gallery" },
];

// Grouped destinations: dropdowns at desktop, headed sections in the sheet.
const GROUPS = [
  {
    id: "explore",
    label: "Explore",
    links: [
      { href: "/wall", label: "The Wall" },
      { href: "/inktober", label: "Inktober" },
      { href: "/planet", label: "Painted Planet" },
    ],
  },
  {
    id: "parents",
    label: "For parents",
    links: [
      { href: "/parents", label: "Parent & teacher guide" },
      { href: "/faq", label: "Safety & FAQ" },
      { href: "/family", label: "Family plan" },
      { href: "/privacy", label: "Privacy" },
    ],
  },
];

// The sheet is used below this width; keep in sync with site-nav.css.
const DESKTOP_QUERY = "(min-width: 900px)";

export default function SiteNav({ onNavigate, current }) {
  const [session, setSession] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false); // the mobile/tablet sheet
  const [openGroup, setOpenGroup] = useState(null); // a desktop dropdown id
  const headerRef = useRef(null);
  const toggleRef = useRef(null);
  const menuId = useId();

  const closeAll = useCallback(() => {
    setMenuOpen(false);
    setOpenGroup(null);
  }, []);

  useEffect(() => {
    if (!menuOpen && !openGroup) return undefined;
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      // Hand focus back to whatever opened the layer.
      const groupBtn = openGroup ? headerRef.current?.querySelector(`[data-group="${openGroup}"] .sn-group-btn`) : null;
      closeAll();
      (groupBtn || toggleRef.current)?.focus();
    };
    const onOutside = (event) => {
      if (!headerRef.current?.contains(event.target)) closeAll();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onOutside);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onOutside);
    };
  }, [menuOpen, openGroup, closeAll]);

  // Crossing the breakpoint (rotating a tablet, resizing) must not strand an
  // open sheet or dropdown in the other layout.
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => closeAll();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [closeAll]);

  // While the sheet is open the page behind it must not scroll under a thumb.
  useEffect(() => {
    if (!menuOpen) return undefined;
    document.documentElement.classList.add("sn-lock");
    return () => document.documentElement.classList.remove("sn-lock");
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

  const follow = (event, href) => {
    // Let the browser handle new-tab/download clicks; SPA-route the rest.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    closeAll();
    onNavigate(href);
  };

  const renderLink = (link) => (
    <a
      key={link.href}
      href={link.href}
      className={`sn-link${current === link.href ? " is-current" : ""}`}
      aria-current={current === link.href ? "page" : undefined}
      onClick={(e) => follow(e, link.href)}
    >
      {link.label}
    </a>
  );

  return (
    <>
      <header
        className={`site-nav${menuOpen ? " sn-open" : ""}`}
        ref={headerRef}
        onBlur={(event) => {
          // Tabbing out of an open dropdown closes it (mouse users have the
          // outside-click handler above).
          if (openGroup && !event.currentTarget.contains(event.relatedTarget)) setOpenGroup(null);
        }}
      >
        <a href="/" className="site-brand" onClick={(e) => follow(e, "/")} aria-label="Drawesome home">
          <BrandMark />
        </a>

        <nav id={menuId} className={`sn-menu${menuOpen ? " is-open" : ""}`} aria-label="Site navigation">
          <div className="sn-primary">{PRIMARY.map(renderLink)}</div>

          {GROUPS.map((group) => {
            const isOpen = openGroup === group.id;
            const hasCurrent = group.links.some((link) => link.href === current);
            const popId = `${menuId}-${group.id}`;
            return (
              <div key={group.id} className={`sn-group${isOpen ? " is-open" : ""}`} data-group={group.id}>
                {/* Desktop: a disclosure button. Sheet: a static section heading
                    (the button is hidden and the links are always shown). */}
                <button
                  type="button"
                  className={`sn-group-btn${hasCurrent ? " is-current" : ""}`}
                  aria-expanded={isOpen}
                  aria-controls={popId}
                  onClick={() => setOpenGroup(isOpen ? null : group.id)}
                >
                  {group.label}
                </button>
                <p className="sn-group-title">{group.label}</p>
                <div id={popId} className="sn-pop">
                  {group.links.map(renderLink)}
                </div>
              </div>
            );
          })}

          {/* Sheet-only: the bar already carries Sign in / My account. */}
          {!session && isCloudConfigured ? (
            <a href="/signup" className="sn-save" onClick={(e) => follow(e, "/signup")}>
              Save my art — free account
            </a>
          ) : null}
        </nav>

        <div className="site-nav-actions">
          {/* Auth entry right beside the Draw now CTA, visible on mobile too.
              Signed in → "My account" (your rooms); signed out → one clear
              "Sign in" (never both, and hidden entirely when cloud accounts
              aren't configured — the app stays anonymous-first). */}
          {session ? (
            <a href="/rooms" className="site-nav-account-cta" onClick={(event) => follow(event, "/rooms")}>
              My account
            </a>
          ) : isCloudConfigured ? (
            <a href="/signup?mode=login" className="site-nav-signin" onClick={(event) => follow(event, "/signup?mode=login")}>
              Sign in
            </a>
          ) : null}
          {/* The generic "Draw now" entry lands in the shared MAIN room (the
              commons); a private room is still one custom code away. */}
          <a href="/join/MAIN" className="site-nav-paint primary-action" onClick={(event) => follow(event, "/join/MAIN")}>
            <span className="site-nav-paint-dot" aria-hidden="true" />
            Draw now
          </a>
          <button
            ref={toggleRef}
            type="button"
            className="site-nav-toggle"
            onClick={() => {
              setOpenGroup(null);
              setMenuOpen((open) => !open);
            }}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls={menuId}
          >
            <svg className="sn-burger" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
              <path d={menuOpen ? "M6 6l12 12M18 6L6 18" : "M4 7h16M4 12h16M4 17h16"} />
            </svg>
          </button>
        </div>
      </header>
      {/* Dims the page behind the sheet; taps on it close the sheet through the
          document-level outside-pointer handler. */}
      <div className={`sn-scrim${menuOpen ? " is-on" : ""}`} aria-hidden="true" />
    </>
  );
}
