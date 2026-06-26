// Secret-free PocketBase token validation for the realtime server.
//
// PocketBase auth tokens are HS256 JWTs signed with a PER-RECORD secret that
// lives inside PocketBase's database, so they can't be verified standalone — the
// correct approach is to let PocketBase validate the token for us. We POST it to
// the auth-refresh endpoint with the token as a RAW Authorization header (no
// "Bearer " prefix, per the PocketBase API). 200 → the user record (whose `id`
// is the identity); anything else → anonymous.
//
// Sign-in is OPTIONAL: every function fails closed to `null` (anonymous) when
// unconfigured, on a bad/expired token, or on any network error. Never throws.
//
// PB_URL is the server-internal PocketBase base URL (e.g. http://pocketbase:8090
// inside the compose network, or http://127.0.0.1:8090 in local dev). It is NOT
// the public VITE_PB_URL the browser uses.

function cfg() {
  const url = (process.env.PB_URL || process.env.POCKETBASE_URL || '').replace(/\/+$/, '');
  return { url };
}

export function pocketbaseConfigured() {
  return Boolean(cfg().url);
}

const cache = new Map();
const OK_TTL_MS = 60000;
const BAD_TTL_MS = 5000;
const MAX_CACHE = 500;

function displayNameFromRecord(rec) {
  const name =
    rec.name ||
    rec.username ||
    (typeof rec.email === 'string' ? rec.email.split('@')[0] : '') ||
    'Artist';
  return String(name).slice(0, 40);
}

function remember(token, profile, ttl) {
  if (cache.size > MAX_CACHE) cache.clear();
  cache.set(token, { profile, exp: Date.now() + ttl });
}

// Returns { profileId, displayName } for a valid token, else null. Never throws.
export async function verifyAccessToken(token) {
  if (!token || typeof token !== 'string') return null;
  const { url } = cfg();
  if (!url) return null;

  const hit = cache.get(token);
  if (hit && hit.exp > Date.now()) return hit.profile;

  try {
    const res = await fetch(`${url}/api/collections/users/auth-refresh`, {
      method: 'POST',
      headers: { Authorization: token }, // RAW token — PocketBase does not want "Bearer "
    });
    if (!res.ok) {
      remember(token, null, BAD_TTL_MS);
      return null;
    }
    const data = await res.json();
    const rec = data && data.record;
    if (!rec || !rec.id) {
      remember(token, null, BAD_TTL_MS);
      return null;
    }
    const profile = { profileId: String(rec.id), displayName: displayNameFromRecord(rec) };
    remember(token, profile, OK_TTL_MS);
    return profile;
  } catch {
    return null; // network hiccup → treat as anonymous, don't cache
  }
}
