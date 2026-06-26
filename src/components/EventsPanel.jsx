// Event Engine UI — the recurring-event loop on the discovery surface.
//
// Renders the daily-prompt + weekend-challenge cards and a list of timed events
// with their lifecycle phase (upcoming / live / voting / ended), a countdown to
// the next phase, and a per-phase call to action:
//   live    → "Enter the studio for this prompt" (navigates to /studio?prompt=…)
//   voting  → votable gallery entries with one-vote-per-profile vote buttons
//   ended   → the winner + results
//
// Mock/local data + voting model live in utils/eventEngine.js. Audience gating
// (kid_safe / friends only; no adult events) happens in getSurfaceEvents().

import { useMemo, useState } from "react";
import {
  castVote,
  formatCountdown,
  getEventEntries,
  getSurfaceEvents,
  nextPhase,
  promptOfTheDay,
  promptPacks,
  readVotedPostIds,
} from "../utils/eventEngine";

function EntryArt({ palette }) {
  const colors = palette || ["#0f172a", "#0ea5e9", "#f97316"];
  return (
    <div className="gallery-art event-entry-art" aria-hidden="true">
      <i style={{ background: colors[0] }} />
      <i style={{ background: colors[1] }} />
      <i style={{ background: colors[2] }} />
    </div>
  );
}

function PromptCard({ pack, onEnterStudio }) {
  const prompt = promptOfTheDay(pack);
  return (
    <article className="event-prompt-card">
      <div className="event-prompt-head">
        <span className="status-pill status-live">{pack.kind === "daily" ? "Today" : "This weekend"}</span>
        <small>{pack.cadence}</small>
      </div>
      <h4>{pack.title}</h4>
      <p className="event-prompt-text">{prompt}</p>
      <button type="button" className="primary-action" onClick={() => onEnterStudio(prompt)}>
        Draw this prompt
      </button>
    </article>
  );
}

function EventEntries({ eventId, votedPostIds, onVote }) {
  const entries = useMemo(() => getEventEntries(eventId, votedPostIds), [eventId, votedPostIds]);
  if (entries.length === 0) {
    return <p className="event-empty">No entries yet — be the first to enter this prompt.</p>;
  }
  return (
    <div className="event-entry-grid">
      {entries.map((entry) => (
        <article key={entry.id} className="event-entry-card">
          <EntryArt palette={entry.palette} />
          <div>
            <h5>{entry.title}</h5>
            <small>{entry.roomTitle} · {entry.contributors} artists</small>
          </div>
          <button
            type="button"
            className={entry.voted ? "is-voted" : ""}
            onClick={() => onVote(entry.id)}
            disabled={entry.voted}
          >
            {entry.voted ? "Voted" : "Vote"} · {entry.displayVotes.toLocaleString()}
          </button>
        </article>
      ))}
    </div>
  );
}

function EventCard({ event, votedPostIds, onEnterStudio, onVote }) {
  const phase = nextPhase(event);
  const countdown = formatCountdown(phase.at);
  const winner = event.status === "ended" ? getEventEntries(event.id, votedPostIds)[0] : null;

  return (
    <article className="event-card">
      <div className="event-card-top">
        <span className={`status-pill status-${event.status}`}>{event.status}</span>
        <strong>{event.title}</strong>
      </div>
      <p className="event-theme">{event.theme}</p>
      <div className="mini-tag-row">
        {event.tags.map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
      </div>
      <div className="event-meta">
        <span>{phase.label}{countdown ? ` ${countdown}` : ""}</span>
        <small>{event.roomCount} rooms</small>
      </div>

      {event.status === "upcoming" ? (
        <p className="event-note">Starts soon — check back to enter.</p>
      ) : null}

      {event.status === "live" ? (
        <button type="button" className="primary-action" onClick={() => onEnterStudio(event.prompt)}>
          Enter the studio for this prompt
        </button>
      ) : null}

      {event.status === "voting" ? (
        <div className="event-voting">
          <p className="event-note">Voting is open — one vote per person per post.</p>
          <EventEntries eventId={event.id} votedPostIds={votedPostIds} onVote={onVote} />
        </div>
      ) : null}

      {event.status === "ended" ? (
        <div className="event-results">
          {winner ? (
            <div className="event-winner">
              <span className="status-pill status-featured">Winner</span>
              <EntryArt palette={winner.palette} />
              <div>
                <h5>{winner.title}</h5>
                <small>{winner.displayVotes.toLocaleString()} votes · {winner.roomTitle}</small>
              </div>
            </div>
          ) : (
            <p className="event-empty">This event ended without entries.</p>
          )}
        </div>
      ) : null}
    </article>
  );
}

export default function EventsPanel({ onNavigate }) {
  const [votedPostIds, setVotedPostIds] = useState(() => readVotedPostIds());
  const [notice, setNotice] = useState(
    "Events use Happy Paint library prompts. Adult events never appear here.",
  );
  const events = useMemo(() => getSurfaceEvents(), []);

  const enterStudio = (prompt) => {
    const query = prompt ? `?prompt=${encodeURIComponent(prompt)}` : "";
    onNavigate?.(`/studio${query}`);
  };

  const handleVote = (postId) => {
    const result = castVote(postId);
    if (!result.ok) {
      setNotice("You already voted on that post. One vote per person keeps it fair.");
      return;
    }
    setVotedPostIds(result.votedPostIds);
    setNotice("Vote counted. One vote per person per post.");
  };

  return (
    <section className="events-engine" id="events" aria-label="Timed events and prompts">
      <div className="panel-title-row">
        <h3>Events &amp; Prompts</h3>
        <span>{events.length} active</span>
      </div>
      <p className="discovery-notice">{notice}</p>

      <div className="event-prompt-row">
        {promptPacks.map((pack) => (
          <PromptCard key={pack.id} pack={pack} onEnterStudio={enterStudio} />
        ))}
      </div>

      <div className="event-card-list">
        {events.map((event) => (
          <EventCard
            key={event.id}
            event={event}
            votedPostIds={votedPostIds}
            onEnterStudio={enterStudio}
            onVote={handleVote}
          />
        ))}
      </div>
    </section>
  );
}
