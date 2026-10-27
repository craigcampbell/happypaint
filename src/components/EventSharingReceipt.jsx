import { useState } from "react";
import { getSession } from "../utils/auth";

// The same receipt works for seasonal and ongoing invitations. Ownership is
// checked by the server; a URL parameter alone never authorizes withdrawal.
export default function EventSharingReceipt({ onRemoved }) {
  const [id, setId] = useState(() => {
    const value = new URLSearchParams(window.location.search).get("post") || "";
    return /^wp_[A-Za-z0-9_-]{1,60}$/.test(value) ? value : "";
  });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    if (busy || !id || !window.confirm("Remove this drawing from public discovery? Your original drawing is not deleted.")) return;
    setBusy(true); setMessage("");
    try {
      const session = await getSession().catch(() => null);
      let userKey = "";
      try { userKey = localStorage.getItem("drawesome:userkey:v1") || ""; } catch { /* unavailable */ }
      const headers = { "Content-Type": "application/json" };
      if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
      const response = await fetch(`/api/wall/${encodeURIComponent(id)}/unpublish`, { method: "POST", headers, body: JSON.stringify({ userKey }) });
      if (!response.ok) throw new Error("owner_required");
      const verify = await fetch(`/api/wall/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (verify.status !== 404) throw new Error("not_verified");
      onRemoved?.(id);
      setId(""); setMessage("Your drawing is no longer public. Your original drawing has not been deleted.");
    } catch { setMessage("We couldn’t confirm removal. Use the same device or account that shared this drawing and try again."); }
    finally { setBusy(false); }
  };
  return <>{id ? <section className="discovery-receipt" aria-labelledby="receipt-title"><h2 id="receipt-title">Your sharing receipt</h2><p>This link was returned after sharing. Open it to see the public drawing.</p><a href={`/wall/${encodeURIComponent(id)}`}>View shared drawing →</a><p>Changed your mind? The device or account that shared it can remove it from public discovery.</p><button type="button" disabled={busy} onClick={remove}>{busy ? "Removing…" : "Unpublish my drawing"}</button></section> : null}{message ? <p role="status">{message}</p> : null}</>;
}
