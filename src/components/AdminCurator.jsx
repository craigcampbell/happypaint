import { useCallback, useEffect, useState } from 'react';
import AdminLogin from './AdminLogin';
import CuratedHeader from './CuratedHeader';
import { clearAdminToken, getAdminToken } from '../utils/adminAuth';
import { CURATOR_PAGES, CURATOR_PALETTES, CURATOR_ART, CURATOR_LINKS, getCuratorDefaults, validateCuratorContent } from '../data/curatorContent';
import './curator.css';

const fields = [['kicker', 'Kicker', 90], ['title', 'Headline', 120], ['description', 'Description', 280], ['note', 'Margin note', 80], ['ctaLabel', 'CTA label', 36]];
const same = (a, b) => a && b && Object.keys(getCuratorDefaults('home')).every((key) => a[key] === b[key]);

export default function AdminCurator({ onNavigate }) {
  const [token, setToken] = useState(getAdminToken);
  const [doc, setDoc] = useState(null);
  const [page, setPage] = useState('home');
  const [edits, setEdits] = useState({}); // memory only; retained on network/auth errors
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [blocked, setBlocked] = useState(false);
  const content = edits[page] || doc?.pages?.[page]?.draft || getCuratorDefaults(page);
  const entry = doc?.pages?.[page];
  const dirty = !!entry && !same(content, entry.draft);
  const anyDirty = !!doc && Object.entries(edits).some(([key, value]) => !same(value, doc.pages[key]?.draft));
  const valid = validateCuratorContent(page, content);
  const request = useCallback(async (path, options = {}) => {
    const response = await fetch(path, { ...options, cache: 'no-store', headers: { 'Content-Type': 'application/json', 'x-admin-key': token } });
    if (response.status === 401) {
      clearAdminToken(); setToken(''); setDoc(null);
      throw new Error('Session expired. Sign in again. Your edits are kept in this tab.');
    }
    if (response.status === 409) { setBlocked(true); throw new Error('Another curator changed this content. Your edits are preserved. Reload server content explicitly before saving again.'); }
    if (!response.ok) throw new Error(`Request failed (${response.status}). Your edits are kept. Try again.`);
    const data = await response.json();
    if (!data || !Number.isSafeInteger(data.revision) || !Object.keys(CURATOR_PAGES).every((key) => validateCuratorContent(key, data.pages?.[key]?.draft).ok && validateCuratorContent(key, data.pages?.[key]?.published).ok)) throw new Error('Invalid server response. Your edits are kept.');
    return data;
  }, [token]);
  useEffect(() => {
    if (!token) return;
    let active = true;
    request('/api/admin/curator').then((data) => { if (active) { setDoc(data); setError(''); } }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [token, request]);
  useEffect(() => {
    const warn = (event) => { if (anyDirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [anyDirty]);
  const reload = async () => {
    if ((anyDirty || blocked) && !window.confirm('Reload server content and discard your local edits?')) return;
    setBusy(true); setError(''); setMessage('');
    try { setDoc(await request('/api/admin/curator')); setEdits({}); setBlocked(false); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  const mutate = async (action) => {
    if (busy || blocked || !entry || (action === 'save' && !valid.ok) || (action === 'publish' && dirty)) return;
    if (action !== 'save' && !window.confirm(action === 'publish' ? `Publish the saved ${CURATOR_PAGES[page].label} draft to the public site?` : `Restore defaults for ${CURATOR_PAGES[page].label}? This replaces both the saved draft and public header, and discards local edits.`)) return;
    const target = page;
    const expected = action === 'reset' ? getCuratorDefaults(target) : action === 'save' ? valid.content : entry.draft;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await request(`/api/admin/curator/pages/${target}${action === 'save' ? '' : `/${action}`}`, { method: action === 'save' ? 'PUT' : 'POST', body: JSON.stringify({ revision: doc.revision, ...(action === 'save' ? { content: expected } : {}) }) });
      // A mutation response alone is not success. Read back the exact page.
      const verified = await request('/api/admin/curator');
      const readback = verified.pages[target];
      if (verified.revision !== result.revision || !same(readback.draft, expected) || (action === 'save' ? !same(readback.published, entry.published) : !same(readback.published, expected))) {
        setBlocked(true); throw new Error('Could not verify the exact saved content. Your edits are preserved. Reload server content before continuing.');
      }
      setDoc(verified); setEdits((current) => { const next = { ...current }; delete next[target]; return next; });
      setMessage(action === 'save' ? 'Draft saved and verified. Public content has not changed.' : action === 'publish' ? 'Published and verified.' : 'Defaults restored and verified on draft and public header.');
    } catch (err) { setError(err.message || 'Network error. Your edits are kept.'); }
    finally { setBusy(false); }
  };
  if (!token) return <AdminLogin title="Curator sign-in" intro={error || undefined} onNavigate={onNavigate} backTo="/admin" backLabel="← Admin" onAuthed={(next) => { setToken(next); setBlocked(false); }} />;
  return <main className="curator-admin">
    <div className="curator-toolbar"><button type="button" onClick={() => { if (!anyDirty || window.confirm('Leave Curator and discard unsaved edits?')) onNavigate('/admin'); }}>← Admin overview</button><h1>Curator</h1><button type="button" disabled={busy} onClick={reload}>Reload server content</button></div>
    <p>Edit page headers only. Saving a draft does not publish it. No artwork, studio permissions, or event details are changed.</p>
    {error ? <p role="alert" className="curator-error">{error}</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {!doc ? <p role="status">{error ? 'Server content unavailable. Retry with Reload server content.' : 'Loading saved headers…'}</p> : <>
      <label className="curator-page-select">Page<select aria-label="Page" value={page} disabled={busy} onChange={(event) => { if (!dirty || window.confirm('Switch pages? Unsaved edits are kept in this tab until you leave or reload.')) { setPage(event.target.value); setMessage(''); setError(''); } }}>{Object.entries(CURATOR_PAGES).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label>
      <p className="curator-state" role="status">{dirty ? 'Unsaved local edits' : 'Saved draft'} · {same(entry.draft, entry.published) ? 'Saved draft matches published' : 'Saved draft differs from published'} · Revision {doc.revision}</p>
      <p>Last draft save: {entry.updatedAt || 'Defaults'} · Last publication: {entry.publishedAt || 'Defaults'}</p>
      <div className="curator-editor-layout"><form className="curator-fields" onSubmit={(event) => { event.preventDefault(); mutate('save'); }}>
        <fieldset disabled={busy}><legend>Draft header</legend>{fields.map(([key, label, limit]) => <label key={key} htmlFor={`curator-${key}`}>{label} <small>{content[key].length}/{limit}{key === 'title' ? ' · up to 3 lines, 40 characters per line' : ''}</small>{key === 'title' || key === 'description' ? <textarea id={`curator-${key}`} rows={3} maxLength={limit} value={content[key]} onChange={(event) => setEdits((current) => ({ ...current, [page]: { ...content, [key]: event.target.value } }))} /> : <input id={`curator-${key}`} maxLength={limit} value={content[key]} onChange={(event) => setEdits((current) => ({ ...current, [page]: { ...content, [key]: event.target.value } }))} />}</label>)}
          {[['ctaHref', 'CTA destination', CURATOR_LINKS], ['palette', 'Palette', CURATOR_PALETTES], ['art', 'Artwork preset', CURATOR_ART]].map(([key, label, values]) => <label key={key}>{label}<select value={content[key]} onChange={(event) => setEdits((current) => ({ ...current, [page]: { ...content, [key]: event.target.value } }))}>{values.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>)}
        </fieldset>
        {!valid.ok ? <p role="alert">Check the header: use a nonempty headline (up to 3 lines, 40 characters each), a CTA label, and the listed choices. Plain text only.</p> : null}
        <div className="curator-actions"><button type="submit" disabled={busy || blocked || !dirty || !valid.ok}>Save draft</button><button type="button" disabled={busy || blocked || dirty || same(entry.draft, entry.published)} onClick={() => mutate('publish')}>Publish saved draft</button><button type="button" disabled={busy || blocked} onClick={() => mutate('reset')}>Restore defaults</button></div>
        {dirty ? <p>Save your edits before publishing. Publishing always uses the saved draft.</p> : null}
      </form><section className="curator-preview" aria-label="Live draft preview"><h2>Live draft preview · not public</h2><div className={`site-page discovery-page ${page === 'home' ? 'artwall-home' : ''}`}><div className={`discovery-main ${page === 'home' ? 'artwall-main' : ''}`}><CuratedHeader page={page} content={content} preview /></div></div><details><summary>Currently published header</summary><div className={`site-page discovery-page ${page === 'home' ? 'artwall-home' : ''}`}><div className={`discovery-main ${page === 'home' ? 'artwall-main' : ''}`}><CuratedHeader page={page} content={entry.published} preview /></div></div></details></section></div>
    </>}
  </main>;
}
