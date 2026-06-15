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
