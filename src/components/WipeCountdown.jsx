// Member wipe card, floats over the top of the canvas while a wipe is pending:
// a countdown (alone / two people) or a room vote (3+). The server owns the
// clock and the tally and sends ms-LEFT, never a timestamp, so a kid's skewed
// device clock can't make it lie; this card only ticks its own display.
//
// It re-renders at most once a second (the shown second or the cancel lock
// changing) and only itself, never the studio, and the draining bar is a
// CSS transform animation, so a countdown adds no jank to the drawing path.

import { useEffect, useState } from "react";

function msLeftOf(req) {
  return Math.max(0, req.receivedAt + req.msLeft - Date.now());
}

export default function WipeCountdown({ req, myId, onCancel, onVote }) {
  const [secs, setSecs] = useState(() => Math.ceil(msLeftOf(req) / 1000));
  const [locked, setLocked] = useState(() => msLeftOf(req) <= req.cancelLockMs);
  // A vote tapped but not yet echoed back, stops a double tap voting twice.
  const [sentVote, setSentVote] = useState(null); // { id, vote }

  useEffect(() => {
    const t = window.setInterval(() => {
      const left = msLeftOf(req);
      setSecs(Math.ceil(left / 1000));
      setLocked(left <= req.cancelLockMs);
    }, 200);
    return () => window.clearInterval(t);
  }, [req]);

  const mine = req.byId === myId;
  const who = req.byName || "Someone";
  const vote = req.mode === "vote";
  const myVote = req.myVote || (sentVote && sentVote.id === req.id ? sentVote.vote : null);
  const passing = vote && req.yes >= req.needed;
  const what = req.sheet ? "start a fresh coloring page" : "wipe the canvas";

  let title;
  let sub;
  if (vote) {
    title = mine ? `🗳️ Asking the room to ${what}` : `🗳️ ${who} wants to ${what}`;
    if (locked && passing) sub = "Here it comes! 🧽";
    else if (passing) sub = `✅ ${req.yes} of ${req.people} said yes, wiping when the timer ends`;
    else if (myVote && !mine) sub = `You voted ${myVote === "yes" ? "to wipe" : "to keep it"} · ${req.yes} of ${req.needed} yes votes so far`;
    else sub = `It wipes if ${req.needed} of ${req.people} say yes · ${req.yes} so far`;
  } else {
    const verb = req.sheet ? "Fresh coloring page" : "Wiping the canvas";
    title = mine ? `🧽 ${verb} in ${secs}s` : `🧽 ${who} is ${req.sheet ? "starting a fresh coloring page" : "wiping the canvas"} in ${secs}s`;
    if (locked) sub = "Here it comes! 🧽";
    else if (mine) sub = req.mode === "solo" ? "Changed your mind? You can cancel until the last 3 seconds." : "Everyone in the room sees this countdown too.";
    else sub = "Love what's here? Save it now! 💾";
  }

  const castVote = (yes) => {
    setSentVote({ id: req.id, vote: yes ? "yes" : "no" });
    onVote(req.id, yes);
  };

  // The bar drains from where the clock is now to empty over the time left.
  // Keyed on the arrival, so every server update re-syncs it.
  const from = req.totalMs ? Math.min(1, req.msLeft / req.totalMs) : 1;

  return (
    <div className={`wipe-req${locked ? " is-locked" : ""}`} role="group" aria-label={vote ? title : `${mine ? "You are" : `${who} is`} wiping the canvas`}>
      <div className="wipe-req-row">
        <span className="wipe-req-clock" aria-label={`${secs} seconds left`}>{secs}</span>
        <div className="wipe-req-text">
          <strong>{title}</strong>
          {/* Live, but only the line that changes on EVENTS (votes, the lock) -
              never the ticking title, which would be read out every second. */}
          <small aria-live="polite">{sub}</small>
        </div>
      </div>
      {mine ? (
        <div className="wipe-req-actions">
          <button type="button" className="wipe-req-cancel" disabled={locked} onClick={() => onCancel(req.id)}>
            {locked ? "Too late to cancel" : "✋ Cancel"}
          </button>
        </div>
      ) : vote && !myVote ? (
        <div className="wipe-req-actions">
          <button type="button" className="wipe-req-yes" onClick={() => castVote(true)}>
            👍 Yes, wipe it
          </button>
          <button type="button" className="wipe-req-no" onClick={() => castVote(false)}>
            👎 No, keep it
          </button>
        </div>
      ) : null}
      <div className="wipe-req-bar" aria-hidden="true">
        <span key={`${req.id}-${req.receivedAt}`} style={{ "--wipe-from": from, animationDuration: `${req.msLeft}ms` }} />
      </div>
    </div>
  );
}
