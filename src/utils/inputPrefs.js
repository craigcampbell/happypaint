// Per-device studio input preferences: which side the tools open on
// (handedness) and whether fingers may paint at all when a pen is in use.
//
//   hand   "right" (default — the tools dock / slide in on the RIGHT, the
//          layout every existing device has) | "left" (mirrored: tools on the
//          left, floating chrome shifts the other way).
//   touch  "auto" (fingers paint, with the pen-priority + palm heuristics) |
//          "pen" (fingers NEVER paint — one finger is inert, two fingers still
//          pinch / pan / twist — the Procreate "disable touch actions" model,
//          the strongest palm rejection there is for a Pencil or a Cintiq).
//
// Stored in ONE localStorage key so the account-deletion wipe list stays
// short (utils/accountDeletion lists it).

export const INPUT_PREFS_STORAGE_KEY = "happypaint:input-prefs:v1";

export const HAND_OPTIONS = ["right", "left"];
export const TOUCH_OPTIONS = ["auto", "pen"];

export const DEFAULT_INPUT_PREFS = Object.freeze({
  hand: "right",
  touch: "auto",
  // One-shot hint: set once the "ignored a palm — try Pen only" toast has shown.
  palmTipShown: false,
});

export function normalizeInputPrefs(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    hand: HAND_OPTIONS.includes(src.hand) ? src.hand : DEFAULT_INPUT_PREFS.hand,
    touch: TOUCH_OPTIONS.includes(src.touch) ? src.touch : DEFAULT_INPUT_PREFS.touch,
    palmTipShown: Boolean(src.palmTipShown),
  };
}

export function loadInputPrefs(storage = typeof window !== "undefined" ? window.localStorage : null) {
  try {
    const raw = storage?.getItem(INPUT_PREFS_STORAGE_KEY);
    if (raw) {
      return normalizeInputPrefs(JSON.parse(raw));
    }
  } catch {
    /* storage blocked / corrupt → defaults */
  }
  return { ...DEFAULT_INPUT_PREFS };
}

export function saveInputPrefs(prefs, storage = typeof window !== "undefined" ? window.localStorage : null) {
  try {
    storage?.setItem(INPUT_PREFS_STORAGE_KEY, JSON.stringify(normalizeInputPrefs(prefs)));
  } catch {
    /* best effort */
  }
}
