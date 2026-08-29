import { useEffect, useState } from "react";
import { getPageImage, setPageImage } from "../utils/pageImageCache";

// /api/sheets/:id returns JSON { image: <dataURL> }, NOT raw image bytes — so a
// stored-image id (trace_/pp_/cd_/sheet) can't go straight into an <img src>.
// Fetch (once, LRU-cached) and render the data URL. A missing image (e.g. a
// chat doodle that faded after a server restart) shows the placeholder.
// Renders spans/imgs only — this sits inside <button> elements, where a <div>
// is invalid content.
export default function PageImage({ id, alt, className, placeholder = "🎨" }) {
  const [src, setSrc] = useState(() => (id && getPageImage(id)) || null);
  useEffect(() => {
    if (!id) { setSrc(null); return undefined; }
    const cached = getPageImage(id);
    if (cached) { setSrc(cached); return undefined; }
    let alive = true;
    fetch(`/api/sheets/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d && d.image) { setPageImage(id, d.image); setSrc(d.image); } })
      .catch(() => { /* broken page — leave placeholder */ });
    return () => { alive = false; };
  }, [id]);
  if (!src) return <span className={`phone-page-empty ${className || ""}`}>{placeholder}</span>;
  return <img src={src} alt={alt} className={className} loading="lazy" />;
}
