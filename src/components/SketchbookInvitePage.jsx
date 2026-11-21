// /sketchbook/invite/:token, accept a sketchbook invitation
// (docs/SKETCHBOOKS-CONTRACT.md).
//
// The token arrives in the URL (the only place it ever appears client-side
// besides the owner's one-time mint panel) and is POSTed to
// /api/sketchbooks/accept under the visitor's REAL PocketBase session, the
// server resolves the authenticated account, enforces the 6-artist cap and
// revocations, and grants drawing across every page. Guests get the honest
// sign-in card; this page proceeds automatically once a session appears.

import { useEffect, useRef, useState } from "react";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import { acceptSketchbookInvite } from "../utils/sketchbookApi";
import { getSession, isCloudConfigured, onAuthStateChange } from "../utils/auth";
import "../sketchbook.css";

const ERROR_COPY = {
  invite_invalid: "That invitation link is invalid or was revoked. Ask the sketchbook owner for a fresh one.",
  book_full: "All six artist spots are taken. Ask the owner if a spot can be opened for you.",
  own_book: "This is your own sketchbook, you can already draw in it!",
  bad_token: "That invitation link looks incomplete. Copy the whole link and try again.",
};

export default function SketchbookInvitePage({ token, onNavigate }) {
  const [session, setSession] = useState(undefined);
  const [state, setState] = useState("idle"); // idle | working | done | error
  const [message, setMessage] = useState("");
  const [bookId, setBookId] = useState(null);
  const [bookPublic, setBookPublic] = useState(null); // visibility of the joined book
  const triedRef = useRef(false);
  // Sign-in sends the visitor straight back to THIS exact invitation link.
  // The token stays in the URL only, never logged, never stored elsewhere.
  const returnTo = encodeURIComponent(`/sketchbook/invite/${token}`);

  useEffect(() => {
    let active = true;
    getSession().then((v) => active && setSession(v));
    const unsub = onAuthStateChange((v) => active && setSession(v));
    return () => { active = false; unsub(); };
  }, []);

  useEffect(() => {
    if (!session || triedRef.current) return undefined;
    let active = true;
    triedRef.current = true;
    setState("working");
    acceptSketchbookInvite(token, session)
      .then((r) => {
        if (!active) return;
        if (r.ok && r.json?.bookId) {
          setBookId(r.json.bookId);
          setBookPublic(r.json.book?.public === true);
          setState("done");
          return;
        }
        setState("error");
        setMessage(ERROR_COPY[r.error] || r.json?.message || "Couldn't accept that invitation, try again.");
      })
      .catch(() => {
        if (!active) return;
        setState("error");
        setMessage("Couldn't accept that invitation, try again.");
      });
    return () => { active = false; };
  }, [session, token]);

  return (
    <div className="skb-paper-page">
      <SiteNav onNavigate={onNavigate} current="/inktober" />
      <main className="skb-start" aria-labelledby="skb-invite-title">
        <p className="skb-edition">Inktober · Sketchbook invitation</p>
        <h1 id="skb-invite-title">You&rsquo;re invited to draw</h1>

        {session === undefined || state === "working" ? (
          <p className="skb-status-line" role="status">
            {state === "working" ? "Adding you to the sketchbook…" : "Checking your sign-in…"}
          </p>
        ) : null}

        {session === null ? (
          <div className="skb-start-actions">
            {isCloudConfigured ? (
              <>
                <p className="skb-start-sub">
                  Join the artist who invited you on the pages of their sketchbook. After you sign in, this invitation automatically adds your account to the book.
                </p>
                <button
                  type="button"
                  className="primary-action"
                  onClick={() => onNavigate(`/signup?mode=login&return=${returnTo}`)}
                >
                  Log in to accept
                </button>
                <button type="button" onClick={() => onNavigate(`/signup?return=${returnTo}`)}>Sign up free</button>
              </>
            ) : (
              <>
                <p className="skb-status-line">This server has accounts turned off, so it can&rsquo;t accept sketchbook invitations. You can still draw together in the shared Ink &amp; Pencil room.</p>
                <button type="button" className="primary-action" onClick={() => onNavigate("/join/INKTOBER")}>Draw in the shared room</button>
              </>
            )}
          </div>
        ) : null}

        {state === "done" ? (
          <div className="skb-start-actions">
            <p className="skb-start-sub">You&rsquo;re in! Open the sketchbook, choose a prompt day, then enter that page&rsquo;s studio to draw with the other artists.</p>
            {bookPublic === false ? (
              <p className="skb-status-line">
                This is a <strong>private</strong> sketchbook, only the owner and invited artists like you can open it.
              </p>
            ) : null}
            <button type="button" className="primary-action" onClick={() => onNavigate(`/sketchbook/${bookId}`)}>
              Open the sketchbook →
            </button>
          </div>
        ) : null}

        {state === "error" ? (
          <div className="skb-start-actions">
            <p className="skb-status-line" role="alert">{message}</p>
            <button type="button" onClick={() => onNavigate("/sketchbook")}>Start your own sketchbook instead →</button>
          </div>
        ) : null}
      </main>
      <SiteFooter onNavigate={onNavigate} />
    </div>
  );
}
