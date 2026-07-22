import { useEffect, useRef } from "react";
import BrandMark from "./BrandMark";

export default function StepBackPreview({ preview, onClose }) {
  const closeRef = useRef(null);
  const themeId = preview.theme?.id || "artwork";
  const title = preview.theme?.label || preview.roomTitle || "Your artwork";
  const palette = preview.palette || [];
  const style = {
    "--preview-palette-a": palette[0] || "#cfd5da",
    "--preview-palette-b": palette[1] || "#8f9aa4",
    "--preview-palette-c": palette[2] || "#3f474e",
  };

  useEffect(() => {
    closeRef.current?.focus();
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <section
      className="step-back-preview"
      data-theme={themeId}
      style={style}
      role="dialog"
      aria-modal="true"
      aria-labelledby="step-back-title"
    >
      <img className="step-back-art-echo" src={preview.src} alt="" aria-hidden="true" />
      {preview.theme ? (
        <img className="step-back-theme-plate" src={preview.theme.asset} alt="" aria-hidden="true" />
      ) : null}
      <img className="step-back-art-streak" src={preview.src} alt="" aria-hidden="true" />

      <header className="step-back-title">
        <span>Step back</span>
        <h2 id="step-back-title">{title}</h2>
        {preview.roomPrompt ? <p>{preview.roomPrompt}</p> : null}
      </header>

      <figure className="step-back-art-stage">
        <div className="step-back-art-frame">
          <img src={preview.src} alt={`Full view of ${title}`} />
        </div>
      </figure>

      <button ref={closeRef} type="button" className="step-back-return" onClick={onClose} aria-label="Back to painting">
        <span className="step-back-chevron" aria-hidden="true">&#8249;</span>
        <BrandMark />
      </button>
    </section>
  );
}
