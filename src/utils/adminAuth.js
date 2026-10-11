// Admin console session (moderators only, never a kid's account).
//
// The console used to keep the raw admin key in localStorage forever. It now
// keeps a short-lived session token the server issued after key + 2FA code,
// in sessionStorage: gone when the tab closes, useless after the server-side
// expiry, and every admin page shares it. The legacy saved key is removed on
// first load so no copy of it lingers in the browser.
const SESSION_STORAGE = "drawesome:adminsession:v1";
const LEGACY_KEY_STORAGE = "drawesome:adminkey:v1";

try {
  localStorage.removeItem(LEGACY_KEY_STORAGE);
} catch {
  // storage blocked: nothing to clean
}

export function getAdminToken() {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE);
    if (!raw) return "";
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.token !== "string") return "";
    if (parsed.expiresAt && Date.now() > Number(parsed.expiresAt)) {
      sessionStorage.removeItem(SESSION_STORAGE);
      return "";
    }
    return parsed.token;
  } catch {
    return "";
  }
}

export function setAdminToken(token, expiresAt) {
  try {
    sessionStorage.setItem(SESSION_STORAGE, JSON.stringify({ token, expiresAt: Number(expiresAt) || 0 }));
  } catch {
    // ephemeral session if storage is blocked
  }
}

export function clearAdminToken() {
  try {
    sessionStorage.removeItem(SESSION_STORAGE);
  } catch {
    // ignore
  }
}

const bust = (path) => `${path}${path.includes("?") ? "&" : "?"}_=${Date.now()}`;

// Does the server require a 2FA code right now?
export async function fetchAdminAuthMode() {
  try {
    const res = await fetch(bust("/api/admin/auth-mode"), { cache: "no-store" });
    if (!res.ok) return { totp: false };
    return await res.json();
  } catch {
    return { totp: false };
  }
}

// Exchange key + code for a session. Resolves { ok, token, expiresAt, method,
// recoveryLeft } or { ok: false, reason } (bad_key, bad_code, code_required,
// rate_limited, network).
export async function adminLogin(key, code) {
  try {
    const res = await fetch(bust("/api/admin/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ key, code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) return { ok: false, reason: data.error || (res.status === 429 ? "rate_limited" : "bad_key") };
    setAdminToken(data.token, data.expiresAt);
    return { ok: true, ...data };
  } catch {
    return { ok: false, reason: "network" };
  }
}

export async function adminLogout(token) {
  clearAdminToken();
  if (!token) return;
  try {
    await fetch("/api/admin/logout", { method: "POST", headers: { "x-admin-key": token }, cache: "no-store" });
  } catch {
    // the token expires on its own
  }
}

export function loginErrorText(reason) {
  switch (reason) {
    case "bad_key":
      return "That admin key didn't work.";
    case "bad_code":
      return "That code didn't work. Codes change every 30 seconds, check your phone's clock, or use a recovery code.";
    case "code_required":
      return "Enter the 6-digit code from your authenticator app.";
    case "rate_limited":
      return "Too many attempts. Wait a few minutes and try again.";
    case "network":
      return "Couldn't reach the server. Try again.";
    default:
      return "Sign-in failed. Try again.";
  }
}
