// Plain-language safety + data page for parents/guardians. Everything stated
// here reflects shipped behaviour (anonymous-first, public-room moderation,
// play-money only, no public people search, local-first storage, account
// deletion). Keep it honest — do not claim features that aren't live.

const SAFETY = [
  {
    icon: "👧",
    title: "Draw without an account",
    body: "Kids can start drawing, coloring, and painting together immediately — no sign-up, no email, no personal details required. Signing in (optional, with a grown-up's Google account) only adds room hosting and a saved gallery.",
  },
  {
    icon: "🛡️",
    title: "Public rooms are moderated",
    body: "In public rooms, mean or inappropriate words are filtered automatically, and shared drawings are checked for unsafe imagery. Anything flagged is auto-reported, the room's grown-up host is alerted, and questionable art can be hidden (and brought back) — it's never deleted on a guess.",
  },
  {
    icon: "⭐",
    title: "Grown-ups are in charge",
    body: "A signed-in adult owns and hosts a room: they can lock the canvas, clear it, mute or remove a painter, and review anything the safety system flags. Co-hosts can help moderate.",
  },
  {
    icon: "🔒",
    title: "Private by default with friends",
    body: "Beyond the public hall, rooms are invite-only. Share a short link or code with friends — there's no way for strangers to wander in, and no public directory of people.",
  },
  {
    icon: "⚠️",
    title: "Anyone can report",
    body: "Every room has a one-tap report button. Reports go straight to the moderation console for a human to review.",
  },
  {
    icon: "🚫",
    title: "No ads. No real-money buying.",
    body: "Drawesome has no advertising and no real-money purchases. The in-app \"drops\" are play-money earned by drawing and spent only on cosmetic fun — there is nothing for a child to buy with real money.",
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
        <h1>Safe by design</h1>
        <p>
          Drawesome is built for kids and families. Here&rsquo;s exactly how we keep it friendly,
          private, and pressure-free — in plain language.
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
            <strong>Local-first.</strong> Your drawings and gallery are saved on your own device by
            default. If you don&rsquo;t sign in, nothing about you leaves the device.
          </li>
          <li>
            <strong>If you sign in</strong> (optional), we store only what&rsquo;s needed to host
            rooms and sync your gallery across devices — a Google account id and a display name you
            choose. We don&rsquo;t sell data and there are no third-party ad trackers.
          </li>
          <li>
            <strong>Delete anytime.</strong> You can erase everything stored on your device, and a
            signed-in account can request full deletion — free and always available.
          </li>
          <li>
            <strong>AI stays on-device.</strong> The optional creative helpers run locally and never
            send a child&rsquo;s art off the device by default.
          </li>
        </ul>
        <p className="safety-note">
          Questions or something to report? Use the ⚠️ button in any room, and a moderator will take
          a look.
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
