// SketchbookRoomBanner — the in-studio banner for Inktober sketchbook page
// rooms (docs/SKETCHBOOKS-CONTRACT.md).
//
// Mount it ONCE per studio room (the parent mounts it in App with the current
// room code; it renders NOTHING for ordinary rooms — a 404 from the by-room
// endpoint just hides it):
//
//   import SketchbookRoomBanner from "./components/SketchbookRoomBanner";
//   <SketchbookRoomBanner roomCode={roomCode} session={session} onNavigate={navigate} onPageChange={setMeta} />
//
// Props:
//   roomCode     — the room the studio is currently joined to (string)
//   session      — the PocketBase session ({ access_token, user }) or null;
//                  owner/artist controls appear only for a verified session
//   onNavigate   — client-side navigation fn (path) => void
//   onPageChange — optional callback (meta | null). Fired ONCE per successful
//                  room/auth resolution with the pinned page metadata
//                  ({ year, day, prompt }) and with null whenever the room is
//                  not a page or the lookup fails, so the parent (the invite
//                  sheet's inktoberPage pin) never keeps a stale page.
//
// What it shows:
//   - the page's PINNED prompt chip (#inktober <year> · Day N — "prompt"),
//     server-stamped and immutable (never the rotating daily prompt; the year
//     comes from the page's stamped date/event metadata, never today's date)
//   - page position + previous/next page flipping (navigates between the
//     book's distinct page rooms)
//   - "View book" → the book reader
//   - a Private/Public visibility badge (private books only ever reach this
//     banner for the owner + invited artists; strangers get the same 404 as
//     an ordinary room, so the banner itself never leaks the book's existence)
//   - OWNER ONLY: add-page (server-validated prompt days), the visibility
//     toggle (PUBLIC needs an explicit confirm; private is immediate),
//     invitation management (mint shown once / revoke links, remove artists), all
//     against the 6-artist cap the server enforces; the artist count is
//     re-fetched after every mutation so it never goes stale
//   - viewers (not owner/artist): a prominent start-your-own-sketchbook CTA
//     with the publicly-viewable / invite-only explainer
//   - a failed by-room lookup shows an honest in-banner error with Retry —
//     the banner never silently disappears on a network error

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchSketchbookByRoom, fetchSketchbook, addSketchbookPage,
  mintSketchbookInvite, revokeSketchbookInvite, revokeSketchbookArtist,
  setSketchbookVisibility,
} from "../utils/sketchbookApi";
import "../sketchbook.css";

// The pinned year comes from the page's server-stamped date ("2026-10-01")
// first, then the book's event id ("inktober-2026") — never from today's
// clock, so an old page keeps its year after the event ends.
function pinnedYear(info) {
  const fromDate = /^(\d{4})-\d{2}-\d{2}$/.exec(info?.date || "");
  if (fromDate) return Number(fromDate[1]);
  const fromEvent = /(\d{4})/.exec(info?.event || "");
  return fromEvent ? Number(fromEvent[1]) : null;
}

// The metadata the parent pins the invite sheet to. Null when the year can't
// be proven from the page metadata — the sheet then falls back to the live
// event, exactly like an unpinned room.
function pageMeta(info) {
  const year = pinnedYear(info);
  const day = Number(info?.day);
  const prompt = typeof info?.prompt === "string" ? info.prompt.trim() : "";
  if (!year || !Number.isInteger(day) || day < 1 || day > 31 || !prompt) return null;
  return { year, day, prompt };
}

// What the parent hears on EVERY successful by-room resolution — including
// private books the caller is authorized for (owner/artist): isSketchbook is
// how the studio knows to keep chat + animation off for this room. The pin
// triple rides along whenever it could be proven from the page metadata.
function roomMeta(info) {
  return {
    ...(pageMeta(info) || {}),
    isSketchbook: true,
    public: info?.public === true,
  };
}

export default function SketchbookRoomBanner({ roomCode, session = null, onNavigate, onPageChange = null }) {
  const [info, setInfo] = useState(null); // by-room payload
  const [state, setState] = useState("loading"); // loading | ready | none | error
  const [book, setBook] = useState(null); // owner view (invites/artists), owner only
  const [panel, setPanel] = useState(""); // "" | "pages" | "invite"
  const [prompts, setPrompts] = useState([]); // official list for the add-page picker
  const [newInvite, setNewInvite] = useState(null); // { token, url } shown ONCE
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [reloadTick, setReloadTick] = useState(0); // Retry button re-runs the lookup
  const noticeTimer = useRef(null);
  const seqRef = useRef(0);
  const onPageChangeRef = useRef(onPageChange);

  const code = String(roomCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);

  useEffect(() => { onPageChangeRef.current = onPageChange; }, [onPageChange]);
  const reportPage = useCallback((meta) => { onPageChangeRef.current?.(meta); }, []);

  const say = useCallback((text) => {
    setNotice(text);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 3200);
  }, []);

  // Resolve the room -> book mapping ONCE per room + auth session. Session
  // changes re-resolve owner flags; the Retry button bumps reloadTick. The
  // seq guard (bumped on every cleanup) cancels stale in-flight responses
  // when the room or session changes mid-fetch — a late reply from the old
  // room can never overwrite the new one.
  useEffect(() => {
    if (!code) { setState("none"); reportPage(null); return undefined; }
    const seq = (seqRef.current += 1);
    setState("loading");
    setPanel("");
    setNewInvite(null);
    fetchSketchbookByRoom(code, session)
      .then((r) => {
        if (seq !== seqRef.current) return;
        if (r.status === 404) { setInfo(null); setState("none"); reportPage(null); return; }
        if (!r.ok || !r.json?.bookId) { setInfo(null); setState("error"); reportPage(null); return; }
        setInfo(r.json);
        setState("ready");
        reportPage(roomMeta(r.json));
      })
      .catch(() => { if (seq === seqRef.current) { setState("error"); reportPage(null); } });
    return () => { seqRef.current += 1; window.clearTimeout(noticeTimer.current); };
  }, [code, session, reloadTick, reportPage]);

  // The owner's admin view (invites + artist ids) loads only for the owner.
  const refreshBook = useCallback(async (bookId) => {
    const r = await fetchSketchbook(bookId, session);
    if (r.ok && r.json?.book?.owner) setBook(r.json.book);
  }, [session]);

  useEffect(() => {
    if (state === "ready" && info?.isOwner) refreshBook(info.bookId);
    else setBook(null);
  }, [state, info, refreshBook]);

  // Silent re-resolve after owner mutations (mint/revoke/remove): the artist
  // count in the by-room payload changes on accept/revoke, so the banner
  // re-reads it instead of trusting the pre-mutation numbers. No loading
  // flicker — the banner stays up while the fresh payload lands.
  const refreshInfo = useCallback(async () => {
    const r = await fetchSketchbookByRoom(code, session);
    if (r.ok && r.json?.bookId) {
      setInfo(r.json);
      reportPage(roomMeta(r.json));
    }
  }, [code, session, reportPage]);

  // The official prompt list for the add-page picker — server truth, loaded
  // lazily when the owner opens the panel.
  useEffect(() => {
    if (panel !== "pages" || prompts.length) return undefined;
    let active = true;
    fetch("/api/inktober", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (active && Array.isArray(d?.prompts)) setPrompts(d.prompts); })
      .catch(() => { /* picker stays on the "today" default */ });
    return () => { active = false; };
  }, [panel, prompts.length]);

  // A lookup ERROR is not a missing sketchbook: keep an honest strip up with
  // a Retry instead of vanishing (ordinary rooms — 404 — still render nothing).
  if (state === "error") {
    return (
      <div className="skb-banner-wrap" role="region" aria-label="Inktober sketchbook">
        <div className="skb-banner skb-banner-error" role="alert">
          <span>Sketchbook details didn’t load — check your connection.</span>
          <button type="button" onClick={() => setReloadTick((t) => t + 1)}>Retry</button>
        </div>
      </div>
    );
  }
  if (state !== "ready" || !info) return null;

  const year = pinnedYear(info);
  const promptTag = `#inktober${year ? ` ${year}` : ""}`;
  const go = (path) => onNavigate(path);
  const usedDays = new Set((book?.pages || []).map((p) => p.day));
  const remaining = prompts.filter((p) => !usedDays.has(Number(p.day)));

  const addPage = async (day) => {
    if (busy) return;
    setBusy(true);
    const r = await addSketchbookPage(info.bookId, day, session);
    setBusy(false);
    if (!r.ok) {
      say(r.json?.message || (r.error === "book_full" ? "This sketchbook already has all 31 pages." : "Couldn't add that page — try again."));
      return;
    }
    const room = r.json?.page?.room;
    await Promise.all([refreshBook(info.bookId), refreshInfo()]);
    say(r.json?.resumed ? `Day ${r.json?.page?.day} already has a page.` : `Page for Day ${r.json?.page?.day} added!`);
    if (room && !r.json?.resumed) go(`/join/${room}`);
  };

  const mintInvite = async () => {
    if (busy) return;
    setBusy(true);
    const r = await mintSketchbookInvite(info.bookId, session);
    setBusy(false);
    if (!r.ok) { say(r.json?.message || "Couldn't mint an invitation — try again."); return; }
    setNewInvite({ token: r.json.token, url: r.json.url });
    setBook(r.json.book);
    refreshInfo(); // fresh artist count / seats
    try { await navigator.clipboard.writeText(`${window.location.origin}${r.json.url}`); say("Invitation link copied — it is shown once, share it carefully."); }
    catch { say("Invitation minted — copy the link below now, it is shown once."); }
  };

  const revokeInvite = async (inviteId) => {
    const r = await revokeSketchbookInvite(info.bookId, inviteId, session);
    if (r.ok) { setBook(r.json.book); refreshInfo(); say("Invitation link revoked."); }
    else say("Couldn't revoke that link — try again.");
  };

  const removeArtist = async (profileId) => {
    if (!window.confirm("Remove this artist from the whole sketchbook? They immediately lose drawing access on every page.")) return;
    const r = await revokeSketchbookArtist(info.bookId, profileId, session);
    if (r.ok) { setBook(r.json.book); refreshInfo(); say("Artist removed from every page."); }
    else say(r.json?.message || "Couldn't remove that artist — try again.");
  };

  // Owner visibility toggle. Going PUBLIC needs an explicit confirm (the
  // book becomes watchable by anyone with the link and gallery-eligible);
  // the downgrade to private is immediate — the server sweeps strangers out
  // of every page room at once.
  const toggleVisibility = async () => {
    if (busy) return;
    const goingPublic = info.public !== true;
    if (goingPublic) {
      const ok = window.confirm(
        "Make this sketchbook PUBLIC?\n\n"
        + "Anyone with the link will be able to watch every page, and pages with real artwork will "
        + "appear in the public Inktober gallery automatically.\n\n"
        + "Drawing stays limited to you and your invited artists. You can switch back to private anytime.",
      );
      if (!ok) return;
    }
    setBusy(true);
    const r = await setSketchbookVisibility(info.bookId, goingPublic, session);
    setBusy(false);
    if (!r.ok || !r.json?.book) {
      say(r.json?.message || "Couldn't change visibility — try again.");
      return;
    }
    setBook(r.json.book);
    await refreshInfo(); // the by-room payload carries the fresh public flag
    say(goingPublic
      ? "Your sketchbook is now public — anyone with the link can watch."
      : "Your sketchbook is now private — only you and invited artists can open it.");
  };

  return (
    <div className="skb-banner-wrap" role="region" aria-label="Inktober sketchbook">
      <div className="skb-banner">
        <span className="skb-prompt-chip" title={`Pinned page prompt — Day ${info.day}`}>
          <span className="skb-prompt-tag">{promptTag}</span>
          <span>Day {info.day}</span>
          <span className="skb-prompt-text">“{info.prompt}”</span>
        </span>

        <span className="skb-banner-flip">
          <button type="button" disabled={!info.prevRoom} onClick={() => go(`/join/${info.prevRoom}`)}
            aria-label="Previous sketchbook page">‹ Prev</button>
          <span className="skb-banner-pagepos">Page {info.pageIndex + 1} of {info.pageCount}</span>
          <button type="button" disabled={!info.nextRoom} onClick={() => go(`/join/${info.nextRoom}`)}
            aria-label="Next sketchbook page">Next ›</button>
        </span>

        <button type="button" onClick={() => go(`/sketchbook/${info.bookId}`)}>View book</button>

        <span
          className={`skb-badge ${info.public === true ? "skb-badge-public" : "skb-badge-private"}`}
          title={info.public === true
            ? "Public — anyone with the link can watch; drawing stays invite-only"
            : "Private — only the owner and invited artists can open this book"}
        >
          {info.public === true ? "🌍 Public" : "🔒 Private"}
        </span>

        <span className="skb-banner-spacer" />
        <span className="skb-banner-artists">{info.artistCount} of {info.maxArtists} artists</span>

        {info.isOwner ? (
          <>
            <button
              type="button"
              onClick={() => setPanel(panel === "pages" ? "" : "pages")}
              disabled={info.pageCount >= info.maxPages}
              title={info.pageCount >= info.maxPages ? "All 31 prompt pages exist" : "Add a page for another prompt day"}
            >
              + Add page
            </button>
            <button type="button" onClick={() => setPanel(panel === "invite" ? "" : "invite")}>
              Invitations
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={toggleVisibility}
              title={info.public === true
                ? "Switch back to private — only you and invited artists can open the book (takes effect immediately)"
                : "Make the book watchable by anyone with the link (asks for confirmation)"}
            >
              {info.public === true ? "Make private" : "Make public…"}
            </button>
          </>
        ) : (
          <span className="skb-own-cta">
            <button type="button" className="skb-banner-primary skb-own-btn" onClick={() => go("/sketchbook")}>
              Draw this prompt in your own sketchbook →
            </button>
            <span className="skb-own-note">
              Choose private or public when you start it — either way, drawing is invite-only (you + up to 5 invited artists).
            </span>
          </span>
        )}
      </div>

      {info.isOwner && panel === "pages" ? (
        <div className="skb-panel" aria-label="Add a sketchbook page">
          <h3>Add a page</h3>
          <p className="skb-panel-note">
            One page per official prompt day — the day &amp; prompt are stamped by the server and never change.
          </p>
          <div className="skb-panel-row">
            <button type="button" className="skb-banner-primary" disabled={busy} onClick={() => addPage(null)}>
              Add today&rsquo;s page
            </button>
            {remaining.length > 0 ? (
              <>
                <label htmlFor="skb-day-pick">or pick a day:</label>
                <select
                  id="skb-day-pick"
                  defaultValue=""
                  disabled={busy}
                  onChange={(e) => { if (e.target.value) addPage(Number(e.target.value)); }}
                >
                  <option value="" disabled>Choose…</option>
                  {remaining.map((p) => (
                    <option key={p.day} value={p.day}>Day {p.day} — {p.prompt}</option>
                  ))}
                </select>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {info.isOwner && panel === "invite" ? (
        <div className="skb-panel" aria-label="Manage invitations">
          <h3>Invitations &amp; artists</h3>
          <p className="skb-panel-note">
            {info.public === true
              ? <>Your book is public — anyone with the book link can already watch. These invitation links are for
                  drawing collaborators: invite up to {info.maxArtists - 1} artists to draw across every page.
                  Links are shown once and can be revoked anytime.</>
              : <>Your book is private — only you and invited artists can open it at all. An invitation link grants
                  viewing AND drawing across every page, for up to {info.maxArtists - 1} artists. Links are shown
                  once and can be revoked anytime.</>}
          </p>
          <div className="skb-panel-row">
            <button type="button" className="skb-banner-primary" disabled={busy || info.artistCount >= info.maxArtists} onClick={mintInvite}>
              {info.artistCount >= info.maxArtists ? "All 6 seats are filled" : "Mint & copy an invite link"}
            </button>
          </div>
          {newInvite ? (
            <p className="skb-panel-row">
              <span className="skb-invite-link">{window.location.origin}{newInvite.url}</span>
            </p>
          ) : null}
          {book?.artists?.length > 1 ? (
            <ul className="skb-list" aria-label="Artists in this sketchbook">
              {book.artists.filter((pid) => pid !== book.artists[0]).map((pid) => (
                <li key={pid}>
                  <span className="skb-list-grow">Artist {pid.slice(0, 6)}…</span>
                  <button type="button" className="skb-danger" onClick={() => removeArtist(pid)}>Remove</button>
                </li>
              ))}
            </ul>
          ) : null}
          {book?.invites?.length ? (
            <ul className="skb-list" aria-label="Invitation links">
              {book.invites.map((inv) => (
                <li key={inv.id} className={inv.revokedAt ? "skb-revoked" : ""}>
                  <span className="skb-list-grow">
                    Link ·{inv.id.slice(-6)} — {inv.uses} joined{inv.revokedAt ? " · revoked" : ""}
                  </span>
                  {!inv.revokedAt ? (
                    <button type="button" className="skb-danger" onClick={() => revokeInvite(inv.id)}>Revoke</button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {notice ? <div className="skb-panel-note" role="status" style={{ padding: "0 1rem" }}>{notice}</div> : null}
    </div>
  );
}

// Named export too, so the parent can import whichever shape it prefers.
export { SketchbookRoomBanner };
