import { useCallback, useEffect, useRef, useState } from "react";
import "./AdminColoringModeration.css";

const ROOT = "/api/admin/ai-coloring";
const LIMIT = 20;
const STATES = { pending: "Needs review", reviewed: "Reviewed", removed: "Removed" };
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function PagePreview({ item, request, onComplete }) {
  const [image, setImage] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState("");
  const actionRef = useRef(null);
  const path = ROOT + "/" + encodeURIComponent(item.id);

  useEffect(() => {
    const controller = new AbortController();
    let url;
    async function load() {
      try {
        const response = await request(path + "/image", controller.signal);
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        if (blob.type !== "image/png") throw new Error("The preview format could not be read.");
        url = URL.createObjectURL(blob);
        setImage(url);
      } catch (error) {
        if (!controller.signal.aborted) setPreviewError(error.message);
      }
    }
    load();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [attempt, path, request]);

  useEffect(() => () => actionRef.current?.abort(), []);

  const act = async (action) => {
    if (actionRef.current) return;
    const controller = new AbortController();
    actionRef.current = controller;
    setWorking(true);
    setActionError("");
    try {
      await request(path + "/" + action, controller.signal, "POST");
      if (!controller.signal.aborted) onComplete(action, item.room);
    } catch (error) {
      if (!controller.signal.aborted) setActionError(error.message);
    } finally {
      if (!controller.signal.aborted) setWorking(false);
      actionRef.current = null;
    }
  };

  return (
    <div className="coloring-detail">
      {previewError ? (
        <div className="coloring-message">
          <span role="alert">{previewError}</span>
          <button type="button" onClick={() => { setPreviewError(""); setImage(""); setAttempt(attempt + 1); }}>Retry preview</button>
        </div>
      ) : image ? (
        <img className="coloring-image" src={image} alt={`Generated coloring page for room ${item.room}`}
          onError={() => setPreviewError("This preview could not be displayed.")} />
      ) : <p role="status">Loading preview…</p>}

      {confirmRemove ? (
        <div className="coloring-confirm">
          <strong>Remove this page from {item.room}?</strong>
          <p>This permanently deletes the generated outline and clears it from the room if it’s in use. The painters’ brushstrokes stay on the canvas.</p>
          <div className="coloring-actions">
            <button type="button" disabled={working} onClick={() => { setActionError(""); setConfirmRemove(false); }}>Keep page</button>
            <button className="admin-danger" type="button" disabled={working} onClick={() => act("remove")}>{working ? "Removing…" : "Confirm removal"}</button>
          </div>
        </div>
      ) : (
        <div className="coloring-actions">
          {item.status === "pending" && <button type="button" disabled={!image || !!previewError || working} onClick={() => act("review")}>{working ? "Saving…" : "Mark reviewed"}</button>}
          <button type="button" className="coloring-remove" disabled={working} onClick={() => setConfirmRemove(true)}>Remove page…</button>
        </div>
      )}
      {actionError && <p role="alert" className="admin-error">{actionError}</p>}
    </div>
  );
}

export default function AdminColoringModeration({ adminKey, onUnauthorized }) {
  const [query, setQuery] = useState({ status: "pending", room: "", offset: 0 });
  const [roomDraft, setRoomDraft] = useState("");
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const request = useCallback(async (path, signal, method = "GET") => {
    const response = await fetch(path, { method, signal, headers: { "x-admin-key": adminKey }, cache: "no-store", redirect: "error" });
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (response.status === 401 || response.status === 403) {
      onUnauthorized();
      throw new Error("Your admin session has expired.");
    }
    if (response.status === 404 || response.status === 409) throw new Error("This page is no longer available in its previous state. Refresh the queue.");
    if (!response.ok) throw new Error("The moderation request failed. Please try again.");
    return response;
  }, [adminKey, onUnauthorized]);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const params = new URLSearchParams({ ...query, limit: LIMIT });
        const response = await request(ROOT + "?" + params, controller.signal);
        const result = await response.json();
        if (controller.signal.aborted) return;
        const lastOffset = Math.max(0, Math.floor((result.total - 1) / LIMIT)) * LIMIT;
        if (query.offset > lastOffset) {
          setQuery({ ...query, offset: lastOffset });
        } else {
          setData(result);
        }
      } catch (err) {
        if (!controller.signal.aborted) setError(err.message);
      }
    }
    load();
    return () => controller.abort();
  }, [query, request]);

  const reload = (next = {}, message = "") => {
    setSelected("");
    setError("");
    setNotice(message);
    setData(null);
    setQuery({ ...query, ...next });
  };
  const complete = (action, room) => reload({}, action === "review" ? `Page marked reviewed in ${room}.` : `Page removed from ${room}.`);
  const counts = data?.counts;
  return (
    <section className="admin-section admin-coloring" aria-labelledby="coloring-title">
      <div className="coloring-head">
        <div>
          <h2 id="coloring-title">AI coloring pages</h2>
          <p>These outlines passed the automatic checks. Review private previews and pages already shared on a room’s canvas.</p>
        </div>
        <button type="button" onClick={() => reload()}>Refresh queue</button>
      </div>
      <dl className="coloring-counts" aria-label={query.room ? `Page counts for ${query.room}` : "Page counts for all rooms"}>
        {Object.entries(STATES).map(([status, label]) => (
          <div key={status}><dt>{label}</dt><dd>{counts ? counts[status].toLocaleString() : "—"}</dd></div>
        ))}
      </dl>
      <form className="coloring-filters" onSubmit={(event) => {
        event.preventDefault();
        const room = roomDraft.trim().toUpperCase();
        setRoomDraft(room);
        reload({ room, offset: 0 });
      }}>
        <label>Page status
          <select value={query.status} onChange={(event) => reload({ status: event.target.value, offset: 0 })}>
            {Object.entries(STATES).map(([status, label]) => <option key={status} value={status}>{label}</option>)}
            <option value="all">All pages</option>
          </select>
        </label>
        <label>Room code
          <input value={roomDraft} onChange={(event) => setRoomDraft(event.target.value)} placeholder="All rooms"
            maxLength={16} pattern={"[a-zA-Z0-9_\\-]*"} title="Use letters, numbers, underscores, or hyphens."
            autoCapitalize="characters" spellCheck={false} />
        </label>
        <button type="submit">Filter room</button>
        {query.room && <button type="button" onClick={() => { setRoomDraft(""); reload({ room: "", offset: 0 }); }}>Clear room</button>}
      </form>

      {notice && <p className="coloring-notice" role="status">{notice}</p>}
      {error ? <p className="admin-error" role="alert">{error}</p>
        : !data ? <p className="admin-empty" role="status">Loading pages…</p>
        : data.items.length === 0 ? <p className="admin-empty" role="status">
          {query.status === "pending" ? "No pages need review" : query.status === "all" ? "No generated pages" : `No ${query.status} pages`}{query.room ? ` in room ${query.room}` : ""}.
        </p> : (
          <>
            <ul className="coloring-list">
              {data.items.map(item => (
                <li key={item.id}>
                  <div className="coloring-row">
                    <div>
                      <strong>Room {item.room}</strong>
                      <small><time dateTime={new Date(item.createdAt).toISOString()}>{dateFormat.format(item.createdAt)}</time> · {STATES[item.status]}</small>
                    </div>
                    {item.status !== "removed" && <button type="button" aria-expanded={selected === item.id}
                      onClick={() => setSelected(selected === item.id ? "" : item.id)}>{selected === item.id ? "Close preview" : "Preview"}</button>}
                  </div>
                  {selected === item.id && item.status !== "removed" && <PagePreview item={item} request={request} onComplete={complete} />}
                </li>
              ))}
            </ul>
            <div className="coloring-pagination" aria-label="Page results">
              <span>{query.offset + 1}–{Math.min(query.offset + LIMIT, data.total)} of {data.total}</span>
              {data.total > LIMIT && <>
                <button type="button" disabled={query.offset === 0} onClick={() => reload({ offset: query.offset - LIMIT })}>Previous</button>
                <button type="button" disabled={query.offset + LIMIT >= data.total} onClick={() => reload({ offset: query.offset + LIMIT })}>Next</button>
              </>}
            </div>
          </>
        )}
      {counts && <aside className="coloring-blocks">
        <h3>Automatic blocks this month</h3>
        <p>{counts.blockedPrompt.toLocaleString()} {counts.blockedPrompt === 1 ? "prompt" : "prompts"} blocked · {counts.blockedImage.toLocaleString()} {counts.blockedImage === 1 ? "image" : "images"} blocked{query.room ? ` in room ${query.room}` : ""}</p>
      </aside>}
    </section>
  );
}
