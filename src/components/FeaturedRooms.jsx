import { useCallback, useEffect, useState } from 'react';
import './featured-rooms.css';

export function FeaturedRoomArt({ item, onImageError }) {
  return <figure className="featured-room-art">
    <img src={item.imageUrl} alt={item.title || `Collective drawing from public room ${item.roomCode}`} loading="lazy" decoding="async" onError={onImageError} />
    <figcaption><strong>{item.title || 'A moment on the shared canvas'}</strong><span>Collective work · Room {item.roomCode}</span><time dateTime={item.capturedAt}>Selected {new Date(item.capturedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</time></figcaption>
  </figure>;
}

export default function FeaturedRooms() {
  const [items, setItems] = useState([]);
  const [visible, setVisible] = useState(() => !document.hidden);
  const load = useCallback(async (signal) => {
    try {
      const response = await fetch('/api/featured-rooms', { cache: 'no-store', signal });
      if (!response.ok) throw new Error('Unavailable');
      const data = await response.json();
      if (!signal.aborted) setItems(Array.isArray(data.items) ? data.items : []);
    } catch { if (!signal.aborted) setItems([]); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => { if (!document.hidden) load(controller.signal); };
    const visibility = () => { setItems([]); setVisible(!document.hidden); refresh(); };
    refresh();
    const timer = window.setInterval(refresh, 30000);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('featured-rooms-changed', refresh);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('featured-rooms-changed', refresh); };
  }, [load]);
  if (!visible || !items.length) return null;
  return <section className="featured-rooms" aria-labelledby="featured-rooms-title"><div className="featured-rooms-heading"><span className="discovery-eyebrow">From the shared canvas</span><h2 id="featured-rooms-title">Featured from public rooms</h2><p>Collective drawings, selected by the Drawesome team. A frozen moment, not a live view.</p></div>
    <div className="featured-rooms-wall">{items.map((item) => <FeaturedRoomArt key={item.id} item={item} onImageError={() => setItems((current) => current.filter((entry) => entry.id !== item.id))} />)}</div>
  </section>;
}
