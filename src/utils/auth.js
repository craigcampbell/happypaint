// Auth / cloud sync layer — ENV-GATED provider abstraction with a graceful
// local-only fallback.
//
// docs/social-backend.md: "Happy Paint should stay useful without an account.
// Accounts unlock cross-device sync, friend invites, planned sessions, and live
// painting." and Store Review Notes: "Keep login optional until the user chooses
// sync or social features." So login is OPTIONAL — the whole app works signed
// out; auth only gates sync/social.
//
// Mode is decided once from import.meta.env at module load and never throws:
//   - CLOUD: both VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set. We lazily
//     create a real @supabase/supabase-js client and back the provider interface
//     with Supabase Auth (magic link + Apple/Google OAuth).
//   - LOCAL (default): same interface, every sign-in call resolves to a clear
//     "Cloud sync not configured — your work is saved on this device." status and
//     NO network calls are ever made. The Supabase client is never instantiated.
//
// The @supabase/supabase-js SDK is loaded LAZILY via dynamic import() so it is
// code-split into its own chunk instead of the main bundle. In local-only mode
// the chunk is never requested at all; in configured mode it loads right after
// the app shell (on the first getSession/onAuthStateChange), keeping first paint
// off the ~145KB-gzip SDK.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

// Cloud sync is configured only when BOTH env vars are present and non-empty.
export const isCloudConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// Shown anywhere we need to explain the local-only state honestly.
export const LOCAL_ONLY_MESSAGE =
  "Cloud sync not configured — your work is saved on this device.";

// OAuth providers we surface as sign-in affordances. Magic link is the primary
// path; Apple/Google require the matching provider to be enabled in Supabase.
export const OAUTH_PROVIDERS = [
  { id: "apple", label: "Continue with Apple" },
  { id: "google", label: "Continue with Google" },
];

// ---- Lazily-loaded + lazily-created Supabase client (configured mode only) ----
// The dynamic import() is what splits the SDK into its own chunk. Both the
// module load and the client creation happen on first use, so local-only mode
// never fetches the chunk or touches the network.
let sdkPromise = null;
function loadCreateClient() {
  if (!sdkPromise) {
    sdkPromise = import("@supabase/supabase-js").then((m) => m.createClient);
  }
  return sdkPromise;
}

let clientPromise = null;

// Returns a Promise of the active Supabase client, or null when unconfigured /
// on load failure. Never throws. Cached after the first successful load.
export async function getSupabaseClient() {
  if (!isCloudConfigured) {
    return null;
  }
  if (!clientPromise) {
    clientPromise = (async () => {
      try {
        const createClient = await loadCreateClient();
        return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
          },
        });
      } catch {
        clientPromise = null; // allow a later call to retry the load
        return null;
      }
    })();
  }
  return clientPromise;
}

// The profile id used to key sync rows server-side is the authenticated user's
// uid (profiles.id === auth.users.id via the handle_new_user trigger). Returns
// null when signed out / unconfigured. Never throws.
export async function getProfileId() {
  const client = await getSupabaseClient();
  if (!client) {
    return null;
  }
  try {
    const { data } = await client.auth.getSession();
    return data?.session?.user?.id || null;
  } catch {
    return null;
  }
}

// ---- LocalProvider — active provider while cloud sync is unconfigured ----
// Same interface as the Supabase provider, but never touches the network:
// there is no session, sign-in reports the local-only status, auth never changes.
const LocalProvider = {
  async getSession() {
    return null;
  },
  onAuthStateChange() {
    return () => {};
  },
  async signInWithEmail() {
    return { ok: false, message: LOCAL_ONLY_MESSAGE };
  },
  async signInWithProvider() {
    return { ok: false, message: LOCAL_ONLY_MESSAGE };
  },
  async signOut() {
    return { ok: true, message: "Signed out (local)." };
  },
};

// ---- SupabaseProvider — real auth, active when configured ----
const SupabaseProvider = {
  async getSession() {
    const client = await getSupabaseClient();
    if (!client) {
      return null;
    }
    const { data } = await client.auth.getSession();
    return data?.session ?? null;
  },

  // Subscribe to Supabase auth state. Returns an unsubscribe function. The client
  // loads asynchronously (dynamic import), so we attach once it's ready and the
  // returned unsubscribe cancels whether or not the load has resolved yet.
  onAuthStateChange(handler) {
    let unsubscribe = () => {};
    let cancelled = false;
    (async () => {
      const client = await getSupabaseClient();
      if (!client || cancelled) {
        return;
      }
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        handler(session ?? null);
      });
      unsubscribe = () => {
        try {
          data?.subscription?.unsubscribe?.();
        } catch {
          // ignore
        }
      };
    })();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  },

  // Email magic link (passwordless). The link returns the user to this origin,
  // where detectSessionInUrl completes the sign-in.
  async signInWithEmail(email) {
    const client = await getSupabaseClient();
    if (!client) {
      return { ok: false, message: LOCAL_ONLY_MESSAGE };
    }
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) {
      return { ok: false, message: error.message || "Couldn't send magic link." };
    }
    return { ok: true, message: `Magic link sent to ${email}. Check your inbox.` };
  },

  // OAuth (Apple/Google). Redirects the browser to the provider; on return,
  // detectSessionInUrl completes the sign-in. The provider must be enabled in
  // the Supabase dashboard.
  async signInWithProvider(provider) {
    const client = await getSupabaseClient();
    if (!client) {
      return { ok: false, message: LOCAL_ONLY_MESSAGE };
    }
    const { error } = await client.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    });
    if (error) {
      return { ok: false, message: error.message || `Couldn't start ${provider} sign-in.` };
    }
    // On success the browser navigates away to the provider.
    return { ok: true, message: `Redirecting to ${provider}…` };
  },

  async signOut() {
    const client = await getSupabaseClient();
    if (!client) {
      return { ok: true, message: "Signed out (local)." };
    }
    const { error } = await client.auth.signOut();
    if (error) {
      return { ok: false, message: error.message || "Couldn't sign out." };
    }
    return { ok: true, message: "Signed out." };
  },
};

// The single active provider, chosen once from env.
const provider = isCloudConfigured ? SupabaseProvider : LocalProvider;

// ---- Public interface (identical across providers) ----

// Current session, or null. Never throws.
export async function getSession() {
  try {
    return await provider.getSession();
  } catch {
    return null;
  }
}

// Subscribe to auth state changes. Returns an unsubscribe function. In local
// mode this is a no-op (state never changes), so callers wire it uniformly.
export function onAuthStateChange(handler) {
  try {
    return provider.onAuthStateChange(handler) || (() => {});
  } catch {
    return () => {};
  }
}

// Send an email magic link. Returns { ok, message }.
export async function signInWithEmail(email) {
  const trimmed = String(email || "").trim();
  if (!trimmed) {
    return { ok: false, message: "Enter an email address." };
  }
  return provider.signInWithEmail(trimmed);
}

// Start an OAuth flow (Apple/Google). Returns { ok, message }.
export async function signInWithProvider(providerId) {
  return provider.signInWithProvider(providerId);
}

// Sign out (best-effort). Safe to call when signed out or in local mode.
export async function signOut() {
  try {
    return await provider.signOut();
  } catch (error) {
    return { ok: false, message: error?.message || "Couldn't sign out." };
  }
}

// Short, human-readable identity label for a session (email, else uid prefix).
export function sessionLabel(session) {
  if (!session) {
    return null;
  }
  return session.user?.email || session.user?.id?.slice(0, 8) || "Signed in";
}
