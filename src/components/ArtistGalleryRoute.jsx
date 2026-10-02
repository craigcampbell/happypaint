// /gallery route wrapper, the one place the artist gallery meets the app's
// auth layer.
//
// ArtistGalleryPage is deliberately standalone (session arrives via props, no
// auth imports) so it stays reusable and fixture-testable; THIS component
// resolves the real PocketBase session via src/utils/auth.js and keeps it
// reactive: signing in or out (here or in another tab) updates the create
// section without a reload.
//
// While the session is resolving we render a status page instead of passing
// session=null, a guest flash would wrongly tell a signed-in artist they
// need an account to create a studio.

import { useEffect, useState } from "react";
import ArtistGalleryPage from "./ArtistGalleryPage";
import { getSession, onAuthStateChange } from "../utils/auth";

export default function ArtistGalleryRoute({ onNavigate }) {
  // undefined = still resolving · null = guest · object = signed in.
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    let active = true;
    getSession().then((value) => { if (active) setSession(value); });
    const unsubscribe = onAuthStateChange((value) => { if (active) setSession(value); });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  if (session === undefined) {
    return (
      <main className="route-status" role="status" aria-live="polite">
        <h1>Opening the artist gallery…</h1>
        <p>One moment while this page loads.</p>
      </main>
    );
  }

  return <ArtistGalleryPage onNavigate={onNavigate} session={session} />;
}
