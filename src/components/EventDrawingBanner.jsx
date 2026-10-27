import "./EventDrawingBanner.css";

export default function EventDrawingBanner({ event, prompt, onShare }) {
  return (
    <section className="event-drawing-banner" aria-label="Private drawing">
      <div>
        <strong>Just you · Not shared</strong>
        <p>{event ? `${event.title} — ${prompt || event.prompt}` : "A quiet canvas of your own. Your draft stays on this device."}</p>
        <small>Nothing is uploaded automatically. Sharing a finished picture is your choice.</small>
      </div>
      <button type="button" onClick={onShare}>
        {event ? "Share to event" : "Share to Wall"}
      </button>
    </section>
  );
}
