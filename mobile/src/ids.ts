// M8: collision-proof id generation.
//
// The previous `${prefix}-${Date.now()}-${Math.random()}` scheme relied on the
// random suffix for uniqueness, because in synchronous clone/duplicate loops
// (duplicate frame, clone frames, duplicate layer) `Date.now()` is constant for
// every id minted in the same tick. A single random collision there yields
// duplicate React keys and corrupts the item list.
//
// A module-level monotonic counter guarantees uniqueness within a session
// regardless of clock resolution or how tight the loop is. We still mix in
// `Date.now()` (stable, human-debuggable) and a small random suffix for
// cross-session/process readability, but correctness rests on the counter.
let counter = 0;

export function makeId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
