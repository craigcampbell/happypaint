// Host control panel — the per-room "controller" for a signed-in grown-up who
// owns (or co-hosts) a room. Every action is also enforced server-side; this is
// just the UI. Hidden entirely for anonymous / non-host users.

import { useState } from "react";

export default function HostControlPanel({
  roomId,
  roomTitle,
  locked,
  isOwner,
  users = [],
  selfId,
  onLock,
  onUnlock,
  onRenameRoom,
  onClear,
  onMute,
  onKick,
  onPromote,
  onDemote,
  onClose,
}) {
  const [titleDraft, setTitleDraft] = useState(roomTitle || "");

  const others = users.filter((u) => u.id !== selfId);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="studio-modal host-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="host-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title-row">
          <h2 id="host-title">⭐ Host controls</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="account-note">
          You {isOwner ? "own" : "co-host"} room <strong>{roomTitle || roomId}</strong>. These controls
          affect everyone painting here.
        </p>

        <div className="ps-group host-section">
          <h3>Room</h3>
          <div className="host-row">
            <button
              type="button"
              className={locked ? "primary-action" : ""}
              onClick={locked ? onUnlock : onLock}
            >
              {locked ? "🔓 Unlock canvas" : "🔒 Lock canvas"}
            </button>
            <button type="button" className="host-danger" onClick={onClear}>
              🧹 Clear everyone&apos;s canvas
            </button>
          </div>
          <p className="account-note">{locked ? "Locked — only hosts can draw." : "Anyone here can draw."}</p>

          <label className="color-picker">
            <span>Room name</span>
            <input
              type="text"
              value={titleDraft}
              maxLength={40}
              placeholder={roomId}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onRenameRoom(titleDraft)}
            />
          </label>
          <button type="button" onClick={() => onRenameRoom(titleDraft)}>
            Save name
          </button>
        </div>

        <div className="ps-group host-section">
          <h3>Painters ({others.length})</h3>
          {others.length === 0 ? (
            <p className="account-note">Nobody else is here yet.</p>
          ) : (
            <ul className="host-painter-list">
              {others.map((u) => (
                <li key={u.id} className="host-painter">
                  <span className="host-painter-name">
                    <span className="host-dot" style={{ background: u.color }} />
                    {u.name}
                    {u.isOwner ? <em className="host-tag">owner</em> : u.isHost ? <em className="host-tag">co-host</em> : null}
                    {u.muted ? <em className="host-tag muted">muted</em> : null}
                  </span>
                  <span className="host-painter-actions">
                    {!u.isHost ? (
                      <>
                        <button type="button" onClick={() => onMute(u.id, !u.muted)}>
                          {u.muted ? "Unmute" : "Mute"}
                        </button>
                        <button type="button" className="host-danger" onClick={() => onKick(u.id)}>
                          Remove
                        </button>
                      </>
                    ) : null}
                    {isOwner && u.signedIn && !u.isOwner ? (
                      u.isHost ? (
                        <button type="button" onClick={() => onDemote(u.id)}>
                          Demote
                        </button>
                      ) : (
                        <button type="button" onClick={() => onPromote(u.id)}>
                          Make co-host
                        </button>
                      )
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="account-note">
            Co-hosts can lock, clear, rename, mute and remove painters. Only you (the owner) can promote a
            co-host. Promotion only works for signed-in painters.
          </p>
        </div>
      </section>
    </div>
  );
}
