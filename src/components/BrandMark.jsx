export default function BrandMark({ className = "", showName = true }) {
  const classes = ["brand-lockup", className].filter(Boolean).join(" ");

  return (
    <span className={classes} aria-hidden={showName ? undefined : "true"}>
      <img className="brand-mark" src="/drawesome-doodle-mark.png" alt="" draggable="false" />
      {showName ? <span className="brand-name">Drawesome</span> : null}
    </span>
  );
}
