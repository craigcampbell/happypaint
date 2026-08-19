// The rooms you've recently painted in, kept on-device so you can hop back
// between them (e.g. your own piece and a friend's room) without hunting for a
// code. Most-recent first, capped. Purely local; account deletion clears it via
// the localStorage sweep in accountDeletion.js.
//
// Each entry can also carry the mention-watch capability for that room: the
// display name we held there and the `mentionKey` the server's join handshake
// issued for it. The notify socket presents that pair to subscribe to @mention
// pings — without it the server refuses the watch (anti-eavesdrop).

const KEY = "happypaint:recent-rooms:v1";
const MAX = 8;

export function getRecentRooms() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r.code === "string") : [];
  } catch {
    return [];
  }
}

// Record (or bump to the top) a room you're in. `title` is optional and updates
// the stored label when known (learned from the server handshake). `watch` is
// the optional { name, key } mention-watch capability from the same handshake.
export function recordRecentRoom(code, title, when, watch) {
  if (!code) return;
  try {
    const prev = getRecentRooms();
    const existing = prev.find((r) => r.code === code);
    const entry = {
      code,
      title: title || existing?.title || null,
      ts: typeof when === "number" ? when : (existing?.ts ?? 0),
      watchName: watch?.name || existing?.watchName || null,
      mentionKey: watch?.key || existing?.mentionKey || null,
    };
    const next = [entry, ...prev.filter((r) => r.code !== code)].slice(0, MAX);
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // best-effort — losing a recents entry is non-fatal
  }
}
