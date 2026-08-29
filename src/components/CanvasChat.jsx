import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import PageImage from "./PageImage";
import DoodlePad from "./DoodlePad";

// Canvas Chat — Twitch × iMessage, ON the canvas.
//
// Two modes:
//  • AMBIENT (closed): the last few messages float as self-scrimmed bubbles
//    over the art (readable on any background) and fade away Twitch-style.
//    The layer is pointer-events:none — drawing passes straight through it.
//  • OPEN: a glassy panel with scrollback, iMessage message clustering,
//    tap-a-bubble tapbacks, reply threading (quoted context), a composer, and
//    the hype tray (big animated reactions over the canvas).
//
// Perf rules (drawing performance is paramount): no backdrop-filter anywhere,
// all animations are transform/opacity, hard DOM caps, and the ambient
// expiry ticker only runs while something is visible.
//
// The parent owns networking: onSend(text, replyToId), onReact(msgId, emoji),
// onHype(kind), onNameTap(userId). `messages` is useMultiplayer's chat list
// ({ msgId, user, message, ts, system?, replyTo?, reactions?, myReacts?,
// arrivedAt? }). `panelExtras` hosts the vote card / participants / room row.

import { HYPES } from "../utils/hypes";

const TAPBACKS = ["❤️", "😂", "🔥", "👍", "😮", "🎨"]; // mirrors server CHAT_TAPBACKS

const AMBIENT_MS = 12_000; // how long a bubble lingers over the art
const AMBIENT_MAX = 6;

// Cluster consecutive messages from the same author within 3 minutes so the
// log reads like iMessage: name shown once, bubbles tightly grouped.
function clusterOf(list, i) {
  const m = list[i];
  const prev = list[i - 1];
  const next = list[i + 1];
  const same = (a, b) => a && b && !a.system && !b.system && a.user?.id === b.user?.id && Math.abs((a.ts || 0) - (b.ts || 0)) < 180_000;
  const withPrev = same(prev, m);
  const withNext = same(m, next);
  if (!withPrev && !withNext) return "solo";
  if (!withPrev) return "first";
  if (!withNext) return "last";
  return "mid";
}

const Bubble = memo(function Bubble({ m, mine, cluster, onReact, onNameTap, onReply, onQuoteTap, pickerOpen, onTogglePicker }) {
  const sys = !!m.system;
  return (
    <div className={`cc-row ${mine ? "is-mine" : ""} ${sys ? "is-system" : ""} cc-${cluster}`}>
      {!mine && !sys && (cluster === "solo" || cluster === "first") ? (
        <button type="button" className="cc-name" style={{ color: m.user?.color || "#9aa6b2" }} onClick={() => onNameTap?.(m.user?.id)}>
          {m.user?.name || "?"}
        </button>
      ) : null}
      <div className="cc-bubble-wrap">
        <button
          type="button"
          className="cc-bubble"
          style={sys ? { borderColor: m.user?.color || "#7c3aed" } : undefined}
          onClick={(e) => {
            // Stop here: the log's own click handler closes the picker, and
            // without this the same tap would open-then-instantly-close it.
            e.stopPropagation();
            onTogglePicker?.(m.msgId);
          }}
          title={sys ? undefined : "React or reply"}
        >
          {m.replyTo ? (
            <span className="cc-quote" onClick={(e) => { e.stopPropagation(); onQuoteTap?.(m.replyTo.id); }}>
              <span className="cc-quote-name">{m.replyTo.name}</span>
              <span className="cc-quote-text">{m.replyTo.snippet}</span>
            </span>
          ) : null}
          {m.doodle ? <PageImage id={m.doodle} alt="a doodle" className="cc-doodle" placeholder="🎨 doodle faded" /> : null}
          {m.message ? <span className="cc-text">{m.message}</span> : null}
        </button>
        {m.reactions && Object.keys(m.reactions).length ? (
          <span className="cc-tapbacks">
            {Object.entries(m.reactions).map(([e, n]) => (
              <button
                key={e}
                type="button"
                className={`cc-tapback ${m.myReacts && m.myReacts[e] ? "is-mine" : ""}`}
                onClick={() => onReact?.(m.msgId, e)}
              >
                {e}{n > 1 ? <i>{n}</i> : null}
              </button>
            ))}
          </span>
        ) : null}
        {pickerOpen ? (
          <span className="cc-picker" role="menu">
            {TAPBACKS.map((e) => (
              <button key={e} type="button" onClick={() => { onReact?.(m.msgId, e); onTogglePicker?.(null); }}>
                {e}
              </button>
            ))}
            {!sys ? (
              <button type="button" className="cc-picker-reply" onClick={() => { onReply?.(m); onTogglePicker?.(null); }}>
                ↩ Reply
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
});

export default function CanvasChat({
  open,
  onOpenChange,
  messages,
  self,
  disabled,
  disabledReason,
  onSend,
  onReact,
  onHype,
  onNameTap,
  panelExtras,
}) {
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState(null); // { msgId, name, message }
  const [pickerFor, setPickerFor] = useState(null); // msgId with the tapback bar open
  const [hypeOpen, setHypeOpen] = useState(false);
  const [padOpen, setPadOpen] = useState(false); // the doodle-reply pad
  const [fadeTick, setFadeTick] = useState(0); // drives ambient expiry recompute
  const [unread, setUnread] = useState(0);
  const logRef = useRef(null);
  const inputRef = useRef(null);
  const openRef = useRef(false);
  openRef.current = open;
  const lastSeenRef = useRef(0); // highest msgId seen while open

  const myId = self?.id;

  // ---- Ambient stream: recent arrivals only, fading out -------------------
  // fadeTick is a real dependency: each 1s tick recomputes the filter so
  // expired bubbles actually UNMOUNT (and the interval below then stops).
  const ambient = useMemo(() => {
    const now = Date.now();
    return messages
      .filter((m) => m.arrivedAt && now - m.arrivedAt < AMBIENT_MS)
      .slice(-AMBIENT_MAX);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, fadeTick]);

  // Expire ambient bubbles on a slow tick — only while any are showing.
  useEffect(() => {
    if (open || ambient.length === 0) return undefined;
    const t = window.setInterval(() => setFadeTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [open, ambient.length]);

  // ---- Unread: count OTHER people's arrivals while closed -----------------
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last || !last.msgId) return;
    if (openRef.current) {
      lastSeenRef.current = Math.max(lastSeenRef.current, last.msgId);
      return;
    }
    const fresh = messages.filter(
      (m) => m.msgId && m.msgId > lastSeenRef.current && m.arrivedAt && m.user?.id !== myId,
    ).length;
    setUnread(fresh);
  }, [messages, myId]);

  const openChat = useCallback(() => {
    onOpenChange?.(true);
    setUnread(0);
    const last = messages[messages.length - 1];
    if (last && last.msgId) lastSeenRef.current = last.msgId;
  }, [messages, onOpenChange]);

  // Opened from outside (the mobile quickbar button): clear unread the same way.
  useEffect(() => {
    if (!open) return;
    setUnread(0);
    const last = messages[messages.length - 1];
    if (last && last.msgId) lastSeenRef.current = last.msgId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the log pinned to the newest message while open — but only when a NEW
  // message actually appended (a tapback count patch must not yank the scroll).
  const lastPinnedRef = useRef(0);
  useEffect(() => {
    if (!open || !logRef.current) return;
    const last = messages[messages.length - 1];
    const lastId = (last && last.msgId) || 0;
    if (lastId === lastPinnedRef.current && lastPinnedRef.current !== 0) return;
    lastPinnedRef.current = lastId;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [open, messages]);

  const submit = (e) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onSend?.(text, replyTo ? replyTo.msgId : null);
    setDraft("");
    setReplyTo(null);
  };

  // A doodle sends with whatever text is drafted (caption-style), consuming
  // any pending reply context the same way a plain message does.
  const sendDoodle = useCallback((dataUrl) => {
    onSend?.(draft.trim(), replyTo ? replyTo.msgId : null, dataUrl);
    setDraft("");
    setReplyTo(null);
    setPadOpen(false);
  }, [draft, onSend, replyTo]);

  const beginReply = useCallback((m) => {
    setReplyTo({ msgId: m.msgId, name: m.user?.name || "?", message: m.message });
    inputRef.current?.focus();
  }, []);

  const jumpToMessage = useCallback((msgId) => {
    const el = logRef.current?.querySelector(`[data-mid="${msgId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("cc-flash");
      window.setTimeout(() => el.classList.remove("cc-flash"), 1200);
    }
  }, []);

  // Render the FULL client buffer (80) so a reply-quote jump can always find
  // its target while the original is still held locally.
  const visible = messages.slice(-80);

  return (
    <>
      {/* Ambient overlay: Twitch-style recent messages over the art. Inert. */}
      {!open && ambient.length > 0 ? (
        <div className="cc-ambient" aria-hidden="true">
          {ambient.map((m) => (
            <div
              key={m.msgId || m.ts}
              className={`cc-ambient-line ${m.user?.id === myId ? "is-mine" : ""} ${m.system ? "is-system" : ""}`}
            >
              {!m.system ? (
                <span className="cc-ambient-name" style={{ color: m.user?.color || "#cbd5e1" }}>{m.user?.name}</span>
              ) : null}
              <span className="cc-ambient-text">
                {m.replyTo ? <span className="cc-ambient-reply">↩ {m.replyTo.name}</span> : null}
                {m.doodle ? <PageImage id={m.doodle} alt="a doodle" className="cc-doodle cc-doodle-sm" placeholder="🎨" /> : null}
                {m.message}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* The 💬 pill: opens the panel; pulses with unread count. */}
      {!open ? (
        <button type="button" className="cc-pill" onClick={openChat} aria-label="Open chat">
          💬{unread > 0 ? <span className="cc-pill-badge">{unread > 9 ? "9+" : unread}</span> : null}
        </button>
      ) : null}

      {/* Open panel: iMessage over the canvas. */}
      {open ? (
        <section className={`cc-panel${padOpen ? " has-pad" : ""}`} aria-label="Room chat">
          <header className="cc-head">
            <span className="cc-head-title">💬 Chat</span>
            <button type="button" className="cc-close" onClick={() => { onOpenChange?.(false); setPickerFor(null); setHypeOpen(false); }} aria-label="Close chat">
              ✕
            </button>
          </header>

          {panelExtras}

          <div className="cc-log" ref={logRef} onClick={() => setPickerFor(null)}>
            {visible.length === 0 ? (
              <p className="cc-empty">Say hi to your friends! 👋</p>
            ) : (
              visible.map((m, i) => (
                <div key={m.msgId || `${m.ts}_${i}`} data-mid={m.msgId}>
                  <Bubble
                    m={m}
                    mine={!m.system && m.user?.id === myId}
                    cluster={clusterOf(visible, i)}
                    onReact={onReact}
                    onNameTap={onNameTap}
                    onReply={beginReply}
                    onQuoteTap={jumpToMessage}
                    pickerOpen={pickerFor === m.msgId}
                    onTogglePicker={(id) => setPickerFor((cur) => (cur === id ? null : id))}
                  />
                </div>
              ))
            )}
          </div>

          {hypeOpen ? (
            <div className="cc-hype-tray">
              {HYPES.map((h) => (
                <button key={h.kind} type="button" title={h.label} onClick={() => { onHype?.(h.kind); setHypeOpen(false); }}>
                  {h.emoji}
                </button>
              ))}
            </div>
          ) : null}

          {padOpen ? <DoodlePad onSend={sendDoodle} onClose={() => setPadOpen(false)} /> : null}

          {replyTo ? (
            <div className="cc-replying">
              <span>↩ Replying to <strong>{replyTo.name}</strong> — “{String(replyTo.message).slice(0, 44)}{String(replyTo.message).length > 44 ? "…" : ""}”</span>
              <button type="button" onClick={() => setReplyTo(null)} aria-label="Cancel reply">✕</button>
            </div>
          ) : null}

          <form className="cc-form" onSubmit={submit}>
            <button
              type="button"
              className={`cc-hype-btn ${hypeOpen ? "is-open" : ""}`}
              onClick={() => { setHypeOpen((v) => !v); setPadOpen(false); }}
              title="Send a big reaction"
              aria-label="Big reactions"
            >
              🎉
            </button>
            <button
              type="button"
              className={`cc-hype-btn ${padOpen ? "is-open" : ""}`}
              onClick={() => { setPadOpen((v) => !v); setHypeOpen(false); }}
              disabled={disabled}
              title="Draw a doodle reply"
              aria-label="Doodle reply"
            >
              ✏️
            </button>
            <input
              ref={inputRef}
              type="text"
              value={draft}
              maxLength={300}
              disabled={disabled}
              placeholder={disabled ? (disabledReason || "You're muted by a host") : "Type a message…"}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button type="submit" className="cc-send" disabled={disabled || !draft.trim()} aria-label="Send">
              ↑
            </button>
          </form>
        </section>
      ) : null}
    </>
  );
}
