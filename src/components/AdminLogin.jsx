import { useEffect, useRef, useState } from "react";
import { adminLogin, adminLogout, fetchAdminAuthMode, loginErrorText, onAdminAuthChange, resumeAdminSession, retryAdminLogout } from "../utils/adminAuth";

// The one sign-in form every admin page uses: admin key + 6-digit code from an
// authenticator app (or a one-time recovery code). On success the server's
// session token is stored for the tab and handed to the page via onAuthed.
// When the server has no 2FA enrolled yet it says so, and the key alone is
// accepted, so a fresh dev checkout still works.
export default function AdminLogin({ title = "🛡️ Drawesome Admin", intro, action = "Unlock", backLabel = "← Home", backTo = "/", onNavigate, onAuthed }) {
  const [key, setKey] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [mode, setMode] = useState(null); // { totp: bool, sessionHours }
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const codeRef = useRef(null);
  const onAuthedRef = useRef(onAuthed);
  onAuthedRef.current = onAuthed;
  const [remembered, setRemembered] = useState(false);
  const [checking, setChecking] = useState(true);
  const [logoutFailed, setLogoutFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const resume = async () => {
      const [m, session] = await Promise.all([fetchAdminAuthMode(), resumeAdminSession()]);
      if (cancelled) return;
      setMode(m || { totp: false });
      setRemembered(!!session.remembered);
      setChecking(false);
      setLogoutFailed(session.reason === "logout_failed");
      if (session.reason === "logout_failed") setError(loginErrorText(session.reason));
      if (session.ok) onAuthedRef.current?.(session.token, session);
    };
    resume();
    const unsubscribe = onAdminAuthChange((kind) => { if (kind === "login") resume(); });
    window.addEventListener("focus", resume);
    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener("focus", resume);
    };
  }, []);

  const needsCode = !!mode?.totp;

  const submit = async () => {
    const k = key.trim();
    if (logoutFailed || (!k && !remembered) || busy || checking) return;
    if (needsCode && !code.trim()) {
      setError(loginErrorText("code_required"));
      codeRef.current?.focus();
      return;
    }
    setBusy(true);
    const result = await adminLogin(k, needsCode ? code.trim() : "");
    setBusy(false);
    if (result.ok) {
      setError("");
      setKey("");
      setCode("");
      onAuthed?.(result.token, result);
    } else {
      if (result.reason === "bad_key") setRemembered(false);
      setError(loginErrorText(result.reason));
      if (result.reason === "bad_code") {
        setCode("");
        codeRef.current?.focus();
      }
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter") submit();
  };

  return (
    <main className="admin-login">
      <div className="admin-login-card">
        <h1>{title}</h1>
        <p>{checking ? "Checking saved authorization…" : intro || (remembered ? "This device is remembered. Enter a fresh authenticator code to continue." : needsCode ? "Enter your admin key and the code from your authenticator app." : "Enter your admin key to continue.")}</p>
        {!remembered && <label className="admin-login-field">
          <span>Admin key</span>
          <input
            type="password"
            value={key}
            placeholder="admin key"
            autoComplete="off"
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </label>}
        {needsCode ? (
          <label className="admin-login-field">
            <span>{recovery ? "Recovery code" : "Authenticator code"}</span>
            <input
              ref={codeRef}
              type="text"
              value={code}
              placeholder={recovery ? "xxxxx-xxxxx" : "6-digit code"}
              inputMode={recovery ? "text" : "numeric"}
              autoComplete="one-time-code"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={recovery ? 16 : 7}
              className={recovery ? "" : "is-otp"}
              onChange={(e) => setCode(recovery ? e.target.value : e.target.value.replace(/[^\d\s]/g, ""))}
              onKeyDown={onKeyDown}
            />
          </label>
        ) : mode && !mode.totp ? (
          <p className="admin-login-warn">
            Two-factor sign-in is not set up on this server yet. Run <code>node scripts/admin-2fa-setup.mjs</code> on the host to
            require an authenticator code.
          </p>
        ) : null}
        {error ? <p className="admin-error">{error}</p> : null}
        {logoutFailed ? <button type="button" disabled={busy} onClick={async () => {
          setBusy(true);
          const ok = await retryAdminLogout();
          setBusy(false);
          if (!ok) { setError(loginErrorText("logout_failed")); return; }
          const session = await resumeAdminSession();
          setRemembered(!!session.remembered);
          setLogoutFailed(false);
          setError("");
        }}>Retry sign out</button> : null}
        {needsCode ? (
          <button type="button" className="admin-login-link" onClick={() => { setRecovery((v) => !v); setCode(""); setError(""); }}>
            {recovery ? "Use my authenticator app instead" : "Lost your phone? Use a recovery code"}
          </button>
        ) : null}
        {remembered ? <button type="button" className="admin-login-link" disabled={busy || checking} onClick={async () => {
          setBusy(true);
          const ok = await adminLogout(undefined, { forget: true });
          setBusy(false);
          if (ok) { setRemembered(false); setCode(""); setError(""); }
          else { setLogoutFailed(true); setError("Could not forget this device. Retry sign out to try again."); }
        }}>Forget this device</button> : null}
        <div className="admin-login-actions">
          <button type="button" onClick={() => onNavigate?.(backTo)}>
            {backLabel}
          </button>
          <button type="button" className="primary-action" onClick={submit} disabled={busy || checking || logoutFailed}>
            {busy ? "Checking…" : action}
          </button>
        </div>
        {mode?.totp && mode.sessionHours ? (
          <p className="admin-muted admin-login-note">
            Your admin key is remembered on this device for {mode.rememberDays || 7} days. A fresh authenticator code is required every {mode.sessionHours} hours, shared across admin pages, tabs and watch rooms.
          </p>
        ) : null}
      </div>
    </main>
  );
}
