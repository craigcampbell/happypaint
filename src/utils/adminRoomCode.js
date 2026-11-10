// Admin links carry exact server room identifiers. Never silently strip a
// character and open a different room under privileged moderation access.
export function adminRoomCode(value) {
  return typeof value === 'string' && /^[A-Z0-9_-]{1,16}$/.test(value) ? value : '';
}
