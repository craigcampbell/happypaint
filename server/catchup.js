// Atomic, ordered catch-up delivery + shared scene-history gzip cache.
//
// Two problems this solves (see the phase-2 room-loading work):
//
// 1) RACE, a joining/fetching socket entered the broadcast roster BEFORE its
//    async catch-up finished, so live ops (and clears/structure changes) could
//    reach it ahead of the history frame and then AGAIN inside the computed
//    tail: duplicates, out-of-order ink, stale structure. This module gates
//    every canvas/structure broadcast to that socket while its catch-up is in
//    flight, then flushes the queue in order after the baseline lands:
//
//      baseline (gz frame + tail, or a fresh complete state)
//        -> queued ops NEWER than the baseline watermark, exactly once
//        -> independent last-wins states (sheet / scene meta / storybook)
//
//    A wholesale mutation (clear, moderation rebuild, frame/layer/scene
//    structure) during the build invalidates the frame; the socket then gets a
//    FRESH complete state instead and the queued events are dropped (they are
//    inside that state). A newer scene_fetch supersedes an in-flight one: the
//    stale fetch never completes late.
//
// 2) PERF, scene histories (join / scene_fetch / modwatch resync) bypassed
//    the shared gzip cache: every fetch re-scanned the whole visible history
//    and re-stringified the scene on the event loop. Scenes now get the same
//    treatment as the full-room frame: one gzipped frame per scene, ONE shared
//    in-flight build, warm fetches served by binary-search tail (no history
//    scan), keyed on content generation + hidden generation + scene/frame/
//    layer structure. The cache is bounded (entry count + bytes, LRU).
//
// Queue bounds: a gate queue that overflows CATCHUP_QUEUE_MAX_MESSAGES /
// CATCHUP_QUEUE_MAX_BYTES closes the socket with 1013 ("try again"), the
// client reconnects and re-catches-up from the durable history rather than
// receiving a silently-truncated stream. Only ephemeral traffic is ever
// droppable; durable ops are disconnect/resync, never discard.
//
// Phase-3 note: the reusable seam is runCatchup(ws, room, scope, deliver) -
// it owns gating, supersede, queue bounds, liveness checks and the ordered
// flush. A checkpoint baseline deliverer (manifest + assets + ordered op tail)
// can plug in as `deliver` and inherit exactly-once ordering for free, as long
// as it reports { kind: 'frame', throughOpId } (baseline + tail watermark) or
// { kind: 'fresh', throughOpId } (complete state, queue drops). See
// deliverRoomVariant/deliverScene for the contract.
import { buildGzippedHistoryFrame } from './historyFrame.js';

// Broadcasts that mutate the shared canvas or its structure: gated while a
// catch-up is in flight. Anything NOT listed here (chat, cursors, presence,
// votes, games, roster…) is ephemeral to the canvas and flows immediately.
const GATED_TYPES = new Set([
  'op', 'clear', 'history', 'resync',
  'scene_add', 'scene_set', 'scene_del',
  'frame_add', 'frame_del', 'frame_move', 'frame_duration',
  'layer_add', 'layer_del', 'layer_patch', 'layer_move', 'layer_merge', 'layer_flatten', 'layer_dup',
  'sheet', 'storybook_state', 'room_animation',
]);
// Last-wins states whose message carries everything the client needs: safe to
// deliver AFTER any baseline, in order, without duplicating baseline content.
const INDEPENDENT_TYPES = new Set(['sheet', 'storybook_state', 'room_animation', 'scene_add', 'scene_set', 'scene_del']);
// Give up scanning for a scene tail past this many history entries, the
// watermark is hopelessly behind and a rebuild is cheaper (bounded work per
// warm fetch; legitimate large histories still ride one shared rebuild).
const TAIL_SCAN_MAX = 8000;

export function createCatchup(deps) {
  const {
    rooms,
    config,
    visibleHistory, historyMessageFor, historyCacheUsable, historyTailAfter, buildHistoryCache,
    sceneHistoryMsg, scenesMeta, framesOfScene, opFrameId, opIndexOf,
  } = deps;
  const {
    HISTORY_CACHE_MIN_OPS, HISTORY_CACHE_TAIL_MAX, HISTORY_CACHE_BUILD_BUDGET_MS,
    SCENE_CACHE_MIN_OPS, SCENE_CACHE_MAX_ENTRIES, SCENE_CACHE_MAX_BYTES,
    CATCHUP_QUEUE_MAX_MESSAGES, CATCHUP_QUEUE_MAX_BYTES,
  } = config;

  const counters = {
    sceneBuilds: 0, sceneHits: 0, sceneTextServes: 0,
    fallbacks: 0, overflows: 0, gatedQueued: 0, gatedFlushed: 0,
  };
  const metrics = () => ({ ...counters });

  // True wire size: queue bounds are BYTES on the socket, so a multibyte
  // payload must account UTF-8 length, not UTF-16 string length.
  const byteLengthOf = (data) => (typeof data === 'string' ? Buffer.byteLength(data) : (data ? data.length : 0));
  // Baselines and flushed ops are DURABLE traffic: route them through the
  // server's bounded outgoing queue (a stalled consumer can never grow
  // ws.bufferedAmount without bound; overflow means disconnect + resync).
  // The fallback keeps the module usable standalone (unit tests).
  const sendReliable = deps.sendReliable
    || ((ws, data, opts = {}) => {
      if (ws.readyState !== 1) return false;
      try { ws.send(data, opts.binary ? { binary: true, compress: false } : undefined); } catch { return false; }
      return true;
    });

  // ---- Per-room scene frame cache (WeakMap: dies with the room) ------------
  const sceneCaches = new WeakMap();
  function sceneCacheFor(room) {
    let cache = sceneCaches.get(room);
    if (!cache) {
      cache = { entries: new Map(), bytes: 0, building: new Map() };
      sceneCaches.set(room, cache);
    }
    return cache;
  }
  // Everything the scene message carries besides ops: all scenes' metadata
  // (name/loops/camera) + this scene's frames WITH their layer stacks. Any
  // scene-metadata or frame/layer-metadata change flips this key.
  function sceneStructKey(room, sceneId) {
    return JSON.stringify([scenesMeta(room), framesOfScene(room, sceneId)]);
  }
  function sceneEntryUsable(room, entry) {
    return !!entry && entry.gen === room.historyGen && entry.hiddenGen === (room.hiddenGen || 0)
      && entry.structKey === sceneStructKey(room, entry.sceneId);
  }
  function sceneOpCount(room, sceneId) {
    let count = 0;
    for (const frame of framesOfScene(room, sceneId)) count += room.frameOpCounts.get(frame.id) || 0;
    return count;
  }
  function cachePut(cache, entry) {
    const existing = cache.entries.get(entry.sceneId);
    if (existing === entry) {
      // Already stored (a co-awaiter beat us to it): just refresh LRU order.
      cache.entries.delete(entry.sceneId);
      cache.entries.set(entry.sceneId, entry);
      return;
    }
    if (existing) cache.bytes -= existing.gz.length;
    cache.entries.set(entry.sceneId, entry);
    cache.bytes += entry.gz.length;
    while (cache.entries.size > SCENE_CACHE_MAX_ENTRIES || cache.bytes > SCENE_CACHE_MAX_BYTES) {
      const oldest = cache.entries.keys().next();
      if (oldest.done) break;
      const stale = cache.entries.get(oldest.value);
      cache.bytes -= stale ? stale.gz.length : 0;
      cache.entries.delete(oldest.value);
    }
  }
  // Ops newer than the cached frame that belong to the scene, binary search +
  // bounded scan, never a whole-history walk. Null = can't extend (rebuild).
  function sceneTailAfter(room, sceneId, lastOpId) {
    const history = room.history;
    const at = opIndexOf(history, lastOpId);
    if (at < 0) return null;
    const ids = new Set(framesOfScene(room, sceneId).map((f) => f.id));
    const tail = [];
    for (let i = at + 1; i < history.length; i += 1) {
      if (i - at > TAIL_SCAN_MAX) return null;
      const op = history[i];
      if (room.hiddenOpIds.size && room.hiddenOpIds.has(op.opId)) continue;
      if (!ids.has(opFrameId(room, op))) continue;
      if (tail.length >= HISTORY_CACHE_TAIL_MAX) return null;
      tail.push(op);
    }
    return tail;
  }
  function buildSceneEntry(room, sceneId) {
    const gen = room.historyGen;
    const hiddenGen = room.hiddenGen || 0;
    const structKey = sceneStructKey(room, sceneId);
    const msg = sceneHistoryMsg(room, sceneId);
    counters.sceneBuilds += 1;
    return buildGzippedHistoryFrame({
      variant: `scene:${sceneId}`, gen, hiddenGen, framesKey: structKey, msg, budgetMs: HISTORY_CACHE_BUILD_BUDGET_MS,
    }).then((built) => ({ ...built, sceneId, structKey }));
  }

  // ---- The gate -------------------------------------------------------------
  function beginGate(ws, scope = null) {
    let gate = ws.catchup;
    if (!gate) {
      gate = { epoch: 0, queue: [], bytes: 0, scope };
      ws.catchup = gate;
    }
    gate.epoch += 1;
    if (scope) gate.scope = scope;
    return gate;
  }
  function isCurrent(ws, gate, epoch) {
    return ws.catchup === gate && gate.epoch === epoch && ws.readyState === 1;
  }
  // Called from broadcast() for every fanned-out message. Returns true when
  // the message was queued (caller must NOT send it directly).
  function routeGatedBroadcast(ws, room, message, data) {
    const gate = ws.catchup;
    if (!gate) return false;
    const type = message && message.type;
    if (!GATED_TYPES.has(type)) return false;
    const size = byteLengthOf(data);
    if (gate.queue.length >= CATCHUP_QUEUE_MAX_MESSAGES || gate.bytes + size > CATCHUP_QUEUE_MAX_BYTES) {
      // Never discard durable ops silently: bounce the socket; the client's
      // reconnect re-runs the catch-up against the durable history.
      counters.overflows += 1;
      ws.catchup = null;
      try { ws.close(1013, 'catch-up overflow'); } catch { /* already gone */ }
      return true;
    }
    const entry = { type, data };
    if (type === 'op' && message.op) {
      entry.opId = message.op.opId || 0;
      entry.frameId = message.op.frameId || (room.frames[0] && room.frames[0].id) || null;
    }
    gate.queue.push(entry);
    gate.bytes += size;
    counters.gatedQueued += 1;
    return true;
  }
  function hasBlockingQueued(gate) {
    return gate.queue.some((e) => e.type !== 'op' && !INDEPENDENT_TYPES.has(e.type));
  }

  // The complete current state for a scope, as the legacy text message.
  function freshMessageFor(room, scope) {
    if (scope.kind === 'scene') return sceneHistoryMsg(room, scope.sceneId);
    return historyMessageFor(room, scope.kind === 'spectator' ? 'spectator' : 'full');
  }
  function sendFresh(ws, room, scope, { fallback = false } = {}) {
    if (fallback) counters.fallbacks += 1;
    if (scope.kind === 'scene') counters.sceneTextServes += 1;
    if (ws.readyState === 1) sendReliable(ws, JSON.stringify(freshMessageFor(room, scope)));
    return { kind: 'fresh', throughOpId: room.opSeq || 0 };
  }

  // Ordered flush of the gated queue after the baseline landed. `outcome`:
  //  - { kind:'frame', throughOpId }, gz frame + tail delivered through that opId
  //  - { kind:'fresh', throughOpId }, complete state delivered (covers everything ≤ it)
  //  - { kind:'none' }, nothing delivered (dead socket/superseded): drop the queue.
  function flushQueue(ws, room, gate, outcome) {
    const queue = gate.queue;
    if (!queue.length || !outcome || outcome.kind === 'none') return;
    const scope = gate.scope || { kind: 'full' };
    const hidden = room.hiddenOpIds;
    const isHidden = (opId) => hidden.size > 0 && hidden.has(opId);
    const sceneFrameIds = scope.kind === 'scene'
      ? new Set(framesOfScene(room, scope.sceneId).map((f) => f.id))
      : null;
    const inScope = (entry) => !sceneFrameIds || !entry.frameId || sceneFrameIds.has(entry.frameId);
    const sends = [];
    let needsFresh = false;
    for (const entry of queue) {
      if (entry.type === 'op') {
        if (isHidden(entry.opId)) continue; // moderation hid it while gated
        if (!inScope(entry)) { sends.push(entry); continue; } // another scene: never in the baseline
        if (outcome.kind === 'frame' && entry.opId > outcome.throughOpId) sends.push(entry);
        // frame: ≤ watermark rides the frame/tail already. fresh: inside the state.
        continue;
      }
      if (INDEPENDENT_TYPES.has(entry.type)) { sends.push(entry); continue; }
      // A wholesale/structure event survived a supposedly-valid frame build -
      // the invalidation keys missed a path. Resync fresh rather than guess.
      if (outcome.kind === 'frame') { needsFresh = true; break; }
      // fresh: the event is inside the delivered state, drop.
    }
    try {
      if (needsFresh) {
        const freshOutcome = sendFresh(ws, room, scope, { fallback: true });
        // Re-run the flush against the fresh state: wholesale/structure events
        // drop, independent states and out-of-scope ops still deliver.
        gate.queue = queue.filter((e) => e.type === 'op' || INDEPENDENT_TYPES.has(e.type));
        flushQueue(ws, room, gate, freshOutcome);
        return;
      }
      for (const entry of sends) {
        if (ws.readyState !== 1) return;
        sendReliable(ws, entry.data);
        counters.gatedFlushed += 1;
      }
    } catch {
      try { ws.close(1013, 'catch-up failed'); } catch { /* already gone */ }
    }
  }

  // The reusable seam (phase 3): gate the socket, run the async deliverer,
  // then flush the queue in order. Only the LATEST catch-up on a socket owns
  // the flush, a superseded deliverer returns { kind:'none' } and vanishes.
  async function runCatchup(ws, room, scope, deliver) {
    const gate = beginGate(ws, scope);
    const epoch = gate.epoch;
    let outcome = null;
    try {
      outcome = await deliver(gate, epoch);
    } catch {
      outcome = null;
    }
    if (ws.catchup !== gate || gate.epoch !== epoch) return; // superseded
    ws.catchup = null; // ungate BEFORE flushing
    if (ws.readyState !== 1 || rooms.get(room.code) !== room) return;
    if (!outcome) {
      // The deliverer failed: never leave a gated socket without a baseline -
      // fall back to the complete current state, then flush what queued.
      try { outcome = sendFresh(ws, room, scope, { fallback: true }); } catch { try { ws.close(1013, 'catch-up failed'); } catch { /* gone */ } return; }
    }
    flushQueue(ws, room, gate, outcome);
  }

  // ---- Full-room / spectator baselines (the original join cache) ------------
  async function deliverRoomVariant(ws, room, scope, gate, epoch) {
    const variant = scope.kind === 'spectator' ? 'spectator' : 'full';
    if (!ws.acceptsGzip || room.animationEnabled || visibleHistory(room).length < HISTORY_CACHE_MIN_OPS) {
      return sendFresh(ws, room, scope);
    }
    const cache = room.historyCache || (room.historyCache = {});
    let entry = cache[variant];
    let tail = historyCacheUsable(room, entry) ? historyTailAfter(room, variant, entry.lastOpId) : null;
    if (!tail) {
      const key = `${variant}Building`;
      if (!cache[key]) {
        cache[key] = buildHistoryCache(room, variant).finally(() => { cache[key] = null; });
      }
      try { entry = await cache[key]; } catch { entry = null; }
      // The shared build populates the room cache even if THIS socket was
      // superseded while awaiting it (original sendHistoryCatchUp behavior).
      if (entry && historyCacheUsable(room, entry)) cache[variant] = entry;
      if (!isCurrent(ws, gate, epoch)) return { kind: 'none' };
      if (!entry || !historyCacheUsable(room, entry)) return sendFresh(ws, room, scope, { fallback: true });
      tail = historyTailAfter(room, variant, entry.lastOpId);
      if (!tail) return sendFresh(ws, room, scope, { fallback: true }); // the mural changed shape while gzipping
      if (hasBlockingQueued(gate)) return sendFresh(ws, room, scope, { fallback: true });
    }
    if (ws.readyState !== 1) return { kind: 'none' };
    sendReliable(ws, entry.gz, { binary: true });
    let throughOpId = entry.lastOpId;
    for (const op of tail) {
      sendReliable(ws, JSON.stringify({ type: 'op', op }));
      throughOpId = op.opId || throughOpId;
    }
    return { kind: 'frame', throughOpId };
  }
  function sendRoomCatchUp(ws, room, variant) {
    return runCatchup(ws, room, { kind: variant === 'spectator' ? 'spectator' : 'full' },
      (gate, epoch) => deliverRoomVariant(ws, room, { kind: variant === 'spectator' ? 'spectator' : 'full' }, gate, epoch));
  }

  // ---- Scene baselines (animation rooms page by scene) ----------------------
  async function deliverScene(ws, room, scope, gate, epoch) {
    const { sceneId } = scope;
    if (!ws.acceptsGzip || sceneOpCount(room, sceneId) < SCENE_CACHE_MIN_OPS) {
      return sendFresh(ws, room, scope);
    }
    const cache = sceneCacheFor(room);
    let entry = cache.entries.get(sceneId);
    if (sceneEntryUsable(room, entry)) {
      // LRU touch, then serve: binary-search watermark + bounded tail scan.
      cache.entries.delete(sceneId);
      cache.entries.set(sceneId, entry);
      const tail = sceneTailAfter(room, sceneId, entry.lastOpId);
      if (tail) {
        counters.sceneHits += 1;
        if (ws.readyState !== 1) return { kind: 'none' };
        sendReliable(ws, entry.gz, { binary: true });
        let throughOpId = entry.lastOpId;
        for (const op of tail) {
          sendReliable(ws, JSON.stringify({ type: 'op', op }));
          throughOpId = op.opId || throughOpId;
        }
        return { kind: 'frame', throughOpId };
      }
    }
    // One in-flight build per scene, shared by every joiner/fetcher/watcher.
    let building = cache.building.get(sceneId);
    if (!building) {
      building = buildSceneEntry(room, sceneId)
        .then((built) => (sceneEntryUsable(room, built) ? built : null))
        .catch(() => null)
        .finally(() => { cache.building.delete(sceneId); });
      cache.building.set(sceneId, building);
    }
    const built = await building;
    // The shared build populates the cache even when THIS awaiter was
    // superseded, otherwise a join immediately followed by a scene_fetch
    // would waste the join's build and force the next client to rebuild.
    if (built) cachePut(cache, built);
    if (!isCurrent(ws, gate, epoch)) return { kind: 'none' }; // superseded fetch
    if (!built || hasBlockingQueued(gate)) return sendFresh(ws, room, scope, { fallback: true });
    const tail = sceneTailAfter(room, sceneId, built.lastOpId);
    if (!tail) return sendFresh(ws, room, scope, { fallback: true });
    if (ws.readyState !== 1) return { kind: 'none' };
    sendReliable(ws, built.gz, { binary: true });
    let throughOpId = built.lastOpId;
    for (const op of tail) {
      sendReliable(ws, JSON.stringify({ type: 'op', op }));
      throughOpId = op.opId || throughOpId;
    }
    return { kind: 'frame', throughOpId };
  }
  function sendSceneCatchUp(ws, room, sceneId) {
    return runCatchup(ws, room, { kind: 'scene', sceneId },
      (gate, epoch) => deliverScene(ws, room, { kind: 'scene', sceneId }, gate, epoch));
  }
  // A synchronous complete baseline was delivered outside the module (the
  // experimental snapshot join path): close the gate with a fresh outcome.
  function finishSyncCatchUp(ws, room) {
    const gate = ws.catchup;
    if (!gate) return;
    gate.epoch += 1;
    ws.catchup = null;
    if (ws.readyState !== 1 || rooms.get(room.code) !== room) return;
    flushQueue(ws, room, gate, { kind: 'fresh', throughOpId: room.opSeq || 0 });
  }

  return {
    beginGate, routeGatedBroadcast, sendRoomCatchUp, sendSceneCatchUp, finishSyncCatchUp, metrics,
    // The phase-3 seam: runCatchup owns gating/supersede/bounds/flush around
    // any async baseline deliverer; isCurrent is the liveness test deliverers
    // use after each await; sendFresh is the complete-state fallback.
    // deliverRoomVariant is the ordinary full/spectator gz-frame deliverer -
    // the checkpoint service (server/checkpoints.js) calls it as its in-gate
    // fallback whenever a checkpoint baseline can't be served. deliverScene
    // is the same fallback for the phase-4 scene checkpoint path.
    runCatchup, isCurrent, sendFresh, deliverRoomVariant, deliverScene,
  };
}
