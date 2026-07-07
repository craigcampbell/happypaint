// The production storyboard — a film's call sheet. One card per segment room
// ("Part"), each with a LIVE preview (spectator canvas — the same tech as the
// homepage carousel), live crew count, frame count and runtime. Tap a part to
// hop into its room; the host adds parts and renames the film. Pure
// presentation: StudioApp owns all production state + actions.

import { useState } from "react";
import LiveRoomCanvas from "./LiveRoomCanvas";

function formatRuntime(ms) {
  if (!ms) return "0s";
  const seconds = ms / 1000;
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s` : `${Math.round(seconds * 10) / 10}s`;
}

export default function Storyboard({
  production, // null until the room joins/creates one
  roomId,
  isRoomHost,
  isExportingVideo,
  onClose,
  onCreate,
  onAddPart,
  onRename,
  onJoinPart,
  onExportFilm,
}) {
  const [titleDraft, setTitleDraft] = useState(null); // null = not editing

  const totalRuntime = production ? production.segments.reduce((sum, s) => sum + (s.runtimeMs || 0), 0) : 0;
  const totalFrames = production ? production.segments.reduce((sum, s) => sum + (s.frames || 0), 0) : 0;

  return (
    <div className="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="storyboard-title">
      <div className="storyboard-card">
        <div className="sb-clapper">
          <div className="sb-clapper-stripes" aria-hidden="true" />
          {production && titleDraft !== null ? (
            <form
              className="sb-title-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (titleDraft.trim()) onRename(titleDraft.trim());
                setTitleDraft(null);
              }}
            >
              <input
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                maxLength={48}
                autoFocus
                aria-label="Film title"
              />
              <button type="submit">Save</button>
            </form>
          ) : (
            <h2 id="storyboard-title">
              🎬 {production ? production.title : "Make a movie!"}
              {production && isRoomHost ? (
                <button
                  type="button"
                  className="sb-rename"
                  onClick={() => setTitleDraft(production.title)}
                  aria-label="Rename film"
                  title="Rename film"
                >
                  ✏️
                </button>
              ) : null}
            </h2>
          )}
          {production ? (
            <span className="sb-runtime" title="Total runtime so far">
              ⏱ {formatRuntime(totalRuntime)} · 🎞 {totalFrames} frames
            </span>
          ) : null}
          <button type="button" className="sb-close" onClick={onClose} aria-label="Close storyboard">
            ✕
          </button>
        </div>

        {!production ? (
          <div className="sb-pitch">
            <p>
              Link up to <strong>6 rooms</strong> into ONE film — each part holds ~30 seconds of animation.
              Friends can work on different parts at the same time, and “Export film” stitches every part
              into a single movie up to <strong>2+ minutes</strong> long.
            </p>
            {isRoomHost ? (
              <button type="button" className="primary-action sb-create" onClick={() => onCreate()}>
                🎬 Start a Production
              </button>
            ) : (
              <p className="sb-hint">Ask your room&apos;s host to start the production — then everyone gets a part to paint!</p>
            )}
          </div>
        ) : (
          <>
            <div className="sb-board" role="list">
              {production.segments.map((segment) => {
                const here = segment.code === roomId;
                return (
                  <div key={segment.code} className={`sb-panel${here ? " is-here" : ""}`} role="listitem" data-code={segment.code}>
                    <div className="sb-tape" aria-hidden="true" />
                    <button
                      type="button"
                      className="sb-panel-preview"
                      onClick={() => (here ? onClose() : onJoinPart(segment.code))}
                      title={here ? "You're painting this part" : `Jump into ${segment.title}`}
                    >
                      <LiveRoomCanvas roomCode={segment.code} />
                      {here ? <span className="sb-here">📍 You&apos;re here</span> : null}
                    </button>
                    <div className="sb-panel-meta">
                      <strong>
                        {segment.index + 1}. {segment.title}
                      </strong>
                      {segment.crew?.length ? (
                        <div className="sb-crew" aria-label={`${segment.crew.length} painting here`}>
                          {segment.crew.slice(0, 6).map((person, i) => (
                            <span key={i} className="sb-crew-chip" style={{ background: person.color || "#2d6cdf" }} title={person.name}>
                              {(person.name || "?").slice(0, 1).toUpperCase()}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <span>
                        {segment.users > 0 ? `🧑‍🎨 ${segment.users} painting · ` : ""}
                        ⏱ {formatRuntime(segment.runtimeMs)}
                      </span>
                    </div>
                  </div>
                );
              })}
              {isRoomHost && production.segments.length < (production.maxSegments || 6) ? (
                <button type="button" className="sb-panel sb-add" onClick={onAddPart}>
                  <span className="sb-add-plus" aria-hidden="true">＋</span>
                  Add Part {production.segments.length + 1}
                </button>
              ) : null}
            </div>
            <div className="sb-footer">
              <button
                type="button"
                className="primary-action"
                onClick={onExportFilm}
                disabled={isExportingVideo}
                title="Stitch every part into one video"
              >
                {isExportingVideo ? "🎬 Rendering…" : "🎬 Export the whole film"}
              </button>
              <span className="sb-footnote">Everyone in any part can watch the board update live.</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
