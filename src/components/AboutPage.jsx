// About Drawesome — drawing together and the available room controls.
import SiteNav from "./SiteNav";

export default function AboutPage({ onNavigate }) {
  return (
    <div className="site-page">
      <SiteNav onNavigate={onNavigate} current="/about" />
      <main className="site-page-body">
        <h1>About Drawesome <span aria-hidden="true">🎨</span></h1>
        <p className="site-lead">
          Drawesome is a free studio for drawing, coloring, and painting together in real time —
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
            <h3>🛡️ Know your room</h3>
            <p>Choose a private room with people you know, or join a public canvas. Public art and chat can appear on the homepage. Filters and host controls help, but younger artists should have an adult present. Read the safety and privacy pages before joining.</p>
          </article>
          <article>
            <h3>💾 Yours to keep</h3>
            <p>Download art you want to keep, or save it to your gallery. When accounts are available, an optional sign-in adds gallery sync across devices.</p>
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
