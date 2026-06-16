// Auth / cloud sync layer — ENV-GATED provider abstraction with a graceful
// local-only fallback (RN / Expo).
//
// docs/social-backend.md: "Happy Paint should stay useful without an account.
// Accounts unlock cross-device sync, friend invites, planned sessions, and live
// painting." and §"Store Review Notes": "Keep login optional until the user
// chooses sync or social features." So login is OPTIONAL — the whole app works
// signed out; auth only gates sync/social.
//
// Mode is decided once from Expo env at module load and never throws:
//   - CLOUD: both EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY set.
//     A Supabase client is created LAZILY (only on first use) with AsyncStorage
//     as the auth storage adapter, persistSession + autoRefreshToken on, and
//     detectSessionInUrl off (required on RN — there is no browser URL bar).
//   - LOCAL (no env): same interface, every call resolves to a clear
//     "Cloud sync not configured — your work is saved on this device." status.
//     No network calls are ever made and no client is ever instantiated.
//
// RN client requirements wired here:
//   - `react-native-url-polyfill/auto` is imported at the app entry (App.tsx)
//     so the SDK has WHATWG URL.
//   - AsyncStorage is the auth storage; sessions persist across launches.
//   - AppState drives supabase.auth.startAutoRefresh/stopAutoRefresh so the
//     token refreshes while the app is foregrounded (Supabase RN guidance).

import { AppState } from "react-native";
import type { AppStateStatus } from "react-native";
import type { SupabaseClient, Session } from "@supabase/supabase-js";

// Expo inlines EXPO_PUBLIC_* vars into process.env at build time.
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";

// Cloud sync is configured only when BOTH env vars are present and non-empty.
export const isCloudConfigured: boolean = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// Shown anywhere we need to explain the local-only state honestly.
export const LOCAL_ONLY_MESSAGE =
  "Cloud sync not configured — your work is saved on this device.";

// Deep link the auth provider redirects back to (must match app.json `scheme`).
// Used for magic-link `emailRedirectTo` and OAuth `redirectTo`.
export const AUTH_REDIRECT_URL = "happypaint://auth-callback";

// A minimal session shape (mirrors the fields we read from a Supabase session).
export type AuthSession = {
  user: {
    id: string;
    email?: string | null;
  };
};

export type AuthResult = { ok: boolean; message: string };

// OAuth providers we surface as sign-in affordances.
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

// Reduce a full Supabase session to our minimal shape.
function toAuthSession(session: Session | null): AuthSession | null {
  if (!session?.user) {
    return null;
  }
  return { user: { id: session.user.id, email: session.user.email ?? null } };
}

// ---- LocalProvider — active while cloud sync is unconfigured ----------------
// Same interface as the Supabase provider, but never touches the network: there
// is no session, sign-in reports the local-only status, and auth state never
// changes. No client is ever created.
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

// ---- Supabase client (lazy singleton) --------------------------------------
// Only instantiated when configured AND first used, so typecheck/builds stay
// green and no network/setup work happens in local-only mode.
let supabaseClient: SupabaseClient | null = null;
let appStateSub: { remove: () => void } | null = null;

function createSupabaseClient(): SupabaseClient {
  // Required lazily so the module never pulls the SDK in local-only paths that
  // don't reach here. AsyncStorage is the RN auth storage adapter.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createClient } = require("@supabase/supabase-js") as typeof import("@supabase/supabase-js");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AsyncStorage =
    require("@react-native-async-storage/async-storage").default as typeof import("@react-native-async-storage/async-storage").default;

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      // RN has no browser URL bar; sessions arrive via deep links we handle.
      detectSessionInUrl: false
    }
  });

  // Foreground auto-refresh per Supabase RN guidance: refresh while active,
  // pause in the background.
  const onAppState = (state: AppStateStatus) => {
    if (state === "active") {
      client.auth.startAutoRefresh();
    } else {
      client.auth.stopAutoRefresh();
    }
  };
  appStateSub = AppState.addEventListener("change", onAppState);
  if (AppState.currentState === "active") {
    client.auth.startAutoRefresh();
  }

  return client;
}

// Active client accessor for the sync layer. Returns null when unconfigured.
export function getSupabaseClient(): SupabaseClient | null {
  if (!isCloudConfigured) {
    return null;
  }
  if (!supabaseClient) {
    supabaseClient = createSupabaseClient();
  }
  return supabaseClient;
}

// Current signed-in profile id (= auth user id; `profiles.id` mirrors it via the
// handle_new_user trigger). Null when signed out or unconfigured. Used by the
// sync layer to key project_snapshots.profile_id / space_assets.owner_profile_id.
let cachedProfileId: string | null = null;
export function getActiveProfileId(): string | null {
  return cachedProfileId;
}

// ---- SupabaseProvider — real implementation when configured -----------------
const SupabaseProvider: AuthProvider = {
  async getSession() {
    const client = getSupabaseClient();
    if (!client) {
      return null;
    }
    const { data } = await client.auth.getSession();
    const session = toAuthSession(data.session);
    cachedProfileId = session?.user.id ?? null;
    return session;
  },
  onAuthStateChange(handler) {
    const client = getSupabaseClient();
    if (!client) {
      return () => {};
    }
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      const mapped = toAuthSession(session);
      cachedProfileId = mapped?.user.id ?? null;
      handler(mapped);
    });
    return () => data.subscription.unsubscribe();
  },
  async signInWithEmail(email) {
    const client = getSupabaseClient();
    if (!client) {
      return { ok: false, message: LOCAL_ONLY_MESSAGE };
    }
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: AUTH_REDIRECT_URL }
    });
    if (error) {
      return { ok: false, message: error.message };
    }
    return { ok: true, message: `We sent a magic sign-in link to ${email}. Open it on this device to finish.` };
  },
  async signInWithProvider(providerId) {
    const client = getSupabaseClient();
    if (!client) {
      return { ok: false, message: LOCAL_ONLY_MESSAGE };
    }
    const { data, error } = await client.auth.signInWithOAuth({
      provider: providerId,
      options: {
        redirectTo: AUTH_REDIRECT_URL,
        // We open the URL ourselves with RN Linking; the redirect deep link is
        // exchanged for a session via handleAuthDeepLink().
        skipBrowserRedirect: true
      }
    });
    if (error) {
      return { ok: false, message: error.message };
    }
    if (!data?.url) {
      return { ok: false, message: "Couldn't start sign-in. Try again." };
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Linking } = require("react-native") as typeof import("react-native");
      await Linking.openURL(data.url);
    } catch {
      return { ok: false, message: "Couldn't open the sign-in page." };
    }
    return { ok: true, message: "Finish signing in in your browser, then return to Happy Paint." };
  },
  async signOut() {
    const client = getSupabaseClient();
    if (!client) {
      return { ok: true, message: "Signed out (local)." };
    }
    cachedProfileId = null;
    const { error } = await client.auth.signOut();
    if (error) {
      return { ok: false, message: error.message };
    }
    return { ok: true, message: "Signed out." };
  }
};

// The single active provider, chosen once from env.
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

// Handle an auth redirect deep link (magic link / OAuth callback). RN has
// detectSessionInUrl off, so we parse the tokens out of the redirect URL and
// hand them to the client. Best-effort; returns true if a session was set.
// No-op for non-auth URLs and in local mode.
export async function handleAuthDeepLink(url: string | null): Promise<boolean> {
  if (!url || !isCloudConfigured) {
    return false;
  }
  const client = getSupabaseClient();
  if (!client) {
    return false;
  }
  try {
    // Tokens may arrive in the fragment (#access_token=...) or query (?code=...).
    const fragment = url.includes("#") ? url.slice(url.indexOf("#") + 1) : "";
    const query = url.includes("?") ? url.slice(url.indexOf("?") + 1).split("#")[0] : "";
    const params = new URLSearchParams(fragment || query);

    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    if (accessToken && refreshToken) {
      const { data, error } = await client.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken
      });
      if (!error) {
        cachedProfileId = data.session?.user.id ?? null;
        return Boolean(data.session);
      }
      return false;
    }

    // PKCE / magic-link `code` exchange path.
    const code = params.get("code");
    if (code) {
      const { data, error } = await client.auth.exchangeCodeForSession(code);
      if (!error) {
        cachedProfileId = data.session?.user.id ?? null;
        return Boolean(data.session);
      }
    }
    return false;
  } catch {
    return false;
  }
}

// Tear down the AppState auto-refresh subscription (e.g. on app teardown). Safe
// to call any time; no-op when nothing was wired.
export function disposeAuth(): void {
  try {
    appStateSub?.remove();
  } catch {
    // ignore
  }
  appStateSub = null;
}

// Short, human-readable identity label for a session (email, else uid prefix).
export function sessionLabel(session: AuthSession | null): string | null {
  if (!session) {
    return null;
  }
  return session.user?.email || session.user?.id?.slice(0, 8) || "Signed in";
}
