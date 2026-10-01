// Rolling log of the ops OTHER artists in the room sent us, so a local undo
// can put THEIR art back after it restores our own layer pixels.
//
// Why this has to exist: since shared layers landed, a friend's op paints into
// the same layer stack we do (op.layerId routing) — there is no separate
// "remote" canvas any more. So the undo snapshot we take before our own stroke
// holds whatever friends had drawn at that instant, and nothing they drew
// afterwards. Restoring it verbatim rubs their newer strokes off OUR screen
// until the next resync: an undo that undoes other people. Undo therefore
// restores the snapshot and then re-applies exactly the friends' ops that
// landed after it.
//
// "Landed" is per-brush, and that is the whole subtlety here (#62):
//   * an ordinary stroke accumulates in a bbox-capped buffer and hits the
//     layer ONCE, on its end op. So its pixels are in our snapshot only if it
//     ENDED before the mark — and replaying one means replaying the whole
//     stroke, including the ops that arrived before the mark.
//   * eraser and legacy smudge cut the layer per segment, so for those only
//     the ops after the mark are missing from the snapshot.
//   * a stroke still open in a live buffer has no pixels on the layer at all;
//     its buffer survives the restore and commits on its own end op, so
//     replaying it would paint it twice. Those are skipped (see `isOpen`).
//
// The log is a memory budget, not a history: it keeps a bounded recent window,
// and a mark that falls off the front returns null so the caller falls back to
// the plain restore (the old behavior) rather than replaying a partial room.

// Undo only ever reaches back MAX_HISTORY of OUR strokes, so the window only
// has to cover the friends' ops between those. 4000 ops is minutes of a busy
// room; the char budget is what actually bounds memory, because image ops
// carry a full dataURL.
export const SHARED_OP_LOG_MAX_OPS = 4000;
export const SHARED_OP_LOG_MAX_CHARS = 24 * 1024 * 1024;

// Brushes that write the layer directly, segment by segment, instead of
// banking into a stroke buffer. Mirrors the branch order in opReplay.applyOp
// and App's applyRemoteOp — keep the three in step. The legacy-smudge test is
// inlined (rather than calling normalizeSmudgeSettings) so this module stays
// free of the brush engine and its canvas globals: it is the `v3` flag from
// utils/brushes.js#normalizeSmudgeSettings, nothing more.
function isDirectBrush(settings) {
  if (!settings) return false;
  if (settings.brush === "eraser") return true;
  if (settings.brush === "smudge" && !(settings.v >= 3)) return true;
  return false;
}

// Rough memory weight of an op. Only the embedded rasters matter — a draw op
// is a short point batch.
function opCharge(op) {
  let charge = 64;
  if (typeof op.dataUrl === "string") charge += op.dataUrl.length;
  const stamp = op.settings?.dab?.stampDataUrl;
  if (typeof stamp === "string") charge += stamp.length;
  return charge;
}

export function createSharedOpLog({
  maxOps = SHARED_OP_LOG_MAX_OPS,
  maxChars = SHARED_OP_LOG_MAX_CHARS,
} = {}) {
  let entries = [];
  let firstSeq = 0; // seq of entries[0]; everything older has been trimmed
  let nextSeq = 0;
  let charge = 0;
  // Settings ride only the FIRST op of a stroke on settings-once clients, so
  // carry them forward to classify the continuation ops' brush.
  const strokeSettings = new Map();

  function trim() {
    while (entries.length && (entries.length > maxOps || charge > maxChars)) {
      const gone = entries.shift();
      charge -= gone.charge;
      firstSeq = gone.seq + 1;
    }
    if (!entries.length) firstSeq = nextSeq;
  }

  return {
    // Record one op that arrived from the room. Ops we drew ourselves never go
    // in here: they are what undo is removing.
    note(op) {
      if (!op || typeof op !== "object") return;
      const strokeId = op.kind === "draw" && typeof op.strokeId === "string" ? op.strokeId : null;
      let settings = op.settings || null;
      if (strokeId) {
        if (settings) strokeSettings.set(strokeId, settings);
        else settings = strokeSettings.get(strokeId) || null;
        if (op.end) strokeSettings.delete(strokeId);
      }
      const entry = {
        seq: nextSeq,
        op,
        strokeId,
        end: Boolean(strokeId && op.end),
        direct: Boolean(strokeId && isDirectBrush(settings)),
        charge: opCharge(op),
      };
      nextSeq += 1;
      entries.push(entry);
      charge += entry.charge;
      trim();
    },

    // A cursor to stamp on an undo entry: "the room looked like this here".
    mark() {
      return nextSeq;
    },

    // The ops a restore to `mark` has to re-apply, in arrival order.
    // `isOpen(strokeId)` reports whether that stroke still has a live buffer on
    // this client. Returns null when the log has rolled past the mark — the
    // caller then does a plain restore, exactly as before this existed.
    replaySince(mark, isOpen = () => false) {
      if (typeof mark !== "number" || mark < firstSeq) return null;
      if (mark >= nextSeq) return [];

      // Buffered strokes land whole, on their end op. Collect the ones whose
      // ink reached the layer AFTER the mark — those need a full replay.
      const wholeStrokes = new Set();
      const seenAfterMark = new Set();
      for (const entry of entries) {
        if (entry.seq < mark || !entry.strokeId || entry.direct) continue;
        seenAfterMark.add(entry.strokeId);
        if (entry.end) wholeStrokes.add(entry.strokeId);
      }
      // A stroke whose end op never arrived (dropped socket, legacy client) is
      // committed by the idle sweep instead — if it is no longer open here, its
      // pixels are on the layer and it needs replaying too.
      for (const strokeId of seenAfterMark) {
        if (!wholeStrokes.has(strokeId) && !isOpen(strokeId)) wholeStrokes.add(strokeId);
      }

      const out = [];
      for (const entry of entries) {
        if (entry.strokeId && !entry.direct) {
          // Whole-stroke replay reaches back BEFORE the mark: the snapshot has
          // none of this stroke, so half of it would be half a stroke.
          if (wholeStrokes.has(entry.strokeId)) out.push(entry.op);
          continue;
        }
        if (entry.seq >= mark) out.push(entry.op);
      }
      return out;
    },

    // A full history rebuild (join, resync, moderation) repaints every layer
    // from the server's own list, so every mark into this log is meaningless.
    reset() {
      entries = [];
      strokeSettings.clear();
      charge = 0;
      firstSeq = nextSeq;
    },

    get size() {
      return entries.length;
    },
    get chars() {
      return charge;
    },
  };
}
