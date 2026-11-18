import { useEffect, useState } from "react";
import { getSession, isCloudConfigured, onAuthStateChange } from "../utils/auth";
import { fetchDrawingPrompts } from "../utils/drawingPrompts";
import { safeSignInReturn } from "../utils/signInReturn";

export default function PrivatePromptStudio({ Studio, idea, prompt }) {
  const [token, setToken] = useState(isCloudConfigured ? undefined : "");
  const [result, setResult] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const returnPath = safeSignInReturn("/draw?" + new URLSearchParams(idea === null ? { prompt } : { idea }));
  // Validate before admission. A later token refresh must not tear down an
  // open local canvas and discard the artist's work.
  const admitted = result?.state === "ready";

  useEffect(() => {
    if (!isCloudConfigured || admitted) return undefined;
    let active = true;
    const update = (session) => { if (active) setToken(session?.access_token || ""); };
    getSession().then(update);
    const unsubscribe = onAuthStateChange(update);
    return () => { active = false; unsubscribe(); };
  }, [admitted]);

  useEffect(() => {
    if (admitted || !returnPath || (isCloudConfigured && !token)) return undefined;
    const controller = new AbortController();
    async function load() {
      try {
        // The catalog also validates the session on legacy text-based links.
        const prompts = (isCloudConfigured || idea !== null) ? await fetchDrawingPrompts(token, controller.signal) : [];
        const text = idea === null ? prompt : prompts.find((entry) => entry.id === idea)?.text;
        if (!controller.signal.aborted) setResult({ token, attempt, state: text ? "ready" : "missing", text });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ token, attempt, state: error.status === 401 && isCloudConfigured ? "expired" : "error" });
      }
    }
    load();
    return () => controller.abort();
  }, [admitted, returnPath, idea, prompt, token, attempt]);

  const current = result?.token === token && result?.attempt === attempt ? result : null;
  if (admitted) return <Studio initialLocal initialPrompt={result.text} />;

  let title = "Opening your drawing prompt…";
  let message;
  let action;
  if (!returnPath || current?.state === "missing") {
    title = "This drawing prompt is unavailable";
    message = "You can still start with a blank canvas.";
  } else if ((isCloudConfigured && token === "") || current?.state === "expired") {
    const expired = current?.state === "expired";
    title = expired ? "Please sign in again" : "Sign in for this drawing prompt";
    message = "Your idea will open on a private canvas after you sign in.";
    const signin = "/signup?" + new URLSearchParams({ mode: "login", return: returnPath, ...(expired ? { reauth: "1" } : {}) });
    action = <a className="primary-action" href={signin}>Sign in</a>;
  } else if (current?.state === "error") {
    title = "Your drawing prompt couldn’t load";
    message = "Check your connection and try again.";
    action = <button type="button" className="primary-action" onClick={() => setAttempt((value) => value + 1)}>Try again</button>;
  }

  return <main className="route-status">
    <h1 aria-live="polite">{title}</h1>
    {message && <p>{message}</p>}
    {action}
    <a href="/draw">Open a blank canvas</a>
  </main>;
}
