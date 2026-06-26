// Account / Auth panel — sign-in state + OPTIONAL sign-in + in-app account
// deletion. Login is optional (the app fully works signed out); auth only gates
// future sync/social. When cloud sync isn't configured we say so plainly.
//
// Account deletion is free, always available, and never gated (App Review +
// compliance). It records an account_deletion_requests row and wipes all local
// stores via utils/accountDeletion.

import { useEffect, useState } from "react";
import {
  LOCAL_ONLY_MESSAGE,
  OAUTH_PROVIDERS,
  getSession,
  isCloudConfigured,
  onAuthStateChange,
  sessionLabel,
  signInWithEmail,
  signInWithProvider,
  signOut,
} from "../utils/auth";
import { deleteAccountAndData, getDeletionRequest } from "../utils/accountDeletion";
import { getSyncStatus, onSyncStatus } from "../utils/sync";

export default function AccountPanel({ onClose, onDeleted }) {
  const [session, setSession] = useState(null);
  const [email, setEmail] = useState("");
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

  const handleEmail = async () => {
    setBusy(true);
    const result = await signInWithEmail(email);
    setMessage(result.message);
    setBusy(false);
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
    setMessage(
      `Your data was deleted from this device (${result.cleared.length} stores cleared). ` +
        `A deletion request was filed; full purge scheduled by ${new Date(
          result.request.scheduled_purge_at,
        ).toLocaleDateString()}.`,
    );
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
                Signing in is <strong>optional</strong> — Happy Paint works fully without an account.
                {" "}
                An account only unlocks cross-device sync and social features later.
              </p>
              {!isCloudConfigured ? (
                <p className="account-note compliance">{LOCAL_ONLY_MESSAGE}</p>
              ) : null}
              <label className="color-picker">
                <span>Email magic link</span>
                <input
                  type="email"
                  value={email}
                  placeholder="you@example.com"
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <div className="account-actions">
                <button
                  type="button"
                  className="primary-action"
                  onClick={handleEmail}
                  disabled={busy || !isCloudConfigured}
                >
                  Send magic link
                </button>
                {OAUTH_PROVIDERS.map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    onClick={() => handleProvider(provider.id)}
                    disabled={busy || !isCloudConfigured}
                  >
                    {provider.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {message ? <p className="account-status">{message}</p> : null}

        <div className="ps-group account-section account-danger">
          <h3>Delete my data &amp; account</h3>
          <p className="account-note">
            Deleting is <strong>free</strong> and <strong>always available</strong> — it isn&apos;t gated by
            an account, a purchase, or anything else. This removes your drawings, gallery, Paint Space,
            wallet, AI consent, replays, and brush packs from this device, files a deletion request, and
            signs you out.
          </p>
          {deletion ? (
            <p className="account-note compliance">
              Deletion requested {new Date(deletion.requested_at).toLocaleString()} · full purge scheduled
              by {new Date(deletion.scheduled_purge_at).toLocaleDateString()}.
            </p>
          ) : null}
          {confirmDelete ? (
            <div className="account-actions">
              <button type="button" className="account-delete-confirm" onClick={handleDelete} disabled={busy}>
                Yes, delete everything
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
