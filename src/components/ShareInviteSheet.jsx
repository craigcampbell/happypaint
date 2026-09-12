// "Invite friends" share sheet. One place for every way to say "come draw with
// me": the OS share sheet (mobile), copy link, X, and Instagram. Instagram is
// the odd one out — there's no share URL and it ignores text — so we hand it a
// pre-rendered invite CARD (art + room code + link) and put the caption on the
// clipboard: on phones via the OS share sheet (pick Instagram → Story/Post),
// on desktop by saving the PNG and opening instagram.com to upload it.

import { useEffect, useRef, useState } from "react";
import { inviteCaption, renderInviteCard, xIntentUrl } from "../utils/inviteCard";

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

export default function ShareInviteSheet({ roomId, roomTitle, getArt, onClose, showToast }) {
  const joinUrl = `${window.location.origin}/join/${encodeURIComponent(roomId)}`;
  const title = roomTitle || `Drawesome room ${roomId}`;
  const caption = inviteCaption({ roomId, joinUrl });
  const [card, setCard] = useState(null); // { blob, file, url }
  const [cardFailed, setCardFailed] = useState(false);
  const cardRef = useRef(null);
  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  // Render the card once when the sheet opens; every button reads from it so
  // the click handlers stay synchronous (popup blockers + share-sheet gestures).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const art = await getArt();
        const canvas = await renderInviteCard({ art, roomId, joinUrl, title: roomTitle });
        const blob = await canvasToBlob(canvas);
        if (!blob) throw new Error("encode");
        const file = new File([blob], `drawesome-invite-${roomId}.png`, { type: "image/png" });
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
      if (cardRef.current?.url) URL.revokeObjectURL(cardRef.current.url);
      cardRef.current = null;
    };
  }, [getArt, joinUrl, roomId, roomTitle]);

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
      await navigator.share({ title, text: `Come draw with me on Drawesome! 🎨 ${joinUrl}`, url: joinUrl });
      showToast("Invite shared! 🎨");
      onClose();
    } catch (err) {
      if (err?.name === "AbortError") return;
      copyLink();
    }
  };

  const shareX = () => {
    const popup = window.open(xIntentUrl({ roomId, joinUrl }), "_blank", "noopener,noreferrer");
    if (!popup) {
      copyText(caption);
      showToast("Popup blocked — caption copied, paste it into your post!");
      return;
    }
    showToast("Opening X — your invite link is in the post 🎨");
    onClose();
  };

  const shareInstagram = async () => {
    const current = cardRef.current;
    if (!current) {
      showToast(cardFailed ? "Couldn't build the invite card — try Copy link instead" : "Getting your invite card ready…");
      return;
    }
    // Instagram ignores share text, so the caption goes on the clipboard first.
    const copied = await copyText(caption);
    if (navigator.canShare?.({ files: [current.file] })) {
      try {
        await navigator.share({ files: [current.file], title, text: caption });
        showToast(copied ? "Pick Instagram, then paste your caption! 🎨" : "Pick Instagram in the share sheet! 🎨");
        onClose();
        return;
      } catch (err) {
        if (err?.name === "AbortError") return;
        // Fall through to the download path.
      }
    }
    downloadBlob(current.blob, current.file.name);
    window.open("https://www.instagram.com/", "_blank", "noopener,noreferrer");
    showToast(copied ? "Invite card saved + caption copied — upload it on Instagram!" : "Invite card saved — upload it on Instagram!");
    onClose();
  };

  return (
    <div className="modal-backdrop share-invite-backdrop" role="presentation" onClick={onClose}>
      <section
        className="studio-modal share-invite-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-invite-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title-row">
          <h2 id="share-invite-title">Invite friends 🎨</h2>
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
          <button type="button" className="share-invite-btn share-copy" onClick={copyLink}>
            <span className="share-invite-icon">🔗</span>
            Copy link
          </button>
          <button
            type="button"
            className="share-invite-btn share-instagram"
            onClick={shareInstagram}
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
          <button type="button" className="share-invite-btn share-x" onClick={shareX}>
            <span className="share-invite-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </span>
            Post on X
          </button>
        </div>

        <p className="share-invite-note">
          Instagram gets your invite card as a picture — the caption is copied for you, just paste it in.
          Posting somewhere public? Check with a grown-up first. 💛
        </p>
      </section>
    </div>
  );
}
