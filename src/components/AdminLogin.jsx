import { useEffect, useRef, useState } from "react";
import { adminLogin, fetchAdminAuthMode, loginErrorText } from "../utils/adminAuth";

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

  useEffect(() => {
    let cancelled = false;
    fetchAdminAuthMode().then((m) => {
      if (!cancelled) setMode(m || { totp: false });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const needsCode = !!mode?.totp;

  const submit = async () => {
    const k = key.trim();
    if (!k || busy) return;
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
        <p>{intro || (needsCode ? "Enter your admin key and the code from your authenticator app." : "Enter your admin key to continue.")}</p>
        <label className="admin-login-field">
          <span>Admin key</span>
          <input
            type="password"
            value={key}
            placeholder="admin key"
            autoComplete="off"
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </label>
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
        {needsCode ? (
          <button type="button" className="admin-login-link" onClick={() => { setRecovery((v) => !v); setCode(""); setError(""); }}>
            {recovery ? "Use my authenticator app instead" : "Lost your phone? Use a recovery code"}
          </button>
        ) : null}
        <div className="admin-login-actions">
          <button type="button" onClick={() => onNavigate?.(backTo)}>
            {backLabel}
          </button>
          <button type="button" className="primary-action" onClick={submit} disabled={busy}>
            {busy ? "Checking…" : action}
          </button>
        </div>
        {mode?.totp && mode.sessionHours ? (
          <p className="admin-muted admin-login-note">
            You stay signed in for {mode.sessionHours} hours in this tab, then sign in again. Nothing is saved on this device.
          </p>
        ) : null}
      </div>
    </main>
  );
}
