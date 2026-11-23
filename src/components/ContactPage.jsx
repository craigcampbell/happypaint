import { useEffect, useRef, useState } from "react";
import SiteFooter from "./SiteFooter";
import SiteNav from "./SiteNav";
import "./contact-page.css";

const topics = {
  general: "General question or feedback",
  bug: "Something isn’t working",
  billing: "Jam Pass or billing",
  safety: "Safety concern",
  privacy: "Privacy or data",
};

const errors = {
  invalid_topic: "Choose a topic for your message.",
  invalid_message: "Use between 10 and 2,000 characters for your message.",
  invalid_email: "Check the reply email or leave it empty.",
  invalid_challenge: "That answer was incorrect or the question expired. Try the new question.",
  rate_limited: "Too many attempts. Please wait a few minutes before trying again.",
  email_unavailable: "Email is currently unavailable. You can send a message to the site inbox.",
  inbox_unavailable: "The inbox is temporarily unavailable. Please try again later.",
};

export default function ContactPage({ onNavigate }) {
  const [topic, setTopic] = useState(() => {
    const requested = new URLSearchParams(window.location.search).get("topic");
    return Object.hasOwn(topics, requested) ? requested : "general";
  });
  const [method, setMethod] = useState("email");
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState("");
  const [emailAvailable, setEmailAvailable] = useState(null);
  const [address, setAddress] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [check, setCheck] = useState(null);
  const [checkVersion, setCheckVersion] = useState(0);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const lastAttempt = useRef(null);
  const confirmation = useRef(null);
  const answerInput = useRef(null);
  const formMessage = useRef(null);
  const addressText = useRef(null);
  const focusAnswer = useRef(false);
  const emailMethod = method === "email";
  const showAddress = emailMethod && Boolean(address);
  const needsCheck = !sent && !showAddress;

  useEffect(() => {
    if (!needsCheck) return;
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    async function load() {
      setCheck(null);
      try {
        const response = await fetch("/api/contact/challenge", {
          cache: "no-store", credentials: "omit", signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok || !result.challengeId || !result.question) {
          throw new Error(errors[result?.error] || "The question couldn’t load. Please try again.");
        }
        if (active) {
          setEmailAvailable(result.emailAvailable);
          if (!result.emailAvailable) setMethod("inbox");
          setCheck(result);
        }
      } catch (err) {
        if (active) setCheck({ error: err.name === "AbortError" || err instanceof TypeError
          ? "The question couldn’t load. Check your connection and try again." : err.message });
      } finally {
        clearTimeout(timeout);
      }
    }
    load();
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [needsCheck, checkVersion]);

  useEffect(() => {
    if (sent || showAddress) confirmation.current?.focus();
  }, [sent, showAddress]);

  useEffect(() => {
    if (check?.challengeId && focusAnswer.current) {
      answerInput.current?.focus();
      focusAnswer.current = false;
    }
  }, [check]);

  function newQuestion() {
    focusAnswer.current = true;
    setCheck(null);
    setCheckVersion(version => version + 1);
  }

  async function submit(event) {
    event.preventDefault();
    if (pending.current || !needsCheck || !check?.challengeId) return;
    const form = event.currentTarget;
    const verification = { challengeId: check.challengeId, answer: form.elements.answer.value.trim() };
    let data = verification;
    if (!emailMethod) {
      const clean = message.trim();
      if (clean.length < 10) {
        form.elements.message.setCustomValidity(errors.invalid_message);
        form.elements.message.reportValidity();
        return;
      }
      const note = { topic, message: clean, email: reply.trim(), website: form.elements.website.value };
      // A lost response can be retried with a fresh question and the same note ID.
      const content = JSON.stringify(note);
      if (content !== lastAttempt.current?.content) {
        const id = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)),
          byte => byte.toString(16).padStart(2, "0")).join("");
        lastAttempt.current = { content, id };
      }
      data = { ...note, ...verification, requestId: lastAttempt.current.id };
    }

    pending.current = true;
    setSending(true);
    setError("");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(emailMethod ? "/api/contact/email" : "/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify(data),
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok || (emailMethod ? !result?.email : result?.ok !== true)) {
        if (result?.error === "email_unavailable") {
          setEmailAvailable(false);
          setMethod("inbox");
          newQuestion();
        } else if (result?.error === "invalid_challenge") {
          newQuestion();
        }
        setError(errors[result?.error] || "Please try again in a moment.");
        return;
      }
      if (emailMethod) {
        setCheck(null);
        setAddress(result.email);
      } else {
        lastAttempt.current = null;
        setSent(true);
      }
    } catch {
      setError(emailMethod ? "We couldn’t load the address. Check your connection and try again."
        : "We couldn’t confirm delivery. Check your connection and try again.");
    } finally {
      clearTimeout(timeout);
      pending.current = false;
      setSending(false);
    }
  }

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(address);
      setCopyStatus("Email address copied.");
    } catch {
      addressText.current.focus();
      addressText.current.select();
      setCopyStatus("Address selected. Use your device’s Copy command.");
    }
  }

  const draft = new URLSearchParams({ subject: `Drawesome — ${topics[topic]}` });
  if (message.trim()) draft.set("body", message.trim().replace(/\r?\n/g, "\r\n"));
  const mailto = address && `mailto:${address}?${draft.toString().replace(/\+/g, "%20")}`;

  return (
    <div className="site-page field-guide contact-page">
      <SiteNav current="/contact" onNavigate={onNavigate} />
      <main className="contact-main">
        <header className="contact-intro">
          <h1>Contact the team</h1>
          <p>Have a question about Drawesome or an idea for the studio? Send a private note to the people who run it.</p>
        </header>

        {sent ? (
          <section className="contact-paper contact-receipt">
            <h2 tabIndex={-1} ref={confirmation}>Message received</h2>
            <p>Your message is in the Drawesome team’s private admin inbox.</p>
            <a href="/">Back to Drawesome</a>
          </section>
        ) : (
          <form method="post" action="/api/contact" className="contact-paper" onSubmit={submit} aria-label="Contact the Drawesome team" aria-busy={sending}>
            <fieldset disabled={sending}>
              {emailAvailable && <fieldset className="contact-method">
                <legend>How would you like to get in touch?</legend>
                {["email", "inbox"].map(value => (
                  <label key={value}>
                    <input type="radio" name="method" value={value} checked={method === value}
                      onChange={() => {
                        setMethod(value);
                        setError("");
                        setCopyStatus("");
                        if (formMessage.current) formMessage.current.setCustomValidity("");
                      }} />
                    {value === "email" ? "Email the team" : "Use the site inbox"}
                  </label>
                ))}
              </fieldset>}
              <p className="contact-hint contact-method-hint">{emailAvailable === null ? "Checking contact options…" : emailMethod
                ? "Reveal our address and send from your own email app."
                : "Send a private message from this page. A reply email is optional."}</p>

              <label htmlFor="contact-topic">Topic</label>
              <select id="contact-topic" name="topic" value={topic} onChange={event => setTopic(event.target.value)}>
                {Object.entries(topics).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>

              <label htmlFor="contact-message">Your message {emailMethod && <span>(optional draft)</span>}</label>
              <p className="contact-hint" id="contact-message-hint">Please leave out names, room codes, passwords and payment details.</p>
              <textarea id="contact-message" name="message" rows={4} minLength={emailMethod ? undefined : 10} maxLength={2000}
                ref={formMessage} required={!emailMethod} value={message} aria-describedby="contact-message-hint"
                onChange={event => { event.currentTarget.setCustomValidity(""); setMessage(event.target.value); }} />

              {!emailMethod && <>
                <label htmlFor="contact-email">Reply email <span>(optional)</span></label>
                <p className="contact-hint" id="contact-email-hint">For a reply, a grown-up can leave their email here.</p>
                <input id="contact-email" type="email" name="email" value={reply} onChange={event => setReply(event.target.value)}
                  maxLength={254} autoComplete="email" aria-describedby="contact-email-hint" />
              </>}
              <div hidden>
                <label htmlFor="contact-website">Website</label>
                <input id="contact-website" name="website" type="text" autoComplete="off" tabIndex={-1} />
              </div>

              {showAddress ? (
                <div className="contact-address">
                  <h2 ref={confirmation} tabIndex={-1}>Email the team</h2>
                  <p>Send your draft in your email app, or copy the address into webmail.</p>
                  <label htmlFor="contact-team-email">Team email address</label>
                  <div className="contact-copy">
                    <input id="contact-team-email" type="text" readOnly ref={addressText} value={address} />
                    <button type="button" onClick={copyAddress}>Copy address</button>
                  </div>
                  <p role="status" className="contact-copy-status">{copyStatus}</p>
                  <a className="contact-send" href={mailto}>Open email app</a>
                </div>
              ) : (
                <>
                  <div className="contact-check">
                    <span className="contact-check-title">Spam check</span>
                    {check?.question ? <>
                      <label htmlFor="contact-answer">{check.question}</label>
                      <input key={check.challengeId} id="contact-answer" name="answer" ref={answerInput} type="text"
                        inputMode="numeric" pattern="[0-9]+" maxLength={4} autoComplete="off" required />
                    </> : check?.error ? (
                      <>
                        <p className="contact-error" role="alert">{check.error}</p>
                        <button type="button" className="contact-retry" onClick={newQuestion}>Try loading the question again</button>
                      </>
                    ) : <p role="status">Loading question…</p>}
                  </div>
                  {error && <p className="contact-error" role="alert">{error}</p>}
                  <button type="submit" className="contact-send" disabled={!check?.challengeId || sending}>
                    {emailMethod ? (sending ? "Checking…" : "Show email address") : (sending ? "Sending…" : "Send to admin inbox")}
                  </button>
                </>
              )}
            </fieldset>
          </form>
        )}

        <aside className="contact-help" aria-label="Reporting and privacy">
          <h2>Something happened in a room?</h2>
          <p>Use <strong>Report</strong> in the room so moderators can review it. If you feel unsafe, leave and tell a trusted adult.</p>
          <a href="/privacy">How we handle your information</a>
        </aside>
      </main>
      <SiteFooter onNavigate={onNavigate} />
    </div>
  );
}
