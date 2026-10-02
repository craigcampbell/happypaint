// Hand-inked display lettering for the Inktober hero paper card.
//
// Original calligraphic treatment, drawn for this site: the words are set in a
// bundled connected brush-cursive font (Caveat, SIL OFL, see
// public/fonts/caveat/OFL.txt), given an energetic hand-tilted baseline, and
// surrounded by hand-authored SVG ink pools, flicks and splatters on the cream
// paper of the card. The marks are deliberately irregular, no two blobs share
// a path, so the heading reads as wet ink, not clip art.
//
// Everything here is decorative presentation of the REAL heading text: the
// words stay selectable DOM text (readable, translatable, announced via the
// card button's accessible name), and the splatters are aria-hidden SVG.

const INK = "#17131f";

// One hand-drawn ink splatter: a pooled blob with satellite flicks. Paths are
// original, sketched for this card. `variant` picks the pool shape.
function InkSplatter({ variant, className }) {
  const pools = {
    // Round-ish pool with three throw-off droplets.
    a: (
      <>
        <path d="M32 26c8-9 24-7 28 3 3 8-3 15-11 16-9 2-19-2-21-10-1-4 1-7 4-9z" />
        <path d="M62 14c3-3 8-2 9 2 1 3-2 6-5 6-4 0-6-4-4-8z" />
        <path d="M14 38c2-3 7-3 8 0 1 4-3 7-6 5-3-1-4-3-2-5z" />
        <path d="M70 34c4-1 7 2 6 6-1 3-6 4-8 1-2-2-1-6 2-7z" />
      </>
    ),
    // Long flick, a stroke that thins into a hairline tail.
    b: (
      <>
        <path d="M8 30c16-10 34-16 52-18 4-1 7 1 6 4-1 2-4 3-8 4-16 4-32 10-46 18-3 2-6-2-4-8z" />
        <path d="M64 30c3-2 7 0 7 4 0 3-4 5-7 4-3-2-3-6 0-8z" />
        <path d="M20 44c2-2 6-1 6 2 1 3-3 5-5 4-2-1-3-4-1-6z" />
      </>
    ),
    // Splash crown, pool with upward spikes like a dropped blot.
    c: (
      <>
        <path d="M40 38c-6-2-9-8-6-13l7 4 3-12 6 10 7-8 2 12 10-4-5 10c3 6-3 12-11 12-5 0-10-4-13-11z" />
        <path d="M18 18c2-3 7-3 8 0 1 4-3 7-6 6-3-1-4-4-2-6z" />
        <path d="M66 12c3-2 7 0 7 4-1 3-5 4-8 2-2-2-2-5 1-6z" />
      </>
    ),
  };
  return (
    <svg className={className} viewBox="0 0 80 60" aria-hidden="true" focusable="false">
      <g fill={INK}>{pools[variant] || pools.a}</g>
    </svg>
  );
}

// The card's ink headline. Two tilted lines of thick connected cursive with
// splatter accents; layout + paper texture live in home-inktober.css.
export default function InktoberInkHeading({ title, className = "" }) {
  const lines = String(title).split("\n");
  return (
    <span className={`ink-heading ${className}`}>
      <InkSplatter variant="c" className="ink-splatter ink-splatter-tl" />
      <InkSplatter variant="b" className="ink-splatter ink-splatter-tr" />
      <InkSplatter variant="a" className="ink-splatter ink-splatter-br" />
      {lines.map((line, i) => (
        <span key={i} className={`ink-line ink-line-${i + 1}`}>
          {line}
        </span>
      ))}
      <span className="ink-underline" aria-hidden="true" />
    </span>
  );
}
