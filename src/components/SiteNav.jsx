// Top navigation shared by the homepage and the About/Privacy/Sign-up/Room-finder
// pages. `current` highlights the active link. When signed in, the "Sign up"
// button is replaced by the account name so returning visitors can see they're
// already logged in (clicking it lands on /signup, which shows the signed-in
// state + "Go paint").

import { useEffect, useState } from "react";
import { getSession, onAuthStateChange, sessionLabel } from "../utils/auth";

export default function SiteNav({ onNavigate, current }) {
  const [session, setSession] = useState(null);
  useEffect(() => {
    let active = true;
    getSession().then((v) => active && setSession(v));
    const unsub = onAuthStateChange((v) => active && setSession(v));
    return () => {
      active = false;
      unsub();
    };
  }, []);

  const links = [
    { href: "/rooms", label: "Rooms" },
    { href: "/wall", label: "The Wall" },
    { href: "/about", label: "About" },
    { href: "/faq", label: "Safety & FAQ" },
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
        {session ? (
          <button
            type="button"
            className={`site-nav-account${current === "/signup" ? " is-current" : ""}`}
            onClick={() => onNavigate("/signup")}
            title="Your account"
          >
            <span aria-hidden="true">👤</span> {sessionLabel(session)}
          </button>
        ) : (
          <button type="button" className="site-nav-signup" onClick={() => onNavigate("/signup")}>
            Sign up
          </button>
        )}
        <button type="button" className="site-nav-paint primary-action" onClick={() => onNavigate("/studio")}>
          🎨 Paint now
        </button>
      </nav>
    </header>
  );
}
