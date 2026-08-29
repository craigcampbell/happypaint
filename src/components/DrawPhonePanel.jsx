import { useEffect, useMemo, useRef, useState } from "react";
import PageImage from "./PageImage";

// Draw Phone (telephone / Gartic) HUD. Pure presentation over the game state:
//  - waiting: need more players (with a host Start button in private rooms)
//  - drawing: a slim top banner ("Draw: CAT") + a floating "Done" button so the
//    canvas stays usable (the player draws on the real studio canvas)
//  - guessing: a centered card showing the drawing to describe + a text input
//  - reveal: the books play back page-by-page, sharable per book
// The parent owns all the networking; this only calls the passed handlers.

function secondsLeft(deadline) {
  if (!deadline) return null;
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}

function useCountdown(deadline) {
  const [left, setLeft] = useState(() => secondsLeft(deadline));
  useEffect(() => {
    setLeft(secondsLeft(deadline));
    if (!deadline) return undefined;
    const id = window.setInterval(() => setLeft(secondsLeft(deadline)), 250);
    return () => window.clearInterval(id);
  }, [deadline]);
  return left;
}

// Share one finished book: the final drawing + the "from → to" journey. Falls
// back to a download when the OS share sheet can't take files.
async function shareBook(book) {
  const drawings = book.pages.filter((p) => p.type === "draw" && p.content && !p.skipped);
  const last = drawings[drawings.length - 1];
  const seed = book.pages[0]?.content || "";
  const finalGuess = [...book.pages].reverse().find((p) => p.type === "guess")?.content;
  // The join link rides inside the text (not only the `url` field) because
  // several share targets drop `url` when a file is attached — the image must
  // still carry a way back to the site.
  const joinUrl = `${window.location.origin}/join/PHONE`;
  const text = finalGuess
    ? `Draw Phone: "${seed}" became "${finalGuess}"! 📞🎨 Play at ${joinUrl}`
    : `Draw Phone on Drawesome! 📞🎨 Play at ${joinUrl}`;
  try {
    if (last) {
      const res = await fetch(`/api/sheets/${last.content}`);
      const data = await res.json();
      const blob = await (await fetch(data.image)).blob();
      const file = new File([blob], "drawphone.jpg", { type: blob.type || "image/jpeg" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text, title: "Draw Phone", url: joinUrl });
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "drawphone.jpg"; a.click();
      URL.revokeObjectURL(url);
      return;
    }
    if (navigator.share) await navigator.share({ text, title: "Draw Phone", url: joinUrl });
  } catch { /* user dismissed or share unsupported — no-op */ }
}

function BookPages({ book }) {
  return (
    <div className="phone-book">
      <div className="phone-book-owner">{book.ownerName}&rsquo;s book</div>
      <div className="phone-book-pages">
        {book.pages.map((pg, i) => (
          <div key={i} className={`phone-page phone-page-${pg.type}`}>
            {pg.type === "draw" ? (
              pg.skipped || !pg.content
                ? <div className="phone-page-empty">⏳ ran out of time</div>
                : <PageImage id={pg.content} alt="a drawing" />
            ) : (
              <div className="phone-page-text">
                {pg.type === "prompt" ? "✏️ " : "💬 "}{pg.content}
              </div>
            )}
            <div className="phone-page-by">{pg.type === "prompt" ? "the prompt" : pg.byName}</div>
          </div>
        ))}
      </div>
      <button type="button" className="phone-share-btn" onClick={() => shareBook(book)}>
        🔗 Share this one
      </button>
    </div>
  );
}

export default function DrawPhonePanel({
  phone,
  task,
  submitted,
  reveal,
  isHost,
  guess,
  setGuess,
  onSubmitDrawing,
  onSubmitGuess,
  onStart,
  onSkip,
}) {
  const guessRef = useRef(null);
  const left = useCountdown(phone?.deadline || task?.deadline || 0);
  const phase = phone?.phase;
  const progress = phone ? `${phone.submittedCount}/${phone.presentCount} done` : "";

  // Autofocus the guess box when a guessing round opens.
  useEffect(() => {
    if (phase === "guessing" && task && !submitted) guessRef.current?.focus();
  }, [phase, task, submitted]);

  const roundLabel = useMemo(() => {
    if (!phone || !phone.totalRounds) return "";
    return `Round ${Math.min(phone.round + 1, phone.totalRounds)} / ${phone.totalRounds}`;
  }, [phone]);

  // ---- Reveal: the books play back ----------------------------------------
  if (reveal) {
    return (
      <div className="phone-reveal-scrim">
        <div className="phone-reveal">
          <div className="phone-reveal-head">
            <h3>📞 The books are in!</h3>
            <p>See how each prompt drifted around the room.</p>
            {phone?.hostControlled && isHost ? (
              <button type="button" className="phone-again-btn" onClick={onStart}>Play again ▶</button>
            ) : (
              <span className="phone-again-note">Next game starts soon…</span>
            )}
          </div>
          <div className="phone-reveal-books">
            {reveal.map((book, i) => <BookPages key={i} book={book} />)}
          </div>
        </div>
      </div>
    );
  }

  if (!phone) return null;

  // ---- Waiting for players ------------------------------------------------
  if (phase === "waiting" || phase === "starting" || !phase) {
    const need = phone.minPlayers || 3;
    return (
      <div className="phone-banner phone-waiting">
        <span className="phone-badge">📞 Draw Phone</span>
        <span className="phone-waiting-msg">
          Need {need} players to start — {phone.presentCount} here. Invite a friend!
        </span>
        {phone.hostControlled && isHost ? (
          <button type="button" className="phone-start-btn" onClick={onStart} disabled={phone.presentCount < need}>
            Start ▶
          </button>
        ) : null}
      </div>
    );
  }

  // ---- Drawing round: slim banner + floating Done -------------------------
  if (phase === "drawing") {
    if (task && !submitted) {
      return (
        <>
          <div className="phone-banner phone-drawing">
            <span className="phone-badge">✏️ Draw this</span>
            <span className="phone-prompt">{task.prompt}</span>
            <span className={`phone-timer ${left != null && left <= 10 ? "low" : ""}`}>{left != null ? `${left}s` : ""}</span>
            <span className="phone-round">{roundLabel}</span>
          </div>
          <button type="button" className="phone-done-fab" onClick={onSubmitDrawing}>Done ✓</button>
        </>
      );
    }
    return (
      <div className="phone-banner phone-drawing">
        <span className="phone-badge">✏️ Draw Phone</span>
        <span className="phone-waiting-msg">{submitted ? "Sent! " : ""}Waiting for the others… {progress}</span>
        {phone.hostControlled && isHost ? <button type="button" className="phone-skip-btn" onClick={onSkip}>Skip ⏭</button> : null}
      </div>
    );
  }

  // ---- Guessing round: centered card --------------------------------------
  if (phase === "guessing") {
    if (task && !submitted) {
      return (
        <div className="phone-guess-scrim">
          <div className="phone-guess-card">
            <div className="phone-guess-head">
              <span className="phone-badge">🤔 What is this?</span>
              <span className={`phone-timer ${left != null && left <= 10 ? "low" : ""}`}>{left != null ? `${left}s` : ""}</span>
            </div>
            <div className="phone-guess-image">
              {task.image ? <PageImage id={task.image} alt="guess this drawing" /> : <div className="phone-page-empty">no drawing</div>}
            </div>
            <form
              className="phone-guess-form"
              onSubmit={(e) => { e.preventDefault(); onSubmitGuess(); }}
            >
              <input
                ref={guessRef}
                type="text"
                value={guess}
                onChange={(e) => setGuess(e.target.value)}
                placeholder="Type what you see…"
                maxLength={120}
                autoComplete="off"
              />
              <button type="submit">Send</button>
            </form>
          </div>
        </div>
      );
    }
    return (
      <div className="phone-banner phone-guessing">
        <span className="phone-badge">🤔 Draw Phone</span>
        <span className="phone-waiting-msg">{submitted ? "Guess sent! " : ""}Waiting for the others… {progress}</span>
        {phone.hostControlled && isHost ? <button type="button" className="phone-skip-btn" onClick={onSkip}>Skip ⏭</button> : null}
      </div>
    );
  }

  return null;
}
