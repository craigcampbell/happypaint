// Sign-up / log-in page. Accounts are optional and only unlock saving your
// gallery across devices — drawing never requires one. Email + password is the
// primary path; Google appears only once it's configured in PocketBase.
import { useEffect, useState } from "react";
import SiteNav from "./SiteNav";
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
  signUpWithEmail,
} from "../utils/auth";

export default function SignupPage({ onNavigate }) {
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(isCloudConfigured ? "" : LOCAL_ONLY_MESSAGE);
  const [mode, setMode] = useState(() =>
    new URLSearchParams(window.location.search).get("mode") === "login" ? "login" : "signup",
  ); // "signup" | "login"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [oauthIds, setOauthIds] = useState([]);
  const returnPath = (() => {
    const requested = new URLSearchParams(window.location.search).get("return") || "";
    return requested === "/family" ? requested : "";
  })();
  const nextDrawingPath = () => {
    if (returnPath) return returnPath;
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 6; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    return `/join/${code}`;
  };
  // Age screen (COPPA hygiene): accounts are 13+ or parent/guardian-made.
  // "" until answered; signup stays disabled until one option is picked.
  const [ageBand, setAgeBand] = useState("");

  useEffect(() => {
    let active = true;
    getSession().then((v) => active && setSession(v));
    const unsub = onAuthStateChange((v) => active && setSession(v));
    getEnabledOAuthProviderIds().then((ids) => active && setOauthIds(ids));
    return () => {
      active = false;
      unsub();
    };
  }, []);

  const submitEmail = async (event) => {
    event.preventDefault();
    if (mode === "signup" && ageBand !== "13plus" && ageBand !== "parent") return;
    setBusy(true);
    setMessage("");
    const result = await (mode === "signup" ? signUpWithEmail : signInWithEmail)(email, password);
    setMessage(result.message);
    setBusy(false);
    if (result.ok) {
      // Keep the attestation on-device (what was answered + when) — the only
      // record we need, and nothing personal beyond a yes/no leaves the browser.
      try {
        window.localStorage.setItem(
          "drawesome:age-attestation:v1",
          JSON.stringify({ band: ageBand || "login", ts: Date.now() }),
        );
      } catch { /* best-effort */ }
      onNavigate(nextDrawingPath());
    }
  };

  const handleProvider = async (provider) => {
    // OAuth can CREATE an account too, so the age screen gates it in signup mode.
    if (mode === "signup" && ageBand !== "13plus" && ageBand !== "parent") {
      setMessage("Pick who this account is for first (13+ or parent-made).");
      return;
    }
    const popup = window.open("", "_blank", "width=520,height=680");
    setBusy(true);
    const result = await signInWithProvider(provider, popup);
    setMessage(result.message);
    setBusy(false);
    if (result.ok) onNavigate(nextDrawingPath());
  };

  const oauthProviders = OAUTH_PROVIDERS.filter((p) => oauthIds.includes(p.id));

  return (
    <div className="site-page">
      <SiteNav onNavigate={onNavigate} current="/signup" />
      <main className="site-page-body site-page-narrow">
        <h1>{mode === "signup" ? "Sign up — keep your art forever" : "Welcome back"}</h1>
        <p className="site-lead">
          You never need an account to draw. Make a free one to <strong>save your gallery</strong> and find
          it on any device.
        </p>

        <div className="signup-card">
          {session ? (
            <>
              <p className="signup-signedin">✅ Signed in as <strong>{sessionLabel(session)}</strong>.</p>
              <button type="button" className="primary-action" onClick={() => onNavigate(nextDrawingPath())}>
                🎨 Go paint
              </button>
            </>
          ) : (
            <>
              <form className="signup-form" onSubmit={submitEmail}>
                {mode === "signup" ? (
                  <fieldset className="signup-age" disabled={busy}>
                    <legend>Who is this account for?</legend>
                    <label>
                      <input
                        type="radio"
                        name="ageBand"
                        value="13plus"
                        checked={ageBand === "13plus"}
                        onChange={() => setAgeBand("13plus")}
                      />
                      <span>I&rsquo;m 13 or older</span>
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="ageBand"
                        value="parent"
                        checked={ageBand === "parent"}
                        onChange={() => setAgeBand("parent")}
                      />
                      <span>I&rsquo;m a parent/guardian making this for my kid</span>
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="ageBand"
                        value="under13"
                        checked={ageBand === "under13"}
                        onChange={() => setAgeBand("under13")}
                      />
                      <span>I&rsquo;m under 13</span>
                    </label>
                    {ageBand === "under13" ? (
                      <p className="signup-age-note">
                        No account needed — you can draw everything as a guest! If you want art saved across
                        devices, ask a parent or guardian to make the account with you. 💛
                      </p>
                    ) : null}
                  </fieldset>
                ) : null}
                <label className="signup-field">
                  <span>Email</span>
                  <input
                    type="email"
                    value={email}
                    autoComplete="email"
                    placeholder="you@example.com"
                    onChange={(e) => setEmail(e.target.value)}
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
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </label>
                <button
                  type="submit"
                  className="primary-action signup-submit"
                  disabled={busy || !isCloudConfigured || (mode === "signup" && ageBand !== "13plus" && ageBand !== "parent")}
                >
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

              {oauthProviders.length ? (
                <>
                  <div className="signup-or"><span>or</span></div>
                  {oauthProviders.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="signup-google"
                      onClick={() => handleProvider(p.id)}
                      disabled={busy}
                    >
                      {p.label}
                    </button>
                  ))}
                </>
              ) : null}

              {!isCloudConfigured ? <p className="account-note compliance">{LOCAL_ONLY_MESSAGE}</p> : null}
              <button type="button" className="signup-guest" onClick={() => onNavigate(nextDrawingPath())}>
                Keep drawing as a guest →
              </button>
            </>
          )}
          {message ? <p className="account-status">{message}</p> : null}
        </div>

        <ul className="signup-perks">
          <li>🖼️ Your gallery saved to your account</li>
          <li>📱 Open your art on any device</li>
          <li>🛡️ No behavioral ads or child-facing buys; delete anytime</li>
        </ul>
      </main>
    </div>
  );
}
