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
  rate_limited: "You’ve sent several messages recently. Please wait before sending another.",
  inbox_unavailable: "The inbox is temporarily unavailable. Please try again later.",
};

export default function ContactPage({ onNavigate }) {
  const topic = new URLSearchParams(window.location.search).get("topic");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const lastAttempt = useRef(null);
  const confirmation = useRef(null);

  useEffect(() => {
    if (sent) confirmation.current?.focus();
  }, [sent]);

  async function submit(event) {
    event.preventDefault();
    if (pending.current) return;
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    data.message = data.message.trim();
    data.email = data.email.trim();
    if (data.message.length < 10) {
      form.elements.message.setCustomValidity(errors.invalid_message);
      form.elements.message.reportValidity();
      return;
    }

    pending.current = true;
    setSending(true);
    setError("");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      // Keep the same ID when retrying a submission whose response was lost.
      const content = JSON.stringify(data);
      if (content !== lastAttempt.current?.content) {
        const id = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)),
          byte => byte.toString(16).padStart(2, "0")).join("");
        lastAttempt.current = { content, id };
      }
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify({ ...data, requestId: lastAttempt.current.id }),
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok || result?.ok !== true) {
        setError(errors[result?.error] || "We couldn’t confirm delivery. Please try again.");
        return;
      }
      lastAttempt.current = null;
      setSent(true);
    } catch {
      setError("We couldn’t confirm delivery. Check your connection and try again.");
    } finally {
      clearTimeout(timeout);
      pending.current = false;
      setSending(false);
    }
  }

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
            <p>Your message is in the Drawesome team’s inbox.</p>
            <a href="/">Back to Drawesome</a>
          </section>
        ) : (
          <form method="post" action="/api/contact" className="contact-paper" onSubmit={submit} aria-label="Contact the Drawesome team" aria-busy={sending}>
            <fieldset disabled={sending}>
              <label htmlFor="contact-topic">Topic</label>
              <select id="contact-topic" name="topic" defaultValue={Object.hasOwn(topics, topic) ? topic : "general"}>
                {Object.entries(topics).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>

              <label htmlFor="contact-message">Your message</label>
              <p className="contact-hint" id="contact-message-hint">Please leave out names, room codes, passwords and payment details.</p>
              <textarea id="contact-message" name="message" rows={5} minLength={10} maxLength={2000}
                required aria-describedby="contact-message-hint" onInput={event => event.currentTarget.setCustomValidity("")} />

              <label htmlFor="contact-email">Reply email <span>(optional)</span></label>
              <p className="contact-hint" id="contact-email-hint">For a reply, a grown-up can leave their email here.</p>
              <input id="contact-email" type="email" name="email" maxLength={254} autoComplete="email" aria-describedby="contact-email-hint" />
              <div hidden>
                <label htmlFor="contact-website">Website</label>
                <input id="contact-website" name="website" type="text" autoComplete="off" tabIndex={-1} />
              </div>
              {error && <p className="contact-error" role="alert">{error}</p>}
              <button type="submit" className="contact-send">{sending ? "Sending…" : "Send message"}</button>
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
