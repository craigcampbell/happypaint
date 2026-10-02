/* eslint-env node */
// Moderation evidence, controller/worker race tests (pure Node, no server).
//
// Drives createNsfwWatcher with a fake worker and stubbed canvas globals to
// prove the evidence-freeze contract:
//   1. A flag seals the frame and waits for the worker's encode before firing.
//   2. Sampling is PAUSED while the encode is in flight (the next scan would
//      overwrite the very pixels being frozen).
//   3. An encode answer whose generation does not match the flagged scan is
//      dropped, newer pixels can never be bound to an older score.
//   4. A stale/failed/timed-out encode never blocks the flag; it just goes
//      out without pixels.
// Plus direct unit tests of the worker-side generation guard.

import { createNsfwWatcher } from "../src/utils/nsfwWatcher.js";
import { createEvidenceGuard } from "../src/workers/evidenceGuard.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
};

// --- Browser-global stubs (the watcher touches these on the main thread) ----
globalThis.OffscreenCanvas = class {
  constructor(w, h) {
    this.width = w;
    this.height = h;
  }
  getContext() {
    return { clearRect() {}, drawImage() {} };
  }
};
globalThis.createImageBitmap = async (snap) => ({
  width: snap.width,
  height: snap.height,
  close() {},
});

// A scripted fake worker. `script` decides how scan and encode messages are
// answered. Everything the controller posts is recorded in `posted`.
function fakeWorker(script = {}) {
  const w = {
    posted: [],
    onmessage: null,
    onerror: null,
    scans: 0,
    postMessage(msg) {
      w.posted.push(msg);
      if (msg.type === "encode") {
        w.encodeMsg = msg;
        if (script.onEncode) script.onEncode(msg, w);
        return;
      }
      w.scans += 1;
      const generation = w.scans;
      const score = typeof script.score === "function" ? script.score(generation) : script.score ?? 0.9;
      queueMicrotask(() => {
        w.onmessage?.({ data: { id: msg.id, ok: true, score, generation } });
      });
    },
    // Test helper: answer the pending encode request.
    replyEncode(data) {
      const msg = w.encodeMsg;
      w.onmessage?.({ data: { id: msg.id, generation: msg.generation, ...data } });
    },
    terminate() {},
  };
  return w;
}

function makeWatcher(worker, opts = {}) {
  const flags = [];
  let opId = opts.opId ?? 5;
  const watcher = createNsfwWatcher({
    getCanvas: () => ({ width: 100, height: 80 }),
    isDrawing: () => false,
    getLastOpId: () => opId,
    onFlag: (flag) => flags.push(flag),
    intervalMs: 5,
    threshold: 0.7,
    workerFactory: () => worker,
    ...opts.watcherOpts,
  });
  return {
    flags,
    watcher,
    bumpOps(n = 1) {
      opId += n;
      watcher.markDirty();
    },
  };
}

async function main() {
  // -- 0. worker-side generation guard, directly -----------------------------
  {
    const guard = createEvidenceGuard();
    const g1 = guard.beginScan();
    check("guard: current generation encodes", guard.encodeIfCurrent(g1, () => "enc") === "enc");
    guard.beginScan(); // a newer scan overwrites the canvas
    check("guard: stale generation dropped after newer scan", guard.encodeIfCurrent(g1, () => "enc") === null);
    check("guard: newest generation still encodes", guard.encodeIfCurrent(2, () => "enc2") === "enc2");
    check("guard: non-numeric generation dropped", guard.encodeIfCurrent("2", () => "x") === null);
  }

  // -- 1. happy path: flag carries the frozen frame ---------------------------
  {
    const worker = fakeWorker({ score: 0.93 });
    const { flags, watcher, bumpOps } = makeWatcher(worker);
    watcher.setActive(true);
    bumpOps(3);
    await sleep(40); // scan ran, encode requested, not yet answered
    check("happy: scan posted to worker", worker.scans === 1);
    check("happy: encode requested with the scan's generation", worker.encodeMsg?.type === "encode" && worker.encodeMsg.generation === 1);
    check("happy: flag not fired before encode resolves", flags.length === 0);
    worker.replyEncode({
      ok: true,
      evidence: { dataUrl: "data:image/png;base64,QUJD", w: 100, h: 80, model: "heuristic" },
    });
    await sleep(10);
    check("happy: flag fired once encode resolved", flags.length === 1);
    const ev = flags[0]?.evidence;
    check(
      "happy: evidence bound to the flag",
      ev && ev.image === "data:image/png;base64,QUJD" && ev.w === 100 && ev.h === 80 && ev.model === "heuristic"
    );
    check(
      "happy: flag shape + metadata",
      flags[0]?.kind === "image" &&
        flags[0]?.score === 0.93 &&
        flags[0]?.sinceOpId === 5 &&
        flags[0]?.toOpId === 8 &&
        ev?.threshold === 0.7 &&
        typeof ev?.capturedAt === "number"
    );
    watcher.destroy();
  }

  // -- 2. sampling pauses while the frame is sealed ---------------------------
  {
    const worker = fakeWorker({ score: 0.95 });
    const { watcher, bumpOps, flags } = makeWatcher(worker);
    watcher.setActive(true);
    bumpOps(1);
    await sleep(40); // flagged; encode pending
    bumpOps(4); // heavy repainting while sealed
    await sleep(60);
    check("sealed: no second scan while encode pending", worker.scans === 1, `scans=${worker.scans}`);
    worker.replyEncode({ ok: true, evidence: { dataUrl: "data:image/png;base64,QUJD", w: 100, h: 80, model: "m" } });
    await sleep(10);
    check("sealed: flag fired after encode", flags.length === 1);
    await sleep(60);
    check("sealed: sampling resumes after the seal lifts", worker.scans >= 2, `scans=${worker.scans}`);
    watcher.destroy();
  }

  // -- 3. THE RACE: newer image must never bind to the older score ------------
  {
    // Worker answers the encode with a MISMATCHED generation (it scanned again
    // before encoding, exactly the async race). Controller must drop the
    // pixels and still fire the flag.
    const worker = fakeWorker({ score: 0.9 });
    const { flags, watcher, bumpOps } = makeWatcher(worker);
    watcher.setActive(true);
    bumpOps(2);
    await sleep(40);
    worker.replyEncode({
      ok: true,
      generation: 99, // lie: these pixels came from a LATER scan
      evidence: { dataUrl: "data:image/png;base64,Rk9SR0VE", w: 100, h: 80, model: "m" },
    });
    await sleep(10);
    check("race: mismatched-generation pixels dropped", flags.length === 1 && !flags[0].evidence);
    watcher.destroy();
  }

  // -- 4. stale encode (worker-side guard fired) → flag without pixels --------
  {
    const worker = fakeWorker({ score: 0.9 });
    const { flags, watcher, bumpOps } = makeWatcher(worker);
    watcher.setActive(true);
    bumpOps(2);
    await sleep(40);
    worker.replyEncode({ ok: false, error: "stale" });
    await sleep(10);
    check("stale: flag fires without evidence", flags.length === 1 && !flags[0].evidence);
    watcher.destroy();
  }

  // -- 5. encode never answers → timeout, flag still fires --------------------
  {
    const worker = fakeWorker({ score: 0.9 });
    const { flags, watcher, bumpOps } = makeWatcher(worker, { watcherOpts: { evidenceTimeoutMs: 60 } });
    watcher.setActive(true);
    bumpOps(2);
    await sleep(30);
    check("timeout: flag held while waiting for encode", flags.length === 0);
    await sleep(80);
    check("timeout: flag fires without evidence after timeout", flags.length === 1 && !flags[0].evidence);
    watcher.destroy();
  }

  // -- 6. clean scan → no encode, no flag, watermark advances ------------------
  {
    let scoreCalls = 0;
    const worker = fakeWorker({
      score: () => {
        scoreCalls += 1;
        return scoreCalls === 1 ? 0.1 : 0.9; // first clean, then dirty
      },
    });
    const { flags, watcher, bumpOps } = makeWatcher(worker, { opId: 5 });
    watcher.setActive(true);
    bumpOps(2); // opId 7, clean
    await sleep(40);
    check("clean: no encode requested for a clean scan", !worker.encodeMsg);
    check("clean: no flag for a clean scan", flags.length === 0);
    bumpOps(3); // opId 10, now dirty
    await sleep(40);
    worker.replyEncode({ ok: false, error: "stale" });
    await sleep(10);
    check(
      "clean: later flag uses the advanced clean watermark",
      flags.length === 1 && flags[0].sinceOpId === 7 && flags[0].toOpId === 10,
      JSON.stringify(flags[0] && { s: flags[0].sinceOpId, t: flags[0].toOpId })
    );
    watcher.destroy();
  }

  // -- 7. destroy mid-encode never fires the flag ------------------------------
  {
    const worker = fakeWorker({ score: 0.9 });
    const { flags, watcher, bumpOps } = makeWatcher(worker, { watcherOpts: { evidenceTimeoutMs: 40 } });
    watcher.setActive(true);
    bumpOps(2);
    await sleep(30);
    watcher.destroy();
    worker.replyEncode({ ok: true, evidence: { dataUrl: "data:image/png;base64,QUJD", w: 1, h: 1 } });
    await sleep(70);
    check("destroy: no flag after destroy (encode reply or timeout)", flags.length === 0);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
