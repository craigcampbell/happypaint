// Server-negotiated per-frame hold timing (Phase 4). The room handshake and
// `room_animation` broadcasts may carry `frameTiming: {minMs, maxMs, defaultMs}`
//, today only FLIPBOOK does (1000..3000, default 1000); every other room
// leaves it null and keeps the local 40..10000ms slider. This module is the
// ONE place that validates the wire shape and derives the clamped slider
// steps, so the studio, the film strip and any future consumer can't drift.

import { HOLD_STEPS, clampHold } from "./filmPlan";

// Validate the wire value; anything malformed is "no constraint" (null), so a
// buggy server can never wedge the hold slider or shrink a private film.
export function normalizeFrameTiming(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { minMs, maxMs, defaultMs } = raw;
  if (![minMs, maxMs, defaultMs].every(Number.isFinite)) return null;
  const min = Math.max(1, Math.round(minMs));
  const max = Math.round(maxMs);
  if (!(min <= max)) return null;
  const def = Math.max(min, Math.min(max, Math.round(defaultMs)));
  return { minMs: min, maxMs: max, defaultMs: def };
}

// Clamp a requested hold to the room's bounds (or the local defaults when the
// room constrains nothing). Rounds to an integer number of ms like clampHold.
export function clampHoldWithTiming(ms, timing) {
  const t = normalizeFrameTiming(timing);
  if (!t) return clampHold(ms);
  const n = Number(ms);
  if (!Number.isFinite(n)) return t.defaultMs;
  return Math.max(t.minMs, Math.min(t.maxMs, Math.round(n)));
}

// The hold slider steps inside the room's bounds (FLIPBOOK: 1000/1500/2000/
// 3000 of the existing steps). Never an empty list: a range between two steps
// still offers its own endpoints so the control always has a position.
export function holdStepsForTiming(timing) {
  const t = normalizeFrameTiming(timing);
  if (!t) return HOLD_STEPS;
  const inside = HOLD_STEPS.filter((step) => step >= t.minMs && step <= t.maxMs);
  if (inside.length) return inside;
  return [t.minMs, t.maxMs];
}

// Nearest index within the (possibly filtered) steps for a duration.
export function holdStepIndexFor(ms, steps) {
  const list = Array.isArray(steps) && steps.length ? steps : HOLD_STEPS;
  let best = 0;
  for (let i = 1; i < list.length; i += 1) {
    if (Math.abs(list[i] - ms) < Math.abs(list[best] - ms)) best = i;
  }
  return best;
}
