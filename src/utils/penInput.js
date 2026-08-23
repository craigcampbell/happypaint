// Pen / stylus input helpers shared by the studio pointer handlers.
//
// Pressure: Pointer Events hand us 0..1 but every digitiser fills a different
// slice of it. Apple Pencil floors near ~0.03 and rarely passes ~0.75 in normal
// drawing; a Wacom Cintiq (Windows Ink) runs the full band up to 1.0. A fixed
// map tuned for the Pencil wastes the top quarter of a Wacom's range, one tuned
// for Wacom makes the Pencil feel dead. So the ceiling ADAPTS: it starts at the
// Pencil band and rises once the pen has *sustained* heavier pressure (a run of
// samples, so a single spike from a kid jabbing the screen doesn't recalibrate
// the session), and the learned ceiling is remembered per device.

export const PEN_PRESSURE_STORAGE_KEY = "happypaint:pen-pressure:v1";

export const PEN_PRESSURE_FLOOR = 0.03;
export const PEN_PRESSURE_DEFAULT_CEILING = 0.75;
// How far above the current ceiling a sample must land to count as "over", and
// how many such samples (≈ a quarter second of a hard stroke at 60-120 Hz)
// before the ceiling is raised to their max.
const OVER_MARGIN = 0.04;
const OVER_SAMPLES_TO_RAISE = 16;

// Pointer Events button semantics (https://www.w3.org/TR/pointerevents/):
//   button 0 / buttons 1  — pen tip, left mouse
//   button 2 / buttons 2  — pen barrel button, right mouse
//   button 1 / buttons 4  — middle mouse
//   button 5 / buttons 32 — pen eraser end (Wacom, Surface, some Android pens)
export const ERASER_BUTTON = 5;
export const ERASER_BUTTONS_BIT = 32;
const SECONDARY_BUTTONS_MASK = 2 | 4;

export function createPenCalibration(initialCeiling = PEN_PRESSURE_DEFAULT_CEILING) {
  return {
    ceiling: clampCeiling(initialCeiling),
    over: 0,
    overMax: 0,
    dirty: false,
  };
}

function clampCeiling(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return PEN_PRESSURE_DEFAULT_CEILING;
  }
  return Math.min(1, Math.max(PEN_PRESSURE_DEFAULT_CEILING, n));
}

export function loadPenCalibration(storage = typeof window !== "undefined" ? window.localStorage : null) {
  try {
    const raw = storage?.getItem(PEN_PRESSURE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return createPenCalibration(parsed?.ceiling);
    }
  } catch {
    /* storage blocked / corrupt → default band */
  }
  return createPenCalibration();
}

export function savePenCalibration(cal, storage = typeof window !== "undefined" ? window.localStorage : null) {
  if (!cal?.dirty) {
    return;
  }
  cal.dirty = false;
  try {
    storage?.setItem(PEN_PRESSURE_STORAGE_KEY, JSON.stringify({ ceiling: Math.round(cal.ceiling * 1000) / 1000 }));
  } catch {
    /* best effort */
  }
}

// Feed one raw pen pressure sample; returns the normalised 0.02..1 value. The
// calibration object is mutated in place (ceiling may rise; `dirty` flags that
// it's worth persisting).
export function mapPenPressure(cal, raw) {
  const p = Number(raw) || 0;
  if (p > cal.ceiling + OVER_MARGIN) {
    cal.over += 1;
    if (p > cal.overMax) {
      cal.overMax = p;
    }
    if (cal.over >= OVER_SAMPLES_TO_RAISE) {
      cal.ceiling = Math.min(1, cal.overMax);
      cal.over = 0;
      cal.overMax = 0;
      cal.dirty = true;
    }
  } else if (cal.over > 0 && p < cal.ceiling - OVER_MARGIN) {
    // The run of heavy samples ended before it counted — forget it.
    cal.over = 0;
    cal.overMax = 0;
  }
  const span = Math.max(0.2, cal.ceiling - PEN_PRESSURE_FLOOR);
  const mapped = (p - PEN_PRESSURE_FLOOR) / span;
  return Math.min(1, Math.max(0.02, mapped));
}

// True when this pen contact came from the eraser end of the stylus.
export function isEraserPointer(event) {
  if (!event || event.pointerType !== "pen") {
    return false;
  }
  return event.button === ERASER_BUTTON || ((event.buttons || 0) & ERASER_BUTTONS_BIT) !== 0;
}

// True when the contact is a "secondary" button: pen barrel button, mouse
// right button, or mouse middle button. The studio treats these as a temporary
// pan (hand) drag — the convention Krita / Photoshop / Procreate users expect.
export function isSecondaryButtonPointer(event) {
  if (!event || event.pointerType === "touch") {
    return false;
  }
  if (event.button === 1 || event.button === 2) {
    return true;
  }
  return ((event.buttons || 0) & SECONDARY_BUTTONS_MASK) !== 0;
}
