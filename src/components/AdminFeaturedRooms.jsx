import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { FeaturedRoomArt } from './FeaturedRooms';
import './featured-rooms.css';
const LiveRoomCanvas = lazy(() => import('./LiveRoomCanvas'));
const messages = { room_not_eligible: 'Only listed public rooms can be featured. Private rooms, unpublished studios and all sketchbooks are excluded.', source_changed: 'The room’s permissions or moderated artwork changed. Reload the preview before selecting again.', collection_full: 'The featured collection is full. Remove a selection first.', unauthorized: 'Your admin session has expired. Sign in again.', persistence_failed: 'The selection could not be saved. Nothing was published.' };

// Mount in RoomWatch with roomCode + the existing authenticated adminKey/session.
// With no roomCode, this is a standalone list/remove manager (e.g. Curator).
export default function AdminFeaturedRooms({ roomCode, adminKey, onChanged }) {
  const [items, setItems] = useState([]);
  const [source, setSource] = useState(null);
  const [ready, setReady] = useState(false);
  const [picture, setPicture] = useState('');
  const [title, setTitle] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const viewport = useRef(null);
  const request = useCallback(async (path, options = {}) => {
    const response = await fetch(`/api/admin/featured-rooms${path}`, { ...options, cache: 'no-store', headers: { 'x-admin-key': adminKey, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(messages[data.error] || (response.status === 401 ? messages.unauthorized : 'Could not complete the request. Please try again.'));
    return data;
  }, [adminKey]);
  useEffect(() => {
    let active = true;
    setSource(null); setPicture(''); setReady(false); setConfirmed(false); setError(''); setTitle(''); setNotice('');
    request('').then((data) => { if (active) setItems(data.items || []); }).catch((err) => { if (active) setError(err.message); });
    if (roomCode) request(`/source/${encodeURIComponent(roomCode)}`).then((data) => { if (active) setSource(data); }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [request, roomCode]);
  const activity = useCallback((count) => { setReady(count > 0); setPicture(''); setConfirmed(false); }, []);
  const denied = useCallback(() => { setSource(null); setPicture(''); setReady(false); setError('This room is no longer available as a public source.'); }, []);
  const changed = () => { window.dispatchEvent(new Event('featured-rooms-changed')); onChanged?.(); };
  const capture = async () => {
    setError(''); setNotice(''); setBusy(true);
    try {
      const check = await request(`/source/${encodeURIComponent(roomCode)}`);
      if (check.version !== source.version) throw new Error(messages.source_changed);
      const canvas = viewport.current?.querySelector('canvas');
      if (!canvas || !canvas.width || !canvas.height) throw new Error('The public preview is not ready yet.');
      setPicture(canvas.toDataURL('image/png')); setConfirmed(false);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const publish = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const { item } = await request('', { method: 'POST', body: JSON.stringify({ roomCode, title, image: picture, version: source.version, confirmed }) });
      const data = await request('');
      if (!data.items?.some((entry) => entry.id === item.id)) throw new Error('Could not verify the saved selection. Reload the list.');
      setItems(data.items); setPicture(''); setConfirmed(false); setNotice('Picture featured in the gallery.'); changed();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const remove = async (item) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      const data = await request('');
      if (data.items?.some((entry) => entry.id === item.id)) throw new Error('Could not verify removal. Reload the list.');
      setItems(data.items || []); setNotice('Selection removed.'); changed();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <section className="admin-featured-rooms" aria-label="Featured public-room pictures"><h2>Feature a public-room picture</h2><p>Select a frozen picture for the gallery. This does not create a Wall post or attribute a collective drawing to one artist. Only listed public rooms are eligible; all sketchbooks are excluded.</p>
    {error ? <p role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    {roomCode && source ? <><div className="admin-featured-viewport" ref={viewport}><Suspense fallback={<p role="status">Loading public preview…</p>}><LiveRoomCanvas roomCode={roomCode} onActivity={activity} onDenied={denied} /></Suspense></div><button type="button" disabled={!ready || busy} onClick={capture}>Preview current picture</button>
      {picture ? <div className="admin-featured-confirm"><img src={picture} alt="Frozen picture to feature" /><label>Title (optional)<input value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} /></label><label className="admin-featured-consent"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I confirm this public-room picture is appropriate to highlight in the gallery.</label><p>The exact picture above will be published under “Featured from public rooms”, labeled as collective work from room {roomCode}. It will not update as people draw. Privacy or moderation changes can withdraw it.</p><div className="admin-featured-actions"><button type="button" disabled={!confirmed || busy} onClick={publish}>Feature this picture</button><button type="button" disabled={busy} onClick={() => { setPicture(''); setConfirmed(false); }}>Cancel preview</button></div></div> : null}</> : null}
    <h3>Selected pictures ({items.length}/24)</h3>{items.length ? <div className="admin-featured-list">{items.map((item) => <article key={item.id}>{item.available ? <FeaturedRoomArt item={item} /> : <p>{item.title || 'Untitled picture'} · Room {item.roomCode} · Not publicly available</p>}<button type="button" disabled={busy} aria-label={`Remove ${item.title || `picture from ${item.roomCode}`}`} onClick={() => remove(item)}>Remove selection</button></article>)}</div> : <p>No pictures selected yet.</p>}
  </section>;
}
