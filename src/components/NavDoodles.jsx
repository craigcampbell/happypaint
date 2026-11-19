import "./nav-doodles.css";

// Each gesture is a continuous pencil movement followed by a shorter accent.
// Coordinates are shared; the pencil stays the same width as the label grows.
const gestures = {
  oval: [
    "M94 6 C73 1 36 2 15 9 C-1 15 0 29 19 35 C46 44 91 40 110 30 C127 20 112 6 86 5 C75 4 64 5 57 6",
    "M77 41 Q94 39 105 34",
  ],
  underline: [
    "M5 35 C22 37 40 32 58 33 S94 30 114 32 Q118 33 115 34",
    "M24 40 Q48 36 82 37",
  ],
  rays: [
    "M5 34 Q8 39 22 39 C46 40 75 35 97 36",
    "M101 9 l-3 -6 M106 10 l4 -8 M112 13 l6 -3",
  ],
};

// Place once on public pages. Every control reuses these six tiny paths.
export default function NavDoodles({ color = "#c7442c" }) {
  return <svg className="nav-ink-library" aria-hidden="true" focusable="false" width="0" height="0">
    <defs>
      {Object.entries(gestures).map(([kind, strokes]) => strokes.map((d, index) =>
        <path key={kind + index} id={`nav-ink-${kind}-${index}`} d={d} pathLength="1"
          vectorEffect="non-scaling-stroke" fill="none" stroke={color} />
      ))}
    </defs>
  </svg>;
}

export function NavInkMark({ kind = "oval" }) {
  return <svg className={`nav-ink-mark nav-ink-${kind}`} aria-hidden="true" focusable="false"
    viewBox="0 0 120 44" preserveAspectRatio="none">
    <use href={`#nav-ink-${kind}-0`} />
    <use className="nav-ink-afterstroke" href={`#nav-ink-${kind}-1`} />
  </svg>;
}
