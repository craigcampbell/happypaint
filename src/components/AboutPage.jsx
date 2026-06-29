// About Drawesome — what it is and how it stays kid-safe.
import SiteNav from "./SiteNav";

export default function AboutPage({ onNavigate }) {
  return (
    <div className="site-page">
      <SiteNav onNavigate={onNavigate} current="/about" />
      <main className="site-page-body">
        <h1>About Drawesome <span aria-hidden="true">🎨</span></h1>
        <p className="site-lead">
          Drawesome is a fast, kid-conscious studio for drawing, coloring, and painting together in real time —
          in the browser, on a phone, or on a tablet. No account needed to start.
        </p>

        <div className="about-grid">
          <article>
            <h3>🖌️ Paint together, live</h3>
            <p>Join an open public room or share a short code with friends and paint on the same canvas at once — everyone’s cursors and strokes appear instantly.</p>
          </article>
          <article>
            <h3>🌈 Real tools, made fun</h3>
            <p>Markers, crayons, pencils, spray, glow, coloring sheets, layers, GIF import, pinch-zoom &amp; rotate — chunky and tappable on touch.</p>
          </article>
          <article>
            <h3>🛡️ Built carefully for kids</h3>
            <p>Public rooms are auto-moderated. You browse <em>rooms</em>, not people. No ads, no real-money buys, and you can delete your data anytime.</p>
          </article>
          <article>
            <h3>💾 Yours to keep</h3>
            <p>Save drawings to your gallery. Sign in with Google (optional) to keep them on every device.</p>
          </article>
        </div>

        <div className="site-page-actions">
          <button type="button" className="primary-action" onClick={() => onNavigate("/studio")}>🎨 Start painting</button>
          <button type="button" onClick={() => onNavigate("/rooms")}>Find a room</button>
          <button type="button" onClick={() => onNavigate("/safety")}>Safety</button>
          <button type="button" onClick={() => onNavigate("/privacy")}>Privacy</button>
        </div>
      </main>
    </div>
  );
}
