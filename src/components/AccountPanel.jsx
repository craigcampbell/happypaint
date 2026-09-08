// Account / Auth panel — sign-in state + OPTIONAL sign-in + in-app account
// deletion. Login is optional (the app fully works signed out); auth only gates
// future sync/social. When cloud sync isn't configured we say so plainly.
//
// Local cleanup is free and available to guests. Signed-in deletion also calls
// the account cleanup endpoint. The local receipt is not a scheduled purge;
// keep the UI honest about stores and shared content outside that cleanup.

import { useEffect, useState } from "react";
import {
  LOCAL_ONLY_MESSAGE,
  OAUTH_PROVIDERS,
  getEnabledOAuthProviderIds,
  getSession,
  isCloudConfigured,
  onAuthStateChange,
  sessionLabel,
  signInWithEmail,
  signInWithProvider,
  signOut,
  signUpWithEmail,
} from "../utils/auth";
import { deleteAccountAndData, getDeletionRequest } from "../utils/accountDeletion";
import { getSyncStatus, onSyncStatus } from "../utils/sync";

export default function AccountPanel({ onClose, onDeleted }) {
  const [session, setSession] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("login"); // "login" | "signup"
  const [oauthIds, setOauthIds] = useState([]);
  const [message, setMessage] = useState(isCloudConfigured ? "" : LOCAL_ONLY_MESSAGE);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletion, setDeletion] = useState(() => getDeletionRequest());
  const [syncLabel, setSyncLabel] = useState(() => getSyncStatus().label);

  useEffect(() => {
    let active = true;
    getSession().then((value) => {
      if (active) {
        setSession(value);
      }
    });
    const unsub = onAuthStateChange((value) => setSession(value));
    getEnabledOAuthProviderIds().then((ids) => active && setOauthIds(ids));
    // Reflect the live cloud-sync status (only meaningful when configured).
    const unsubSync = onSyncStatus((_status, label) => {
      if (active) {
        setSyncLabel(label);
      }
    });
    return () => {
      active = false;
      unsub();
      unsubSync();
    };
  }, []);

  const handleEmail = async (event) => {
    event?.preventDefault?.();
    setBusy(true);
    setMessage("");
    const result = await (mode === "signup" ? signUpWithEmail : signInWithEmail)(email, password);
    setMessage(result.message);
    setBusy(false);
    // Session updates via onAuthStateChange — the panel flips to the signed-in view.
  };

  const handleProvider = async (provider) => {
    // Open the popup synchronously on tap so Safari (the iPad/iPhone audience)
    // doesn't block it — the SDK loads async, so we hand the open window to
    // sign-in which points it at the provider once ready.
    const popup = window.open("", "_blank", "width=520,height=680");
    setBusy(true);
    const result = await signInWithProvider(provider, popup);
    setMessage(result.message);
    setBusy(false);
  };

  const handleSignOut = async () => {
    setBusy(true);
    const result = await signOut();
    setSession(null);
    setMessage(result.message);
    setBusy(false);
  };

  const handleDelete = async () => {
    setBusy(true);
    setMessage("Deleting your data…");
    const result = await deleteAccountAndData();
    setSession(null);
    setConfirmDelete(false);
    setDeletion(result.request);
    if (!result.server.filed && ["local-only", "signed-out"].includes(result.server.reason)) {
      setMessage("Local cleanup ran in this browser. No cloud account or shared-room content was deleted.");
    } else if (!result.server.filed) {
      setMessage(
        "Local cleanup ran, but cloud account deletion could not be completed. Sign in and try deletion again.",
      );
    } else if (result.server.billingCancellationPending) {
      setMessage("Your cloud account was deleted and local cleanup ran. Subscription cancellation is queued and will retry automatically.");
    } else {
      setMessage("Your cloud account was deleted and local cleanup ran. Shared content may remain as described in Privacy.");
    }
    setBusy(false);
    onDeleted?.(result);
  };

  const label = sessionLabel(session);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="studio-modal account-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title-row">
          <h2 id="account-title">Account &amp; Sync</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="ps-group account-section">
          <h3>Sign in</h3>
          {session ? (
            <div className="account-signed-in">
              <p>
                Signed in as <strong>{label}</strong>.
              </p>
              {isCloudConfigured ? (
                <p className="account-note compliance">Cloud sync: {syncLabel}</p>
              ) : null}
              <button type="button" onClick={handleSignOut} disabled={busy}>
                Sign out
              </button>
            </div>
          ) : (
            <>
              <p className="account-note">
                Signing in is <strong>optional</strong> — your work keeps going without an account. An
                account saves your gallery and follows you to any device.
              </p>
              {!isCloudConfigured ? (
                <p className="account-note compliance">{LOCAL_ONLY_MESSAGE}</p>
              ) : null}
              <form className="signup-form" onSubmit={handleEmail}>
                <label className="signup-field">
                  <span>Email</span>
                  <input
                    type="email"
                    value={email}
                    autoComplete="email"
                    placeholder="you@example.com"
                    onChange={(event) => setEmail(event.target.value)}
                    required
                  />
                </label>
                <label className="signup-field">
                  <span>Password</span>
                  <input
                    type="password"
                    value={password}
                    autoComplete={mode === "signup" ? "new-password" : "current-password"}
                    placeholder={mode === "signup" ? "8+ characters" : "Your password"}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                  />
                </label>
                <button type="submit" className="primary-action" disabled={busy || !isCloudConfigured}>
                  {mode === "signup" ? "Create account" : "Log in"}
                </button>
              </form>
              <button
                type="button"
                className="signup-toggle"
                onClick={() => {
                  setMode((m) => (m === "signup" ? "login" : "signup"));
                  setMessage("");
                }}
              >
                {mode === "signup" ? "Already have an account? Log in" : "New here? Create an account"}
              </button>
              {OAUTH_PROVIDERS.filter((p) => oauthIds.includes(p.id)).map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  className="signup-google"
                  onClick={() => handleProvider(provider.id)}
                  disabled={busy}
                >
                  {provider.label}
                </button>
              ))}
            </>
          )}
        </div>

        <div className="ps-group account-section">
          <h3>Drawesome Family</h3>
          <p className="account-note">
            A parent can make every private room they own ad-free—including for friends who join as guests.
          </p>
          <button type="button" className="primary-action" onClick={() => { window.location.href = "/family"; }}>
            View Family plan
          </button>
        </div>

        {message ? <p className="account-status">{message}</p> : null}

        <div className="ps-group account-section account-danger">
          <h3>Delete my data &amp; account</h3>
          <p className="account-note">
            Local cleanup is <strong>free</strong> and available without an account. It clears drafts,
            gallery items, Paint Space, wallet, replays and brush packs from this browser, then signs
            you out. Some browser identifiers and preferences may remain. Sign in before deleting
            to also request cloud account deletion and cancellation of an attached Family subscription.
          </p>
          <p className="account-note">
            Guest server saves, shared canvas drawings and some chat or report copies can remain.
            Read the <a href="/privacy">Privacy page</a> for the scope of deletion before continuing.
          </p>
          {deletion ? (
            <p className="account-note compliance">
              Last deletion attempt: {new Date(deletion.requested_at).toLocaleString()}.
            </p>
          ) : null}
          {confirmDelete ? (
            <div className="account-actions">
              <button type="button" className="account-delete-confirm" onClick={handleDelete} disabled={busy}>
                Yes, delete my data
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} disabled={busy}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="account-delete-btn" onClick={() => setConfirmDelete(true)}>
              Delete my data
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
