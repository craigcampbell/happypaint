// Phase-3/4 trusted checkpoint service (CHECKPOINT-CONTRACT.md + PHASE4-CONTRACT.md).
//
// What this is: an ACCELERATION layer over the retained authoritative op
// history. A trusted renderer worker (server/checkpointWorker.js +
// checkpointRenderer.mjs) replays a FROZEN, closed-stroke, fully-seeded prefix
// of ONE frame through the same replayFrameOnto the clients run, producing
// per-layer full-resolution transparent PNGs plus the layer-0 wet-mix
// continuation state. Capable joiners (cp=<64hex renderer fingerprint>)
// receive those assets as the optional `history.checkpoint` field of the
// ordinary gzipped history frame.
//
// Phase 4 extends the single-frame pilot to PER-FRAME checkpoints in
// animation rooms (per PHASE4-CONTRACT.md "Animation checkpoints"):
//  - `history.checkpoint.frames` carries a SUBSET of the scene's frames, each
//    with its OWN throughOpId watermark; `history.ops` keeps global order and
//    holds the tail above the watermark for checkpointed frames plus FULL ops
//    for every uncached frame (partial coverage — never truncated ink);
//  - builds are LAZY and requested-frame priority: joins and scene_fetch
//    (optional scene_fetch.frameId) warm exactly the frame someone is waiting
//    on; the op hot path only ever re-warms frames that already have an
//    entry. There is NO eager all-frames render (no 300-frame storm);
//  - jobs and the derived cache stay bounded (one worker, small priority
//    queue, global entry/byte ceilings, per-frame failure cooldowns and
//    ineligibility retry watermarks);
//  - generation/moderation/structure/cancellation safety: content generation,
//    hidden generation, room-object identity and the frame's OWN layer stack
//    are re-validated after every await; a mutation mid-build discards the
//    result; a nack disables checkpoints for that connection and resends the
//    CURRENT scene via the ordinary scene history (not all room frames).
//
// What this is not: it never truncates old ops, never replaces the history,
// and every failure mode — flag off, missing Chromium, version mismatch,
// worker error/timeout, corrupt or over-budget result, mutation mid-build,
// stale room object — degrades to the ordinary full/scene catch-up.
//
// Safe-cut policy (contract "Renderer parity and safe cut"):
//  - the prefix ends at a CLOSED-stroke boundary: every draw stroke started
//    inside it carries its end op inside it. Open strokes are tracked by
//    AUTHOR + stroke identity (`userId:strokeId`) inside ONE frame — the
//    frame filter scopes identity, and an end op can never close another
//    author's (or another frame's) stroke;
//  - every draw stroke inside it is SEEDED (settings.seed != null on its
//    first op) — unseeded strokes roll Math.random and can never be
//    parity-cut;
//  - AMBIGUOUS stroke identity conservatively ENDS the prefix (the prefix
//    stays a real closed prefix, history/tail stay exact): the same strokeId
//    opened by two different authors at once, or a mid-stroke settings batch
//    that changes brush or seed (e.g. a switch to eraser before `end`) can
//    never be cut safely. ORDINARY repeated-settings batches (same brush,
//    same seed — how the apps actually stream a stroke) are preserved;
//  - text ops (system font) and non-inline rasters are excluded: the first
//    ineligible op ends the prefix for good, matching "retain source history,
//    fall back to full replay".
//
// Review hardening (phase-3 independent review, folded into phase 4):
//  - the prefix scan is SLICED (yields on a time budget) and runs off the op
//    handler's call stack; an ineligible/small/oversize skip records a
//    per-frame RETRY WATERMARK so a flood of later ops never rescans the
//    whole history per op;
//  - the frozen job snapshot is cloned PER OP with the byte budget enforced
//    DURING the clone (never one synchronous 96MB JSON.parse/stringify pair);
//  - the oversize serve path evicts the entry BEFORE stamping the failure
//    cooldown (phase-3 ordering wiped the cooldown it had just set).
import { createHash } from 'node:crypto';
import { checkpointRendererVersion } from './checkpointVersion.js';
import { createCheckpointWorker } from './checkpointWorker.js';
import { buildGzippedHistoryFrame } from './historyFrame.js';
import {
  CHECKPOINT_SCHEMA_VERSION,
  CHECKPOINT_WIDTH,
  CHECKPOINT_HEIGHT,
  CHECKPOINT_MAX_LAYER_BYTES,
  CHECKPOINT_MAX_FRAME_BYTES,
  CHECKPOINT_MAX_LAYERS,
  checkpointLayersKey,
} from '../src/utils/checkpointFormat.js';
import { isInlineRaster } from '../src/utils/safeImage.js';

const SHA_RE = /^[a-f0-9]{64}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Mirror dimensions (mixMap is a 1/8 mirror of layer 0): capture/restore
// contract — see src/utils/mixMap.js.
const MIX_W = Math.ceil(CHECKPOINT_WIDTH / 8);
const MIX_H = Math.ceil(CHECKPOINT_HEIGHT / 8);
// After a failed build, don't hammer the worker on every join/op.
const FAILURE_COOLDOWN_MS = 30_000;
// queue_full is transient contention, not bad content: a brief pause, then the
// next join/fetch/op may retry (the 30s failure cooldown would wedge a
// requested frame behind a busy queue).
const BUSY_COOLDOWN_MS = 250;

const yieldToLoop = () => new Promise((done) => { setImmediate(done); });

export function createCheckpointService(deps) {
  const {
    rooms, config, visibleHistory, opIndexOf, catchup, sendReliable,
    log = () => {},
  } = deps;
  // Animation scope helpers (server.js passes its own; the fallbacks keep the
  // module usable standalone in module tests).
  const opFrameId = deps.opFrameId || ((room, op) => op.frameId || (room.frames[0] && room.frames[0].id) || 'f0');
  const framesOfScene = deps.framesOfScene || ((room, sceneId) => room.frames.filter((f) => f.sceneId === sceneId));
  const scenesMeta = deps.scenesMeta || ((room) => room.scenes);
  const {
    enabled, chromePath, minOps, rebuildTail, tailMax, maxEntries, maxBytes,
    jobMaxOps, jobMaxPoints, jobMaxBytes, jobTimeoutMs, serveMaxBytes, buildBudgetMs,
  } = config;
  // Animation builds may use a smaller per-frame floor than the pilot's
  // room-wide one; every build still needs SOME ops to be worth a render.
  const frameMinOps = Math.max(1, Number(config.frameMinOps) || minOps);
  // Cap on checkpoint descriptors served in ONE scene baseline (the rest of
  // the scene rides full ops — partial coverage by design).
  const sceneMaxFrames = Math.max(1, Number(config.sceneMaxFrames) || 8);
  // Ops to wait before rescanning a frame whose prefix was ineligible/small/
  // oversize (a generation change resets the watermark immediately).
  const retryOps = Math.max(1, Number(config.retryOps) || rebuildTail || 400);
  const workerMaxQueue = Math.max(1, Number(config.workerMaxQueue) || 3);

  const counters = {
    builds: 0, buildFailures: 0, invalidations: 0,
    hits: 0, sceneHits: 0, fallbackJoins: 0, nacks: 0,
    workerTimeouts: 0, workerErrors: 0, queueFull: 0,
    skippedIneligible: 0, skippedSmall: 0, skippedRetry: 0, oversize: 0,
    prefixScans: 0,
  };
  let disabledReason = null;
  let rendererVersion = null;
  let worker = null;
  if (!enabled) {
    disabledReason = 'flag_off';
  } else {
    try {
      rendererVersion = checkpointRendererVersion();
    } catch {
      // Renderer sources missing/partial: decline checkpoints, never fail boot.
      disabledReason = 'version_unavailable';
    }
    if (!disabledReason) {
      // config.workerFactory is a TEST seam (module tests substitute a stub);
      // production always constructs the real server/checkpointWorker.js.
      const factory = config.workerFactory || createCheckpointWorker;
      worker = factory({ chromePath, timeoutMs: jobTimeoutMs, maxQueue: workerMaxQueue, workerEntry: config.workerEntry });
      if (!worker.available) disabledReason = worker.reason || 'worker_unavailable';
    }
    if (disabledReason) log(`[checkpoints] disabled: ${disabledReason}`);
    else log('[checkpoints] trusted checkpoints enabled');
  }
  const disabled = () => disabledReason !== null;

  // ---- Bounded derived cache (memory-only; restart = full replay/rebuild) --
  // key `${code}:${frameId}` -> entry. Entry identity is pinned to the ROOM
  // OBJECT: a delete + recreate of the same code can never serve the old
  // room's pixels, and closeRoom() evicts explicitly so the bytes die with
  // the room. LRU order is refreshed on every serve.
  const entries = new Map();
  const builds = new Map(); // key -> in-flight build promise
  const failedAt = new Map(); // key -> last failure timestamp (cooldown)
  const busyUntil = new Map(); // key -> queue_full short cooldown
  const skipUntil = new Map(); // key -> { untilOpSeq, gen, hiddenGen } ineligibility retry watermark
  let totalBytes = 0;

  const canonicalLayers = (frame) => frame.layers.map((l) => ({
    id: l.id, visible: l.visible !== false, opacity: typeof l.opacity === 'number' ? l.opacity : 1,
  }));

  function evictKey(key) {
    const entry = entries.get(key);
    if (entry) {
      totalBytes -= entry.bytes;
      entries.delete(key);
    }
  }
  function evictRoom(code) {
    for (const key of Array.from(entries.keys())) if (key.startsWith(`${code}:`)) evictKey(key);
    for (const map of [failedAt, busyUntil, skipUntil, skipGen]) {
      for (const key of Array.from(map.keys())) if (key.startsWith(`${code}:`)) map.delete(key);
    }
  }
  function touchEntry(key, entry) {
    entries.delete(key);
    entries.set(key, entry);
  }
  function putEntry(entry) {
    const old = entries.get(entry.key);
    if (old) totalBytes -= old.bytes;
    entries.delete(entry.key);
    entries.set(entry.key, entry);
    totalBytes += entry.bytes;
    while (entries.size > maxEntries || totalBytes > maxBytes) {
      const oldest = entries.keys().next();
      if (oldest.done || oldest.value === entry.key) break;
      totalBytes -= entries.get(oldest.value).bytes;
      entries.delete(oldest.value);
    }
  }

  // Everything that must hold for a cached frame to be servable: same room
  // object, same content generation, same moderation generation, the frame
  // still present with the SAME layer stack, same renderer, and the watermark
  // still present in history (a front trim past it makes the prefix
  // unverifiable -> full replay). Other frames' structure is irrelevant —
  // served metadata is always rebuilt live.
  function usable(room, entry) {
    if (!entry || entry.room !== room) return false;
    if (entry.gen !== room.historyGen) return false;
    if (entry.hiddenGen !== (room.hiddenGen || 0)) return false;
    if (entry.rendererVersion !== rendererVersion) return false;
    const frame = room.frames.find((f) => f.id === entry.frameId);
    if (!frame) return false;
    if (checkpointLayersKey(canonicalLayers(frame)) !== entry.frame.layersKey) return false;
    return opIndexOf(room.history, entry.throughOpId) >= 0;
  }

  // ---- Eligibility + safe prefix selection ---------------------------------
  // Open strokes keyed by author + stroke identity inside one frame's op
  // stream. `open` maps `${userId}:${strokeId}` -> { brush, seed };
  // `openIds` maps strokeId -> its single open author key (reuse AFTER a
  // close is a new stroke in every replay; reuse WHILE OPEN is ambiguous).
  function opEligibility(op, open, openIds) {
    switch (op.kind) {
      case 'draw': {
        const sid = op.strokeId;
        if (typeof sid !== 'string' || !sid) return false;
        const authorKey = `${op.userId || ''}:${sid}`;
        if (op.settings) {
          // Unseeded strokes roll Math.random per consumer — never cut-able.
          if (op.settings.seed == null) return false;
          const brush = op.settings.brush || '';
          const seed = op.settings.seed;
          const prior = open.get(authorKey);
          // Mid-stroke brush/seed change (e.g. switching to eraser before the
          // end op): the renderer's stroke buffer is still open, so a cut
          // here is premature — end the prefix conservatively. ORDINARY
          // repeated-settings batches (identical brush+seed) are fine.
          if (prior && (prior.brush !== brush || prior.seed !== seed)) return false;
          // The same strokeId open under a DIFFERENT author: replay keys
          // buffers loosely enough that the two interpretations diverge —
          // decline the ambiguous region, keep the earlier closed prefix.
          const otherAuthor = openIds.get(sid);
          if (otherAuthor && otherAuthor !== authorKey) return false;
          open.set(authorKey, { brush, seed });
          openIds.set(sid, authorKey);
        } else if (!open.has(authorKey)) {
          return false; // orphan continuation of a stroke we can't verify
        }
        // Imported stamp tips must be inline rasters (same fence as ingest).
        const stamp = op.settings?.dab?.stampDataUrl ?? op.settings?.stampDataUrl;
        if (stamp != null && !isInlineRaster(stamp)) return false;
        return true;
      }
      case 'shape':
        return true;
      case 'image':
        return isInlineRaster(op.dataUrl);
      default:
        return false; // text (system font) + anything unknown: excluded
    }
  }

  // The longest CLOSED, fully-eligible prefix of ONE frame. Sliced: the scan
  // yields to the event loop on the shared build budget instead of stalling
  // the relay for a long history. Returns:
  //  - { ops, throughOpId }            a real closed prefix;
  //  - { ops: null, ineligible: true } an ineligible op ended the scan before
  //    any closed boundary — only a content/moderation GENERATION change can
  //    ever change that verdict (new ops never move the blocking op);
  //  - { ops: null, ineligible: false } no closed boundary YET (empty frame
  //    or a stroke still open) — more ops can complete it.
  async function selectFramePrefix(room, frameId) {
    counters.prefixScans += 1;
    const all = visibleHistory(room);
    const ops = [];
    for (let i = 0; i < all.length; i += 1) {
      if (opFrameId(room, all[i]) === frameId) ops.push(all[i]);
    }
    const open = new Map();
    const openIds = new Map();
    let points = 0;
    let candidate = -1;
    let sliceStart = performance.now();
    let brokeIneligible = false;
    for (let i = 0; i < ops.length && i < jobMaxOps; i += 1) {
      const op = ops[i];
      if (!opEligibility(op, open, openIds)) { brokeIneligible = true; break; }
      if (op.kind === 'draw') {
        points += Array.isArray(op.points) ? op.points.length : 0;
        // Over the point budget: the prefix ends here. If no closed boundary
        // exists yet this verdict is content-stable (ops never shrink), so it
        // classifies as ineligible for retry purposes.
        if (points > jobMaxPoints) { brokeIneligible = true; break; }
        if (op.end) {
          const authorKey = `${op.userId || ''}:${op.strokeId}`;
          open.delete(authorKey);
          if (openIds.get(op.strokeId) === authorKey) openIds.delete(op.strokeId);
        }
      }
      if (open.size === 0) candidate = i;
      if ((i & 255) === 255 && performance.now() - sliceStart >= buildBudgetMs) {
        await yieldToLoop();
        sliceStart = performance.now();
      }
    }
    if (candidate < 0) return { ops: null, ineligible: brokeIneligible };
    const throughOpId = ops[candidate].opId || 0;
    if (!Number.isSafeInteger(throughOpId)) return { ops: null, ineligible: true };
    return { ops: ops.slice(0, candidate + 1), throughOpId };
  }

  // Freeze the prefix for the async build PER OP with the byte budget
  // enforced DURING the clone: over-budget declines before the clone is even
  // complete, and the loop yields on the shared budget — never one
  // synchronous whole-history JSON.parse/stringify pair on the event loop.
  // (The deep copy matters: layer merges retag live ops in place.)
  async function freezeOps(ops) {
    const frozen = new Array(ops.length);
    let bytes = 0;
    let sliceStart = performance.now();
    for (let i = 0; i < ops.length; i += 1) {
      const text = JSON.stringify(ops[i]);
      bytes += Buffer.byteLength(text);
      if (bytes > jobMaxBytes) return null;
      frozen[i] = JSON.parse(text);
      if ((i & 31) === 31 && performance.now() - sliceStart >= buildBudgetMs) {
        await yieldToLoop();
        sliceStart = performance.now();
      }
    }
    return frozen;
  }

  // ---- Worker result validation (decode/hash BEFORE anything is cached) ----
  function validRect(r) {
    return r === null || (r && [r.x0, r.y0, r.w, r.h].every(Number.isFinite) && r.w >= 0 && r.h >= 0);
  }
  function validateFrame(frame, job) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('bad frame');
    if (frame.frameId !== job.frameId) throw new Error('frameId mismatch');
    if (!Number.isSafeInteger(frame.throughOpId) || frame.throughOpId !== job.throughOpId) throw new Error('watermark mismatch');
    if (frame.layersKey !== checkpointLayersKey(job.layers)) throw new Error('layersKey mismatch');
    if (!Array.isArray(frame.layers) || frame.layers.length !== job.layers.length) throw new Error('layer count mismatch');
    let bytes = 0;
    for (let i = 0; i < frame.layers.length; i += 1) {
      const layer = frame.layers[i];
      if (!layer || layer.id !== job.layers[i].id) throw new Error('layer order mismatch');
      if (typeof layer.pngBase64 !== 'string' || !layer.pngBase64.length
        || layer.pngBase64.length > CHECKPOINT_MAX_LAYER_BYTES || !B64_RE.test(layer.pngBase64)) throw new Error('bad layer png');
      if (!SHA_RE.test(layer.pngSha256 || '') || !SHA_RE.test(layer.rgbaSha256 || '')) throw new Error('bad layer hash');
      const png = Buffer.from(layer.pngBase64, 'base64');
      if (!png.length || png.subarray(0, 8).compare(PNG_MAGIC) !== 0) throw new Error('not a png');
      if (createHash('sha256').update(png).digest('hex') !== layer.pngSha256) throw new Error('png hash mismatch');
      bytes += layer.pngBase64.length;
    }
    if (bytes > CHECKPOINT_MAX_FRAME_BYTES) throw new Error('frame too large');
    const ms = frame.mixState;
    if (!ms || ms.version !== 1 || ms.width !== MIX_W || ms.height !== MIX_H) throw new Error('bad mix dims');
    if (typeof ms.pixelsBase64 !== 'string' || !B64_RE.test(ms.pixelsBase64)) throw new Error('bad mix pixels');
    if (Buffer.from(ms.pixelsBase64, 'base64').length !== MIX_W * MIX_H * 4) throw new Error('mix length mismatch');
    if (!validRect(ms.dirty) || !validRect(ms.prefetched)) throw new Error('bad mix bounds');
    bytes += ms.pixelsBase64.length;
    if (bytes > CHECKPOINT_MAX_FRAME_BYTES + 4 * 1024 * 1024) throw new Error('frame too large');
    return bytes;
  }

  // ---- Ineligibility retry watermarks ---------------------------------------
  // A frame whose prefix can't build must NOT be rescanned on every later op
  // (the review's O(history)-per-op finding). Two verdict classes:
  //  - INELIGIBLE / oversize (skipGen): new ops can NEVER move the blocking
  //    op or shrink the prefix, so rescan only when the content or moderation
  //    generation changes (a clear removes the text op, a hide covers it);
  //  - NOT YET / too small (skipUntil): more ops complete the prefix — retry
  //    once the op counter has grown by the deficit (never per-op).
  const skipGen = new Map(); // key -> { gen, hiddenGen, anim }
  function noteSkipGen(room, key) {
    skipGen.set(key, { gen: room.historyGen, hiddenGen: room.hiddenGen || 0, anim: !!room.animationEnabled });
  }
  function noteSkip(room, key, retryAfterOps = retryOps) {
    skipUntil.set(key, {
      untilOpSeq: (room.opSeq || 0) + Math.max(1, retryAfterOps),
      gen: room.historyGen,
      hiddenGen: room.hiddenGen || 0,
      anim: !!room.animationEnabled,
    });
  }
  function skipActive(room, key) {
    // The animation toggle swaps the min-ops semantics (room-wide pilot floor
    // vs per-frame floor): a verdict recorded on the other side of it is
    // meaningless — expire it instead of wedging the frame.
    const g = skipGen.get(key);
    if (g) {
      if (g.gen === room.historyGen && g.hiddenGen === (room.hiddenGen || 0) && g.anim === !!room.animationEnabled) return true;
      skipGen.delete(key); // the room changed shape: the verdict may have too
    }
    const s = skipUntil.get(key);
    if (!s) return false;
    if (s.gen !== room.historyGen || s.hiddenGen !== (room.hiddenGen || 0)
      || s.anim !== !!room.animationEnabled
      || (room.opSeq || 0) >= s.untilOpSeq) {
      skipUntil.delete(key);
      return false;
    }
    return true;
  }

  // ---- Background generation -------------------------------------------------
  // Cheap synchronous guards run on the caller's stack; the scan, the freeze
  // and the worker round-trip all happen in the async continuation, so the
  // op hot path never pays O(history) per noteOp (and the in-flight entry in
  // `builds` makes every concurrent caller share one build).
  function startBuild(room, frameId = null, { priority = 0 } = {}) {
    if (disabled()) return null;
    const frame = frameId ? room.frames.find((f) => f.id === frameId) : room.frames[0];
    if (!frame) return null;
    // Scope: ordinary rooms checkpoint their single frame (the pilot);
    // animation rooms checkpoint any frame LAZILY. A preserved multi-frame
    // flipbook with the toggle OFF stays on full replay.
    if (!room.animationEnabled && (room.frames.length !== 1 || frame !== room.frames[0])) return null;
    if (frame.layers.length > CHECKPOINT_MAX_LAYERS) return null;
    const code = room.code;
    const key = `${code}:${frame.id}`;
    if (builds.has(key)) return builds.get(key);
    const existing = entries.get(key);
    if (existing && existing.room !== room) evictKey(key); // delete/recreate race
    // A servable entry with a short tail is fresh enough: joins/ops never
    // trigger a redundant rebuild of the same prefix.
    if (existing && existing.room === room && usable(room, existing)
      && (room.opSeq || 0) - existing.throughOpId < rebuildTail) return null;
    if ((failedAt.get(key) || 0) + FAILURE_COOLDOWN_MS > Date.now()) return null;
    if ((busyUntil.get(key) || 0) > Date.now()) return null;
    if (skipActive(room, key)) { counters.skippedRetry += 1; return null; }
    const promise = (async () => {
      const minNeeded = room.animationEnabled ? frameMinOps : minOps;
      const sel = await selectFramePrefix(room, frame.id);
      if (!sel.ops) {
        counters.skippedIneligible += 1;
        // Ineligible content: only a generation change can help. A frame that
        // just isn't there yet: retry once minNeeded more ops could exist.
        if (sel.ineligible) noteSkipGen(room, key);
        else noteSkip(room, key, minNeeded);
        return null;
      }
      if (sel.ops.length < minNeeded) {
        counters.skippedSmall += 1;
        noteSkip(room, key, minNeeded - sel.ops.length);
        return null;
      }
      // Freeze EVERYTHING the async build spans: the ops (per-op deep copy,
      // budget enforced during the clone), the layer stack, and the
      // generations the result will be re-validated against.
      const gen = room.historyGen;
      const hiddenGen = room.hiddenGen || 0;
      const layers = canonicalLayers(frame);
      const frozenOps = await freezeOps(sel.ops);
      if (!frozenOps) {
        // Over the job byte budget: ops never shrink, so only a generation
        // change (moderation/clear) can make this frame buildable.
        counters.skippedIneligible += 1;
        noteSkipGen(room, key);
        return null;
      }
      const job = {
        rendererVersion,
        frameId: frame.id,
        throughOpId: sel.throughOpId,
        layers,
        ops: frozenOps,
        budgets: { maxOps: jobMaxOps, maxPoints: jobMaxPoints, maxBytes: jobMaxBytes, maxLayerB64: CHECKPOINT_MAX_LAYER_BYTES },
      };
      const result = await worker.submit(job, { priority });
      const bytes = validateFrame(result, job); // throws on any corruption
      const liveFrame = room.frames.find((f) => f.id === frame.id);
      if (rooms.get(code) !== room || room.historyGen !== gen
        || (room.hiddenGen || 0) !== hiddenGen
        || !liveFrame || checkpointLayersKey(canonicalLayers(liveFrame)) !== checkpointLayersKey(layers)) {
        counters.invalidations += 1; // mutation during generation: discard safely
        return null;
      }
      const entry = {
        key, code, frameId: frame.id, room, gen, hiddenGen, rendererVersion,
        frame: result, throughOpId: sel.throughOpId, bytes,
      };
      putEntry(entry);
      counters.builds += 1;
      return entry;
    })().catch((err) => {
      counters.buildFailures += 1;
      if (err && err.code === 'timeout') {
        counters.workerTimeouts += 1;
        failedAt.set(key, Date.now());
      } else if (err && err.code === 'queue_full') {
        counters.queueFull += 1;
        busyUntil.set(key, Date.now() + BUSY_COOLDOWN_MS); // transient: retry soon
      } else {
        counters.workerErrors += 1;
        failedAt.set(key, Date.now());
      }
      return null;
    }).finally(() => { builds.delete(key); });
    builds.set(key, promise);
    return promise;
  }

  // O(1)-ish guard on the op hot path. Correctness never depends on this — a
  // join/fetch with no usable entry just takes the ordinary path.
  function noteOp(room, frameId = null) {
    if (disabled()) return;
    if (room.animationEnabled) {
      // Animation: the op hot path only RE-WARMS frames that already have an
      // entry. First builds are requested-frame priority from join/scene_fetch
      // — never an eager render of every frame anyone draws on.
      const fid = frameId && room.frames.some((f) => f.id === frameId) ? frameId : null;
      if (!fid) return;
      const key = `${room.code}:${fid}`;
      if (builds.has(key)) return;
      const entry = entries.get(key);
      if (entry && usable(room, entry) && (room.opSeq || 0) - entry.throughOpId >= rebuildTail) {
        startBuild(room, fid);
      }
      return;
    }
    // Pilot (ordinary single-frame rooms), unchanged: rebuild once the tail
    // crosses rebuildTail, or kick the first build once the room is big enough.
    const first = room.frames[0];
    if (!first) return;
    const key = `${room.code}:${first.id}`;
    if (builds.has(key)) return;
    const entry = entries.get(key);
    if (entry && usable(room, entry)) {
      if ((room.opSeq || 0) - entry.throughOpId >= rebuildTail) startBuild(room, first.id);
      return;
    }
    if (!entry && visibleHistory(room).length >= minOps) startBuild(room, first.id);
  }

  // The ops newer than a checkpoint watermark (moderation-filtered, bounded)
  // — null when the watermark is gone or the tail is too long. Pilot scope:
  // the whole (single-frame) room.
  function tailAfter(room, throughOpId) {
    const history = room.history;
    const at = opIndexOf(history, throughOpId);
    if (at < 0) return null;
    const tail = [];
    for (let i = at + 1; i < history.length; i += 1) {
      const op = history[i];
      if (room.hiddenOpIds.size && room.hiddenOpIds.has(op.opId)) continue;
      if (tail.length >= tailMax) return null;
      tail.push(op);
    }
    return tail;
  }

  // ---- Join delivery (pilot: ordinary single-frame rooms) -------------------
  // Warm checkpoint join: one gzipped history frame carrying
  // {ops: TAIL ONLY, frames, checkpoint:{schemaVersion:1, rendererVersion,
  // frames:[descriptor]}} through the shared sliced gzip builder (with the
  // asset byte budget), gated/flushed by runCatchup exactly like the ordinary
  // path. Any degradation falls back to the ordinary full-history deliverer.
  function sendJoinCatchUp(ws, room) {
    if (room.animationEnabled) return sendSceneCatchUp(ws, room, room.scenes[0].id);
    const ordinary = () => catchup.sendRoomCatchUp(ws, room, 'full');
    if (disabled()) return ordinary();
    if (!ws.acceptsGzip || ws.checkpointsDisabled || ws.checkpointVersion !== rendererVersion) {
      // Not a checkpoint client (legacy, text-only, nacked, or stale bundle):
      // ordinary join — but warm the cache in the background if the room
      // qualifies, so the NEXT capable joiner finds it ready.
      startBuild(room, room.frames[0] && room.frames[0].id);
      return ordinary();
    }
    const key = `${room.code}:${room.frames[0] && room.frames[0].id}`;
    const entry = entries.get(key);
    if (!entry || !usable(room, entry)) {
      // First join before the checkpoint is ready: ordinary full history.
      counters.fallbackJoins += 1;
      startBuild(room, room.frames[0] && room.frames[0].id);
      return ordinary();
    }
    return catchup.runCatchup(ws, room, { kind: 'full' }, async (gate, epoch) => {
      const serve = entries.get(key);
      if (!serve || !usable(room, serve)) {
        return catchup.deliverRoomVariant(ws, room, { kind: 'full' }, gate, epoch);
      }
      touchEntry(key, serve);
      const tail = tailAfter(room, serve.throughOpId);
      if (!tail) return catchup.deliverRoomVariant(ws, room, { kind: 'full' }, gate, epoch);
      const msg = {
        type: 'history',
        ops: tail,
        frames: room.frames,
        checkpoint: {
          schemaVersion: CHECKPOINT_SCHEMA_VERSION,
          rendererVersion: serve.rendererVersion,
          frames: [serve.frame],
        },
      };
      const built = await buildGzippedHistoryFrame({
        variant: 'checkpoint', gen: serve.gen, hiddenGen: serve.hiddenGen,
        framesKey: serve.frame.layersKey, msg, budgetMs: buildBudgetMs,
      });
      // The async gzip spans many loop turns: a mutation (clear / moderation /
      // structure) may have landed mid-build. Re-validate before serving.
      if (!usable(room, serve)) {
        return catchup.deliverRoomVariant(ws, room, { kind: 'full' }, gate, epoch);
      }
      if (built.gz.length > serveMaxBytes) {
        // Too big for one WS message: drop the entry, serve ordinary, and
        // remember so we don't rebuild the same oversize frame every join.
        // Evict BEFORE stamping the cooldown — evictRoom clears failure
        // timestamps, and the phase-3 ordering silently wiped this one.
        counters.oversize += 1;
        evictKey(key);
        failedAt.set(key, Date.now());
        return catchup.deliverRoomVariant(ws, room, { kind: 'full' }, gate, epoch);
      }
      if (!catchup.isCurrent(ws, gate, epoch)) return { kind: 'none' };
      sendReliable(ws, built.gz, { binary: true });
      counters.hits += 1;
      let throughOpId = serve.throughOpId;
      if (tail.length) throughOpId = tail[tail.length - 1].opId || throughOpId;
      return { kind: 'frame', throughOpId };
    });
  }

  // ---- Scene delivery (phase 4: animation rooms page by scene) --------------
  // One gzipped scene history frame whose checkpoint.frames carry a SUBSET of
  // the scene's frames (each with its own watermark) and whose ops keep
  // global order: the exact tail above the watermark for checkpointed frames,
  // FULL ops for every other scene frame. Structural metadata (scenes meta +
  // the scene's frame list with layer stacks) stays the full authoritative
  // list. capability nacks fall back to the ordinary scene gzip path inside
  // the same gate, so ordering/exactly-once semantics are inherited.
  function sendSceneCatchUp(ws, room, sceneId, opts = {}) {
    const ordinary = () => catchup.sendSceneCatchUp(ws, room, sceneId);
    if (!room.animationEnabled || !room.scenes.some((s) => s.id === sceneId)) return ordinary();
    // Remember the CURRENT requested scene: checkpoint_nack resends THIS
    // scene via the ordinary scene history, never the whole room's frames.
    ws.checkpointSceneId = sceneId;
    if (disabled()) return ordinary();
    const sceneFrames = framesOfScene(room, sceneId);
    if (!sceneFrames.length) return ordinary();
    // Optional scene_fetch.frameId: the frame the client WANTS current —
    // its build jumps the worker queue. Absent → the scene's first frame.
    let wanted = null;
    if (opts.frameId != null) {
      const fid = String(opts.frameId).slice(0, 24);
      if (sceneFrames.some((f) => f.id === fid)) wanted = fid;
    }
    const warmTarget = wanted || sceneFrames[0].id;
    if (!ws.acceptsGzip || ws.checkpointsDisabled || ws.checkpointVersion !== rendererVersion) {
      // Not a checkpoint client: ordinary scene history — but warm the
      // requested frame in the background for the NEXT capable fetch.
      startBuild(room, warmTarget, { priority: wanted ? 2 : 1 });
      return ordinary();
    }
    return catchup.runCatchup(ws, room, { kind: 'scene', sceneId },
      (gate, epoch) => deliverSceneCheckpoint(ws, room, sceneId, { wanted, gate, epoch }));
  }

  async function deliverSceneCheckpoint(ws, room, sceneId, { wanted, gate, epoch }) {
    const fallback = () => catchup.deliverScene(ws, room, { kind: 'scene', sceneId }, gate, epoch);
    const sceneFrames = framesOfScene(room, sceneId);
    const sceneIds = new Set(sceneFrames.map((f) => f.id));
    // Usable per-frame entries, the requested frame first, capped: the rest
    // of the scene rides full ops (partial coverage, never truncated ink).
    const ordered = sceneFrames.slice().sort((a, b) => (a.id === wanted ? -1 : b.id === wanted ? 1 : 0));
    const picked = [];
    for (const frame of ordered) {
      if (picked.length >= sceneMaxFrames) break;
      const key = `${room.code}:${frame.id}`;
      const entry = entries.get(key);
      if (entry && usable(room, entry)) {
        touchEntry(key, entry);
        picked.push(entry);
      }
    }
    if (!picked.length) {
      // Cold: ordinary scene baseline + warm the requested frame for next time.
      startBuild(room, wanted || sceneFrames[0].id, { priority: wanted ? 2 : 1 });
      return fallback();
    }
    // The requested frame isn't covered by a warm entry: build it in the
    // background (queue-priority) so the NEXT fetch finds it — only ever the
    // requested frame, never the whole film.
    if (wanted && !picked.some((e) => e.frameId === wanted)) {
      startBuild(room, wanted, { priority: 2 });
    }
    // Per-frame tail feasibility: a checkpointed frame whose tail outgrew the
    // budget drops OUT of the checkpoint set and serves its full ops instead.
    const watermarks = new Map(picked.map((e) => [e.frameId, e.throughOpId]));
    const visible = visibleHistory(room);
    const tailCounts = new Map();
    for (let i = 0; i < visible.length; i += 1) {
      const op = visible[i];
      const fid = opFrameId(room, op);
      if (!sceneIds.has(fid)) continue;
      const wm = watermarks.get(fid);
      if (wm == null || (op.opId || 0) <= wm) continue;
      const n = (tailCounts.get(fid) || 0) + 1;
      tailCounts.set(fid, n);
      if (n > tailMax) watermarks.delete(fid);
    }
    if (!watermarks.size) return fallback(); // every tail outgrew the budget
    // Assemble in GLOBAL history order: tail above each checkpointed frame's
    // watermark, full ops for every other scene frame. freezeWatermark is the
    // last scene op covered by this baseline — the gate flush re-sends only
    // strictly-newer in-scope ops (exactly-once, same contract as the
    // ordinary frame+tail path).
    const ops = [];
    let freezeWatermark = 0;
    for (let i = 0; i < visible.length; i += 1) {
      const op = visible[i];
      const fid = opFrameId(room, op);
      if (!sceneIds.has(fid)) continue;
      freezeWatermark = Math.max(freezeWatermark, op.opId || 0);
      const wm = watermarks.get(fid);
      if (wm != null && (op.opId || 0) <= wm) continue; // checkpoint asset covers it
      ops.push(op);
    }
    const descriptors = picked.filter((e) => watermarks.has(e.frameId)).map((e) => e.frame);
    const gen = room.historyGen;
    const hiddenGen = room.hiddenGen || 0;
    const msg = {
      type: 'history',
      sceneId,
      scenes: scenesMeta(room),
      frames: sceneFrames,
      ops,
      checkpoint: {
        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
        rendererVersion,
        frames: descriptors,
      },
    };
    const built = await buildGzippedHistoryFrame({
      variant: `scenecp:${sceneId}`, gen, hiddenGen,
      framesKey: JSON.stringify([sceneId, descriptors.map((d) => d.frameId)]),
      msg, budgetMs: buildBudgetMs,
    });
    // The async gzip spans loop turns: a mutation (draw burst is fine —
    // covered by the tail watermark — but clear/moderation/structure is not)
    // may have landed mid-build. Re-validate everything before serving.
    if (rooms.get(room.code) !== room || room.historyGen !== gen
      || (room.hiddenGen || 0) !== hiddenGen
      || !descriptors.every((d) => {
        const e = entries.get(`${room.code}:${d.frameId}`);
        return e && usable(room, e) && e.frame === d;
      })) {
      return fallback();
    }
    if (built.gz.length > serveMaxBytes) {
      // Too big for one WS message: drop the entries, serve ordinary, and
      // cool down so the next join doesn't rebuild the same oversize set.
      // Evict BEFORE stamping the cooldown (eviction helpers clear it).
      counters.oversize += 1;
      for (const d of descriptors) evictKey(`${room.code}:${d.frameId}`);
      for (const d of descriptors) failedAt.set(`${room.code}:${d.frameId}`, Date.now());
      return fallback();
    }
    if (!catchup.isCurrent(ws, gate, epoch)) return { kind: 'none' };
    sendReliable(ws, built.gz, { binary: true });
    counters.hits += 1;
    counters.sceneHits += 1;
    return { kind: 'frame', throughOpId: freezeWatermark };
  }

  // The client refused/failed a checkpoint: disable them FOR THIS CONNECTION
  // ONLY and re-send the ordinary baseline — the CURRENT scene for a
  // scene-paged (animation) connection, the full history otherwise. No
  // server-side retry loop — the flag dies with the socket.
  function handleNack(ws, room) {
    if (ws.checkpointsDisabled) return;
    ws.checkpointsDisabled = true;
    counters.nacks += 1;
    const sceneId = ws.checkpointSceneId;
    if (room.animationEnabled && sceneId && room.scenes.some((s) => s.id === sceneId)) {
      void catchup.sendSceneCatchUp(ws, room, sceneId);
      return;
    }
    void catchup.sendRoomCatchUp(ws, room, 'full');
  }

  function metrics() {
    return {
      enabled: !disabled(),
      reason: disabledReason,
      rendererVersion,
      ...counters,
      entries: entries.size,
      bytes: totalBytes,
      worker: worker ? worker.stats() : null,
    };
  }

  async function close() {
    entries.clear();
    skipUntil.clear();
    skipGen.clear();
    totalBytes = 0;
    if (worker) await worker.close();
  }

  return {
    sendJoinCatchUp, sendSceneCatchUp, handleNack, noteOp, startBuild, evictRoom, metrics, close,
    // Test seam (module tests drive the safe-cut selection directly).
    selectPrefix: (room, frameId = null) => selectFramePrefix(room, frameId || (room.frames[0] && room.frames[0].id)),
  };
}
