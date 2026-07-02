// Safety & FAQ — a plain-language page parents and kids can read to understand
// exactly how Drawesome keeps rooms kind, what data we keep, and how to get help.
// Written to match how the app actually works today (not aspirational).
import SiteNav from "./SiteNav";

function QA({ q, children }) {
  return (
    <details className="faq-item">
      <summary>{q}</summary>
      <div className="faq-answer">{children}</div>
    </details>
  );
}

export default function FaqPage({ onNavigate }) {
  return (
    <div className="site-page">
      <SiteNav onNavigate={onNavigate} current="/faq" />
      <main className="site-page-body">
        <h1>Safety &amp; FAQ <span aria-hidden="true">🛟</span></h1>
        <p className="site-lead">
          Drawesome is a paint-together studio for kids and teens. Here’s exactly how it works, how we
          keep rooms kind, and how to get help. If you’re a grown-up deciding whether it’s okay for your
          kid — this page is for you.
        </p>

        <QA q="Is Drawesome safe for my kid?">
          <p>
            <strong>Public rooms</strong> (the ones on the home page and in “Find a room”) are auto-moderated:
            chat is filtered for bad words, drawings are scanned for inappropriate images when a capable
            device is present, hosts can mute / remove / hide, and anyone can report with one tap.
          </p>
          <p>
            <strong>Private rooms</strong> — the ones you make by sharing a short code — are meant for people
            you already know. Serious/explicit chat is still blocked everywhere, but private rooms are
            <em> not</em> fully auto-moderated the way public rooms are. Only share a room code with friends
            you trust. Every private room shows a “not auto-moderated” reminder at the top.
          </p>
        </QA>

        <QA q="Do you need an account?">
          <p>
            No. Drawing is guest-friendly — tap in and paint. A free account only saves your gallery and lets
            you find it on another device. You can play the whole app signed out.
          </p>
        </QA>

        <QA q="How old should you be?">
          <p>
            Drawesome is made for kids and teens. If you’re a younger kid, please make sure a parent or
            guardian is okay with you drawing online with others. Grown-ups: you know your kid best — the
            <a href="/privacy" onClick={(e) => { e.preventDefault(); onNavigate("/privacy"); }}> Privacy page</a> lists
            exactly what we store.
          </p>
        </QA>

        <QA q="What information do you collect — and can I delete it?">
          <p>
            We keep things minimal and local-first: your drawings and settings live on your device, and
            signed-in accounts store a gallery. You can <strong>delete your account and data anytime</strong> from
            the profile menu (the avatar) inside the studio — that also scrubs your chat messages from our
            servers. See the <a href="/privacy" onClick={(e) => { e.preventDefault(); onNavigate("/privacy"); }}>Privacy page</a> for details.
          </p>
        </QA>

        <QA q="How do I report something bad?">
          <p>
            Every room has a <strong>Report</strong> button (⚠️). Tell us what’s wrong and it goes straight to
            our moderators — reports that mention anything urgent (like someone asking to meet up or share
            contacts) are pushed to the top of the queue. You’ll get a “report sent” confirmation.
          </p>
        </QA>

        <QA q="Someone is bugging me — can I block them?">
          <p>
            Yes. You can hide a specific person’s chat and cursor just for you, without waiting for a host.
            Room hosts can also mute or remove someone for everyone.
          </p>
        </QA>

        <QA q="What are the rules? (Be kind!)">
          <ul>
            <li>Be friendly — you’re drawing <em>with</em> people, not at them.</li>
            <li>No mean, gross, scary, or grown-up content.</li>
            <li>Never share your real name, address, school, phone, or socials — and don’t ask others for theirs.</li>
            <li>Don’t wreck other people’s art on purpose.</li>
            <li>If something feels wrong, tell a grown-up and use Report.</li>
          </ul>
        </QA>

        <QA q="Who runs Drawesome? How do I reach you?">
          <p>
            We’re a small team. For anything safety-related — a report that needs a human, a privacy request,
            or a worry — email <a href="mailto:safety@drawesome.art">safety@drawesome.art</a>.
          </p>
        </QA>

        <div className="site-page-actions">
          <button type="button" className="primary-action" onClick={() => onNavigate("/studio")}>🎨 Start painting</button>
          <button type="button" onClick={() => onNavigate("/safety")}>Safety</button>
          <button type="button" onClick={() => onNavigate("/privacy")}>Privacy</button>
          <button type="button" onClick={() => onNavigate("/about")}>About</button>
        </div>
      </main>
    </div>
  );
}
