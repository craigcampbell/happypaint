// Auth / cloud sync layer — ENV-GATED provider abstraction with a graceful
// local-only fallback.
//
// docs/social-backend.md: "Happy Paint should stay useful without an account.
// Accounts unlock cross-device sync, friend invites, planned sessions, and live
// painting." and Store Review Notes: "Keep login optional until the user chooses
// sync or social features." So login is OPTIONAL — the whole app works signed
// out; auth only gates future sync/social.
//
// DEPENDENCY NOTE: the preferred path was to add `@supabase/supabase-js` and
// lazily create a client. Installing it cleanly resolved, but this project's
// bundler (Vite 8 / Rolldown) fails to resolve the SDK's transitive `tslib`
// import from `@supabase/functions-js`, which broke `npm run build`. Per the
// task's fallback guidance, we therefore use a PROVIDER ABSTRACTION here
// (LocalProvider active now + a documented SupabaseProvider stub) WITHOUT the
// dependency, keeping builds green. The SupabaseProvider stub below documents
// exactly how to wire the SDK once the bundler/peer issue is resolved (install
// `@supabase/supabase-js` + `tslib`, then implement the marked methods); the
// public interface of this module does not change either way.
//
// Mode is decided once from import.meta.env at module load and never throws:
//   - CLOUD: both VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set.
//   - LOCAL (current state): same interface, every call resolves to a clear
//     "Cloud sync not configured — your work is saved on this device." status.
//     No network calls are ever made.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

// Cloud sync is configured only when BOTH env vars are present and non-empty.
export const isCloudConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// Shown anywhere we need to explain the local-only state honestly.
export const LOCAL_ONLY_MESSAGE =
  "Cloud sync not configured — your work is saved on this device.";

// OAuth providers we surface as sign-in affordances (Apple/Google are
// placeholders until the backend is configured; magic link is the primary path).
export const OAUTH_PROVIDERS = [
  { id: "apple", label: "Continue with Apple" },
  { id: "google", label: "Continue with Google" },
];

// ---- LocalProvider — the active provider while cloud sync is unconfigured ----
// Same interface as the (future) Supabase provider, but never touches the
// network: there is no session, sign-in reports the local-only status, and
// auth state never changes.
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

// ---- SupabaseProvider — documented stub for when the backend is configured ----
// To activate cloud sync: (1) resolve the bundler peer issue and install
// `@supabase/supabase-js` (+ `tslib`); (2) set VITE_SUPABASE_URL and
// VITE_SUPABASE_ANON_KEY; (3) implement the methods below using a lazily-created
// client, e.g.:
//
//   let clientPromise;
//   async function getClient() {
//     if (!clientPromise) {
//       clientPromise = import("@supabase/supabase-js").then(({ createClient }) =>
//         createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
//           auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
//         }),
//       );
//     }
//     return clientPromise;
//   }
//   getSession:           const { data } = await (await getClient()).auth.getSession(); return data.session;
//   signInWithEmail:      (await getClient()).auth.signInWithOtp({ email, options: { emailRedirectTo } })
//   signInWithProvider:   (await getClient()).auth.signInWithOAuth({ provider, options: { redirectTo } })
//   signOut:              (await getClient()).auth.signOut()
//   onAuthStateChange:    (await getClient()).auth.onAuthStateChange((_e, session) => handler(session))
//
// Until then the stub degrades to a clear "configure the SDK" message so the
// app still builds and runs.
const SupabaseProvider = {
  async getSession() {
    return null;
  },
  onAuthStateChange() {
    return () => {};
  },
  async signInWithEmail(email) {
    return {
      ok: false,
      message: `Supabase env detected, but the SDK isn't wired yet. Magic link for ${email} not sent.`,
    };
  },
  async signInWithProvider(provider) {
    return { ok: false, message: `Supabase env detected, but ${provider} sign-in isn't wired yet.` };
  },
  async signOut() {
    return { ok: true, message: "Signed out." };
  },
};

// The single active provider, chosen once from env. Local today.
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
