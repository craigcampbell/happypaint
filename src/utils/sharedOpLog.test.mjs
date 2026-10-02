import test from "node:test";
import assert from "node:assert/strict";
import { createSharedOpLog } from "./sharedOpLog.js";

// Ops as they arrive on the wire: a buffered stroke is a run of draw ops ending
// with `end: true`; an eraser writes the layer per segment.
const brush = (strokeId, extra = {}) => ({
  kind: "draw",
  strokeId,
  points: [{ x: 1, y: 1 }],
  settings: { brush: "marker" },
  ...extra,
});
const eraser = (strokeId, extra = {}) => ({
  kind: "draw",
  strokeId,
  points: [{ x: 1, y: 1 }],
  settings: { brush: "eraser" },
  ...extra,
});
const ids = (ops) => ops.map((op) => op.strokeId ?? op.kind);

test("a mark with nothing after it replays nothing", () => {
  const log = createSharedOpLog();
  log.note(brush("a", { end: true }));
  assert.deepEqual(log.replaySince(log.mark()), []);
});

test("a friend's stroke that started and ended after the mark replays whole", () => {
  const log = createSharedOpLog();
  const mark = log.mark();
  log.note(brush("a"));
  log.note(brush("a", { end: true }));
  assert.deepEqual(ids(log.replaySince(mark)), ["a", "a"]);
});

test("a stroke that was mid-flight at the mark replays from its first op", () => {
  // Its ink lands on the layer only at the end op, so the snapshot holds NONE
  // of it, replaying just the tail would restore half a stroke.
  const log = createSharedOpLog();
  log.note(brush("a"));
  log.note(brush("a"));
  const mark = log.mark();
  log.note(brush("a", { end: true }));
  assert.equal(log.replaySince(mark).length, 3);
});

test("a stroke that finished before the mark is already in the snapshot", () => {
  const log = createSharedOpLog();
  log.note(brush("a"));
  log.note(brush("a", { end: true }));
  const mark = log.mark();
  log.note(brush("b", { end: true }));
  assert.deepEqual(ids(log.replaySince(mark)), ["b"]);
});

test("a stroke still open in a live buffer is skipped, its buffer commits itself", () => {
  const log = createSharedOpLog();
  const mark = log.mark();
  log.note(brush("open"));
  log.note(brush("done", { end: true }));
  const open = (strokeId) => strokeId === "open";
  assert.deepEqual(ids(log.replaySince(mark, open)), ["done"]);
  // …and with no live buffer left (the idle sweep committed it) it comes back.
  assert.deepEqual(ids(log.replaySince(mark)).sort(), ["done", "open"]);
});

test("eraser ops replay only from the mark, they cut the layer per segment", () => {
  const log = createSharedOpLog();
  log.note(eraser("e"));
  const mark = log.mark();
  log.note(eraser("e"));
  log.note(eraser("e", { end: true }));
  assert.equal(log.replaySince(mark).length, 2);
});

test("legacy smudge counts as a direct write, v3 smudge as a buffered stroke", () => {
  const log = createSharedOpLog();
  const legacy = { kind: "draw", strokeId: "s", points: [], settings: { brush: "smudge" } };
  const v3 = { kind: "draw", strokeId: "t", points: [], settings: { brush: "smudge", v: 3 } };
  log.note(legacy);
  log.note(v3);
  const mark = log.mark();
  log.note({ ...legacy, end: true });
  log.note({ ...v3, end: true });
  const out = log.replaySince(mark);
  // legacy: only the post-mark op; v3: both, because its ink lands on `end`.
  assert.equal(out.filter((op) => op.strokeId === "s").length, 1);
  assert.equal(out.filter((op) => op.strokeId === "t").length, 2);
});

test("settings-once clients still classify their continuation ops", () => {
  const log = createSharedOpLog();
  log.note(eraser("e")); // settings ride the first op only
  const mark = log.mark();
  log.note({ kind: "draw", strokeId: "e", points: [] });
  log.note({ kind: "draw", strokeId: "e", points: [], end: true });
  // Classified as an eraser, so no reach-back before the mark.
  assert.equal(log.replaySince(mark).length, 2);
});

test("non-draw ops replay when they land after the mark", () => {
  const log = createSharedOpLog();
  const mark = log.mark();
  log.note({ kind: "shape", tool: "rect" });
  log.note({ kind: "text", text: "hi" });
  assert.deepEqual(ids(log.replaySince(mark)), ["shape", "text"]);
});

test("replay keeps arrival order across strokes", () => {
  const log = createSharedOpLog();
  const mark = log.mark();
  log.note(brush("a"));
  log.note(brush("b"));
  log.note(brush("a", { end: true }));
  log.note(brush("b", { end: true }));
  assert.deepEqual(ids(log.replaySince(mark)), ["a", "b", "a", "b"]);
});

test("a mark that rolled off the front returns null, not a partial room", () => {
  const log = createSharedOpLog({ maxOps: 3 });
  const stale = log.mark();
  for (let i = 0; i < 5; i += 1) log.note(brush(`s${i}`, { end: true }));
  assert.equal(log.replaySince(stale), null);
  assert.equal(log.size, 3);
});

test("the char budget evicts heavy image ops", () => {
  const log = createSharedOpLog({ maxChars: 5000 });
  log.note({ kind: "image", dataUrl: "d".repeat(4000) });
  log.note({ kind: "image", dataUrl: "d".repeat(4000) });
  assert.equal(log.size, 1);
});

test("reset invalidates every outstanding mark", () => {
  const log = createSharedOpLog();
  const mark = log.mark();
  log.note(brush("a", { end: true }));
  log.reset();
  assert.equal(log.replaySince(mark), null);
  assert.deepEqual(log.replaySince(log.mark()), []);
});
