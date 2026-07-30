import { useEffect, useState } from "react";

export default function StorybookPanel({
  storybook,
  scenes,
  activeSceneId,
  isHost,
  onSelectPage,
  onCaption,
  onToggleLock,
  onMove,
  onExport,
}) {
  const pageIndex = Math.max(0, (storybook?.pages || []).findIndex((page) => page.sceneId === activeSceneId));
  const page = storybook?.pages?.[pageIndex];
  const [caption, setCaption] = useState(page?.caption || "");

  useEffect(() => setCaption(page?.caption || ""), [page?.caption, page?.sceneId]);
  if (!storybook?.enabled || !page) return null;

  return (
    <aside className="storybook-panel" aria-label="Storybook pages">
      <header>
        <span aria-hidden="true">📖</span>
        <div>
          <strong>{storybook.title || "Our Story"}</strong>
          <small>Page {pageIndex + 1} of {storybook.pages.length}</small>
        </div>
      </header>
      <nav aria-label="Choose a story page">
        {storybook.pages.map((item, index) => (
          <button
            type="button"
            key={item.sceneId}
            className={item.sceneId === activeSceneId ? "is-active" : ""}
            onClick={() => onSelectPage(item.sceneId)}
            title={item.title}
          >
            {item.locked ? "🔒" : index + 1}
          </button>
        ))}
      </nav>
      <p className="storybook-prompt">{page.prompt}</p>
      <label>
        <span>Page caption</span>
        <textarea
          value={caption}
          maxLength={160}
          disabled={page.locked && !isHost}
          placeholder="Tell this part of the story…"
          onChange={(event) => setCaption(event.target.value)}
          onBlur={() => {
            if (caption !== (page.caption || "")) onCaption(page.sceneId, caption);
          }}
        />
      </label>
      {isHost ? (
        <>
          <div className="storybook-reorder" aria-label="Reorder this page">
            <button type="button" disabled={pageIndex === 0} onClick={() => onMove(page.sceneId, pageIndex - 1)}>Move earlier</button>
            <button type="button" disabled={pageIndex === storybook.pages.length - 1} onClick={() => onMove(page.sceneId, pageIndex + 1)}>Move later</button>
          </div>
          <button type="button" className="storybook-lock" onClick={() => onToggleLock(page.sceneId, !page.locked)}>
            {page.locked ? "Unlock page" : "Lock finished page"}
          </button>
        </>
      ) : null}
      <button type="button" className="storybook-export" onClick={onExport}>
        Print storybook
      </button>
      <span className="sr-only">{scenes?.length || 0} story scenes loaded</span>
    </aside>
  );
}
