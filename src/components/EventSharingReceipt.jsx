import { useEffect, useState } from "react";
import { getSession, onAuthStateChange } from "../utils/auth";
import { getDeviceKey } from "../utils/deviceIdentity";

// The same receipt works for seasonal and ongoing invitations. Ownership is
// checked by the server; a URL parameter alone never authorizes withdrawal.
export default function EventSharingReceipt({ onRemoved, postId = "" }) {
  const [id, setId] = useState(() => {
    const value = postId || new URLSearchParams(window.location.search).get("post") || "";
    return /^wp_[A-Za-z0-9_-]{1,60}$/.test(value) ? value : "";
  });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [canManage, setCanManage] = useState(false);
  useEffect(() => {
    if (!id) { setCanManage(false); return undefined; }
    let active = true;
    let controller = null;
    const refresh = async () => {
      controller?.abort();
      const current = new AbortController(); controller = current;
      setCanManage(false); // Never render management before server confirmation.
      try {
        const session = await getSession().catch(() => null);
        let userKey = "";
        try { userKey = getDeviceKey(); } catch { /* unavailable */ }
        const attempts = [];
        if (session?.access_token) attempts.push({ Authorization: `Bearer ${session.access_token}` });
        // An account sign-in does not transfer an anonymous device's own post.
        if (userKey && !userKey.startsWith("pb_")) attempts.push({});
        for (const headers of attempts) {
          if (!active || current.signal.aborted) return;
          const response = await fetch(`/api/wall/${encodeURIComponent(id)}/permissions`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ userKey }), signal: current.signal, cache: "no-store" });
          if (response.status >= 500 || response.status === 429) return;
          const result = response.ok ? await response.json() : null;
          if (result?.canUnpublish === true && active && !current.signal.aborted) { setCanManage(true); return; }
        }
      } catch { /* No verified ownership means no owner controls. */ }
    };
    refresh();
    const unsubscribe = onAuthStateChange(refresh);
    const storageChanged = (event) => { if (!event.key || ["pocketbase_auth", "drawesome:userkey:v1"].includes(event.key)) refresh(); };
    window.addEventListener("storage", storageChanged);
    return () => { active = false; controller?.abort(); unsubscribe(); window.removeEventListener("storage", storageChanged); };
  }, [id]);
  const remove = async () => {
    if (!canManage || busy || !id || !window.confirm("Remove this drawing from public discovery? Your original drawing is not deleted.")) return;
    setBusy(true); setMessage("");
    try {
      const session = await getSession().catch(() => null);
      let userKey = "";
      try { userKey = getDeviceKey(); } catch { /* unavailable */ }
      const headers = { "Content-Type": "application/json" };
      if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
      let response = await fetch(`/api/wall/${encodeURIComponent(id)}/unpublish`, { method: "POST", headers, body: JSON.stringify({ userKey }) });
      // Later sign-in does not transfer anonymous posts to the account.
      if ([401, 403].includes(response.status) && session?.access_token && userKey && !userKey.startsWith("pb_")) {
        response = await fetch(`/api/wall/${encodeURIComponent(id)}/unpublish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userKey }) });
      }
      if (!response.ok) throw new Error("owner_required");
      const verify = await fetch(`/api/wall/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (verify.status !== 404) throw new Error("not_verified");
      onRemoved?.(id);
      setId(""); setMessage("Your drawing is no longer public. Your original drawing has not been deleted.");
    } catch { setMessage("We couldn’t confirm removal. Use the same device or account that shared this drawing and try again."); }
    finally { setBusy(false); }
  };
  return <>{id && canManage ? <section className="discovery-receipt" aria-labelledby="receipt-title"><h2 id="receipt-title">{postId ? "Manage your drawing" : "Your sharing receipt"}</h2><p>{postId ? "If you shared this drawing, you can remove it using the original device or account." : "This link was returned after sharing. Open it to see the public drawing."}</p><a href={`/wall/${encodeURIComponent(id)}`}>View shared drawing →</a><p>Changed your mind? The device or account that shared it can remove it from public discovery.</p><button type="button" disabled={busy} onClick={remove}>{busy ? "Removing…" : "Unpublish my drawing"}</button></section> : null}{message ? <p role="status">{message}</p> : null}</>;
}
