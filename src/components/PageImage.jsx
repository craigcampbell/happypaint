import { useEffect, useState } from "react";
import { getPageImage, setPageImage } from "../utils/pageImageCache";
import { getSession, onAuthStateChange } from "../utils/auth";

// /api/sheets/:id returns JSON { image: <dataURL> }, NOT raw image bytes, so a
// stored-image id (trace_/pp_/cd_/sheet) can't go straight into an <img src>.
// Fetch (once, LRU-cached) and render the data URL. A missing image (e.g. a
// chat doodle that faded after a server restart) shows the placeholder.
// Renders spans/imgs only, this sits inside <button> elements, where a <div>
// is invalid content.
export default function PageImage({ id, alt, className, placeholder = "🎨" }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    if (!id) { setSrc(null); return undefined; }
    let alive = true;
    let controller = null;
    const refresh = async () => {
      controller?.abort();
      const current = new AbortController(); controller = current;
      setSrc(null);
      try {
        const session = await getSession();
        if (!alive || current.signal.aborted) return;
        // A prior account's private image must never satisfy the next account.
        const cacheKey = `${session?.user?.id || "anonymous"}:${id}`;
        const cached = getPageImage(cacheKey);
        if (cached) { setSrc(cached); return; }
        const response = await fetch(`/api/sheets/${encodeURIComponent(id)}`, {
          cache: "no-store", signal: current.signal,
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
        });
        const data = response.ok ? await response.json() : null;
        if (alive && !current.signal.aborted && data?.image) {
          setPageImage(cacheKey, data.image); setSrc(data.image);
        }
      } catch { /* Missing or unauthorized image: leave the placeholder. */ }
    };
    refresh();
    const unsubscribe = onAuthStateChange(refresh);
    return () => { alive = false; controller?.abort(); unsubscribe(); };
  }, [id]);
  if (!src) return <span className={`phone-page-empty ${className || ""}`}>{placeholder}</span>;
  return <img src={src} alt={alt} className={className} loading="lazy" draggable={false} />;
}
