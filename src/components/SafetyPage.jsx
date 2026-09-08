// Plain-language safety + data page for parents/guardians. Everything stated
// here reflects shipped behaviour (anonymous-first, public-room moderation,
// play-money only, no public people search, local-first storage, account
// deletion). Keep it honest — do not claim features that aren't live.

const SAFETY = [
  {
    icon: "👧",
    title: "Draw without an account",
    body: "Start drawing, coloring, and painting together without signing up or entering an email address. Optional accounts, when available, add gallery sync and persistent room ownership. Younger artists should draw with an adult present.",
  },
  {
    icon: "🛡️",
    title: "Understand the limits of moderation",
    body: "Public chat is filtered. Image scanning depends on a capable participant's device being available, and filters can miss harmful content. Hosts can review and hide flagged art. Use a private room with people you know for an adult-led group session.",
  },
  {
    icon: "⭐",
    title: "Hosts have moderation tools",
    body: "Room hosts can lock or clear the canvas, mute or remove a painter, and review flags. The first guest in an unowned private room becomes its temporary host; hosting can pass to another painter when that guest leaves. A host role does not verify someone's age or identity.",
  },
  {
    icon: "🔒",
    title: "Keep room invitations with people you know",
    body: "Private rooms are unlisted, but anyone with a room link or code can join, including a forwarded invitation. Public-room art, chat, and display names can appear on the homepage. Use nicknames and keep personal details out of shared art and chat.",
  },
  {
    icon: "⚠️",
    title: "Anyone can report",
    body: "Use the report control in any room to send a concern to the moderation console for review. A report does not guarantee an immediate response. Leave the room and tell a trusted adult if something feels wrong.",
  },
  {
    icon: "🚫",
    title: "No behavioral ads or child-facing buying.",
    body: "Free spaces may show contextual, non-personalized ads marked child-directed. The in-app \"drops\" remain play-money earned by drawing; the optional Family subscription is bought and managed by an adult outside the canvas.",
  },
];

export default function SafetyPage({ onNavigate }) {
  return (
    <main className="safety-page">
      <header className="safety-top">
        <button type="button" className="safety-home" onClick={() => onNavigate("/")}>
          ← Drawesome 🎨
        </button>
        <button type="button" className="primary-action" onClick={() => onNavigate("/studio")}>
          Open the studio
        </button>
      </header>

      <section className="safety-hero">
        <h1>Drawing together: safety &amp; privacy</h1>
        <p>
          Know what is shared, how room controls work, and where filters have limits.
          For younger artists, start with an adult and people you already know.
        </p>
      </section>

      <section className="safety-grid">
        {SAFETY.map((item) => (
          <article key={item.title} className="safety-card">
            <span className="safety-icon" aria-hidden="true">
              {item.icon}
            </span>
            <h2>{item.title}</h2>
            <p>{item.body}</p>
          </article>
        ))}
      </section>

      <section className="safety-data">
        <h2>Your data &amp; privacy</h2>
        <ul>
          <li>
            <strong>Device and server storage.</strong> Settings and drafts can stay on your device.
            Shared drawings, chat, and server-saved artwork are sent to the server even when you draw as a guest.
          </li>
          <li>
            <strong>If you sign in</strong> (optional), account details connect your gallery and room
            ownership across devices. Free spaces may load a third-party advertising service when ads are configured.
          </li>
          <li>
            <strong>Deletion choices.</strong> The Account panel offers local-data and account deletion.
            Read the <a href="/privacy">Privacy page</a> for what is stored and which deletion options apply.
          </li>
          <li>
            <strong>Local creative helpers.</strong> The current AI Assist helpers run on your device.
            Sharing artwork in a room or posting it to the Wall still sends that artwork to the server.
          </li>
        </ul>
        <p className="safety-note">
          Questions or something to report? Use the report control in a room or email <a href="mailto:safety@drawesome.art">safety@drawesome.art</a>.
        </p>
      </section>

      <section className="safety-cta">
        <button type="button" className="primary-action" onClick={() => onNavigate("/studio")}>
          🎨 Start drawing
        </button>
      </section>
    </main>
  );
}
