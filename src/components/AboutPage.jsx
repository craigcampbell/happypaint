// About Drawesome, drawing together and the available room controls.
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";

export default function AboutPage({ onNavigate }) {
  return (
    <div className="site-page field-guide">
      <SiteNav onNavigate={onNavigate} current="/about" />
      <main className="site-page-body">
        <h1>About Drawesome</h1>
        <p className="site-lead">
          Drawesome is a free studio for drawing, coloring, and painting together in real time. Open it in a browser on your phone, tablet, or computer. No account needed to start.
        </p>

        <div className="about-grid">
          <article>
            <h2>Paint together, live</h2>
            <p>Join an open public room or share a short code with friends and paint on the same canvas. You can see where each painter is working as their strokes appear.</p>
          </article>
          <article>
            <h2>Choose a brush</h2>
            <p>Build up a drawing with markers, pencils, crayons, or a coloring sheet. Pinch to zoom on a touch screen when you want to add detail.</p>
          </article>
          <article>
            <h2>Know your room</h2>
            <p>Choose a private room with people you know, or join a public canvas. Public art and chat can appear in room previews. Filters and host controls help, but younger artists should have an adult present. Read the safety and privacy pages before joining.</p>
          </article>
          <article>
            <h2>Keep a copy</h2>
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
      <SiteFooter onNavigate={onNavigate} />
    </div>
  );
}
