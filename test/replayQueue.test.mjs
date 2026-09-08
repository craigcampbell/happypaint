import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replayInSlices } from '../src/utils/replayQueue.js';

test('image decode finishes before later paint operations', async () => {
  const painted = [];
  let finishImage;
  const decoding = new Promise((resolve) => { finishImage = resolve; });
  const replay = replayInSlices(['image', 'paint'], async (op) => {
    if (op === 'image') await decoding;
    painted.push(op);
  });
  await Promise.resolve();
  assert.deepEqual(painted, []);
  finishImage();
  assert.equal(await replay, true);
  assert.deepEqual(painted, ['image', 'paint']);
});

test('a new room cancels yielded replay before any later operation', async () => {
  const painted = [];
  let current = true;
  let clock = 0;
  const complete = await replayInSlices([1, 2, 3], (op) => {
    painted.push(op);
    clock += 10;
  }, { now: () => clock, isCurrent: () => current, yieldTask: async () => { current = false; } });
  assert.equal(complete, false);
  assert.deepEqual(painted, [1]);
});

test('expensive operations yield based on elapsed work and retain order', async () => {
  const events = [];
  let clock = 0;
  await replayInSlices([1, 2, 3], (op) => {
    events.push(op);
    clock += 6;
  }, { now: () => clock, budgetMs: 8, yieldTask: async () => { events.push('yield'); } });
  assert.deepEqual(events, [1, 2, 'yield', 3]);
});

test('cancelled image replay does not continue into strokes or final paint', async () => {
  let current = true;
  const events = [];
  const complete = await replayInSlices(['image', 'stroke'], async (op) => {
    events.push(op);
    current = false;
  }, { isCurrent: () => current, onSlice: () => events.push('render') });
  assert.equal(complete, false);
  assert.deepEqual(events, ['image']);
});
