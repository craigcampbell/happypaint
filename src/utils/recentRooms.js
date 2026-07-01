// The rooms you've recently painted in, kept on-device so you can hop back
// between them (e.g. your own piece and a friend's room) without hunting for a
// code. Most-recent first, capped. Purely local; account deletion clears it via
// the localStorage sweep in accountDeletion.js.

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
// the stored label when known (learned from the server handshake).
export function recordRecentRoom(code, title, when) {
  if (!code) return;
  try {
    const prev = getRecentRooms();
    const existing = prev.find((r) => r.code === code);
    const entry = {
      code,
      title: title || existing?.title || null,
      ts: typeof when === "number" ? when : (existing?.ts ?? 0),
    };
    const next = [entry, ...prev.filter((r) => r.code !== code)].slice(0, MAX);
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // best-effort — losing a recents entry is non-fatal
  }
}
