/* eslint-env node */
// Phase-4 checkpoint renderer WORKER STUB: echoes each job back as a minimal
// result frame after job.delayMs, so queue-ordering tests can run without a
// browser. NOT the trusted renderer, never used by the app (the production
// worker entry is always server/checkpointRenderer.mjs).
process.on('message', (msg) => {
  if (!msg || msg.type !== 'render' || !Number.isSafeInteger(msg.jobId)) return;
  const delay = Number(msg.job && msg.job.delayMs) || 0;
  setTimeout(() => {
    try {
      process.send({
        type: 'result',
        jobId: msg.jobId,
        frame: { frameId: String((msg.job && msg.job.frameId) || 'f0'), throughOpId: 0, tag: msg.job && msg.job.tag },
      });
    } catch { /* parent gone */ }
  }, delay);
});
process.on('disconnect', () => process.exit(0));
try { process.send({ type: 'ready' }); } catch { /* parent gone */ }
