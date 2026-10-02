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

// Feed one raw pen pressure sample; returns the normalized 0.02..1 value. The
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

// ---------------------------------------------------------------------------
// The getPoint pressure seam (App.jsx): what pressure does ONE pointer sample
// contribute to a stroke?
//
// A pen sample ALWAYS resolves through the adaptive band above — even when
// its pressure is zero (including pen-down/up boundary samples). Zero must
// not select the mouse/finger 0.65 fallback. Physical-device pressure curves
// require device verification; synthetic events test this routing contract.
// Mouse and fingers report UA constants (0.5/0), so only
// they use the velocity synthesizer (#63): slow, deliberate = heavy; fast
// flicks = light, EMA-smoothed so width breathes instead of flickering.

export function createVelocityPressure() {
  return { lastX: 0, lastY: 0, lastT: null, ema: null, lastP: 0.65 };
}

// Velocity-pressure synthesis starts fresh on every stroke.
export function resetVelocityPressure(vel) {
  vel.lastT = null;
  vel.ema = null;
}

// Resolve one sample's stroke pressure. `event` needs pointerType / pressure /
// timeStamp; `penCal` is the adaptive calibration (mutated by mapPenPressure)
// and `velocity` the synthesizer state from createVelocityPressure(). Returns
// the un-quantized 0.02..1 value — callers quantize for the wire.
export function resolvePointPressure(event, { worldX, worldY, penCal, velocity, now }) {
  if (event.pointerType === "pen") {
    return mapPenPressure(penCal, event.pressure);
  }
  const vel = velocity;
  const t = event.timeStamp || now;
  if (vel.lastT == null || t > vel.lastT) {
    if (vel.lastT == null) {
      vel.lastP = 0.65; // first point of a stroke: neutral baseline
    } else {
      const speed = Math.hypot(worldX - vel.lastX, worldY - vel.lastY) / Math.max(1, t - vel.lastT);
      vel.ema = vel.ema == null ? speed : vel.ema * 0.7 + speed * 0.3;
      vel.lastP = Math.min(0.9, Math.max(0.3, 0.9 - vel.ema * 0.055));
    }
    vel.lastX = worldX;
    vel.lastY = worldY;
    vel.lastT = t;
  }
  // t <= lastT: the same event seen twice (cursor relay + coalesced draw
  // replay) or an older coalesced sibling — reuse the last synthesis rather
  // than poisoning the EMA with zero/negative dt samples.
  return vel.lastP;
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
