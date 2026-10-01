// Canonical cancellation value — US spelling ("canceled") is the ONLY value
// new code emits. Readers must keep accepting the legacy UK spelling
// ("cancelled") found in older stored rows, locally persisted receipts, and
// pre-rename backend data, so an old value never silently falls through a
// comparison. Mirrors the web build's src/utils/cancellation.js.
//
// Plain JS with JSDoc types (dependency-free) so it bundles under Metro and
// is directly importable from both the TS sources and Node test harnesses.

/** Canonical US-spelled cancellation value. */
export const CANCELED = "canceled";
/** Legacy UK spelling still found in older stored/fetched values. */
export const LEGACY_CANCELLED = "cancelled";

/**
 * Map either spelling to the canonical "canceled"; every other value passes
 * through untouched so non-cancellation states are never coerced.
 * @param {string} value
 * @returns {string}
 */
export function normalizeCanceled(value) {
  return value === LEGACY_CANCELLED ? CANCELED : value;
}

/**
 * True for either spelling of the cancellation value.
 * @param {string} value
 * @returns {boolean}
 */
export function isCanceled(value) {
  return normalizeCanceled(value) === CANCELED;
}
