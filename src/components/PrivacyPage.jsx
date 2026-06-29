// Plain-language privacy page for a kids' drawing app.
import SiteNav from "./SiteNav";

export default function PrivacyPage({ onNavigate }) {
  return (
    <div className="site-page">
      <SiteNav onNavigate={onNavigate} current="/privacy" />
      <main className="site-page-body">
        <h1>Privacy</h1>
        <p className="site-lead">
          Drawesome is built to be safe for kids. You can draw and paint together without an account, and
          we collect as little as possible.
        </p>

        <h2>What we store</h2>
        <ul>
          <li><strong>No account needed to draw.</strong> Anonymous painters are identified only by a random per-device id and a fun nickname — no email, no real name.</li>
          <li><strong>Your art.</strong> Drawings you save are kept on our server keyed to that device id (or your account if you sign in). Shared-room murals are stored so people who join later see the canvas.</li>
          <li><strong>Optional sign-in.</strong> If you sign in with Google, we receive a basic profile (name + email) to tie your saved gallery to your account. That’s the only reason to sign in.</li>
          <li><strong>Chat &amp; public rooms.</strong> Public rooms are auto-moderated for safety. Messages and drawings in public rooms may be reviewed by moderators.</li>
        </ul>

        <h2>What we don’t do</h2>
        <ul>
          <li>No ads, no ad trackers, no selling data.</li>
          <li>No real-money purchases.</li>
          <li>No public people-search — you find <em>rooms</em>, not individual kids.</li>
        </ul>

        <h2>Your choices</h2>
        <ul>
          <li>Delete your data anytime from the in-app Account panel (free, always available).</li>
          <li>Report anything inappropriate with the ⚠️ button in any room.</li>
        </ul>

        <div className="site-page-actions">
          <button type="button" className="primary-action" onClick={() => onNavigate("/studio")}>🎨 Start painting</button>
          <button type="button" onClick={() => onNavigate("/about")}>About Drawesome</button>
        </div>
      </main>
    </div>
  );
}
