// Trusted checkpoint renderer — the WORKER CHILD side of the phase-3 process
// boundary (see docs: CHECKPOINT-CONTRACT.md). Spawned by
// server/checkpointWorker.js as a bare Node child with a scrubbed environment
// (no app credentials) and one job in flight at a time.
//
// Trust model:
//  - The job payload is ops + metadata ONLY. Nothing in it is ever eval'd,
//    imported, navigated to, or turned into a URL — it crosses into the page
//    as structured data through page.evaluate(fn, job).
//  - The page can only reach a fixed virtual origin; every request is
//    intercepted and fulfilled from a frozen, in-memory copy of the pinned
//    renderer module list (CHECKPOINT_RENDERER_FILES). Anything else —
//    any origin, any path outside the list — is aborted. There is NO
//    listening socket and NO network route of any kind.
//  - One fresh browser context per job; the context is always closed, and a
//    failed job also drops the browser so a poisoned renderer can't leak
//    state into the next room.
//  - The child re-validates the job envelope and budgets before rendering and
//    re-computes the renderer fingerprint itself: a job naming a different
//    rendererVersion is refused outright.
//
// IPC protocol (JSON over child_process IPC):
//   in : { type:'render', jobId, job:{rendererVersion,frameId,throughOpId,
//          layers:[{id,visible,opacity}],ops:[...],budgets:{...}} }
//   out: { type:'ready' }                       (once, at boot)
//        { type:'result', jobId, frame }        (frame = ONE frame descriptor)
//        { type:'error',  jobId, message }
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKPOINT_RENDERER_FILES, checkpointRendererVersion } from './checkpointVersion.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ORIGIN = 'http://checkpoint.render';

// Hard ceilings even if the parent's budgets are absent/malformed — the child
// is the last fence, so its own limits must stand alone.
const HARD_MAX_OPS = 30000;
const HARD_MAX_POINTS = 8_000_000;
const HARD_MAX_JOB_BYTES = 128 * 1024 * 1024;
const HARD_MAX_LAYERS = 6;
const HARD_MAX_LAYER_B64 = 24 * 1024 * 1024; // base64 chars, above the 16MiB contract cap

// Freeze the pinned renderer sources at boot: a job can never cause a disk
// read, and a mid-run file change can't split a render across two versions.
const MODULES = new Map();
for (const rel of CHECKPOINT_RENDERER_FILES) {
  MODULES.set(rel, readFileSync(resolve(ROOT, rel)));
}
const OWN_VERSION = (() => {
  try { return checkpointRendererVersion(ROOT); } catch { return null; }
})();

const send = (msg) => { try { process.send(msg); } catch { /* parent gone */ } };
const fail = (jobId, message) => send({ type: 'error', jobId, message: String(message).slice(0, 300) });

function validateJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) return 'job must be an object';
  if (!OWN_VERSION) return 'renderer sources unavailable';
  if (job.rendererVersion !== OWN_VERSION) return 'renderer version mismatch';
  if (typeof job.frameId !== 'string' || !job.frameId || job.frameId.length > 24) return 'bad frameId';
  if (!Number.isSafeInteger(job.throughOpId) || job.throughOpId < 0) return 'bad throughOpId';
  if (!Array.isArray(job.layers) || !job.layers.length || job.layers.length > HARD_MAX_LAYERS) return 'bad layers';
  const seen = new Set();
  for (const layer of job.layers) {
    if (!layer || typeof layer.id !== 'string' || !layer.id || layer.id.length > 24 || seen.has(layer.id)) return 'bad layer id';
    seen.add(layer.id);
  }
  if (!Array.isArray(job.ops)) return 'bad ops';
  const budgets = job.budgets && typeof job.budgets === 'object' ? job.budgets : {};
  const maxOps = Math.min(Number(budgets.maxOps) || HARD_MAX_OPS, HARD_MAX_OPS);
  const maxPoints = Math.min(Number(budgets.maxPoints) || HARD_MAX_POINTS, HARD_MAX_POINTS);
  const maxBytes = Math.min(Number(budgets.maxBytes) || HARD_MAX_JOB_BYTES, HARD_MAX_JOB_BYTES);
  if (job.ops.length > maxOps) return 'op budget exceeded';
  let points = 0;
  for (const op of job.ops) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) return 'bad op';
    if (op.kind === 'draw' && Array.isArray(op.points)) points += op.points.length;
    if (points > maxPoints) return 'point budget exceeded';
  }
  const bytes = Buffer.byteLength(JSON.stringify(job.ops));
  if (bytes > maxBytes) return 'job byte budget exceeded';
  return null;
}

let browser = null;
let chromium = null;
async function ensureBrowser() {
  if (browser) return browser;
  if (!chromium) ({ chromium } = await import('playwright-core')); // optional dep: only the worker ever loads it
  browser = await chromium.launch({
    executablePath: process.env.CHECKPOINT_CHROME_PATH,
    headless: true,
    args: [
      '--no-sandbox', // containers rarely allow the SUID sandbox; job content is server-derived ops, not web content
      '--disable-dev-shm-usage',
      '--disable-gpu',
      // crypto.subtle (PNG/RGBA hashing) requires a secure context; the
      // virtual origin is route-intercepted and can never leave the box.
      `--unsafely-treat-insecure-origin-as-secure=${ORIGIN}`,
    ],
  });
  browser.on('disconnected', () => { browser = null; });
  return browser;
}

// The in-page renderer. Serialized by page.evaluate: it must stay fully
// self-contained (no closure references). `job` arrives as structured data.
async function renderInPage(job) {
  const W = 4000;
  const H = 2500;
  const [{ replayFrameOnto }, { createLayerCanvas }, fmt] = await Promise.all([
    import('/m/src/utils/opReplay.js'),
    import('/m/src/utils/layers.js'),
    import('/m/src/utils/checkpointFormat.js'),
  ]);
  const metas = job.layers.map((l) => ({ id: l.id, visible: l.visible !== false, opacity: typeof l.opacity === 'number' ? l.opacity : 1 }));
  const scratch = metas.map(() => createLayerCanvas(W, H));
  const indexOf = new Map(metas.map((m, i) => [m.id, i]));
  // Same routing rule as replayFrameComposite: an op naming a missing layer
  // lands on layer 0.
  const targetFor = (op) => scratch[indexOf.has(op.layerId) ? indexOf.get(op.layerId) : 0].getContext('2d');
  let mix = null;
  await replayFrameOnto(scratch[0], job.ops, W, H, targetFor, { onMixState: (s) => { mix = s; } });
  if (!mix) throw new Error('no mix state captured');

  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const sha256 = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));
  const maxLayerB64 = Math.min(Number(job.budgets && job.budgets.maxLayerB64) || 0, 24 * 1024 * 1024) || 24 * 1024 * 1024;

  const layers = [];
  for (let i = 0; i < scratch.length; i += 1) {
    const canvas = scratch[i];
    if (canvas.width !== W || canvas.height !== H) throw new Error('layer dimensions changed');
    const ctx = canvas.getContext('2d');
    const rgba = ctx.getImageData(0, 0, W, H);
    const rgbaSha256 = await sha256(rgba.data);
    const dataUrl = canvas.toDataURL('image/png');
    const pngBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    if (!pngBase64.length || pngBase64.length > maxLayerB64) throw new Error('layer png budget');
    // Roundtrip proof: the PNG must decode back to the exact same RGBA bytes
    // (lossless), or the checkpoint would silently drift from the op replay.
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('png decode failed')); img.src = dataUrl; });
    const back = createLayerCanvas(W, H);
    const bctx = back.getContext('2d');
    bctx.drawImage(img, 0, 0);
    const roundtrip = bctx.getImageData(0, 0, W, H);
    if (await sha256(roundtrip.data) !== rgbaSha256) throw new Error('png roundtrip mismatch');
    const pngBytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
    const pngSha256 = await sha256(pngBytes);
    layers.push({ id: metas[i].id, pngBase64, pngSha256, rgbaSha256 });
  }

  // Wire-encode the mix map: pixelsBase64, `data` omitted (client rebuilds
  // the Uint8ClampedArray before restoreState — see mixMap.js header).
  const u8 = mix.data;
  const parts = [];
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK)));
  }
  return {
    frameId: job.frameId,
    throughOpId: job.throughOpId,
    layersKey: fmt.checkpointLayersKey(metas),
    layers,
    mixState: {
      version: mix.version,
      width: mix.width,
      height: mix.height,
      pixelsBase64: btoa(parts.join('')),
      dirty: mix.dirty,
      prefetched: mix.prefetched,
    },
  };
}

async function runJob(jobId, job) {
  const bad = validateJob(job);
  if (bad) return fail(jobId, `job rejected: ${bad}`);
  let context = null;
  try {
    const b = await ensureBrowser();
    context = await b.newContext();
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      let u;
      try { u = new URL(route.request().url()); } catch { return route.abort(); }
      if (u.origin !== ORIGIN) return route.abort();
      if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<title>checkpoint</title>' });
      const m = /^\/m\/(.+)$/.exec(u.pathname);
      const rel = m && (MODULES.has(m[1]) ? m[1] : (MODULES.has(`${m[1]}.js`) ? `${m[1]}.js` : null));
      if (!rel) return route.abort();
      return route.fulfill({ contentType: 'text/javascript', body: MODULES.get(rel) });
    });
    await page.goto(`${ORIGIN}/`);
    const frame = await page.evaluate(renderInPage, job);
    await context.close();
    context = null;
    send({ type: 'result', jobId, frame });
  } catch (err) {
    if (context) { try { await context.close(); } catch { /* already gone */ } }
    // A crashed renderer must not carry state into the next job.
    if (browser) { try { await browser.close(); } catch { /* already gone */ } browser = null; }
    fail(jobId, err && err.message ? err.message : err);
  }
}

// Serialize jobs even if a buggy parent pipelines them.
let chain = Promise.resolve();
process.on('message', (msg) => {
  if (!msg || msg.type !== 'render' || !Number.isSafeInteger(msg.jobId)) return;
  chain = chain.then(() => runJob(msg.jobId, msg.job)).catch(() => {});
});
if (!process.env.CHECKPOINT_CHROME_PATH) {
  fail(0, 'CHECKPOINT_CHROME_PATH unset');
  process.exit(2);
}
// Never outlive the app: if the IPC channel drops (server exit/crash), take
// the browser down with us instead of leaking an orphaned Chromium.
process.on('disconnect', () => {
  if (browser) { browser.close().catch(() => {}).finally(() => process.exit(0)); }
  else process.exit(0);
});
send({ type: 'ready' });
