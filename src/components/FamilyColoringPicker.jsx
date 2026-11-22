import { useEffect, useRef, useState } from "react";
import { AI_COLORING_CONSENT_VERSION, COLORING_DETAILS, COLORING_IDEAS, MAX_COLORING_PROMPT } from "../data/aiColoring";
import "./family-coloring.css";

function validPage(page) {
  return typeof page?.id === "string" && /^ai_[a-z0-9]+$/i.test(page.id)
    && typeof page.image === "string" && page.image.startsWith("data:image/png;base64,");
}

function problemMessage(code, stage) {
  switch (code) {
    case "content_blocked":
      if (stage === "image") return "The picture didn’t pass the safety check. Try another scene.";
      if (stage === "prompt") return "That description didn’t pass the safety check. Try a family-friendly scene.";
      return "This page didn’t pass the safety check. Try a different idea.";
    case "consent_required": return "The generator has changed. Reload the studio to review how it uses your description.";
    case "unusable_page": return "The picture didn’t have enough clear outlines to color. Try another description.";
    case "page_removed": return "A moderator removed this coloring page.";
    case "attempt_limit": return "This account has reached its generation attempt limit until next month.";
    case "invalid_recipe": return "Enter a description and choose a detail level.";
    case "monthly_limit": return "You’ve used this month’s pages. Your allowance renews next month.";
    case "rate_limited": return "Please wait a little before generating another page.";
    case "busy": return "A page is already being made. Check again in a moment.";
    case "storage_full": return "There’s no space for a new page right now. Try again later.";
    case "unavailable": return "The generator is currently unavailable. The coloring library is open.";
    default: return "Your page couldn’t be loaded. Try again with this idea.";
  }
}

export default function FamilyColoringPicker({ roomCode, token, onApply, removedAiSheets, children }) {
  const [availability, setAvailability] = useState(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const [check, setCheck] = useState(0);
  const [creating, setCreating] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [detail, setDetail] = useState(COLORING_DETAILS[0].id);
  const [preview, setPage] = useState(null);
  const removed = Boolean(preview && removedAiSheets?.has(preview.id));
  const page = removed ? null : preview;
  const [editing, setEditing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [canCheckLatest, setCanCheckLatest] = useState(false);
  const idea = useRef(0);
  const generation = useRef(null);
  const generationNumber = useRef(0);
  const retryRequest = useRef(null);
  const url = `/api/rooms/${encodeURIComponent(roomCode)}/ai-coloring`;

  useEffect(() => {
    // Also discard a late HTTP result if its removal won the race over WS.
    if (!removed) return;
    setPage(null);
    setEditing(true);
    setCanCheckLatest(false);
    setProblem(problemMessage("page_removed"));
  }, [removed]);

  useEffect(() => {
    const controller = new AbortController();
    const version = generationNumber.current;
    setCheckFailed(false);
    fetch(url, {
      headers: { Authorization: "Bearer " + token }, cache: "no-store", signal: controller.signal,
    }).then(async response => {
      if ([401, 403, 404].includes(response.status)) return { enabled: false };
      if (!response.ok) throw new Error("check_failed");
      return response.json();
    }).then(data => {
      if (controller.signal.aborted || version !== generationNumber.current) return;
      setAvailability({ enabled: data.enabled, remaining: data.remaining, limit: data.limit, attemptsRemaining: data.attemptsRemaining });
      if (validPage(data.page)) {
        setProblem("");
        setCanCheckLatest(false);
        setPage(data.page);
        setEditing(false);
      }
    }).catch(() => {
      if (!controller.signal.aborted && version === generationNumber.current) setCheckFailed(true);
    });
    return () => controller.abort();
  }, [url, token, check]);

  useEffect(() => () => generation.current?.abort(), []);

  const generate = async event => {
    event.preventDefault();
    const description = prompt.trim();
    if (!description || !availability?.enabled || availability.remaining <= 0 || availability.attemptsRemaining === 0 || generation.current) return;
    const body = JSON.stringify({ prompt: description, detail, consentVersion: AI_COLORING_CONSENT_VERSION });
    // An interrupted response can follow a successful, billable generation.
    // Keep its key for an explicit retry of the same request.
    if (retryRequest.current?.body !== body) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      retryRequest.current = { body, key: Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("") };
    }
    const controller = new AbortController();
    generation.current = controller;
    generationNumber.current += 1;
    setBusy(true);
    setCanCheckLatest(false);
    setProblem("");
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token, "Content-Type": "application/json",
          "Idempotency-Key": retryRequest.current.key,
        },
        body, signal: controller.signal, cache: "no-store",
      });
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (response.status === 401 || response.status === 403) {
        setAvailability({ enabled: false });
        setPage(null);
        setCreating(false);
        return;
      }
      if (!response.ok) {
        if (data.error === "page_removed") retryRequest.current = null;
        if (data.error === "monthly_limit") setAvailability(current => ({ ...current, remaining: 0 }));
        if (data.error === "attempt_limit") setAvailability(current => ({ ...current, attemptsRemaining: 0 }));
        setCanCheckLatest(data.error === "busy");
        setProblem(problemMessage(data.error, data.stage));
        return;
      }
      if (!validPage(data)) throw new Error("bad_page");
      retryRequest.current = null;
      setAvailability({ enabled: true, remaining: data.remaining, limit: data.limit, attemptsRemaining: data.attemptsRemaining });
      setPage({ id: data.id, title: data.title, image: data.image });
      setEditing(false);
    } catch {
      if (!controller.signal.aborted) {
        setProblem(problemMessage());
        setCanCheckLatest(true);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      generation.current = null;
    }
  };

  if (!availability?.enabled) return <>
    {checkFailed && <p className="ai-sheet-retry" role="status">
      Couldn’t check your Family pages. <button type="button" onClick={() => setCheck(n => n + 1)}>Try again</button>
    </p>}
    {children}
  </>;

  return <>
    <div className="ai-sheet-switch" role="group" aria-label="Coloring page source">
      <button type="button" aria-pressed={!creating} onClick={() => setCreating(false)}>Sheet library</button>
      <button type="button" aria-pressed={creating} onClick={() => setCreating(true)}>Make an AI page</button>
    </div>
    {!creating ? children : <div className="ai-sheet-body">
      <p className="ai-sheet-quota" role="status">
        {availability.attemptsRemaining === 0 && availability.remaining > 0 ? problemMessage("attempt_limit")
          : `Your paid Family plan has ${availability.remaining} of ${availability.limit} pages left this month.`}
      </p>
      {editing ? <form onSubmit={generate} className="ai-sheet-form">
        <label htmlFor="ai-sheet-prompt">What would you like to color?</label>
        <textarea id="ai-sheet-prompt" rows={3} maxLength={MAX_COLORING_PROMPT}
          value={prompt} disabled={busy} placeholder="A dragon tending a rooftop garden…"
          aria-describedby="ai-sheet-privacy" onChange={event => { setPrompt(event.target.value); setProblem(""); }} />
        <div className="ai-sheet-prompt-tools">
          <button type="button" disabled={busy} onClick={() => {
            setPrompt(COLORING_IDEAS[idea.current % COLORING_IDEAS.length]);
            idea.current += 1;
            setProblem("");
          }}>Try a drawing idea</button>
          <small>{prompt.length}/{MAX_COLORING_PROMPT}</small>
        </div>
        <label htmlFor="ai-sheet-detail">Line art detail</label>
        <select id="ai-sheet-detail" value={detail} disabled={busy} onChange={event => setDetail(event.target.value)}>
          {COLORING_DETAILS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
        <p className="ai-sheet-note" id="ai-sheet-privacy">For grown-ups. Choosing Generate sends this description to OpenRouter to check it and make one page. Site moderators can review your preview. Leave out names, contact details, sexual content and violence.</p>
        <div className="ai-sheet-actions">
          <button type="submit" className="primary-action" disabled={busy || !prompt.trim() || availability.remaining <= 0 || availability.attemptsRemaining === 0} aria-describedby="ai-sheet-privacy">
            {busy ? "Making your page…" : "Generate with OpenRouter"}
          </button>
          {page && <button type="button" disabled={busy} onClick={() => { setEditing(false); setProblem(""); }}>Back to preview</button>}
        </div>
        {busy && <p role="status" className="ai-sheet-note">Drawing the outlines and checking the image. This can take a minute.</p>}
      </form> : page && <div className="ai-sheet-result">
        <figure><img src={page.image} alt="Preview of your generated coloring page" /></figure>
        <div className="ai-sheet-actions">
          <button type="button" className="primary-action" onClick={() => onApply(page, true)}>Use in this room</button>
          <a href={page.image} download="drawesome-coloring-page.png">Download PNG</a>
        </div>
        {availability.remaining > 0 && availability.attemptsRemaining !== 0 && <button className="ai-sheet-another" type="button" onClick={() => { setEditing(true); setProblem(""); }}>Make another page</button>}
      </div>}
      {problem && <div role="alert" className="ai-sheet-problem">
        {problem}
        {canCheckLatest && <button type="button" className="ai-sheet-another" onClick={() => setCheck(n => n + 1)}>Check latest page</button>}
      </div>}
    </div>}
  </>;
}
