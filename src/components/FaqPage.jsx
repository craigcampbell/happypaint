// Safety & FAQ, a plain-language page parents and kids can read to understand
// exactly how Drawesome keeps rooms kind, what data we keep, and how to get help.
// Written to match how the app actually works today (not aspirational).
import GuideLinks from "./GuideLinks";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";

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
    <div className="site-page field-guide">
      <SiteNav onNavigate={onNavigate} current="/faq" />
      <main className="site-page-body guide-body">
        <h1>Common questions</h1>
        <p className="site-lead">
          Find out who can join your canvas, how to keep a drawing, and where to get help if something goes wrong in a room.
        </p>

        <GuideLinks current="/faq" onNavigate={onNavigate} />

        <QA q="Is Drawesome safe for my kid?">
          <p>
            <strong>Public rooms</strong> have moderation tools.
            Chat is filtered for bad words, drawings are scanned for inappropriate images when a capable
            device is present, hosts can mute / remove / hide, and anyone can report with one tap.
          </p>
          <p>These tools can miss harmful content. For younger artists, start in a private room with people you know and an adult present.</p>
          <p>
            <strong>Private rooms</strong>, the ones you make by sharing a short code, are meant for people
            you already know. Serious/explicit chat is filtered everywhere. Private rooms are unlisted,
            and a forwarded link or code lets someone else try to enter. Keep invitations with people you trust.
          </p>
        </QA>

        <QA q="Who can see a public room?">
          <p>Anyone can join a public room. Its artwork, chat, and display names can also appear in public room previews. Use a nickname and do not share personal details in drawings or chat. Private rooms do not allow the public spectator connection.</p>
        </QA>

        <QA q="Who are Pip and Fern?">
          <p>They’re drawing bots in the recorded homepage demo. To paint with other visitors, choose <strong>Join an Art Jam</strong>. Open Rooms inside the studio to try another public canvas.</p>
        </QA>

        <QA q="Can I email a drawing?">
          <p>Download your drawing and attach the image to an email. In a private Art Jam hosted by a Jam Pass member, you can also turn the canvas into an art postcard with a personal note. <a href="/jam-pass">Explore Jam Pass</a>.</p>
        </QA>

        <QA q="Do you need an account?">
          <p>
            You can draw solo or join a public canvas as a guest. On a site with accounts enabled, sign in to use friend lists and invite-only rooms or sync your gallery across devices.
          </p>
        </QA>

        <QA q="How old should you be?">
          <p>
            Drawesome is made for kids and teens. If you’re a younger kid, please make sure a parent or
            guardian is okay with you drawing online with others. Grown-ups: you know your kid best, the
            <a href="/privacy" onClick={(e) => { e.preventDefault(); onNavigate("/privacy"); }}> Privacy page</a> lists
            exactly what we store.
          </p>
        </QA>

        <QA q="What information do you collect, and can I delete it?">
          <p>
            Settings and drafts can live on your device. Shared-room drawings and chat, server-saved art,
            and public Wall posts also use server storage, including when you are signed out. The Account
            panel offers deletion options. See the <a href="/privacy" onClick={(e) => { e.preventDefault(); onNavigate("/privacy"); }}>Privacy page</a> for storage and deletion details.
          </p>
        </QA>

        <QA q="How do I report something bad?">
          <p>
            Use the <strong>Report</strong> control in the room. A successful submission sends your concern
            for review and shows a confirmation. This does not guarantee an immediate response; leave the
            room and tell a trusted adult if something feels wrong.
          </p>
        </QA>

        <QA q="Someone is bugging me, can I block them?">
          <p>
            Yes. You can hide a specific person’s chat and cursor just for you, without waiting for a host.
            Room hosts can also mute or remove someone for everyone.
          </p>
        </QA>

        <QA q="What are the rules? (Be kind!)">
          <ul>
            <li>Be friendly, you’re drawing <em>with</em> people, not at them.</li>
            <li>No mean, gross, scary, or grown-up content.</li>
            <li>Never share your real name, address, school, phone, or socials, and don’t ask others for theirs.</li>
            <li>Don’t wreck other people’s art on purpose.</li>
            <li>If something feels wrong, tell a grown-up and use Report.</li>
          </ul>
        </QA>

        <QA q="Who runs Drawesome? How do I reach you?">
          <p>
            We’re a small team. For anything safety-related, a report that needs a human, a privacy request,
            or a worry, email <a href="mailto:safety@drawesome.art">safety@drawesome.art</a>.
          </p>
        </QA>

        <div className="site-page-actions">
          <button type="button" className="primary-action" onClick={() => onNavigate("/studio")}>🎨 Start painting</button>
          <button type="button" onClick={() => onNavigate("/safety")}>Safety</button>
          <button type="button" onClick={() => onNavigate("/privacy")}>Privacy</button>
          <button type="button" onClick={() => onNavigate("/about")}>About</button>
        </div>
      </main>
      <SiteFooter onNavigate={onNavigate} />
    </div>
  );
}
