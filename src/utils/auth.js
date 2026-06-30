// Auth layer — PocketBase-backed, ENV-GATED, with a graceful local-only fallback.
//
// Login is OPTIONAL: the whole app works signed out; an account only unlocks
// cross-device sync + room ownership/host powers. Mode is decided once at module
// load from import.meta.env:
//   - CLOUD: VITE_PB_URL is set → we lazily create a PocketBase client and back
//     sign-in with Google OAuth (more providers can be added later).
//   - LOCAL (default): every sign-in call resolves to a clear "saved on this
//     device" status and NO network call is ever made.
//
// The pocketbase SDK is loaded LAZILY via dynamic import() so it is code-split
// out of the main bundle and never fetched in local-only mode.
//
// The exported surface is intentionally the same shape the rest of the app
// already consumes (getSession/onAuthStateChange/signInWithProvider/…), and a
// "session" is normalized to { access_token, user:{ id, email, name } } so the
// multiplayer socket can keep passing session?.access_token unchanged.

const PB_URL = import.meta.env.VITE_PB_URL || "";

export const isCloudConfigured = Boolean(PB_URL);

export const LOCAL_ONLY_MESSAGE =
  "Cloud accounts not configured — your work is saved on this device.";

// Sign-in affordances. Google first; Apple can be added once enrolled.
export const OAUTH_PROVIDERS = [{ id: "google", label: "Continue with Google" }];

// ---- Lazily-loaded PocketBase client (configured mode only) ----
let pbPromise = null;
function loadPocketBase() {
  if (!isCloudConfigured) return Promise.resolve(null);
  if (!pbPromise) {
    pbPromise = import("pocketbase")
      .then((mod) => {
        const PocketBase = mod.default;
        const pb = new PocketBase(PB_URL);
        // We fire overlapping requests (pull + push); don't auto-cancel them.
        pb.autoCancellation(false);
        return pb;
      })
      .catch(() => {
        pbPromise = null; // allow a later retry
        return null;
      });
  }
  return pbPromise;
}

export async function getPocketBase() {
  return loadPocketBase();
}

// Normalize PocketBase's authStore into the session shape the app expects.
function sessionFromPb(pb) {
  if (!pb || !pb.authStore.isValid || !pb.authStore.record) return null;
  const r = pb.authStore.record;
  return { access_token: pb.authStore.token, user: { id: r.id, email: r.email, name: r.name } };
}

export async function getSession() {
  try {
    const pb = await getPocketBase();
    return sessionFromPb(pb);
  } catch {
    return null;
  }
}

// The authenticated user id (profiles/users record id) — the owner key for
// gallery rows / room ownership. null when signed out / unconfigured.
export async function getProfileId() {
  try {
    const pb = await getPocketBase();
    return pb && pb.authStore.isValid ? pb.authStore.record?.id || null : null;
  } catch {
    return null;
  }
}

// Subscribe to auth changes; returns an unsubscribe. No-op in local mode.
export function onAuthStateChange(handler) {
  let unsubscribe = () => {};
  let cancelled = false;
  (async () => {
    const pb = await getPocketBase();
    if (!pb || cancelled) return;
    unsubscribe = pb.authStore.onChange(() => handler(sessionFromPb(pb)));
  })();
  return () => {
    cancelled = true;
    try {
      unsubscribe();
    } catch {
      // ignore
    }
  };
}

// OAuth sign-in (Google). `popup` is an already-opened window handed in by the
// caller's CLICK handler — opening it synchronously on tap is what keeps Safari
// (the iPad/iPhone audience) from blocking it, since the SDK loads async first.
export async function signInWithProvider(providerId, popup) {
  const pb = await getPocketBase();
  if (!pb) {
    if (popup) popup.close();
    return { ok: false, message: LOCAL_ONLY_MESSAGE };
  }
  try {
    await pb.collection("users").authWithOAuth2({
      provider: providerId,
      urlCallback: (url) => {
        if (popup) popup.location.href = url;
        else window.location.href = url;
      },
    });
    return { ok: true, message: "Signed in!" };
  } catch (error) {
    if (popup) {
      try {
        popup.close();
      } catch {
        // ignore
      }
    }
    return { ok: false, message: error?.message || `Couldn't sign in with ${providerId}.` };
  }
}

// PocketBase native email + password. Sign-in authenticates; sign-up creates the
// `users` record (public create must be allowed on the collection) then signs in.
export async function signInWithEmail(email, password) {
  const pb = await getPocketBase();
  if (!pb) {
    return { ok: false, message: LOCAL_ONLY_MESSAGE };
  }
  const id = String(email || "").trim();
  if (!id || !password) {
    return { ok: false, message: "Enter your email and password." };
  }
  try {
    await pb.collection("users").authWithPassword(id, password);
    return { ok: true, message: "Signed in!" };
  } catch {
    return { ok: false, message: "Wrong email or password." };
  }
}

export async function signUpWithEmail(email, password) {
  const pb = await getPocketBase();
  if (!pb) {
    return { ok: false, message: LOCAL_ONLY_MESSAGE };
  }
  const id = String(email || "").trim();
  if (!id || !/.+@.+\..+/.test(id)) {
    return { ok: false, message: "Enter a valid email address." };
  }
  if (!password || password.length < 8) {
    return { ok: false, message: "Password needs at least 8 characters." };
  }
  try {
    await pb.collection("users").create({
      email: id,
      password,
      passwordConfirm: password,
      name: id.split("@")[0].slice(0, 20),
    });
    await pb.collection("users").authWithPassword(id, password);
    return { ok: true, message: "Account created — you're signed in!" };
  } catch (error) {
    const data = error?.response?.data || {};
    if (data.email) {
      return { ok: false, message: "That email is already registered — try logging in." };
    }
    if (data.password?.message) {
      return { ok: false, message: data.password.message };
    }
    return { ok: false, message: error?.message || "Couldn't create that account." };
  }
}

// Which OAuth providers are actually enabled on the PB users collection, so the
// UI can show (e.g.) the Google button only once it's configured instead of a
// button that always errors. Empty when local-only or unreachable.
export async function getEnabledOAuthProviderIds() {
  if (!isCloudConfigured) return [];
  try {
    const res = await fetch(`${PB_URL}/api/collections/users/auth-methods`, { cache: "no-store" });
    const data = await res.json();
    const providers = data?.oauth2?.providers || data?.authProviders || [];
    return providers.map((p) => p.name).filter(Boolean);
  } catch {
    return [];
  }
}

// Sign out — PocketBase has no logout endpoint; you just clear the local store.
export async function signOut() {
  try {
    const pb = await getPocketBase();
    if (pb) pb.authStore.clear();
    return { ok: true, message: "Signed out." };
  } catch (error) {
    return { ok: false, message: error?.message || "Couldn't sign out." };
  }
}

// Short, human-readable identity label for a session.
export function sessionLabel(session) {
  if (!session) return null;
  return session.user?.name || session.user?.email || session.user?.id?.slice(0, 8) || "Signed in";
}
