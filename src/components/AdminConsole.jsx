import { useMemo, useState } from "react";
import {
  adminMetrics,
  banReviewItems,
  ddosSignals,
  discoveryReviewItems,
  eventAdminItems,
  galleryVoteItems,
  liveMonitorRooms,
  mediaReviewItems,
  moderationReports,
  networkBlockItems,
  roomEventLog,
  roomReviewItems,
  verificationItems,
} from "../utils/adminData";
import { getPendingPackReviews, reviewPackSubmission } from "../utils/brushPacks";
import { getPendingAiGenerations, reviewAiGeneration } from "../utils/aiGenerations";

// Short, readable summary of an AI generation's output for the review row.
function summarizeAiOutput(generation) {
  if (generation.kind === "palette") {
    return (generation.output?.colors || []).join(" ");
  }
  if (generation.kind === "brush_recipe") {
    const recipe = generation.output?.brush_recipe || {};
    return `${recipe.baseBrush || "brush"} · size ${recipe.size} · opacity ${recipe.opacity}`;
  }
  if (generation.kind === "prompt_card") {
    return generation.output?.prompt || "";
  }
  return JSON.stringify(generation.output || {});
}

const filters = ["All", "Kid-safe", "Friends", "18+"];

function statusClass(value) {
  return `status-${value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "")}`;
}

export default function AdminConsole({ onNavigate }) {
  const [activeFilter, setActiveFilter] = useState("All");
  const [selectedReport, setSelectedReport] = useState(moderationReports[0]);
  const [selectedMonitorRoom, setSelectedMonitorRoom] = useState(liveMonitorRooms[0]);
  const [observingRoom, setObservingRoom] = useState(null);
  const [adminLog, setAdminLog] = useState(["Admin console ready"]);

  // Pending asset/pack review queue (asset_moderation_queue) + pending AI
  // generations (ai_generations). Loaded from the local stores; decisions write
  // through and we refresh the list so resolved items drop out.
  const [packReviews, setPackReviews] = useState(() => getPendingPackReviews());
  const [aiReviews, setAiReviews] = useState(() => getPendingAiGenerations());

  const filteredRooms = useMemo(() => {
    if (activeFilter === "All") {
      return roomReviewItems;
    }

    return roomReviewItems.filter((room) => room.audience === activeFilter);
  }, [activeFilter]);

  const logAction = (message) => {
    setAdminLog((items) => [message, ...items].slice(0, 6));
  };

  const selectedRoomEvents = roomEventLog.filter((event) => event.room === selectedMonitorRoom.code);

  const startObservation = () => {
    setObservingRoom(selectedMonitorRoom.code);
    logAction(`${selectedMonitorRoom.code}: unseen observe started`);
  };

  const endObservation = () => {
    logAction(`${observingRoom}: unseen observe ended`);
    setObservingRoom(null);
  };

  // Review a community pack submission. `decision` is approved | rejected |
  // needs_changes. Approval propagates to the shared brushPacks store so the
  // pack appears in public browse; all decisions write a moderation_actions
  // audit row. We optionally collect a reason for reject / needs_changes.
  const handlePackReview = (entry, decision) => {
    let reason = "";
    if (decision !== "approved") {
      reason =
        window.prompt(
          decision === "rejected" ? "Reason for rejecting (optional):" : "What changes are needed?",
        ) || "";
    }
    reviewPackSubmission(entry.id, decision, reason);
    setPackReviews(getPendingPackReviews());
    const name = entry.pack?.title || entry.target_id;
    const verb =
      decision === "approved" ? "approved — now public in browse" : decision === "rejected" ? "rejected" : "changes requested";
    logAction(`${name}: pack ${verb}`);
  };

  // Review a pending AI generation. `decision` is approved | blocked. Writes the
  // ai_generations moderation_status + a moderation_actions audit row.
  const handleAiReview = (generation, decision) => {
    let note = "";
    if (decision === "blocked") {
      note = window.prompt("Reason for blocking (optional):") || "";
    }
    reviewAiGeneration(generation.id, decision, note);
    setAiReviews(getPendingAiGenerations());
    logAction(`${generation.kind} ${generation.id.slice(0, 12)}: AI generation ${decision}`);
  };

  return (
    <main className="admin-console">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Operations</p>
          <h1>Happy Paint Admin</h1>
          <p>Moderation, media approval, room safety, and verification review.</p>
        </div>
        <div className="admin-header-actions">
          <button type="button" onClick={() => onNavigate("/")}>
            Marketing
          </button>
          <button type="button" onClick={() => onNavigate("/studio")}>
            Studio
          </button>
        </div>
      </header>

      <section className="admin-metrics" aria-label="Admin metrics">
        {adminMetrics.map((metric) => (
          <article key={metric.id}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <small>{metric.detail}</small>
          </article>
        ))}
      </section>

      <section className="admin-grid">
        <div className="admin-panel reports-panel">
          <div className="admin-panel-title">
            <h2>Moderation Queue</h2>
            <span>{moderationReports.length} reports</span>
          </div>
          <div className="report-list">
            {moderationReports.map((report) => (
              <button
                type="button"
                key={report.id}
                className={selectedReport.id === report.id ? "is-active" : ""}
                onClick={() => setSelectedReport(report)}
              >
                <span className={`priority-pill ${statusClass(report.priority)}`}>{report.priority}</span>
                <strong>{report.reason}</strong>
                <small>
                  {report.room} · {report.audience} · {report.createdAt}
                </small>
              </button>
            ))}
          </div>
        </div>

        <div className="admin-panel report-detail-panel">
          <div className="admin-panel-title">
            <h2>{selectedReport.id}</h2>
            <span>{selectedReport.ageBand}</span>
          </div>
          <p>{selectedReport.detail}</p>
          <dl className="admin-detail-list">
            <div>
              <dt>Room</dt>
              <dd>{selectedReport.room}</dd>
            </div>
            <div>
              <dt>Audience</dt>
              <dd>{selectedReport.audience}</dd>
            </div>
            <div>
              <dt>Priority</dt>
              <dd>{selectedReport.priority}</dd>
            </div>
          </dl>
          <div className="admin-action-row">
            <button type="button" className="primary-action" onClick={() => logAction(`${selectedReport.id}: room locked`)}>
              Lock Room
            </button>
            <button type="button" onClick={() => logAction(`${selectedReport.id}: media blocked`)}>
              Block Media
            </button>
            <button type="button" onClick={() => logAction(`${selectedReport.id}: escalated`)}>
              Escalate
            </button>
          </div>
        </div>

        <div className="admin-panel">
          <div className="admin-panel-title">
            <h2>Safe Library</h2>
            <span>Approval</span>
          </div>
          <div className="admin-table-list">
            {mediaReviewItems.map((item) => (
              <article key={item.id}>
                <div>
                  <strong>{item.title}</strong>
                  <small>
                    {item.type} · {item.source}
                  </small>
                </div>
                <span className={`status-pill ${statusClass(item.status)}`}>{item.status}</span>
                <button type="button" onClick={() => logAction(`${item.id}: approved for ${item.ageFloor}`)}>
                  Approve
                </button>
              </article>
            ))}
          </div>
        </div>

        <div className="admin-panel pack-review-panel">
          <div className="admin-panel-title">
            <h2>Brush &amp; Pack Review</h2>
            <span>{packReviews.length} pending</span>
          </div>
          <div className="admin-table-list">
            {packReviews.length === 0 ? (
              <p className="admin-note">No community packs waiting for review.</p>
            ) : (
              packReviews.map((entry) => (
                <article key={entry.id} className="pack-review-row">
                  <div className="pack-review-info">
                    <span
                      className="pack-review-preview"
                      style={{ background: entry.pack?.accent || "#6366f1" }}
                      aria-hidden="true"
                    >
                      {(entry.pack?.title || "?").slice(0, 1)}
                    </span>
                    <div>
                      <strong>{entry.pack?.title || entry.target_id}</strong>
                      <small>
                        {entry.target_kind} · by {entry.pack?.authorSpace || entry.submitted_by} ·{" "}
                        {(entry.pack?.items || []).length} asset(s)
                      </small>
                      <small className="pack-review-tags">
                        {(entry.pack?.tags || []).join(", ") || "no tags"} · submitted{" "}
                        {new Date(entry.submitted_at).toLocaleDateString()}
                      </small>
                    </div>
                  </div>
                  <div className="admin-action-row pack-review-actions">
                    <button
                      type="button"
                      className="primary-action"
                      onClick={() => handlePackReview(entry, "approved")}
                    >
                      Approve
                    </button>
                    <button type="button" onClick={() => handlePackReview(entry, "needs_changes")}>
                      Request changes
                    </button>
                    <button type="button" onClick={() => handlePackReview(entry, "rejected")}>
                      Reject
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
          <p className="admin-note">
            Approving a public pack sets its visibility public + status approved, so it appears in the
            community browse. Every decision writes an immutable moderation action.
          </p>
        </div>

        <div className="admin-panel ai-review-panel">
          <div className="admin-panel-title">
            <h2>AI Generation Review</h2>
            <span>{aiReviews.length} pending</span>
          </div>
          <div className="admin-table-list">
            {aiReviews.length === 0 ? (
              <p className="admin-note">No AI generations waiting for review.</p>
            ) : (
              aiReviews.map((generation) => (
                <article key={generation.id} className="ai-review-row">
                  <div>
                    <strong>{generation.kind}</strong>
                    <small>
                      {generation.model ? generation.model : "local/deterministic"} · consent{" "}
                      {generation.consent_version}
                    </small>
                    {generation.kind === "palette" ? (
                      <span className="ai-review-swatches">
                        {(generation.output?.colors || []).map((color, index) => (
                          <span
                            key={`${generation.id}-${index}`}
                            className="ai-review-swatch"
                            style={{ background: color }}
                          />
                        ))}
                      </span>
                    ) : (
                      <small className="ai-review-output">{summarizeAiOutput(generation)}</small>
                    )}
                  </div>
                  <div className="admin-action-row">
                    <button
                      type="button"
                      className="primary-action"
                      onClick={() => handleAiReview(generation, "approved")}
                    >
                      Approve
                    </button>
                    <button type="button" onClick={() => handleAiReview(generation, "blocked")}>
                      Block
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
          <p className="admin-note">
            Generated assets stay private to their creator while pending. Approve to allow sharing/saving;
            blocked items are retained for audit but can&apos;t be reused. Clients can&apos;t self-approve.
          </p>
        </div>

        <div className="admin-panel">
          <div className="admin-panel-title">
            <h2>Room Review</h2>
            <div className="filter-row">
              {filters.map((filter) => (
                <button
                  type="button"
                  key={filter}
                  className={activeFilter === filter ? "is-active" : ""}
                  onClick={() => setActiveFilter(filter)}
                >
                  {filter}
                </button>
              ))}
            </div>
          </div>
          <div className="admin-table-list">
            {filteredRooms.map((room) => (
              <article key={room.id}>
                <div>
                  <strong>{room.code}</strong>
                  <small>
                    {room.host} · {room.participants} people · {room.media}
                  </small>
                </div>
                <span className={`audience-pill ${statusClass(room.audience)}`}>{room.audience}</span>
                <button type="button" onClick={() => logAction(`${room.code}: reviewed`)}>
                  Review
                </button>
              </article>
            ))}
          </div>
        </div>

        <div className="admin-panel monitor-panel">
          <div className="admin-panel-title">
            <h2>Live Room Monitor</h2>
            <span>{observingRoom ? `Observing ${observingRoom}` : "No observer active"}</span>
          </div>
          <div className="monitor-layout">
            <div className="monitor-room-list">
              {liveMonitorRooms.map((room) => (
                <button
                  type="button"
                  key={room.id}
                  className={selectedMonitorRoom.id === room.id ? "is-active" : ""}
                  onClick={() => setSelectedMonitorRoom(room)}
                >
                  <strong>{room.code}</strong>
                  <small>
                    {room.audience} · {room.participants} people
                  </small>
                  <span className={`priority-pill ${statusClass(room.risk)}`}>{room.risk}</span>
                </button>
              ))}
            </div>
            <div className="monitor-detail">
              <dl className="admin-detail-list">
                <div>
                  <dt>Activity</dt>
                  <dd>{selectedMonitorRoom.activity}</dd>
                </div>
                <div>
                  <dt>Host</dt>
                  <dd>{selectedMonitorRoom.host}</dd>
                </div>
                <div>
                  <dt>Last Event</dt>
                  <dd>{selectedMonitorRoom.lastEvent}</dd>
                </div>
              </dl>
              <div className="admin-action-row">
                {observingRoom === selectedMonitorRoom.code ? (
                  <button type="button" className="primary-action" onClick={endObservation}>
                    End Observe
                  </button>
                ) : (
                  <button type="button" className="primary-action" onClick={startObservation}>
                    Observe Unseen
                  </button>
                )}
                <button type="button" onClick={() => logAction(`${selectedMonitorRoom.code}: timeline exported`)}>
                  Export Log
                </button>
                <button type="button" onClick={() => logAction(`${selectedMonitorRoom.code}: room lock requested`)}>
                  Lock Room
                </button>
              </div>
              <ul className="room-event-list">
                {selectedRoomEvents.map((event) => (
                  <li key={event.id}>
                    <span>{event.createdAt}</span>
                    <strong>{event.type}</strong>
                    <p>{event.detail}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="admin-note">
            Observe mode is not shown in participant presence, but every start, stop, export, and intervention must be written to
            the staff audit log.
          </p>
        </div>

        <div className="admin-panel discovery-admin-panel">
          <div className="admin-panel-title">
            <h2>Discovery Ops</h2>
            <span>Search, events, gallery, and role gates</span>
          </div>
          <div className="security-grid">
            <section>
              <h3>Listed Rooms</h3>
              <div className="admin-table-list">
                {discoveryReviewItems.map((item) => (
                  <article key={item.id}>
                    <div>
                      <strong>{item.room}</strong>
                      <small>
                        {item.audience} · {item.visibility} · {item.tags}
                      </small>
                    </div>
                    <span className={`status-pill ${statusClass(item.visibility)}`}>{item.visibility}</span>
                    <button type="button" onClick={() => logAction(`${item.id}: discovery listing reviewed`)}>
                      Review
                    </button>
                  </article>
                ))}
              </div>
            </section>

            <section>
              <h3>Timed Events</h3>
              <div className="admin-table-list">
                {eventAdminItems.map((item) => (
                  <article key={item.id}>
                    <div>
                      <strong>{item.title}</strong>
                      <small>
                        {item.window} · {item.rooms} rooms · {item.safety}
                      </small>
                    </div>
                    <span className={`status-pill ${statusClass(item.status)}`}>{item.status}</span>
                    <button type="button" onClick={() => logAction(`${item.id}: event schedule opened`)}>
                      Open
                    </button>
                  </article>
                ))}
              </div>
            </section>

            <section>
              <h3>Gallery Votes</h3>
              <div className="admin-table-list">
                {galleryVoteItems.map((item) => (
                  <article key={item.id}>
                    <div>
                      <strong>{item.title}</strong>
                      <small>
                        {item.event} · {item.votes} votes · {item.signal}
                      </small>
                    </div>
                    <span className={`status-pill ${statusClass(item.status)}`}>{item.status}</span>
                    <button type="button" onClick={() => logAction(`${item.id}: vote audit opened`)}>
                      Audit
                    </button>
                  </article>
                ))}
              </div>
            </section>
          </div>
          <p className="admin-note">
            Discovery should index rooms, topics, tags, approved preview snapshots, and gallery posts only. It must not expose
            public people search, live child presence, invite codes for joining, unreviewed uploads, or 18+ rooms.
          </p>
        </div>

        <div className="admin-panel">
          <div className="admin-panel-title">
            <h2>Verification</h2>
            <span>Access gates</span>
          </div>
          <div className="admin-table-list">
            {verificationItems.map((item) => (
              <article key={item.id}>
                <div>
                  <strong>{item.kind}</strong>
                  <small>
                    {item.profile} · {item.status}
                  </small>
                </div>
                <button type="button" onClick={() => logAction(`${item.id}: verification reviewed`)}>
                  Open
                </button>
              </article>
            ))}
          </div>
        </div>

        <div className="admin-panel security-panel">
          <div className="admin-panel-title">
            <h2>Ban & Shield</h2>
            <span>Accounts, networks, and DDoS signals</span>
          </div>
          <div className="security-grid">
            <section>
              <h3>Profile Bans</h3>
              <div className="admin-table-list">
                {banReviewItems.map((item) => (
                  <article key={item.id}>
                    <div>
                      <strong>{item.profile}</strong>
                      <small>
                        {item.scope} · {item.reason} · {item.expires}
                      </small>
                    </div>
                    <span className={`status-pill ${statusClass(item.status)}`}>{item.status}</span>
                    <button type="button" onClick={() => logAction(`${item.id}: profile ban updated`)}>
                      Open
                    </button>
                  </article>
                ))}
              </div>
            </section>

            <section>
              <h3>Network Blocks</h3>
              <div className="admin-table-list">
                {networkBlockItems.map((item) => (
                  <article key={item.id}>
                    <div>
                      <strong>{item.network}</strong>
                      <small>
                        {item.provider} · {item.reason} · {item.expires}
                      </small>
                    </div>
                    <span className={`status-pill ${statusClass(item.action)}`}>{item.action}</span>
                    <button type="button" onClick={() => logAction(`${item.id}: ${item.action.toLowerCase()} rule queued`)}>
                      Apply
                    </button>
                  </article>
                ))}
              </div>
            </section>

            <section>
              <h3>DDoS Signals</h3>
              <div className="admin-table-list">
                {ddosSignals.map((item) => (
                  <article key={item.id}>
                    <div>
                      <strong>{item.route}</strong>
                      <small>
                        {item.volume} · {item.signal}
                      </small>
                    </div>
                    <span className="status-pill status-pending">{item.action}</span>
                    <button type="button" onClick={() => logAction(`${item.id}: mitigation reviewed`)}>
                      Review
                    </button>
                  </article>
                ))}
              </div>
            </section>
          </div>
          <p className="admin-note">
            Use profile bans for behavior, network blocks for abusive sources, and WAF/CDN rate limits for DDoS. IP blocks can hit
            schools, homes, VPNs, and mobile carriers, so prefer short expirations and challenge/rate-limit actions before deny.
          </p>
        </div>

        <div className="admin-panel">
          <div className="admin-panel-title">
            <h2>Audit Log</h2>
            <span>Local demo</span>
          </div>
          <ul className="audit-list">
            {adminLog.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}
