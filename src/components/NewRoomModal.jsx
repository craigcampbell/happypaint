import { useEffect, useState } from "react";
import ColoringSheetModal from "./ColoringSheetModal";

export default function NewRoomModal({ session, onClose, onEnter }) {
  const [today, setToday] = useState(null);
  const [showPicker, setShowPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/coloring-sheets/today", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (active) setToday(data?.sheet || null);
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const createRoom = async (sheet = null) => {
    setBusy(true);
    setError("");
    try {
      const token = session?.access_token || "";
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          audience: "friends",
          listed: false,
          sheetId: sheet?.id ? `lib:${sheet.id}` : null,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data?.code) throw new Error(data?.error || "failed");
      setCreated({ code: data.code, sheet });
    } catch {
      setError("Couldn’t make the room. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const copyInvite = async () => {
    const link = `${window.location.origin}/join/${created.code}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      window.prompt("Copy this invite link:", link);
    }
  };

  const shareInvite = async () => {
    const url = `${window.location.origin}/join/${created.code}`;
    if (!navigator.share) return copyInvite();
    try {
      await navigator.share({ title: "Come draw with me on Drawesome!", text: "Come paint with me 🎨", url });
    } catch (shareError) {
      if (shareError?.name !== "AbortError") await copyInvite();
    }
  };

  if (showPicker) {
    return (
      <ColoringSheetModal
        onClose={() => setShowPicker(false)}
        onApply={(sheet) => {
          setShowPicker(false);
          createRoom(sheet);
        }}
      />
    );
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={busy ? undefined : onClose}>
      <section
        className="studio-modal new-room-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-room-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title-row">
          <h2 id="new-room-title">{created ? "Your room is ready! 🎉" : "Start a room 🎨"}</h2>
          <button type="button" onClick={onClose} disabled={busy}>Close</button>
        </div>

        {created ? (
          <div className="new-room-ready">
            <p>{created.sheet ? `We put “${created.sheet.title}” on the canvas.` : "A fresh canvas is waiting."}</p>
            <div className="new-room-code" aria-label={`Room code ${created.code}`}>
              <span>Room code</span>
              <strong>{created.code}</strong>
              <small>{window.location.origin}/join/{created.code}</small>
            </div>
            <p className="new-room-gentle">Only people with this link can join. Send it to family or friends you know.</p>
            <div className="new-room-ready-actions">
              <button type="button" onClick={copyInvite}>{copied ? "Copied! ✓" : "Copy invite link"}</button>
              <button type="button" onClick={shareInvite}>Share</button>
              <button type="button" className="primary-action" onClick={() => onEnter(created.code)}>Enter room →</button>
            </div>
          </div>
        ) : (
          <>
            <p className="new-room-intro">Pick a starting point. You can always change it once you’re painting.</p>
            <div className="new-room-choices">
              <button type="button" disabled={busy} onClick={() => createRoom()}>
                <span aria-hidden="true">✎</span>
                <strong>Blank canvas</strong>
                <small>Start with anything you imagine</small>
              </button>
              <button type="button" disabled={busy || !today} onClick={() => createRoom(today)}>
                <span aria-hidden="true">✨</span>
                <strong>Today’s coloring sheet</strong>
                <small>{today?.title || "Finding today’s pick…"}</small>
              </button>
              <button type="button" disabled={busy} onClick={() => setShowPicker(true)}>
                <span aria-hidden="true">🖍️</span>
                <strong>Pick a coloring sheet</strong>
                <small>Search animals, space, holidays, and more</small>
              </button>
            </div>
            {busy ? <p className="new-room-status" aria-live="polite">Making your room…</p> : null}
            {error ? <p className="admin-error" role="alert">{error}</p> : null}
          </>
        )}
      </section>
    </div>
  );
}
