// Checkpoint worker manager, the parent side of the trusted-render process
// boundary. Owns ONE bare Node child (server/checkpointRenderer.mjs) spawned
// with a scrubbed environment (no app credentials, no PocketBase/billing
// secrets, only what Chromium needs to launch), serializes render jobs
// through it, and enforces the operational contract:
//
//  - DISABLED-BY-DEFAULT: constructed with no usable executable, the manager
//    is inert, nothing spawns, submit() rejects 'disabled', and the realtime
//    server's startup/join paths never touch it.
//  - LAZY: the child (and Chromium inside it) starts on the FIRST job, never
//    at server boot; an idle deployment pays nothing.
//  - BOUNDED: one job in flight, a short queue (default 1 waiter, a second
//    room's build is cheaper recomputed later than queued), per-job timeout
//    with SIGKILL + respawn, and rejection of stale/oversized IPC results.
//  - CRASH-SAFE: an unexpected child exit rejects the in-flight job and the
//    next submit spawns a fresh child; the queue never wedges.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORKER_ENTRY = fileURLToPath(new URL('./checkpointRenderer.mjs', import.meta.url));
// Results carry base64 PNGs + the mix pixel array; the contract caps a frame
// at 48MiB of assets, anything larger on the wire is a renderer bug or an
// attack, not a checkpoint.
const MAX_RESULT_CHARS = 96 * 1024 * 1024;

export function createCheckpointWorker({
  chromePath = '',
  timeoutMs = 45_000,
  maxQueue = 1,
  workerEntry = WORKER_ENTRY,
} = {}) {
  const available = !!chromePath && existsSync(chromePath) && existsSync(workerEntry);
  const stats = { spawns: 0, restarts: 0, timeouts: 0, exits: 0, submitted: 0, completed: 0, failed: 0, queueFull: 0 };

  let child = null;        // the spawned renderer process (null = not running)
  let ready = false;       // child announced {type:'ready'}
  let current = null;      // in-flight { jobId, job, resolve, reject, timer }
  const queue = [];        // waiting { job, resolve, reject }
  let nextJobId = 1;
  let stderrTail = '';

  const err = (code) => { const e = new Error(code); e.code = code; return e; };

  function dropChild(reason) {
    const c = child;
    child = null;
    ready = false;
    if (c) {
      try { c.kill('SIGKILL'); } catch { /* already gone */ }
    }
    if (current) {
      const job = current;
      current = null;
      clearTimeout(job.timer);
      job.reject(err(reason));
    }
  }

  function spawnChild() {
    stats.spawns += 1;
    // Scrubbed environment: the renderer needs a PATH, a HOME and a temp dir
    // for Chromium, and NOTHING from the app process (PB tokens, admin key,
    // billing secrets stay unreachable from the render boundary).
    const env = {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      TMPDIR: process.env.TMPDIR || '',
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || '',
      NODE_ENV: 'production',
      CHECKPOINT_CHROME_PATH: chromePath,
    };
    const c = spawn(process.execPath, [workerEntry], {
      env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    child = c;
    ready = false;
    c.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });
    c.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') { ready = true; return; }
      if (!current || msg.jobId !== current.jobId) return; // stale/unsolicited: ignored
      const job = current;
      current = null;
      clearTimeout(job.timer);
      if (msg.type === 'result' && msg.frame && typeof msg.frame === 'object'
        && Buffer.byteLength(JSON.stringify(msg.frame)) <= MAX_RESULT_CHARS) {
        stats.completed += 1;
        job.resolve(msg.frame);
      } else {
        stats.failed += 1;
        job.reject(err(msg.type === 'error' ? `worker_error:${String(msg.message || '').slice(0, 200)}` : 'worker_bad_result'));
      }
      pump();
    });
    c.on('exit', () => {
      stats.exits += 1;
      if (child === c) {
        dropChild('worker_exit');
        pump();
      }
    });
    c.on('error', () => {
      if (child === c) {
        dropChild('worker_spawn_error');
        pump();
      }
    });
    return c;
  }

  // Wait for the child's ready banner so the first job doesn't race boot.
  function waitReady(c, ms) {
    if (ready) return Promise.resolve();
    return new Promise((resolveReady, rejectReady) => {
      const cleanup = () => {
        clearTimeout(timer);
        c.off('message', onMsg);
        c.off('exit', onExit);
      };
      const onExit = () => { cleanup(); rejectReady(err('worker_exit')); };
      const onMsg = (msg) => {
        if (msg && msg.type === 'ready') {
          cleanup();
          resolveReady();
        }
      };
      const timer = setTimeout(() => { cleanup(); rejectReady(err('worker_boot_timeout')); }, ms);
      c.on('message', onMsg);
      c.once('exit', onExit);
    });
  }

  async function run(job, resolve, reject) {
    const jobId = nextJobId;
    nextJobId += 1;
    try {
      if (!child) spawnChild();
      await waitReady(child, timeoutMs);
    } catch (e) {
      dropChild('worker_boot_failed');
      stats.failed += 1;
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      stats.timeouts += 1;
      stats.restarts += 1;
      dropChild('timeout');
      pump();
    }, timeoutMs);
    current = { jobId, job, resolve, reject, timer };
    try {
      child.send({ type: 'render', jobId, job });
    } catch {
      clearTimeout(timer);
      current = null;
      dropChild('worker_send_failed');
      stats.failed += 1;
      reject(err('worker_send_failed'));
    }
  }

  let pumping = false;
  function pump() {
    if (pumping) return;
    pumping = true;
    (async () => {
      while (queue.length && !current) {
        const next = queue.shift();
        await run(next.job, next.resolve, next.reject);
      }
      pumping = false;
    })().catch(() => { pumping = false; });
  }

  function submit(job, { priority = 0 } = {}) {
    stats.submitted += 1;
    if (!available) return Promise.reject(err('disabled'));
    if (current || queue.length) {
      if (queue.length >= maxQueue) {
        stats.queueFull += 1;
        return Promise.reject(err('queue_full'));
      }
    }
    // Requested-frame priority (phase 4): a joiner/fetch waiting on a specific
    // frame's checkpoint jumps ahead of speculative background rebuilds, but
    // the queue stays bounded and FIFO INSIDE one priority band, an urgent
    // job can never starve same-band waiters or reorder past the in-flight job.
    const prio = Number.isFinite(priority) ? priority : 0;
    return new Promise((resolve, reject) => {
      const entry = { job, resolve, reject, priority: prio };
      let at = queue.length;
      while (at > 0 && queue[at - 1].priority < prio) at -= 1;
      queue.splice(at, 0, entry);
      pump();
    });
  }

  async function close() {
    queue.splice(0).forEach((q) => q.reject(err('closed')));
    dropChild('closed');
  }

  return {
    available,
    reason: available ? null : (!chromePath ? 'no_chrome_path' : 'chrome_missing'),
    submit,
    close,
    stats: () => ({ ...stats }),
    stderrTail: () => stderrTail,
  };
}
