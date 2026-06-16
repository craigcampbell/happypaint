// Auth / cloud sync layer — ENV-GATED provider abstraction with a graceful
// local-only fallback (RN / Expo).
//
// docs/social-backend.md: "Happy Paint should stay useful without an account.
// Accounts unlock cross-device sync, friend invites, planned sessions, and live
// painting." and §"Store Review Notes": "Keep login optional until the user
// chooses sync or social features." So login is OPTIONAL — the whole app works
// signed out; auth only gates future sync/social.
//
// DEPENDENCY NOTE: the preferred path was to add `@supabase/supabase-js` and
// lazily create a client. The parallel web agent found its bundler couldn't
// resolve a transitive dep of the SDK, and on RN the SDK also needs extra
// polyfills (url, structuredClone, base64, AsyncStorage storage adapter). Per
// the task's fallback guidance — and to keep `npm run typecheck`/builds green
// with ZERO new dependencies — this module uses a PROVIDER ABSTRACTION:
// LocalProvider is active now + a documented SupabaseProvider stub. The public
// interface does not change when the SDK is wired later.
//
// Mode is decided once from Expo env at module load and never throws:
//   - CLOUD: both EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY set.
//   - LOCAL (current state): same interface, every call resolves to a clear
//     "Cloud sync not configured — your work is saved on this device." status.
//     No network calls are ever made.

// Expo inlines EXPO_PUBLIC_* vars into process.env at build time.
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";

// Cloud sync is configured only when BOTH env vars are present and non-empty.
export const isCloudConfigured: boolean = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// Shown anywhere we need to explain the local-only state honestly.
export const LOCAL_ONLY_MESSAGE =
  "Cloud sync not configured — your work is saved on this device.";

// A minimal session shape (mirrors the fields we read from a Supabase session).
export type AuthSession = {
  user: {
    id: string;
    email?: string | null;
  };
};

export type AuthResult = { ok: boolean; message: string };

// OAuth providers we surface as sign-in affordances (Apple/Google are
// placeholders until the backend is configured; magic link is the primary path).
export type OAuthProviderId = "apple" | "google";
export const OAUTH_PROVIDERS: Array<{ id: OAuthProviderId; label: string }> = [
  { id: "apple", label: "Continue with Apple" },
  { id: "google", label: "Continue with Google" }
];

type AuthStateHandler = (session: AuthSession | null) => void;

type AuthProvider = {
  getSession: () => Promise<AuthSession | null>;
  onAuthStateChange: (handler: AuthStateHandler) => () => void;
  signInWithEmail: (email: string) => Promise<AuthResult>;
  signInWithProvider: (provider: OAuthProviderId) => Promise<AuthResult>;
  signOut: () => Promise<AuthResult>;
};

// ---- LocalProvider — the active provider while cloud sync is unconfigured ----
// Same interface as the (future) Supabase provider, but never touches the
// network: there is no session, sign-in reports the local-only status, and
// auth state never changes.
const LocalProvider: AuthProvider = {
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
  }
};

// ---- SupabaseProvider — documented stub for when the backend is configured ----
// To activate cloud sync on mobile:
//   (1) install `@supabase/supabase-js` plus the RN polyfills it needs
//       (react-native-url-polyfill, react-native-get-random-values, and a
//        base64 polyfill), and pass an AsyncStorage auth storage adapter;
//   (2) set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY;
//   (3) implement the methods below using a lazily-created client, e.g.:
//
//   import AsyncStorage from "@react-native-async-storage/async-storage";
//   import "react-native-url-polyfill/auto";
//   let clientPromise: Promise<SupabaseClient> | null = null;
//   async function getClient() {
//     if (!clientPromise) {
//       clientPromise = import("@supabase/supabase-js").then(({ createClient }) =>
//         createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
//           auth: { storage: AsyncStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
//         })
//       );
//     }
//     return clientPromise;
//   }
//   getSession:          const { data } = await (await getClient()).auth.getSession(); return data.session;
//   signInWithEmail:     (await getClient()).auth.signInWithOtp({ email, options: { emailRedirectTo } })
//   signInWithProvider:  (await getClient()).auth.signInWithOAuth({ provider, options: { redirectTo } })
//   signOut:             (await getClient()).auth.signOut()
//   onAuthStateChange:   (await getClient()).auth.onAuthStateChange((_e, session) => handler(session))
//
// Until then the stub degrades to a clear "configure the SDK" message so the
// app still builds and runs without the dependency.
const SupabaseProvider: AuthProvider = {
  async getSession() {
    return null;
  },
  onAuthStateChange() {
    return () => {};
  },
  async signInWithEmail(email) {
    return {
      ok: false,
      message: `Supabase env detected, but the SDK isn't wired yet. Magic link for ${email} not sent.`
    };
  },
  async signInWithProvider(provider) {
    return { ok: false, message: `Supabase env detected, but ${provider} sign-in isn't wired yet.` };
  },
  async signOut() {
    return { ok: true, message: "Signed out." };
  }
};

// The single active provider, chosen once from env. Local today.
const provider: AuthProvider = isCloudConfigured ? SupabaseProvider : LocalProvider;

// ---- Public interface (identical across providers) ----

// Current session, or null. Never throws.
export async function getSession(): Promise<AuthSession | null> {
  try {
    return await provider.getSession();
  } catch {
    return null;
  }
}

// Subscribe to auth state changes. Returns an unsubscribe function. In local
// mode this is a no-op (state never changes), so callers wire it uniformly.
export function onAuthStateChange(handler: AuthStateHandler): () => void {
  try {
    return provider.onAuthStateChange(handler) || (() => {});
  } catch {
    return () => {};
  }
}

// Send an email magic link. Returns { ok, message }.
export async function signInWithEmail(email: string): Promise<AuthResult> {
  const trimmed = String(email || "").trim();
  if (!trimmed) {
    return { ok: false, message: "Enter an email address." };
  }
  return provider.signInWithEmail(trimmed);
}

// Start an OAuth flow (Apple/Google). Returns { ok, message }.
export async function signInWithProvider(providerId: OAuthProviderId): Promise<AuthResult> {
  return provider.signInWithProvider(providerId);
}

// Sign out (best-effort). Safe to call when signed out or in local mode.
export async function signOut(): Promise<AuthResult> {
  try {
    return await provider.signOut();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Couldn't sign out.";
    return { ok: false, message };
  }
}

// Short, human-readable identity label for a session (email, else uid prefix).
export function sessionLabel(session: AuthSession | null): string | null {
  if (!session) {
    return null;
  }
  return session.user?.email || session.user?.id?.slice(0, 8) || "Signed in";
}
