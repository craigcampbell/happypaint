import { useEffect, useRef, useState } from "react";

export default function KeepColoringVersion({ sheetId, room, token, capture }) {
  const pending = useRef(null);
  const retry = useRef(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => () => pending.current?.abort(), []);
  async function keep() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true); setNotice("");
    try {
      if (!retry.current) {
        const image = await capture(sheetId);
        if (controller.signal.aborted) return;
        retry.current = { key: crypto.randomUUID(), image };
      }
      const response = await fetch("/api/me/coloring-book/" + sheetId + "/versions", {
        method: "POST", cache: "no-store", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, "Idempotency-Key": retry.current.key },
        body: JSON.stringify({ room, image: retry.current.image }),
      });
      if (controller.signal.aborted) return;
      if (!response.ok) {
        const { error } = await response.json();
        if (response.status < 500) retry.current = null;
        if (error === "version_limit") throw new Error("This page has 24 versions. Delete one from your book to keep another.");
        if (response.status === 413) throw new Error("This painting is too large to keep. Use Export to save a PNG.");
        if ([401, 403, 404, 409].includes(response.status)) throw new Error("This outline is no longer available to save in this room.");
        throw new Error("Couldn’t keep this version. Try again.");
      }
      retry.current = null;
      setNotice("Version kept in My Coloring Book.");
    } catch (err) {
      if (!controller.signal.aborted) setNotice(err instanceof TypeError ? "Check your connection, then retry saving this version." : err.message);
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return <div>
    <button type="button" className="sheet-browse-btn" disabled={busy} onClick={keep}>{busy ? "Saving version…" : retry.current ? "Retry saving this version" : "Keep this version"}</button>
    {notice && <p role="status" className="tool-hint">{notice}</p>}
  </div>;
}
