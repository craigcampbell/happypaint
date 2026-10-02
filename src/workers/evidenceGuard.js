// Generation guard for evidence encoding (nsfwWatcher.worker.js).
//
// THE RACE THIS PREVENTS
//   The worker scans into ONE reused OffscreenCanvas: every scan overwrites
//   the previous frame's pixels. When a scan crosses the flag threshold, the
//   main thread asks the worker to encode that frame as evidence, but the
//   request is async. If a newer scan ran in between, encoding the canvas NOW
//   would bind NEWER pixels to the OLDER score: the evidence would "show"
//   something the classifier never judged. So every scan gets a generation
//   number and an encode is honored only while its generation is still the
//   latest, anything older is dropped, and the flag goes out without pixels.
//
// Kept as a tiny pure module so the guard is unit-testable outside a Worker.

export function createEvidenceGuard() {
  let generation = 0;
  return {
    // Called at the top of every scan, BEFORE the canvas is drawn into.
    // Returns the generation the scan's pixels belong to.
    beginScan() {
      generation += 1;
      return generation;
    },
    // Run encodeFn only if `gen` is still the newest scan's generation.
    // Returns encodeFn()'s (possibly async) result, or null when stale.
    encodeIfCurrent(gen, encodeFn) {
      if (typeof gen !== "number" || gen !== generation || typeof encodeFn !== "function") {
        return null;
      }
      return encodeFn();
    },
  };
}
