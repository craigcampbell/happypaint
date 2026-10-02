// /sketchbook — the own-sketchbook ENTRY route (docs/SKETCHBOOKS-CONTRACT.md).
//
// Signed-in: GET mine auto-resumes the visitor's EXISTING book — it never
// creates one, and resume never changes visibility. A first-time signed-in
// visitor gets an explicit visibility CHOICE card: PRIVATE (the default —
// only the owner and invited artists can ever open the book) or PUBLIC
// (anyone with the link can watch; pages with real artwork appear in the
// public Inktober gallery automatically). The create POST — carrying the
// chosen `public` boolean — fires ONLY on that click. Guest: an honest
// account-needed card (never a fake identity); the login/signup links carry
// return=/sketchbook so this page picks up where it left off once the
// session appears, and the anonymous shared INKTOBER room stays one tap
// away the whole time.

import { useEffect, useRef, useState } from "react";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import { createOrResumeSketchbook, fetchMySketchbook } from "../utils/sketchbookApi";
import { getSession, isCloudConfigured, onAuthStateChange, LOCAL_ONLY_MESSAGE } from "../utils/auth";
import "../sketchbook.css";

const RETURN_TO = encodeURIComponent("/sketchbook");

export default function SketchbookStartPage({ onNavigate }) {
  const [session, setSession] = useState(undefined); // undefined = resolving
  const [status, setStatus] = useState("idle"); // idle | checking | confirm | creating | error
  const [message, setMessage] = useState("");
  const [isPublic, setIsPublic] = useState(false); // PRIVATE is the default selection
  const checkedRef = useRef(false); // the GET-mine resume check ran for this session
  const sessionRef = useRef(null); // latest session for retry handlers
  const failedStepRef = useRef("check"); // which step "Try again" re-runs
  const isPublicRef = useRef(false); // latest choice for the create handler
  sessionRef.current = session || null;
  isPublicRef.current = isPublic;

  useEffect(() => {
    let active = true;
    getSession().then((v) => active && setSession(v));
    const unsub = onAuthStateChange((v) => active && setSession(v));
    return () => { active = false; unsub(); };
  }, []);

  // Auto-RESUME only: the moment a session exists (including the sign-in
  // return path completing in this tab), look the book up. First-time
  // visitors land on the visibility choice card instead of an implicit
  // create.
  useEffect(() => {
    if (!session) {
      checkedRef.current = false;
      if (session === null) { setStatus("idle"); setMessage(""); }
      return undefined;
    }
    if (checkedRef.current) return undefined;
    let active = true;
    checkedRef.current = true;
    setStatus("checking");
    setMessage("");
    fetchMySketchbook(session)
      .then((r) => {
        if (!active) return;
        if (r.ok && r.json?.book?.id) {
          onNavigate(`/sketchbook/${r.json.book.id}`);
          return;
        }
        if (r.status === 404) {
          setStatus("confirm");
          return;
        }
        checkedRef.current = false; // allow retry
        failedStepRef.current = "check";
        setStatus("error");
        setMessage(r.json?.message || "We couldn't look for your sketchbook — try again.");
      })
      .catch(() => {
        if (!active) return;
        checkedRef.current = false;
        failedStepRef.current = "check";
        setStatus("error");
        setMessage("We couldn't look for your sketchbook — try again.");
      });
    return () => { active = false; };
  }, [session, onNavigate]);

  // The ONLY create path: the visitor picked a visibility and clicked. The
  // POST body carries that explicit boolean — private by default, public
  // only when the PUBLIC option was deliberately selected.
  const create = () => {
    const s = sessionRef.current;
    if (!s || status === "creating") return;
    setStatus("creating");
    setMessage("");
    createOrResumeSketchbook(s, { isPublic: isPublicRef.current })
      .then((r) => {
        if (r.ok && r.json?.book?.id) {
          onNavigate(`/sketchbook/${r.json.book.id}`);
          return;
        }
        failedStepRef.current = "create";
        setStatus("error");
        setMessage(r.json?.message || "We couldn't create your sketchbook — try again.");
      })
      .catch(() => {
        failedStepRef.current = "create";
        setStatus("error");
        setMessage("We couldn't create your sketchbook — try again.");
      });
  };

  const retry = () => {
    setStatus("idle");
    setMessage("");
    if (failedStepRef.current === "create") {
      setStatus("confirm"); // back to the choice card; creation needs the click
      return;
    }
    // Re-run the resume check by nudging session state.
    setSession((cur) => (cur ? { ...cur } : cur));
  };

  return (
    <div>
      <SiteNav onNavigate={onNavigate} current="/inktober" />
      <main className="skb-start" aria-labelledby="skb-start-title">
        <p className="home-eyebrow">#inktober 2026</p>
        <h1 id="skb-start-title">Your Inktober sketchbook</h1>
        <p className="skb-start-sub">
          One prompt a day, one page per prompt, all October. Flip through your book anytime — and invite
          up to five artists to draw alongside you.
        </p>
        <ul className="skb-start-points">
          <li>📖 Up to 31 pages — one for each official daily prompt, pinned forever.</li>
          <li>🖋️ Ink &amp; pencil tools, like the shared Ink &amp; Pencil room.</li>
          <li>🔒 Private by default — only you and the artists you invite can open it. You choose if it ever goes public.</li>
          <li>✨ Public sketchbooks are watchable by anyone with the link, and pages with real artwork appear in the Inktober gallery automatically.</li>
        </ul>

        {session === undefined || status === "checking" || status === "creating" ? (
          <p className="skb-status-line" role="status">
            {status === "creating"
              ? "Creating your sketchbook…"
              : status === "checking"
                ? "Opening your sketchbook…"
                : "Checking your sign-in…"}
          </p>
        ) : null}

        {session && status === "confirm" ? (
          <div className="skb-start-actions skb-consent">
            <p className="skb-status-line">
              You don&rsquo;t have a sketchbook yet. Choose who can see it — you can change this later.
            </p>
            <div className="skb-visibility-choice" role="radiogroup" aria-label="Sketchbook visibility">
              <label className={`skb-visibility-option${isPublic ? "" : " skb-visibility-selected"}`}>
                <input
                  type="radio"
                  name="skb-visibility"
                  checked={!isPublic}
                  onChange={() => setIsPublic(false)}
                />
                <span>
                  <strong>Private</strong> <em>(default)</em> — only you and the artists you invite can
                  view or draw. It never appears in the public Inktober gallery.
                </span>
              </label>
              <label className={`skb-visibility-option${isPublic ? " skb-visibility-selected" : ""}`}>
                <input
                  type="radio"
                  name="skb-visibility"
                  checked={isPublic}
                  onChange={() => setIsPublic(true)}
                />
                <span>
                  <strong>Public</strong> — anyone with the link can watch your pages (drawing stays
                  limited to you and your invited artists), and pages with real artwork appear in the
                  public Inktober gallery automatically.
                </span>
              </label>
            </div>
            <button type="button" className="primary-action" onClick={create}>
              {isPublic ? "Create my public sketchbook" : "Create my private sketchbook"}
            </button>
          </div>
        ) : null}

        {session === null ? (
          <div className="skb-start-actions">
            {isCloudConfigured ? (
              <>
                <p className="skb-status-line">
                  A sketchbook keeps your artwork under your account, so it needs a quick sign-in.
                  Come straight back here afterwards — this page picks up where you left off.
                </p>
                <button
                  type="button"
                  className="primary-action"
                  onClick={() => onNavigate(`/signup?mode=login&return=${RETURN_TO}`)}
                >
                  Log in to start your sketchbook
                </button>
                <button type="button" onClick={() => onNavigate(`/signup?return=${RETURN_TO}`)}>Sign up free</button>
              </>
            ) : (
              <p className="skb-status-line" role="alert">{LOCAL_ONLY_MESSAGE} Sketchbooks need cloud accounts.</p>
            )}
            <p className="skb-start-quiet">
              No account? You can still draw Inktober anonymously in the{" "}
              <a href="/join/INKTOBER" onClick={(e) => { e.preventDefault(); onNavigate("/join/INKTOBER"); }}>
                shared Ink &amp; Pencil room
              </a>{" "}
              or <a href="/inktober" onClick={(e) => { e.preventDefault(); onNavigate("/inktober"); }}>browse the event</a>.
            </p>
          </div>
        ) : null}

        {status === "error" ? (
          <div className="skb-start-actions">
            <p className="skb-status-line" role="alert">{message}</p>
            <button type="button" className="primary-action" onClick={retry}>Try again</button>
          </div>
        ) : null}
      </main>
      <SiteFooter onNavigate={onNavigate} />
    </div>
  );
}
