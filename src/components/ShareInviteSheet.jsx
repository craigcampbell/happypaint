// "Invite friends" share sheet. One place for every way to say "come draw with
// me": the OS share sheet (mobile), copy link, X, Instagram, TikTok, save
// image, SMS and email. Instagram/TikTok are the odd ones out — there's no
// share URL and they ignore text — so we hand them a pre-rendered invite CARD
// (art + room code + link) and put the caption on the clipboard: on phones via
// the OS share sheet (pick the app → Story/Post), on desktop by saving the PNG
// and opening the site to upload it.
//
// During October the card defaults to the seasonal Inktober theme (original
// rough ink strokes, cream paper, hand-lettered Caveat — see inviteCard.js)
// with a user toggle back to the year-round Classic look. The seasonal
// default follows the server-stamped phase: ONLY "active" (Oct 1–31) means
// Inktober — the upcoming warm-up and the ended wind-down both default to
// Classic, matching the October-only local-calendar fallback.
//
// Sketchbook pages can pin the sheet to a fixed Inktober day via the optional
// inktoberPage prop ({ year, day, prompt }): the pinned state replaces the
// live /api/inktober fetch, so an old page keeps its prompt, its DAY chip and
// the Inktober default even after October. Invalid metadata is ignored and
// the live event wins, exactly like an unpinned sheet.
//
// Gesture discipline: navigator.share is called FIRST in every share handler
// (no awaited clipboard work before it, or mobile Safari drops the user
// activation). The caption is copied only AFTER the share resolves; an
// AbortError (user cancelled) triggers nothing — no download, no new tab.
// "Share image…" attaches the card FILE to the OS sheet so Messages/Mail can
// be picked as the target; sms:/mailto: stay link-only on purpose (those URL
// schemes cannot attach images), with honest attach-it-yourself guidance.

import { useEffect, useMemo, useRef, useState } from "react";
import { inviteCaption, pinnedInktoberState, renderInviteCard, xIntentUrl } from "../utils/inviteCard";
import "../share-invite-ink.css";

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export default function ShareInviteSheet({ roomId, roomTitle, getArt, onClose, showToast, inktoberPage }) {
  const joinUrl = `${window.location.origin}/join/${encodeURIComponent(roomId)}`;
  const title = roomTitle || `Drawesome room ${roomId}`;
  const [fetched, setFetched] = useState(null); // /api/inktober payload
  const [themeChoice, setThemeChoice] = useState(null); // user's manual override
  const [card, setCard] = useState(null); // { blob, file, url }
  const [cardFailed, setCardFailed] = useState(false);
  const cardRef = useRef(null);
  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  // Probe once per render: can the OS sheet take an image file? (False on
  // most desktops → "Share image…" stays hidden and Save image covers it.)
  const canShareFiles = (() => {
    if (!canNativeShare || typeof File === "undefined" || typeof navigator.canShare !== "function") return false;
    try {
      return navigator.canShare({ files: [new File([""], "probe.png", { type: "image/png" })] }) === true;
    } catch {
      return false;
    }
  })();

  // A pinned sketchbook page overrides the live event entirely — serialize
  // first so an inline object literal from the parent stays referentially
  // stable across renders (no card re-render churn).
  const pinnedJson = inktoberPage ? JSON.stringify(inktoberPage) : null;
  const pinned = useMemo(
    () => pinnedInktoberState(pinnedJson ? JSON.parse(pinnedJson) : null),
    [pinnedJson],
  );
  const inktober = pinned ?? fetched;

  // Seasonal default: the server-stamped event state wins (UTC rollover, no
  // client clock math); until it arrives, an optimistic guess from the local
  // calendar keeps the first render sensible. Only the ACTIVE season defaults
  // to Inktober — upcoming/ended default to Classic, and the toggle always
  // allows either style. A pinned page skips the fetch: it IS the event.
  useEffect(() => {
    if (pinned) return undefined;
    let active = true;
    fetch("/api/inktober", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (active && d && ["active", "upcoming", "ended"].includes(d.phase)) setFetched(d);
      })
      .catch(() => { /* seasonal default falls back to the local calendar */ });
    return () => {
      active = false;
    };
  }, [pinned]);

  const seasonalTheme = inktober
    ? (inktober.phase === "active" ? "inktober" : "classic")
    : (new Date().getUTCMonth() === 9 ? "inktober" : "classic");
  const theme = themeChoice ?? seasonalTheme;
  const caption = inviteCaption({ roomId, joinUrl, theme });

  // Render the card once per sheet-open/theme; every button reads from it so
  // the click handlers stay synchronous (popup blockers + share gestures).
  useEffect(() => {
    let cancelled = false;
    // Invalidate the previous card IMMEDIATELY: clear the ref and revoke its
    // object URL before the async render starts, so no handler can share or
    // save a stale (wrong room/theme) image during loading or after failure.
    // The prior run's in-flight continuation is cancelled by the cleanup
    // below (it revokes its own URL and never touches the ref).
    if (cardRef.current?.url) URL.revokeObjectURL(cardRef.current.url);
    cardRef.current = null;
    setCard(null);
    setCardFailed(false);
    (async () => {
      try {
        const art = await getArt();
        const canvas = await renderInviteCard({ art, roomId, joinUrl, title: roomTitle, theme, inktober });
        const blob = await canvasToBlob(canvas);
        if (!blob) throw new Error("encode");
        const prefix = theme === "inktober" ? "drawesome-inktober" : "drawesome-invite";
        const file = new File([blob], `${prefix}-${roomId}.png`, { type: "image/png" });
        const url = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        cardRef.current = { blob, file, url };
        setCard(cardRef.current);
      } catch {
        if (!cancelled) setCardFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getArt, joinUrl, roomId, roomTitle, theme, inktober]);

  // Revoke the object URL only when the sheet unmounts.
  useEffect(() => () => {
    if (cardRef.current?.url) URL.revokeObjectURL(cardRef.current.url);
    cardRef.current = null;
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copyLink = async () => {
    if (await copyText(joinUrl)) {
      showToast("Invite link copied — paste it anywhere!");
    } else {
      window.prompt("Copy this invite link:", joinUrl);
    }
    onClose();
  };

  const nativeShare = async () => {
    try {
      // Link-only on purpose: iPadOS drops the URL when a file rides along.
      // The caption is seasonal — it matches the card the preview is showing.
      await navigator.share({ title, text: caption, url: joinUrl });
      showToast("Invite shared! 🎨");
      onClose();
    } catch (err) {
      if (err?.name === "AbortError") return;
      copyLink();
    }
  };

  const shareX = () => {
    const popup = window.open(xIntentUrl({ roomId, joinUrl, theme }), "_blank", "noopener,noreferrer");
    if (!popup) {
      copyText(caption);
      showToast("Popup blocked — caption copied, paste it into your post!");
      return;
    }
    showToast("Opening X — your invite link is in the post 🎨");
    onClose();
  };

  // Image-native sharing for the apps that eat text (Instagram, TikTok).
  // Share FIRST (preserves the tap's user activation), caption copy AFTER.
  const shareImageCard = async (target) => {
    const label = target === "tiktok" ? "TikTok" : "Instagram";
    const current = cardRef.current;
    if (!current) {
      showToast(cardFailed ? "Couldn't build the invite card — try Copy link instead" : "Getting your invite card ready…");
      return;
    }
    if (navigator.canShare?.({ files: [current.file] })) {
      try {
        await navigator.share({ files: [current.file], title, text: caption });
        const copied = await copyText(caption);
        showToast(copied ? `Pick ${label}, then paste your caption! 🖋` : `Pick ${label} in the share sheet! 🖋`);
        onClose();
        return;
      } catch (err) {
        if (err?.name === "AbortError") return; // cancelled: no download, no tab
        // Fall through to the save-and-upload path.
      }
    }
    const copied = await copyText(caption);
    downloadBlob(current.blob, current.file.name);
    window.open(target === "tiktok" ? "https://www.tiktok.com/upload" : "https://www.instagram.com/", "_blank", "noopener,noreferrer");
    showToast(copied ? `Invite card saved + caption copied — upload it on ${label}!` : `Invite card saved — upload it on ${label}!`);
    onClose();
  };

  // "Share image…" — the OS share sheet WITH the card file attached, so
  // Messages or Mail can be picked as the target and the picture rides along
  // (the sms:/mailto: links below can't do that). Share FIRST — nothing is
  // awaited before the native call, so the tap's user activation survives —
  // and an AbortError (user cancelled) is completely side-effect-free: no
  // download, no toast, no close. Unsupported platforms fall back to saving
  // the card with honest attach-it-yourself guidance.
  const shareImageNative = async () => {
    const current = cardRef.current;
    if (!current) {
      showToast(cardFailed ? "Couldn't build the invite card — try Copy link instead" : "Getting your invite card ready…");
      return;
    }
    if (navigator.canShare?.({ files: [current.file] })) {
      try {
        await navigator.share({ files: [current.file], title, text: caption });
        showToast("Invite card shared! 🖼️");
        onClose();
        return;
      } catch (err) {
        if (err?.name === "AbortError") return; // cancelled: no download, no tab
        // Fall through to the save-and-attach path.
      }
    }
    downloadBlob(current.blob, current.file.name);
    showToast("Invite card saved — attach it in Messages or Mail! 🖼️");
    onClose();
  };

  const saveImage = () => {
    const current = cardRef.current;
    if (!current) {
      showToast(cardFailed ? "Couldn't build the invite card — try Copy link instead" : "Getting your invite card ready…");
      return;
    }
    downloadBlob(current.blob, current.file.name);
    showToast("Invite card saved — attach it anywhere! 🖼️");
    onClose();
  };

  // SMS/email can't carry the picture — only the link (honest note below).
  const smsHref = `sms:?&body=${encodeURIComponent(caption)}`;
  const mailHref = `mailto:?subject=${encodeURIComponent("Come draw with me on Drawesome!")}&body=${encodeURIComponent(caption)}`;

  return (
    <div className="modal-backdrop share-invite-backdrop" role="presentation" onClick={onClose}>
      <section
        className="studio-modal share-invite-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-invite-title"
        data-card-theme={theme}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title-row">
          <h2 id="share-invite-title">Invite friends {theme === "inktober" ? "🖋" : "🎨"}</h2>
          <button type="button" className="share-invite-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="share-invite-preview">
          {card ? (
            <img src={card.url} alt="Your invite card" />
          ) : (
            <div className="share-invite-preview-empty">{cardFailed ? "No preview" : "Making your invite card…"}</div>
          )}
        </div>

        <div className="share-card-theme" role="group" aria-label="Invite card style">
          <button type="button" aria-pressed={theme === "inktober"} onClick={() => setThemeChoice("inktober")}>
            🖋 Inktober
          </button>
          <button type="button" aria-pressed={theme === "classic"} onClick={() => setThemeChoice("classic")}>
            🎨 Classic
          </button>
        </div>

        <div className="share-invite-code">
          <span>Room code</span>
          <strong>{roomId}</strong>
        </div>

        <div className="share-invite-grid">
          {canNativeShare ? (
            <button type="button" className="share-invite-btn share-native" onClick={nativeShare}>
              <span className="share-invite-icon">📤</span>
              Share…
            </button>
          ) : null}
          {canShareFiles ? (
            <button
              type="button"
              className="share-invite-btn share-image"
              onClick={shareImageNative}
              disabled={!card && !cardFailed}
            >
              <span className="share-invite-icon">📨</span>
              Share image…
            </button>
          ) : null}
          <button type="button" className="share-invite-btn share-copy" onClick={copyLink}>
            <span className="share-invite-icon">🔗</span>
            Copy link
          </button>
          <button
            type="button"
            className="share-invite-btn share-instagram"
            onClick={() => shareImageCard("instagram")}
            disabled={!card && !cardFailed}
          >
            <span className="share-invite-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="5" />
                <circle cx="12" cy="12" r="4" />
                <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
              </svg>
            </span>
            Instagram
          </button>
          <button
            type="button"
            className="share-invite-btn share-tiktok"
            onClick={() => shareImageCard("tiktok")}
            disabled={!card && !cardFailed}
          >
            <span className="share-invite-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M16.6 3c.4 2 1.8 3.6 3.9 3.9v3.1c-1.5 0-2.9-.5-3.9-1.3v6.1c0 3.6-2.6 6.2-6 6.2-3.3 0-6-2.7-6-6.1 0-3.5 2.8-6.2 6.4-6V12c-1.7-.1-3.2 1.2-3.2 3 0 1.7 1.3 3 3 3 1.8 0 3-1.4 3-3.1V3h2.8z" />
              </svg>
            </span>
            TikTok
          </button>
          <button type="button" className="share-invite-btn share-x" onClick={shareX}>
            <span className="share-invite-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </span>
            Post on X
          </button>
          <button
            type="button"
            className="share-invite-btn share-save"
            onClick={saveImage}
            disabled={!card && !cardFailed}
          >
            <span className="share-invite-icon">🖼️</span>
            Save image
          </button>
          <a className="share-invite-btn share-sms" href={smsHref}>
            <span className="share-invite-icon">💬</span>
            Text it
          </a>
          <a className="share-invite-btn share-email" href={mailHref}>
            <span className="share-invite-icon">✉️</span>
            Email it
          </a>
        </div>

        <p className="share-invite-note">
          Instagram &amp; TikTok get your invite card as a picture — the caption is copied for you, just paste it in.{" "}
          {canShareFiles
            ? "For texts and email, tap Share image… and pick Messages or Mail — the card rides along as a picture. Text it / Email it send the link only (they can’t attach pictures automatically), so tap Save image first if you’d rather attach the card yourself."
            : "Texts and email send the link only — they can’t attach pictures automatically, so tap Save image first and attach the card in your app."}{" "}
          Posting somewhere public? Check with a grown-up first. 💛
        </p>
      </section>
    </div>
  );
}
