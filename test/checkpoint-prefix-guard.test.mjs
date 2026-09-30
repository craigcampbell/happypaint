/* eslint-env node */
// Phase-4 safe-cut guard + retry-watermark unit tests (module level, no
// browser): the phase-3 independent review found
//  1. selectPrefix/deep-copy ran on EVERY op for rooms that could never
//     checkpoint (text-first MAIN-like) — O(history) + two JSON freezes per
//     op. Fixed with verdict-classified retry watermarks: ineligible content
//     rescans only on a generation change; a not-yet/too-small prefix retries
//     after the op deficit grows — never per op.
//  2. Stroke identity: the review's proposed "reject repeated settings" fix
//     was WRONG — the apps legitimately repeat identical settings batches
//     mid-stroke. The REAL hazards are the same strokeId open under a
//     DIFFERENT author, and a mid-stroke brush/seed change (e.g. switching to
//     eraser before `end` leaves the renderer buffer open). Both end the
//     prefix CONSERVATIVELY (a real closed prefix, never truncated ink);
//     ordinary repeated-settings batches still checkpoint.
//
//   node --test test/checkpoint-prefix-guard.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCheckpointService } from '../server/checkpoints.js';

// A stub worker manager: available, never actually renders (the scan/skip
// paths under test never reach submit; a pending promise keeps single-flight
// semantics if one ever did).
const stubWorkerFactory = () => ({
  available: true,
  reason: null,
  submit: () => new Promise(() => {}),
  stats: () => ({ submitted: 0 }),
  close: async () => {},
});

const draw = (userId, strokeId, {
  seed = 1, brush = 'marker', end = true, settingsless = false, opId = 0, points = 2,
} = {}) => {
  const op = {
    kind: 'draw', strokeId, userId, opId,
    points: Array.from({ length: points }, (_, i) => ({ x: i, y: i })),
  };
  if (!settingsless) op.settings = { brush, color: '#112233', size: 24, opacity: 1, seed };
  if (end) op.end = true;
  return op;
};

function mockService(history, config = {}) {
  const room = {
    code: 'TM',
    history,
    historyGen: 0,
    hiddenGen: 0,
    hiddenOpIds: new Set(),
    opSeq: history.length,
    frames: [{ id: 'f0', sceneId: 's0', layers: [{ id: 'L0', visible: true, opacity: 1 }] }],
    scenes: [{ id: 's0' }],
    animationEnabled: false,
  };
  const svc = createCheckpointService({
    rooms: new Map([['TM', room]]),
    config: {
      enabled: true,
      minOps: 3, rebuildTail: 400, tailMax: 800,
      maxEntries: 4, maxBytes: 64 * 1024 * 1024,
      jobMaxOps: 1000, jobMaxPoints: 100000, jobMaxBytes: 16 * 1024 * 1024,
      jobTimeoutMs: 5000, serveMaxBytes: 8 * 1024 * 1024, buildBudgetMs: 8,
      workerFactory: stubWorkerFactory,
      ...config,
    },
    visibleHistory: (r) => r.history,
    opIndexOf: (h, id) => h.findIndex((o) => (o.opId || 0) === id),
    catchup: {},
    sendReliable: () => {},
  });
  return { room, svc };
}

test('ordinary repeated-settings batches (same brush+seed) still checkpoint', async () => {
  const { room, svc } = mockService([
    draw('u1', 's1', { opId: 1, end: false }),
    draw('u1', 's1', { opId: 2, end: false }), // identical settings batch mid-stroke
    draw('u1', 's1', { opId: 3 }),             // another identical batch, closing
    draw('u1', 's2', { opId: 4 }),
  ]);
  const sel = await svc.selectPrefix(room);
  assert.ok(sel.ops, 'prefix exists');
  assert.equal(sel.ops.length, 4);
  assert.equal(sel.throughOpId, 4);
});

test('same strokeId open under a DIFFERENT author ends the prefix conservatively', async () => {
  const { room, svc } = mockService([
    draw('u1', 's0', { opId: 1 }),                 // closed earlier prefix exists
    draw('u1', 's1', { opId: 2, end: false }),     // u1 opens s1
    draw('u2', 's1', { opId: 3, end: false }),     // u2 opens the SAME id — ambiguous
    draw('u1', 's1', { opId: 4, settingsless: true }),
  ]);
  const sel = await svc.selectPrefix(room);
  assert.ok(sel.ops, 'the earlier CLOSED prefix survives');
  assert.equal(sel.throughOpId, 1, 'cut stays before the ambiguous stroke');
});

test('mid-stroke brush change (eraser switch before end) never gets cut inside', async () => {
  const { room, svc } = mockService([
    draw('u1', 's0', { opId: 1 }),
    draw('u1', 's1', { opId: 2, end: false, brush: 'marker' }),
    draw('u1', 's1', { opId: 3, end: true, brush: 'eraser' }), // buffer still open + brush changed
  ]);
  const sel = await svc.selectPrefix(room);
  assert.ok(sel.ops);
  assert.equal(sel.throughOpId, 1, 'prefix ends before the ambiguous stroke');

  const seedChange = mockService([
    draw('u1', 's1', { opId: 1, end: false, seed: 7 }),
    draw('u1', 's1', { opId: 2, end: true, seed: 8 }), // same id, new seed while open
  ]);
  const sel2 = await seedChange.svc.selectPrefix(seedChange.room);
  assert.equal(sel2.ops, null, 'no closed prefix before the ambiguous stroke: no checkpoint at all');
  assert.equal(sel2.ineligible, true, 'content-stable verdict (gen-gated retry)');
});

test('strokeId reuse AFTER close is a new stroke (not ambiguous)', async () => {
  const { room, svc } = mockService([
    draw('u1', 's1', { opId: 1 }),
    draw('u2', 's1', { opId: 2 }), // same id, different author, but u1's closed first
    draw('u1', 's1', { opId: 3 }), // and again after u2's close
  ]);
  const sel = await svc.selectPrefix(room);
  assert.ok(sel.ops);
  assert.equal(sel.throughOpId, 3);
});

test('ineligible room does NOT rescan per op; a generation change re-allows exactly one scan', async () => {
  const history = [
    { kind: 'text', point: { x: 1, y: 1 }, text: 'hello', opts: {}, userId: 'u1', opId: 1 },
  ];
  for (let i = 0; i < 20; i += 1) history.push(draw('u1', `st${i}`, { opId: i + 2 }));
  const { room, svc } = mockService(history);
  room.opSeq = history.length;
  // First attempt scans once (join-equivalent trigger) and records the verdict.
  svc.startBuild(room, 'f0');
  await new Promise((r) => setImmediate(r));
  const m1 = svc.metrics();
  assert.equal(m1.prefixScans, 1, 'one scan');
  assert.equal(m1.skippedIneligible, 1);
  // Twenty more ops must NOT rescan: the text op blocks the prefix forever
  // (until moderation/clear), so the O(history)-per-op pathology is gone.
  for (let i = 0; i < 20; i += 1) {
    room.history.push(draw('u1', `late${i}`, { opId: 100 + i }));
    room.opSeq += 1;
    svc.noteOp(room, 'f0');
  }
  const m2 = svc.metrics();
  assert.equal(m2.prefixScans, 1, 'no per-op rescans while the verdict stands');
  assert.ok(m2.skippedRetry >= 1, 'retry-watermark hits counted');
  // A moderation generation change (hide/restore) makes the verdict stale:
  // exactly ONE rescan is allowed, and it re-arms the watermark.
  room.hiddenGen += 1;
  svc.noteOp(room, 'f0');
  await new Promise((r) => setImmediate(r));
  const m3 = svc.metrics();
  assert.equal(m3.prefixScans, 2, 'one rescan after the generation change');
});

test('too-small prefix retries after the op deficit, not per op', async () => {
  const history = [draw('u1', 's1', { opId: 1 })]; // one closed stroke, minOps 3
  const { room, svc } = mockService(history);
  svc.startBuild(room, 'f0');
  await new Promise((r) => setImmediate(r));
  let m = svc.metrics();
  assert.equal(m.skippedSmall, 1);
  assert.equal(m.prefixScans, 1);
  // One more op: the deficit was 2, so this must NOT rescan yet.
  room.history.push(draw('u1', 's2', { opId: 2 }));
  room.opSeq += 1;
  svc.noteOp(room, 'f0');
  await new Promise((r) => setImmediate(r));
  m = svc.metrics();
  assert.equal(m.prefixScans, 1, 'still inside the deficit window');
  // Second op completes the deficit: exactly one rescan, reaching submit.
  room.history.push(draw('u1', 's3', { opId: 3 }));
  room.opSeq += 1;
  svc.noteOp(room, 'f0');
  await new Promise((r) => setImmediate(r));
  m = svc.metrics();
  assert.equal(m.prefixScans, 2, 'one rescan at the deficit boundary');
});

test('oversize job declines during the clone and gen-gates the retry', async () => {
  const history = [
    draw('u1', 's1', { opId: 1, points: 50 }),
    draw('u1', 's2', { opId: 2, points: 50 }),
    draw('u1', 's3', { opId: 3, points: 50 }),
  ];
  const { room, svc } = mockService(history, { jobMaxBytes: 200 }); // tiny budget
  svc.startBuild(room, 'f0');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  let m = svc.metrics();
  assert.equal(m.skippedIneligible, 1, 'over-budget freeze declined');
  // More ops: no rescan (ops never shrink the prefix).
  room.history.push(draw('u1', 's4', { opId: 4 }));
  room.opSeq += 1;
  svc.noteOp(room, 'f0');
  await new Promise((r) => setImmediate(r));
  m = svc.metrics();
  assert.equal(m.prefixScans, 1, 'oversize verdict is content-stable');
});
