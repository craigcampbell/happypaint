// Draw & Guess HUD — the on-canvas game overlay. Shows whose turn it is, the
// secret word (to the drawer) or masked blanks (to guessers), a live countdown,
// the scoreboard, and celebratory pops when someone guesses or the word is
// revealed. Pure presentation: all game logic is server-authoritative; this
// reads the `game` snapshot and ticks its own local clock for the countdown.

import { useEffect, useState } from "react";

const ROUND_SECONDS = 75; // matches server GAME_ROUND_MS (cosmetic bar only)

export default function GameHud({ game, myWord, myId, isHost, pop, onSkip }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, []);

  if (!game) return null;

  const iAmDrawer = game.drawerId === myId;
  const secsLeft = game.endsAt ? Math.max(0, Math.ceil((game.endsAt - now) / 1000)) : 0;
  const frac = Math.max(0, Math.min(1, secsLeft / ROUND_SECONDS));
  const urgent = game.phase === "playing" && secsLeft <= 10;

  return (
    <>
      <div className={`game-hud${urgent ? " is-urgent" : ""}`} role="status" aria-live="polite">
        <div className="game-hud-main">
          <span className="game-round">Round {game.roundNo || 1}</span>

          {game.phase === "playing" ? (
            <span className="game-timer" aria-label={`${secsLeft} seconds left`}>
              ⏱ {secsLeft}s
            </span>
          ) : null}

          <div className="game-word">
            {game.phase === "waiting" ? (
              <span className="game-word-wait">Waiting for another player to join… 👋</span>
            ) : game.phase === "intermission" ? (
              <span className="game-word-wait">Get ready — next round starting…</span>
            ) : iAmDrawer ? (
              <span className="game-word-draw">
                <span className="game-word-label">Your word</span>
                <strong>{myWord || "…"}</strong>
                <span className="game-word-hint">draw it — no letters or numbers!</span>
              </span>
            ) : (
              <span className="game-word-guess">
                <span className="game-word-label">
                  {game.drawerName || "Someone"} is drawing — guess in chat!
                </span>
                <strong className="game-blanks">{game.wordMask || "_ ".repeat(game.wordLen || 3)}</strong>
              </span>
            )}
          </div>

          {game.phase === "playing" && (iAmDrawer || isHost) ? (
            <button type="button" className="game-skip" onClick={onSkip} title="End this round">
              Skip ⏭
            </button>
          ) : null}
        </div>

        {game.phase === "playing" ? (
          <div className="game-timebar" aria-hidden="true">
            <span style={{ width: `${frac * 100}%` }} />
          </div>
        ) : null}

        {Array.isArray(game.scores) && game.scores.length ? (
          <ol className="game-scores">
            {game.scores.slice(0, 6).map((s) => (
              <li
                key={s.id}
                className={`${s.id === game.drawerId ? "is-drawer" : ""}${s.guessed ? " has-guessed" : ""}${s.id === myId ? " is-me" : ""}`}
              >
                <span className="gs-name">
                  {s.id === game.drawerId ? "✏️ " : s.guessed ? "✅ " : ""}
                  {s.name}
                </span>
                <span className="gs-score">{s.score}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>

      {pop ? (
        <div className={`game-pop game-pop-${pop.kind}`} role="status">
          {pop.kind === "correct" ? (
            <>
              <span className="game-pop-big">{pop.mine ? "You guessed it! 🎉" : `${pop.name} guessed it!`}</span>
              <span className="game-pop-sub">+{pop.points} points</span>
            </>
          ) : (
            <>
              <span className="game-pop-sub">The word was</span>
              <span className="game-pop-big">{pop.word} ✨</span>
            </>
          )}
        </div>
      ) : null}
    </>
  );
}
