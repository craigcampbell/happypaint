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
//   pressure  what pen pressure drives: "size" (default — the line thins on a
//          light touch, the way every brush has always behaved) | "opacity"
//          (a light touch lays faint paint at full width) | "both" | "off"
//          (a constant line whatever the pressure). The choice is stamped
//          INTO each stroke op (pressureSize / pressureOpacity) so friends,
//          spectators and history replay lay the identical stroke.
//
// Stored in ONE localStorage key so the account-deletion wipe list stays
// short (utils/accountDeletion lists it).

export const INPUT_PREFS_STORAGE_KEY = "happypaint:input-prefs:v1";

export const HAND_OPTIONS = ["right", "left"];
export const TOUCH_OPTIONS = ["auto", "pen"];
export const PRESSURE_OPTIONS = ["size", "opacity", "both", "off"];

export const DEFAULT_INPUT_PREFS = Object.freeze({
  hand: "right",
  touch: "auto",
  pressure: "size",
  // One-shot hint: set once the "ignored a palm — try Pen only" toast has shown.
  palmTipShown: false,
});

export function normalizeInputPrefs(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    hand: HAND_OPTIONS.includes(src.hand) ? src.hand : DEFAULT_INPUT_PREFS.hand,
    touch: TOUCH_OPTIONS.includes(src.touch) ? src.touch : DEFAULT_INPUT_PREFS.touch,
    pressure: PRESSURE_OPTIONS.includes(src.pressure) ? src.pressure : DEFAULT_INPUT_PREFS.pressure,
    palmTipShown: Boolean(src.palmTipShown),
  };
}

// The two per-stroke flags a pressure mode stands for. Size is on unless the
// mode says otherwise (so ops that carry no flag — every stroke ever recorded
// — keep their taper); opacity is off unless asked for.
export function pressureFlagsFor(mode) {
  return {
    pressureSize: mode !== "opacity" && mode !== "off",
    pressureOpacity: mode === "opacity" || mode === "both",
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
