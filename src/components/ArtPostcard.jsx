import { useEffect, useMemo, useRef, useState } from "react";
import { POSTCARD_STYLES, renderArtPostcard } from "../utils/artPostcard";
import { shareFile } from "../utils/replayShare";
import "./art-postcard.css";

export default function ArtPostcard({ getArt, onClose }) {
  const [art, setArt] = useState(null);
  const [note, setNote] = useState("");
  const [styleId, setStyleId] = useState("airmail");
  const [prepared, setPrepared] = useState(null);
  const [problem, setProblem] = useState("");
  const [status, setStatus] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [date] = useState(() => new Date());
  const dialog = useRef(null);

  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element.showModal();
    element.querySelector("button")?.focus({ preventScroll: true });
    return () => {
      element.close();
      const target = previous?.isConnected ? previous : document.querySelector(".share-invite-close");
      target?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    let active = true;
    setProblem("");
    setArt(null);
    Promise.all([
      getArt(),
      document.fonts.ready.then(() => Promise.allSettled([
        document.fonts.load('600 67px "Sketchbook lettering"'),
        document.fonts.load('800 92px "Bricolage Grotesque"'),
        document.fonts.load('800 25px "DM Sans"'),
      ])),
    ]).then(([image]) => { if (active) setArt(image); })
      .catch(() => { if (active) setProblem("Your painting couldn’t be loaded."); });
    return () => { active = false; };
  }, [getArt, attempt]);

  useEffect(() => {
    if (!art) return undefined;
    let active = true;
    const timer = window.setTimeout(() => {
      try {
        const canvas = renderArtPostcard({ art, note, styleId, date });
        canvas.toBlob(blob => {
          if (!active) return;
          if (!blob) { setProblem("Your postcard couldn’t be prepared."); return; }
          const file = new File([blob], "drawesome-art-postcard.png", { type: "image/png" });
          const url = URL.createObjectURL(blob);
          setPrepared({ url, file, note, styleId, art });
        }, "image/png");
      } catch {
        setProblem("Your postcard couldn’t be prepared.");
      }
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [art, date, note, styleId]);

  useEffect(() => () => {
    if (prepared) URL.revokeObjectURL(prepared.url);
  }, [prepared]);

  const ready = !problem && prepared && prepared.note === note && prepared.styleId === styleId && prepared.art === art;
  const canShare = useMemo(() => {
    if (!prepared || typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
    try { return navigator.canShare({ files: [prepared.file] }); }
    catch { return false; }
  }, [prepared]);
  const share = async () => {
    const result = await shareFile(prepared.file, { files: [prepared.file], title: "Art postcard" });
    if (result === "shared") setStatus("Postcard shared.");
    else if (result !== "aborted") setStatus("Save the PNG and attach it in your email app.");
  };

  return <dialog className="studio-modal postcard-dialog" aria-labelledby="postcard-title" ref={dialog}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="modal-title-row">
      <h2 id="postcard-title">Art postcard</h2>
      <button type="button" onClick={onClose}>Close</button>
    </div>
    <div className="postcard-preview" aria-busy={!ready && !problem}>
      {prepared && !problem && <img src={prepared.url} width="1800" height="1200" alt="A postcard with your painting and personal note" />}
      {!prepared && !problem && <p>Preparing your postcard…</p>}
      {problem && <div role="alert">{problem} <button type="button" onClick={() => setAttempt(n => n + 1)}>Try again</button></div>}
    </div>
    <div className="postcard-style" role="group" aria-label="Postcard paper">
      {Object.entries(POSTCARD_STYLES).map(([id, style]) => <button key={id} type="button"
        aria-pressed={id === styleId} onClick={() => { setStyleId(id); setStatus(""); }}>{style.name}</button>)}
    </div>
    <label className="postcard-note">Your note <small>Up to 3 lines</small>
      <textarea value={note} rows={2} maxLength={120} onChange={event => {
        const lines = event.target.value.split("\n");
        setNote(lines.length <= 3 ? event.target.value : [lines[0], lines[1], lines.slice(2).join(" ")].join("\n"));
        setStatus("");
      }} placeholder="Made together." />
    </label>
    <p className="postcard-tip">Save a PNG to attach to an email{canShare ? ", or choose a mail app from your share sheet." : "."}</p>
    <div className="postcard-actions">
      {canShare && <button type="button" disabled={!ready} onClick={share}>Share postcard…</button>}
      <a href={ready ? prepared.url : undefined} download="drawesome-art-postcard.png" aria-disabled={!ready}>Save postcard PNG</a>
    </div>
    {status && <p role="status">{status}</p>}
  </dialog>;
}
