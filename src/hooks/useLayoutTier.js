import { useEffect, useState } from "react";

// Studio layout tiers. ONE definition that the JSX (panel defaults, toggles)
// and the CSS (`src/studio-layout.css`) both follow — keep the two in sync.
//
//   desktop  — wide + fine pointer (mouse / Wacom Cintiq): the tool rail is a
//              docked right column that collapses to give the canvas the whole
//              window; the studio menu is a floating popover.
//   tablet   — the compact chrome (quick bar, rooms FAB) BUT landscape and
//              ≥ 900px wide (iPad landscape, Cintiq touch-only): the tool rail
//              is a right-hand side sheet so the canvas stays visible while
//              picking brushes / colours.
//   phone    — everything else compact: the tool rail is a bottom sheet.
//
// "Compact" is the historical `(max-width: 1024px), (pointer: coarse)` rule
// the rest of the stylesheet keys on, so every existing mobile override still
// applies to BOTH tablet and phone.
export const COMPACT_QUERY = "(max-width: 1024px), (pointer: coarse)";
export const TABLET_QUERY = "(min-width: 900px) and (orientation: landscape)";

export function resolveLayoutTier() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "desktop";
  }
  if (!window.matchMedia(COMPACT_QUERY).matches) {
    return "desktop";
  }
  return window.matchMedia(TABLET_QUERY).matches ? "tablet" : "phone";
}

export function useLayoutTier() {
  const [tier, setTier] = useState(resolveLayoutTier);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }
    const queries = [window.matchMedia(COMPACT_QUERY), window.matchMedia(TABLET_QUERY)];
    const update = () => setTier(resolveLayoutTier());
    queries.forEach((mq) => {
      if (mq.addEventListener) {
        mq.addEventListener("change", update);
      } else if (mq.addListener) {
        mq.addListener(update);
      }
    });
    // Orientation flips on iPad can land before the media queries settle.
    window.addEventListener("orientationchange", update);
    update();
    return () => {
      queries.forEach((mq) => {
        if (mq.removeEventListener) {
          mq.removeEventListener("change", update);
        } else if (mq.removeListener) {
          mq.removeListener(update);
        }
      });
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return tier;
}
