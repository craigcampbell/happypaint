// Painterly building blocks for the Painted Planet: SVG filters that make flat
// vector shapes read as paint on paper, plus the hand-painted ocean, sea creatures
// and lettering behind the countries.
//
// Everything here is decorative and deterministic (seeded, no Math.random) so the
// picture is identical on every render and device. Nothing in it encodes data —
// the data lives in the country fills, brushwork density and splatter in
// PlanetPage.jsx — and every element is aria-hidden / pointer-events:none.

import { memo } from "react";
import { rng } from "./paintUtils";

// ---- filters ---------------------------------------------------------------------
// pm-warp   : wobbles an outline like a wet brush edge (also used inside the land mask
//             so the bristle layer stops exactly where the paint does).
// pm-wc     : warp + darker pigment pooling at the rim + paper granulation.
// pm-deckle : rough torn/deckled paper edge for the ocean sheet.
// pm-bristle-dark / -light : long horizontal streaks, like a flat brush dragged across.
export function PaintDefs() {
  return (
    <defs>
      <filter id="pm-warp" x="-3%" y="-3%" width="106%" height="106%">
        <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2" seed="7" result="warp" />
        <feDisplacementMap in="SourceGraphic" in2="warp" scale="5.5" xChannelSelector="R" yChannelSelector="G" />
      </filter>

      {/* dry-brush: erodes whatever is drawn through it into streaky bristle marks */}
      <filter id="pm-dry" x="-2%" y="-2%" width="104%" height="104%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.012 0.42" numOctaves="2" seed="17" result="s" />
        <feColorMatrix in="s" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 3.4 -1.05" result="mask" />
        <feComposite in="SourceGraphic" in2="mask" operator="in" />
      </filter>

      {/* a second, offset pencil line that never quite agrees with the paint */}
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

      <filter id="pm-deckle" x="-4%" y="-4%" width="108%" height="108%">
        <feTurbulence type="fractalNoise" baseFrequency="0.018 0.03" numOctaves="3" seed="21" result="d" />
        <feDisplacementMap in="SourceGraphic" in2="d" scale="14" xChannelSelector="R" yChannelSelector="G" />
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

      <radialGradient id="pm-sea" cx="50%" cy="46%" r="72%">
        <stop offset="0" stopColor="#d9f0ee" />
        <stop offset="0.55" stopColor="#a9d8de" />
        <stop offset="1" stopColor="#6fb3c8" />
      </radialGradient>
      <radialGradient id="pm-bloom-w" cx="50%" cy="50%" r="50%">
        <stop offset="0" stopColor="#ffffff" stopOpacity="0.7" />
        <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="pm-bloom-t" cx="50%" cy="50%" r="50%">
        <stop offset="0" stopColor="#2f86a6" stopOpacity="0.5" />
        <stop offset="1" stopColor="#2f86a6" stopOpacity="0" />
      </radialGradient>
    </defs>
  );
}

// ---- the ocean -------------------------------------------------------------------
// One hand-painted sea: washes, wave dashes, a compass rose, two tall ships, a
// whale and lettering. Static, so it is built once and memoised.
function waveStrokes(w, h) {
  const r = rng(90210);
  const out = [];
  const palette = ["#ffffff", "#ffffff", "#5fb0c9", "#2f7fa6", "#f3fbfa"];
  for (let i = 0; i < 70; i += 1) {
    const x = r() * (w - 40);
    const y = 10 + r() * (h - 20);
    const len = 14 + r() * 30;
    const amp = 2 + r() * 3.5;
    const c = palette[Math.floor(r() * palette.length)];
    out.push({
      key: i,
      d: `M${x.toFixed(1)} ${y.toFixed(1)} q ${(len / 4).toFixed(1)} ${-amp.toFixed(1)} ${(len / 2).toFixed(1)} 0 t ${(len / 2).toFixed(1)} 0`,
      stroke: c,
      width: (1.4 + r() * 2.6).toFixed(1),
      opacity: c === "#ffffff" || c === "#f3fbfa" ? 0.35 + r() * 0.3 : 0.16 + r() * 0.16,
    });
  }
  return out;
}

function swipeStrokes(w, h) {
  const r = rng(4242);
  const out = [];
  const palette = ["#ffffff", "#f3fbfa", "#3f97b8", "#2a7aa3", "#8fd0d8"];
  for (let i = 0; i < 26; i += 1) {
    const y = r() * h;
    const x = -20 + r() * (w * 0.5);
    const len = 160 + r() * 380;
    const rise = (r() - 0.5) * 34;
    const c = palette[Math.floor(r() * palette.length)];
    out.push({
      key: i,
      d: `M${x.toFixed(1)} ${y.toFixed(1)} q ${(len / 2).toFixed(1)} ${(rise * 0.4 + (r() - 0.5) * 16).toFixed(1)} ${len.toFixed(1)} ${rise.toFixed(1)}`,
      stroke: c,
      width: (12 + r() * 22).toFixed(1),
      opacity: c === "#ffffff" || c === "#f3fbfa" ? 0.22 + r() * 0.2 : 0.14 + r() * 0.14,
    });
  }
  return out;
}

const OceanArtInner = ({ width, height }) => {
  const waves = waveStrokes(width, height);
  const swipes = swipeStrokes(width, height);
  return (
    <g aria-hidden="true" pointerEvents="none">
      {/* the sheet: soft teal wash on a rough-edged piece of paper */}
      <g filter="url(#pm-deckle)">
        <rect x="0" y="0" width={width} height={height} fill="url(#pm-sea)" />
      </g>
      {/* pigment blooms where wet paint pooled and lifted */}
      <ellipse cx="170" cy="120" rx="150" ry="60" fill="url(#pm-bloom-w)" />
      <ellipse cx="470" cy="420" rx="200" ry="46" fill="url(#pm-bloom-t)" />
      <ellipse cx="760" cy="80" rx="130" ry="50" fill="url(#pm-bloom-w)" />
      <ellipse cx="90" cy="380" rx="120" ry="70" fill="url(#pm-bloom-t)" />
      <ellipse cx="640" cy="330" rx="110" ry="40" fill="url(#pm-bloom-w)" />
      <ellipse cx="880" cy="260" rx="80" ry="70" fill="url(#pm-bloom-t)" />
      {/* wide brush swipes across the sea, dragged dry so the paper shows through */}
      <g filter="url(#pm-dry)">
        {swipes.map((sw) => (
          <path key={sw.key} d={sw.d} fill="none" stroke={sw.stroke} strokeWidth={sw.width} strokeLinecap="round" opacity={sw.opacity} />
        ))}
      </g>
      {waves.map((wv) => (
        <path key={wv.key} d={wv.d} fill="none" stroke={wv.stroke} strokeWidth={wv.width} strokeLinecap="round" opacity={wv.opacity} />
      ))}

      {/* ocean lettering — italic, wide-tracked, faint, like a chart hand-lettered in ink */}
      <g fill="#1a4f6b" opacity="0.72" fontFamily="Georgia, 'Times New Roman', serif" fontStyle="italic" letterSpacing="5" fontSize="15">
        <text x="60" y="300" transform="rotate(-8 60 300)">Pacific</text>
        <text x="392" y="330" transform="rotate(-70 392 330)" fontSize="13">Atlantic</text>
        <text x="612" y="352" fontSize="13">Indian Ocean</text>
      </g>

      {/* compass rose, bottom-left */}
      <g transform="translate(92 402)" opacity="0.8">
        <circle r="30" fill="#fbf3dc" opacity="0.6" />
        <circle r="30" fill="none" stroke="#7a4a2a" strokeWidth="1.2" strokeDasharray="2 3" />
        <path d="M0 -30 L5 -5 L0 0 L-5 -5 Z" fill="#c8407f" />
        <path d="M0 30 L5 5 L0 0 L-5 5 Z" fill="#7a4a2a" opacity="0.7" />
        <path d="M-30 0 L-5 -5 L0 0 L-5 5 Z" fill="#7a4a2a" opacity="0.7" />
        <path d="M30 0 L5 -5 L0 0 L5 5 Z" fill="#7a4a2a" opacity="0.7" />
        <path d="M-16 -16 L-3 -3 L-16 -16 M16 -16 L3 -3 M-16 16 L-3 3 M16 16 L3 3" stroke="#7a4a2a" strokeWidth="1.4" strokeLinecap="round" fill="none" />
        <text y="-35" textAnchor="middle" fontSize="10" fontWeight="800" fill="#7a4a2a" fontFamily="Georgia, serif">N</text>
      </g>

      {/* tall ship in the Atlantic */}
      <g transform="translate(430 292) rotate(-4)">
        <path d="M-22 0 Q0 14 22 0 L17 -6 L-17 -6 Z" fill="#8a5a3c" />
        <path d="M0 -6 V-44" stroke="#5a3a24" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M2 -42 Q22 -28 2 -12 Z" fill="#fffaf0" stroke="#d9c9a8" strokeWidth="0.8" />
        <path d="M-2 -38 Q-18 -26 -2 -14 Z" fill="#ffe08a" stroke="#d9b45a" strokeWidth="0.8" />
        <path d="M0 -44 l9 3 l-9 3 z" fill="#c8407f" />
        <path d="M-30 6 q6 -4 12 0 t12 0 t12 0 t12 0 t12 0" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.8" />
      </g>

      {/* second ship, Pacific */}
      <g transform="translate(40 190) rotate(3) scale(0.8)">
        <path d="M-22 0 Q0 14 22 0 L17 -6 L-17 -6 Z" fill="#9a6a4a" />
        <path d="M0 -6 V-40" stroke="#5a3a24" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M2 -38 Q20 -26 2 -12 Z" fill="#fffaf0" stroke="#d9c9a8" strokeWidth="0.8" />
        <path d="M-30 6 q6 -4 12 0 t12 0 t12 0 t12 0 t12 0" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.8" />
      </g>

      {/* whale in the Indian Ocean */}
      <g transform="translate(700 392)">
        <path d="M-34 0 C-30 -18 -6 -24 14 -14 C26 -8 30 -16 40 -26 C40 -12 40 -6 46 0 C36 -2 28 4 20 8 C8 16 -24 16 -34 0 Z" fill="#3b6f96" />
        <path d="M-26 6 C-10 12 8 12 20 6" stroke="#e8f4f8" strokeWidth="3" fill="none" strokeLinecap="round" opacity="0.8" />
        <circle cx="-18" cy="-4" r="1.8" fill="#12303f" />
        <path d="M-24 -20 q-4 -10 0 -16 M-24 -20 q4 -8 10 -12 M-24 -20 q0 -12 4 -18" stroke="#ffffff" strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.75" />
        <path d="M-40 10 q6 -4 12 0 t12 0 t12 0 t12 0 t12 0 t12 0 t12 0" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.8" />
      </g>
    </g>
  );
};

export const OceanArt = memo(OceanArtInner);

// A little painted globe for the page title (replaces the flat emoji).
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
