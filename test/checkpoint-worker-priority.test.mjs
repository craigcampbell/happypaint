/* eslint-env node */
// Phase-4 worker manager queue discipline (server/checkpointWorker.js):
// requested-frame priority must jump the bounded queue (a joiner waiting on
// frame 12's checkpoint never queues behind a speculative frame-3 rebuild),
// FIFO is kept INSIDE one priority band, the queue stays bounded (overflow
// rejects queue_full, never grows), and single-argument submit(job) callers
// behave exactly as before. Uses test/fixtures/echoCheckpointWorker.mjs (a
// stub child, no browser needed).
//
//   node --test test/checkpoint-worker-priority.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCheckpointWorker } from '../server/checkpointWorker.js';

const ECHO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'echoCheckpointWorker.mjs');
const make = (opts = {}) => createCheckpointWorker({
  chromePath: process.execPath, // any existing executable satisfies the availability gate
  timeoutMs: 10000,
  workerEntry: ECHO,
  ...opts,
});

test('priority jobs run before ordinary queued jobs; FIFO within a band', async () => {
  const worker = make({ maxQueue: 4 });
  const order = [];
  const track = (promise, tag) => promise.then((frame) => { order.push(tag); return frame; });
  const submit = (tag, delayMs, priority) => track(worker.submit({ tag, delayMs }, { priority }), tag);
  const first = submit('first', 250, 0); // occupies the worker while the rest queue
  const low1 = submit('low1', 0, 0);
  const high = submit('high', 0, 5);
  const low2 = submit('low2', 0, 0);
  const mid = submit('mid', 0, 3);
  await Promise.all([first, low1, high, low2, mid]);
  assert.deepEqual(order, ['first', 'high', 'mid', 'low1', 'low2']);
  await worker.close();
});

test('single-argument submit(job) keeps legacy default priority', async () => {
  const worker = make({ maxQueue: 4 });
  const order = [];
  const track = (promise, tag) => promise.then(() => { order.push(tag); });
  const first = track(worker.submit({ tag: 'first', delayMs: 200 }), 'first');
  const plain = track(worker.submit({ tag: 'plain', delayMs: 0 }), 'plain'); // no opts: priority 0
  const urgent = track(worker.submit({ tag: 'urgent', delayMs: 0 }, { priority: 1 }), 'urgent');
  await Promise.all([first, plain, urgent]);
  assert.deepEqual(order, ['first', 'urgent', 'plain']);
  await worker.close();
});

test('queue stays bounded: overflow rejects queue_full instead of growing', async () => {
  const worker = make({ maxQueue: 1 });
  const a = worker.submit({ tag: 'a', delayMs: 200 });
  const b = worker.submit({ tag: 'b', delayMs: 0 });
  await assert.rejects(() => worker.submit({ tag: 'c', delayMs: 0 }, { priority: 9 }), (e) => e.code === 'queue_full');
  await Promise.all([a, b]);
  assert.equal(worker.stats().queueFull, 1);
  await worker.close();
});

test('priority never resurrects a stale/late result over the in-flight job', async () => {
  const worker = make({ maxQueue: 2 });
  const slow = worker.submit({ tag: 'slow', delayMs: 150 });
  const queued = worker.submit({ tag: 'queued', delayMs: 0 }, { priority: 7 });
  const slowFrame = await slow;
  assert.equal(slowFrame.tag, 'slow', 'the in-flight job resolves with ITS result');
  const queuedFrame = await queued;
  assert.equal(queuedFrame.tag, 'queued');
  await worker.close();
});
