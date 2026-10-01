// Canonical cancellation value — US spelling ("canceled") is the ONLY value
// new code emits: wire messages, URLs, error reasons, stored rows. Readers
// must keep accepting the legacy UK spelling ("cancelled") found in older
// stored values, bookmarked checkout URLs, and wire messages from pre-rename
// servers, so an old value never silently falls through a comparison.

export const CANCELED = "canceled";
export const LEGACY_CANCELLED = "cancelled";

// Map either spelling to the canonical "canceled"; every other value passes
// through untouched so non-cancellation states are never coerced.
export function normalizeCanceled(value) {
  return value === LEGACY_CANCELLED ? CANCELED : value;
}

// True for either spelling of the cancellation value.
export function isCanceled(value) {
  return normalizeCanceled(value) === CANCELED;
}
