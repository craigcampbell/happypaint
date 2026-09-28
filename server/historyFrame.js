// Async, byte-faithful join-frame builder for the history catch-up cache.
//
// Rebuilding a room's gzipped join frame used to mean one synchronous
// JSON.stringify of the whole visible history on the single realtime thread —
// measured at 0.4–1.8s of event-loop stall for a cap-full room, freezing every
// room on the box for that window (see docs/CATCHUP-IMPLEMENTATION.md). This
// module produces BYTE-IDENTICAL output to JSON.stringify(msg) but in
// time-budgeted slices, yielding to the event loop between them; the gzip then
// runs on zlib's threadpool as before. Wire format, cache contract and the
// fallback path are unchanged — only the stall is gone.

import { Gzip } from 'node:zlib';

const yieldToLoop = () => new Promise((done) => setImmediate(done));

// Arrays longer than this are serialized element-by-element with loop yields
// between budgeted slices. Anything smaller (including every individual op —
// measured ~5µs for a 6KB op) goes through one JSON.stringify call, which is
// byte-identical: the production of a value inside JSON.stringify(parent) is
// exactly JSON.stringify(value) (modulo undefined-in-array → null, handled by
// the caller). A pathological single value larger than the slice budget (e.g.
// one op carrying a multi-MB payload) still serializes in one call — op size
// is bounded by the WS message limit, so worst case stays well under budgetMs.
const SLICE_ARRAY_MIN = 256;

async function stringifyInto(value, parts, state, depth) {
  if (Array.isArray(value) && value.length > SLICE_ARRAY_MIN) {
    parts.push('[');
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) parts.push(',');
      const el = value[i];
      if (el === undefined || typeof el === 'function' || typeof el === 'symbol') parts.push('null');
      else await stringifyInto(el, parts, state, depth + 1);
      // Cheap cadence gate so performance.now() isn't sampled per element.
      if ((i & 63) === 63 && (performance.now() - state.sliceStart) >= state.budgetMs) {
        await yieldToLoop();
        state.sliceStart = performance.now();
      }
    }
    parts.push(']');
    return;
  }
  if (depth === 0 && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    // Root object (the {type:'history', ops, frames?} message): serialize per
    // key so the huge ops array property is sliced by the branch above.
    if (typeof value.toJSON === 'function') {
      await stringifyInto(value.toJSON(), parts, state, depth);
      return;
    }
    parts.push('{');
    let first = true;
    for (const key of Object.keys(value)) {
      const v = value[key];
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
      if (!first) parts.push(',');
      first = false;
      parts.push(JSON.stringify(key), ':');
      await stringifyInto(v, parts, state, depth + 1);
    }
    parts.push('}');
    return;
  }
  const s = JSON.stringify(value);
  parts.push(s === undefined ? 'null' : s);
}

// Byte-identical to JSON.stringify(value) for JSON-shaped values, but the
// event loop stays live between ~budgetMs slices. Verified byte-for-byte
// against JSON.stringify in scripts/history-catchup-async-verify.mjs.
export async function stringifyJsonSlicedParts(value, { budgetMs = 8 } = {}) {
  const parts = [];
  const state = { budgetMs: Math.max(1, budgetMs), sliceStart: performance.now() };
  await stringifyInto(value, parts, state, 0);
  return parts;
}
export async function stringifyJsonSliced(value, opts = {}) {
  return (await stringifyJsonSlicedParts(value, opts)).join('');
}

// Feed the parts into a Gzip stream in budgeted slices. This avoids TWO
// remaining main-thread costs of the naive gzip(parts.join('')): the giant
// join itself, and zlib's synchronous string→Buffer conversion of the whole
// ~72MB payload. Parts are coalesced into ~1MB chunks first (per-write stream
// overhead would otherwise add ~1.2s at 24k parts); each write() then
// converts one bounded chunk while the compression runs on zlib's threadpool.
// Output is the exact gzip of parts.join('').
const GZIP_CHUNK_BYTES = 1024 * 1024;
async function coalesceParts(parts, budgetMs) {
  const chunks = [];
  let group = [];
  let groupLen = 0;
  let sliceStart = performance.now();
  for (const part of parts) {
    group.push(part);
    groupLen += part.length;
    if (groupLen >= GZIP_CHUNK_BYTES) {
      chunks.push(group.join(''));
      group = [];
      groupLen = 0;
      if ((performance.now() - sliceStart) >= budgetMs) {
        await yieldToLoop();
        sliceStart = performance.now();
      }
    }
  }
  if (group.length) chunks.push(group.join(''));
  return chunks;
}
function gzipPartsSliced(parts, { level = 6, budgetMs = 8 } = {}) {
  return new Promise((resolve, reject) => {
    coalesceParts(parts, budgetMs).then((chunks) => {
      const gz = new Gzip({ level });
      const out = [];
      gz.on('data', (chunk) => out.push(chunk));
      gz.on('error', reject);
      gz.on('end', () => resolve(Buffer.concat(out)));
      let i = 0;
      const writeMore = () => {
        const sliceStart = performance.now();
        while (i < chunks.length) {
          const drained = gz.write(chunks[i]);
          i += 1;
          if (!drained) { gz.once('drain', writeMore); return; } // backpressure
          if ((performance.now() - sliceStart) >= budgetMs) {
            setImmediate(writeMore);
            return;
          }
        }
        gz.end();
      };
      writeMore();
    }, reject);
  });
}

// Build one gzipped join frame ({type:'history', ops, frames?} shape) without
// stalling the event loop.
//
// The ops array is SNAPSHOTTED up front: the async build spans many loop
// turns during which live ops append to room.history (and trimHistoryFront
// SPLICES it in place). Building from the live array would either leak ops
// past the entry's lastOpId watermark (a joiner would then receive them twice
// — once in the frame, once in the tail — and double-apply ink) or corrupt the
// frame mid-write. The snapshot is exactly "ops ≤ lastOpId"; anything newer
// rides the per-join tail, as before.
export async function buildGzippedHistoryFrame({ variant, gen, hiddenGen, framesKey, msg, level = 6, budgetMs = 8 }) {
  const ops = Array.isArray(msg.ops) ? msg.ops.slice() : [];
  const snapshot = { ...msg, ops };
  const lastOpId = ops.length ? (ops[ops.length - 1].opId || 0) : 0;
  const parts = await stringifyJsonSlicedParts(snapshot, { budgetMs });
  const gz = await gzipPartsSliced(parts, { level, budgetMs });
  return { variant, gen, hiddenGen, framesKey, lastOpId, gz, opCount: ops.length };
}
