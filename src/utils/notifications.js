// On-device inbox of cross-room @mention alerts, shown in the profile menu. Kept
// in localStorage so it survives room switches (which fully reload the studio).
// Cleared by the account-deletion localStorage sweep.

const KEY = "happypaint:notifications:v1";
const MAX = 40;

export function getNotifications() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function save(list) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // best-effort — a dropped notification is non-fatal
  }
}

// Add a mention (from a server 'mention' event). Deduped by room+ts+from so a
// reconnect replaying the same ping can't double-count. Returns the new list.
export function addNotification(n) {
  const list = getNotifications();
  const id = `${n.room}|${n.ts}|${n.from}`;
  if (list.some((x) => x.id === id)) return list;
  const entry = {
    id,
    room: n.room,
    roomTitle: n.roomTitle || null,
    from: n.from || "someone",
    text: String(n.text || "").slice(0, 200),
    ts: n.ts || 0,
    read: false,
  };
  const next = [entry, ...list].slice(0, MAX);
  save(next);
  return next;
}

export function markAllRead() {
  const next = getNotifications().map((n) => ({ ...n, read: true }));
  save(next);
  return next;
}

export function clearNotifications() {
  save([]);
  return [];
}

export function unreadCount(list) {
  return (list || getNotifications()).filter((n) => !n.read).length;
}
