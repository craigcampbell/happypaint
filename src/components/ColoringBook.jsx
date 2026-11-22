import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "./coloring-book.css";

const API = "/api/me/coloring-book";
const PAGE_SIZE = 6;
const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const dateLabel = value => shortDate.format(new Date(value));

function useBookImage(path, token, onDenied) {
  const [result, setResult] = useState(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl;
    fetch(path, {
      headers: { Authorization: "Bearer " + token }, signal: controller.signal, cache: "no-store", redirect: "error",
    }).then(async response => {
      if (controller.signal.aborted) return;
      if ([401, 403].includes(response.status)) { onDenied(response.status); return; }
      if (!response.ok) throw new Error(response.status === 404 ? "This picture is no longer available." : "The picture couldn’t load.");
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      if (blob.type !== "image/png") throw new Error("The picture couldn’t load.");
      objectUrl = URL.createObjectURL(blob);
      setResult({ path, url: objectUrl });
    }).catch(err => {
      if (!controller.signal.aborted) setResult({ path, error: err.message });
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, token, retry, onDenied]);
  return { ...(result?.path === path ? result : {}), retry: () => { setResult(null); setRetry(v => v + 1); } };
}

function PageCard({ page, number, token, onOpen, onDenied }) {
  const { url, error } = useBookImage(API + "/" + page.id + "/image", token, onDenied);
  return <button type="button" className="book-page-card" onClick={() => onOpen(page.id)}>
    <span className="book-page-paper">{url ? <img src={url} alt="" /> : <span>{error ? "Open page" : "Loading…"}</span>}</span>
    <strong>Page {number}</strong>
    <small>{dateLabel(page.createdAt)} · {page.versions.length} {page.versions.length === 1 ? "version" : "versions"}</small>
  </button>;
}

function BookDetail({ page, number, token, onBack, onUse, onDenied, onRefresh, inRoom }) {
  const [versionId, setVersionId] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState("");
  const versions = [...page.versions].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const versionIndex = versions.findIndex(v => v.id === versionId);
  const version = versions[versionIndex];
  const base = API + "/" + page.id;
  const path = base + (version ? "/versions/" + version.id : "") + "/image";
  const image = useBookImage(path, token, onDenied);
  const title = version ? "Version " + (versionIndex + 1) : "Original outline";
  async function deleteVersion() {
    if (!version || !window.confirm("Delete this finished version from your coloring book?")) return;
    setDeleting(true); setProblem("");
    try {
      const response = await fetch(base + "/versions/" + version.id, {
        method: "DELETE", cache: "no-store", headers: { Authorization: "Bearer " + token }, redirect: "error",
      });
      if ([401, 403].includes(response.status)) { onDenied(response.status); return; }
      if (!response.ok && response.status !== 404) throw new Error();
      setVersionId("");
      onRefresh();
    } catch { setProblem("This version couldn’t be deleted. Try again."); }
    finally { setDeleting(false); }
  }

  return <section className="book-detail" aria-label={"Coloring book page " + number}>
    <button type="button" className="book-back" onClick={onBack}>← All pages</button>
    <h3>Page {number}</h3>
    <label className="book-version-select">View
      <select value={version?.id || ""} disabled={deleting} onChange={e => { setVersionId(e.target.value); setProblem(""); }}>
        <option value="">Original outline</option>
        {versions.map((v, i) => <option key={v.id} value={v.id}>Version {i + 1} · {dateLabel(v.createdAt)}</option>)}
      </select>
    </label>
    <div className="book-print-preview">
      {image.url ? <img src={image.url} alt={title + " for page " + number} />
        : image.error ? <div role="alert">{image.error} <button type="button" onClick={image.retry}>Retry picture</button></div>
        : <span role="status">Loading picture…</span>}
    </div>
    {image.url && createPortal(<img className="coloring-book-print-sheet" src={image.url} alt={title} />, document.body)}
    <div className="book-detail-actions">
      {!version && image.url && <button type="button" className="book-primary" onClick={() => onUse(page)}>
        {inRoom ? "Use this outline in the room" : "Color in a new Art Jam"}
      </button>}
      {image.url && <>
        <a href={image.url} download={`drawesome-page-${number}-${version ? "version-" + (versionIndex + 1) : "outline"}.png`}>Download PNG</a>
        <button type="button" onClick={() => window.print()}>Print</button>
      </>}
      {version && <button type="button" onClick={deleteVersion} disabled={deleting}>{deleting ? "Deleting…" : "Delete version"}</button>}
    </div>
    {problem && <p role="alert">{problem}</p>}
  </section>;
}

export default function ColoringBook({ token, onUse, onCreate, inRoom = false, removedAiSheets }) {
  const [offset, setOffset] = useState(0);
  const [response, setResponse] = useState(null);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState("");
  const [denied, setDenied] = useState(0);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(() => setRevision(n => n + 1), []);
  const onDenied = useCallback(status => { setDenied(status); setResponse(null); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    fetch(API + "?offset=" + offset + "&limit=" + PAGE_SIZE, {
      cache: "no-store", headers: { Authorization: "Bearer " + token }, signal: controller.signal, redirect: "error",
    }).then(async res => {
      if (controller.signal.aborted) return;
      if ([401, 403].includes(res.status)) { onDenied(res.status); return; }
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (data.total > 0 && offset >= data.total) { setOffset(Math.floor((data.total - 1) / PAGE_SIZE) * PAGE_SIZE); return; }
      if (!Number.isFinite(data.paidUntil) || data.paidUntil <= Date.now()) { onDenied(403); return; }
      setDenied(0); setResponse({ ...data, offset });
    }).catch(() => { if (!controller.signal.aborted) { setFailed(true); setResponse(null); } });
    return () => controller.abort();
  }, [token, offset, revision, onDenied]);
  useEffect(() => {
    if (!response?.paidUntil) return;
    const timer = setTimeout(() => {
      if (Date.now() >= response.paidUntil) onDenied(403);
      reload();
    }, Math.min(2_147_483_647, Math.max(0, response.paidUntil - Date.now())));
    return () => clearTimeout(timer);
  }, [response?.paidUntil, onDenied, reload]);
  useEffect(() => {
    const resume = () => { if (!document.hidden) reload(); };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    const timer = window.setInterval(resume, 30000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [reload]);

  if (denied) return <div className="book-message" role="status">
    <p>{denied === 401 ? "Sign in again to open your private coloring book." : "My Coloring Book opens with a paid Jam Pass."}</p>
    <a className="book-primary" href={denied === 401 ? "/signup?mode=login&reauth=1&return=/coloring-book" : "/jam-pass"}>{denied === 401 ? "Sign in" : "See Jam Pass"}</a>
    <button type="button" onClick={reload}>Check again</button>
  </div>;
  if (failed) return <p className="book-message" role="alert">Your coloring book couldn’t load. <button type="button" onClick={reload}>Try again</button></p>;
  if (!response || response.offset !== offset) return <p role="status">Opening your coloring book…</p>;
  const items = response.items.filter(item => !removedAiSheets?.has(item.id));
  const selectedIndex = items.findIndex(item => item.id === selected);
  if (selectedIndex >= 0) return <BookDetail key={selected} page={items[selectedIndex]} number={response.total - offset - selectedIndex}
    token={token} onBack={() => setSelected("")} onUse={onUse} onRefresh={reload} onDenied={onDenied} inRoom={inRoom} />;

  return <div className="book-pages">
    {items.length ? <div className="book-page-grid">{items.map((page, i) => <PageCard key={page.id} page={page} number={response.total - offset - i} token={token} onOpen={setSelected} onDenied={onDenied} />)}</div>
      : <div className="book-message">
        <h3>Your first page starts in a room</h3>
        <p>Generate an outline in a private Art Jam you own. It will appear here automatically.</p>
        {onCreate && <button type="button" className="book-primary" onClick={onCreate}>Make a coloring page</button>}
      </div>}
    {response.total > PAGE_SIZE && <nav aria-label="Coloring book pages" className="book-pagination">
      <button type="button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</button>
      <span>{Math.floor(offset / PAGE_SIZE) + 1} of {Math.ceil(response.total / PAGE_SIZE)}</span>
      <button type="button" disabled={offset + PAGE_SIZE >= response.total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</button>
    </nav>}
  </div>;
}
