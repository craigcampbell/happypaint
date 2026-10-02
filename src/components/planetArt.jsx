// Painterly building blocks for the Painted Planet: SVG filters that make flat
// vector shapes read as paint on paper. The spinning globe renders on canvas
// (see globe/PainterlyGlobe.jsx + globe/sphere.js); these filters serve the
// still nature scene (globe/NatureScene.jsx) and any SVG bits of the page.
//
// Everything here is decorative and deterministic (seeded, no Math.random) so the
// picture is identical on every render and device. Nothing in it encodes data -
// the data lives in the country fills, brushwork density and drips, and every
// element is aria-hidden / pointer-events:none.

// ---- filters ---------------------------------------------------------------------
// pm-warp   : wobbles an outline like a wet brush edge.
// pm-dry    : dry-brush; erodes whatever is drawn through it into streaky marks.
// pm-sketch : a second, offset pencil line that never quite agrees with the paint.
// pm-wc     : warp + darker pigment pooling at the rim + paper granulation.
// pm-bristle-dark / -light : long streaks, like a flat brush dragged across.
// pm-paper  : paper tooth, to lay over a finished sheet.
export function PaintDefs() {
  return (
    <defs>
      <filter id="pm-warp" x="-3%" y="-3%" width="106%" height="106%">
        <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2" seed="7" result="warp" />
        <feDisplacementMap in="SourceGraphic" in2="warp" scale="5.5" xChannelSelector="R" yChannelSelector="G" />
      </filter>

      <filter id="pm-dry" x="-2%" y="-2%" width="104%" height="104%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.012 0.42" numOctaves="2" seed="17" result="s" />
        <feColorMatrix in="s" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 3.4 -1.05" result="mask" />
        <feComposite in="SourceGraphic" in2="mask" operator="in" />
      </filter>

      <filter id="pm-sketch" x="-3%" y="-3%" width="106%" height="106%">
        <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="13" result="w2" />
        <feDisplacementMap in="SourceGraphic" in2="w2" scale="4" xChannelSelector="G" yChannelSelector="R" />
      </filter>

      <filter id="pm-wc" x="-3%" y="-3%" width="106%" height="106%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2" seed="7" result="warp" />
        <feDisplacementMap in="SourceGraphic" in2="warp" scale="5.5" xChannelSelector="R" yChannelSelector="G" result="wob" />
        <feMorphology in="wob" operator="erode" radius="1.8" result="core" />
        <feGaussianBlur in="core" stdDeviation="1.4" result="coreSoft" />
        <feComposite in="wob" in2="coreSoft" operator="out" result="rim" />
        <feColorMatrix in="rim" type="matrix" values="0.5 0 0 0 0  0 0.46 0 0 0  0 0 0.52 0 0  0 0 0 0.9 0" result="rimDark" />
        <feMerge result="pooled">
          <feMergeNode in="wob" />
          <feMergeNode in="rimDark" />
        </feMerge>
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="3" result="grain" />
        <feColorMatrix in="grain" type="matrix" values="0 0 0 0 0.25  0 0 0 0 0.15  0 0 0 0 0.1  0 0 0 -1.6 0.72" result="grainA" />
        <feComposite in="grainA" in2="pooled" operator="in" result="grainIn" />
        <feMerge>
          <feMergeNode in="pooled" />
          <feMergeNode in="grainIn" />
        </feMerge>
      </filter>

      <filter id="pm-bristle-dark" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.004 0.2" numOctaves="2" seed="11" result="t" />
        <feColorMatrix in="t" type="matrix" values="0 0 0 0 0.28  0 0 0 0 0.12  0 0 0 0 0.1  2.2 0 0 0 -0.95" />
      </filter>
      <filter id="pm-bristle-light" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.005 0.26" numOctaves="2" seed="29" result="t" />
        <feColorMatrix in="t" type="matrix" values="0 0 0 0 1  0 0 0 0 0.97  0 0 0 0 0.9  2.2 0 0 0 -0.95" />
      </filter>

      <filter id="pm-paper" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="3" seed="5" result="n" />
        <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.35  0 0 0 0 0.25  0 0 0 0 0.15  0 0 0 0.16 0" />
      </filter>
    </defs>
  );
}

// A little painted globe for the page title.
export function PaintedGlobe({ size = 64 }) {
  return (
    <svg className="planet-globe" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id="pg-clip"><circle cx="32" cy="32" r="28" /></clipPath>
        <radialGradient id="pg-sea" cx="35%" cy="30%" r="80%">
          <stop offset="0" stopColor="#b8e6ec" />
          <stop offset="1" stopColor="#3f98c0" />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="28" fill="url(#pg-sea)" />
      <g clipPath="url(#pg-clip)">
        <path d="M8 22 C14 12 26 12 30 20 C34 28 24 30 22 38 C20 44 12 42 10 34 C8 30 6 26 8 22 Z" fill="#7cc46a" />
        <path d="M36 14 C44 10 54 16 54 26 C54 32 46 34 44 30 C40 26 32 20 36 14 Z" fill="#f2a65a" />
        <path d="M34 40 C42 36 50 42 46 50 C42 56 32 54 32 48 C32 44 32 42 34 40 Z" fill="#e4606d" />
        <ellipse cx="22" cy="18" rx="14" ry="6" fill="#fff" opacity="0.35" transform="rotate(-25 22 18)" />
      </g>
      <circle cx="32" cy="32" r="28" fill="none" stroke="#215f7d" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="60 8 40 6 50 12" />
    </svg>
  );
}
