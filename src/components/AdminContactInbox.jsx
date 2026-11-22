import { useCallback, useEffect, useRef, useState } from "react";
import "./AdminContactInbox.css";

const INBOX = "/api/admin/contact";
const PAGE_SIZE = 20;
const TOPICS = {
  general: "General question",
  bug: "Bug report",
  billing: "Billing",
  safety: "Safety",
  privacy: "Privacy",
};
const receivedAt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export default function AdminContactInbox({ adminKey, openCount, onUnauthorized }) {
  const [messages, setMessages] = useState(null);
  const [filter, setFilter] = useState("open");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [revision, setRevision] = useState(0);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mutation = useRef(null);
  const activeFilter = useRef(null);

  const request = useCallback(async (path, options) => {
    const response = await fetch(path, {
      cache: "no-store",
      redirect: "error",
      ...options,
      headers: { "x-admin-key": adminKey, ...(options.body && { "Content-Type": "application/json" }) },
    });
    if (options.signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (response.status === 401 || response.status === 403) onUnauthorized();
    return response;
  }, [adminKey, onUnauthorized]);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await request(INBOX, { signal: controller.signal });
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (!Array.isArray(data.messages)) throw new Error();
        if (!controller.signal.aborted) {
          setMessages(data.messages);
          setError("");
        }
      } catch {
        if (!controller.signal.aborted) setError("Couldn’t load the inbox. Refresh to try again.");
      }
    }
    load();
    return () => controller.abort();
  }, [request, revision, openCount]);

  useEffect(() => () => mutation.current?.abort(), []);

  async function update(item, remove = false) {
    if (mutation.current) return;
    if (remove && !window.confirm("Permanently delete this message and its reply address from the contact inbox?")) return;
    const controller = new AbortController();
    mutation.current = controller;
    setWorking(item.id);
    setError("");
    setNotice("");
    const status = item.status === "open" ? "resolved" : "open";
    try {
      const options = remove ? { method: "DELETE" } : { method: "PATCH", body: JSON.stringify({ status }) };
      const response = await request(`${INBOX}/${encodeURIComponent(item.id)}`, { ...options, signal: controller.signal });
      if (response.status === 404) {
        setNotice("That message is no longer in the inbox.");
        setMessages((list) => list.filter((entry) => entry.id !== item.id));
      } else {
        if (!response.ok) throw new Error();
        setMessages((list) => remove
          ? list.filter((entry) => entry.id !== item.id)
          : list.map((entry) => entry.id === item.id ? { ...entry, status } : entry));
        setNotice(remove ? "Message deleted." : status === "resolved" ? "Message resolved." : "Message reopened.");
      }
      setRevision((value) => value + 1);
      activeFilter.current?.focus({ preventScroll: true });
    } catch {
      if (!controller.signal.aborted) setError("Couldn’t update that message. Refresh the inbox and try again.");
    } finally {
      mutation.current = null;
      if (!controller.signal.aborted) setWorking("");
    }
  }

  const filtered = messages?.filter((item) => item.status === filter);
  const openTotal = messages?.filter((item) => item.status === "open").length;
  return (
    <section className="admin-section admin-contact-inbox" aria-labelledby="contact-inbox-title">
      <header className="contact-inbox-head">
        <h2 id="contact-inbox-title">Contact inbox</h2>
        <button type="button" disabled={!!working} onClick={() => { setNotice(""); setRevision((value) => value + 1); }}>Refresh inbox</button>
      </header>
      <div className="contact-inbox-filters" role="group" aria-label="Message status">
        {["open", "resolved"].map((value) => (
          <button key={value} type="button" ref={value === filter ? activeFilter : null} aria-pressed={value === filter}
            onClick={() => { setFilter(value); setLimit(PAGE_SIZE); setNotice(""); }}>
            {value === "open" ? "Open" : "Resolved"}{messages && <span>{value === "open" ? openTotal : messages.length - openTotal}</span>}
          </button>
        ))}
      </div>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {notice && <p className="contact-inbox-notice" role="status">{notice}</p>}
      {!messages && !error && <p className="admin-empty" role="status">Loading messages…</p>}
      {filtered?.length === 0 && <p className="admin-empty">No {filter} messages.</p>}
      {!!filtered?.length && (
        <ul className="contact-inbox-list">
          {filtered.slice(0, limit).map((item) => (
            <li key={item.id}>
              <article aria-labelledby={`contact-topic-${item.id}`}>
                <header>
                  <h3 id={`contact-topic-${item.id}`}>{TOPICS[item.topic] || "Message"}</h3>
                  <time dateTime={new Date(item.createdAt).toISOString()}>{receivedAt.format(new Date(item.createdAt))}</time>
                </header>
                <p className="contact-inbox-body">{item.message}</p>
                {item.email && <p className="contact-inbox-email">Reply to <a href={`mailto:${encodeURIComponent(item.email).replace("%40", "@")}`}>{item.email}</a></p>}
                <div className="contact-inbox-actions">
                  <button type="button" disabled={!!working} onClick={() => update(item)}>{item.status === "open" ? "Resolve" : "Reopen"}</button>
                  <button type="button" className="contact-inbox-delete" disabled={!!working} onClick={() => update(item, true)}>Delete…</button>
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}
      {filtered?.length > limit && <button className="contact-inbox-more" type="button" onClick={() => setLimit(limit + PAGE_SIZE)}>Show more messages</button>}
    </section>
  );
}
