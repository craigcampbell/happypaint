import { useEffect, useState } from "react";
import { getSession, isCloudConfigured, onAuthStateChange } from "../utils/auth";
import { createInviteCode } from "../utils/social";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import ColoringBook from "./ColoringBook";

export default function ColoringBookPage({ onNavigate }) {
  const [session, setSession] = useState(undefined);
  useEffect(() => {
    if (!isCloudConfigured) return;
    let active = true;
    getSession().then(value => { if (active) setSession(value); });
    const unsubscribe = onAuthStateChange(value => { if (active) setSession(value); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const openJam = page => onNavigate("/join/" + createInviteCode() + "?color=1", { bookOutline: page?.id, makePage: !page });
  return <div className="site-page coloring-book-page">
    <SiteNav current="/coloring-book" onNavigate={onNavigate} />
    <main className="book-cover">
      <header className="book-heading">
        <h1>My Coloring Book</h1>
        <p>Your original outlines and the paintings you’ve kept from your Art Jams.</p>
      </header>
      {!isCloudConfigured ? <p className="book-message">Accounts are unavailable here. <a href="/draw">Open the drawing studio</a></p>
        : session === undefined ? <p role="status">Checking your account…</p>
        : session?.access_token ? <ColoringBook key={session.access_token} token={session.access_token} onUse={openJam} onCreate={() => openJam(null)} />
        : <div className="book-message"><p>Sign in with the Drawesome account for your Jam Pass to open your private book.</p>
          <a className="book-primary" href="/signup?mode=login&return=/coloring-book">Sign in to My Coloring Book</a></div>}
    </main>
    <SiteFooter onNavigate={onNavigate} />
  </div>;
}
