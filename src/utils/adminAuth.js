// Admin console session (moderators only, never a kid's account).
//
// Raw admin keys are never stored. Per-tab transport tokens expire at the
// server's fixed four-hour deadline. HttpOnly device + authorization cookies
// permit safe same-origin resume in independent tabs, without exposing either
// cookie to JavaScript. Only non-secret change notifications cross tabs.
const SESSION_STORAGE = "drawesome:adminsession:v1";
const LEGACY_KEY_STORAGE = "drawesome:adminkey:v1";
let logoutPending = Promise.resolve();
const LOGOUT_STORAGE = "drawesome:adminlogout:v1";
let logoutBlocked = false;
let logoutForget = false;
let logoutGeneration = 0;
try {
  const pending = sessionStorage.getItem(LOGOUT_STORAGE);
  logoutBlocked = pending !== null;
  logoutForget = pending === "forget";
} catch { /* in-memory guard still works when storage is blocked */ }
function markLogout(blocked, forget = false) {
  logoutBlocked = blocked;
  logoutForget = forget;
  try {
    if (blocked) sessionStorage.setItem(LOGOUT_STORAGE, forget ? "forget" : "logout");
    else sessionStorage.removeItem(LOGOUT_STORAGE);
  } catch { /* keep in-memory guard */ }
}
export function retryAdminLogout() { return adminLogout(undefined, { forget: logoutForget }); }
const authChanges = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("drawesome-admin-auth") : null;
function notifyAuthChange(kind) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("admin-auth-change", { detail: kind }));
}
if (authChanges) authChanges.onmessage = ({ data }) => {
  if (data === "login" || data === "logout") {
    if (data === "logout") clearAdminToken();
    notifyAuthChange(data);
  }
};
export function onAdminAuthChange(listener) {
  const handler = (event) => listener(event.detail);
  window.addEventListener("admin-auth-change", handler);
  return () => window.removeEventListener("admin-auth-change", handler);
}

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
    if (parsed.expiresAt && Date.now() >= Number(parsed.expiresAt)) {
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

// Every new tab obtains its own header/WS token via same-origin HttpOnly
// cookies. The remembered-device cookie alone is never enough to resume.
export async function resumeAdminSession() {
  await logoutPending;
  if (logoutBlocked) return { ok: false, reason: "logout_failed" };
  const generation = logoutGeneration;
  try {
    const response = await fetch("/api/admin/resume", { method: "POST", credentials: "same-origin", cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.token) return { ok: false, reason: data.error, remembered: !!data.remembered };
    if (logoutBlocked || generation !== logoutGeneration) return { ok: false, reason: "logout_failed" };
    setAdminToken(data.token, data.expiresAt);
    return { ...data, ok: true };
  } catch { return { ok: false, reason: "network" }; }
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
  await logoutPending;
  if (logoutBlocked) return { ok: false, reason: "logout_failed" };
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
    authChanges?.postMessage("login");
    return { ok: true, ...data };
  } catch {
    return { ok: false, reason: "network" };
  }
}

export function adminLogout(token, { forget = false } = {}) {
  logoutGeneration++;
  markLogout(true, forget);
  clearAdminToken();
  logoutPending = (async () => {
    try {
      const response = await fetch("/api/admin/logout", { method: "POST", credentials: "same-origin", headers: { "x-admin-key": token || "", "Content-Type": "application/json" }, body: JSON.stringify({ forget }), cache: "no-store" });
      if (response.ok) {
        markLogout(false);
        authChanges?.postMessage("logout");
        notifyAuthChange("logout");
      }
      return response.ok;
    } catch { return false; }
  })();
  return logoutPending;
}

export function loginErrorText(reason) {
  switch (reason) {
    case "logout_failed":
      return "Sign out was not confirmed. Retry sign out before signing in again.";
    case "unavailable":
      return "Admin authentication is temporarily unavailable. Try again or contact the server operator.";
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
