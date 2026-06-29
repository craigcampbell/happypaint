// Sign-up / log-in page. Accounts are optional and only unlock saving your
// gallery across devices — drawing never requires one.
import { useEffect, useState } from "react";
import SiteNav from "./SiteNav";
import {
  LOCAL_ONLY_MESSAGE,
  OAUTH_PROVIDERS,
  getSession,
  isCloudConfigured,
  onAuthStateChange,
  sessionLabel,
  signInWithProvider,
} from "../utils/auth";

export default function SignupPage({ onNavigate }) {
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(isCloudConfigured ? "" : LOCAL_ONLY_MESSAGE);

  useEffect(() => {
    let active = true;
    getSession().then((v) => active && setSession(v));
    const unsub = onAuthStateChange((v) => active && setSession(v));
    return () => {
      active = false;
      unsub();
    };
  }, []);

  const handleProvider = async (provider) => {
    // Open the popup synchronously on tap so Safari doesn't block it.
    const popup = window.open("", "_blank", "width=520,height=680");
    setBusy(true);
    const result = await signInWithProvider(provider, popup);
    setMessage(result.message);
    setBusy(false);
  };

  return (
    <div className="site-page">
      <SiteNav onNavigate={onNavigate} current="/signup" />
      <main className="site-page-body site-page-narrow">
        <h1>Sign up — keep your art forever</h1>
        <p className="site-lead">
          You never need an account to draw. Make a free one to <strong>save your gallery</strong> and find
          it on any device.
        </p>

        <div className="signup-card">
          {session ? (
            <>
              <p className="signup-signedin">✅ Signed in as <strong>{sessionLabel(session)}</strong>.</p>
              <button type="button" className="primary-action" onClick={() => onNavigate("/studio")}>
                🎨 Go paint
              </button>
            </>
          ) : (
            <>
              {OAUTH_PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="primary-action signup-google"
                  onClick={() => handleProvider(p.id)}
                  disabled={busy || !isCloudConfigured}
                >
                  {p.label}
                </button>
              ))}
              {!isCloudConfigured ? <p className="account-note compliance">{LOCAL_ONLY_MESSAGE}</p> : null}
              <button type="button" className="signup-guest" onClick={() => onNavigate("/studio")}>
                Keep drawing as a guest →
              </button>
            </>
          )}
          {message ? <p className="account-status">{message}</p> : null}
        </div>

        <ul className="signup-perks">
          <li>🖼️ Your gallery saved to your account</li>
          <li>📱 Open your art on any device</li>
          <li>🛡️ No ads, no real-money buys, delete anytime</li>
        </ul>
      </main>
    </div>
  );
}
