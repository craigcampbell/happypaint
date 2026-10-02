# Faithful faster long-room loading, async join-frame builds (Tier 1)

Date: 2026-09-28 · Tree: `/home/craig/Projects/happypaint-catchup` (isolated feature copy, baseline `bc9fe59`)
Research basis: `~/.hermes/cache/scratch/drawesome-checkpoint-research.md` → **Tier 1, items 3 (+ proactive rebuild from §7.3)**

## What shipped

The join catch-up cache already sends one shared gzipped history frame per room +
a per-join tail (server.js `sendHistoryCatchUp`). Its remaining defect, measured in
the research at **0.55–1.8s of event-loop stall per cold frame rebuild**, was the
synchronous `JSON.stringify` of the whole visible history (40–120MB at the caps) on
the single realtime thread, every room on the box froze for that window.

Two changes, no protocol/trust/persistence/engine change:

1. **Sliced async frame builds** (`server/historyFrame.js`, used by `buildHistoryCache`):
   - The frame stringify runs in ~8ms budgeted slices, yielding to the event loop
     between them (`stringifyJsonSlicedParts`). Output is **byte-identical** to
     `JSON.stringify(msg)` (unit-tested byte-for-byte on 7 payload shapes × 2 budgets,
     incl. unicode/emoji, floats, `-0`, nested large arrays, undefined-field dropping).
   - The gzip consumes the parts through a `Gzip` stream in ~1MB coalesced chunks -
     no 72MB intermediate string, no synchronous string→Buffer conversion of the whole
     payload; compression stays on zlib's threadpool as before.
   - The ops array is **snapshotted** (`slice()`) at build start. Builds span many loop
     turns; live ops append to `room.history` and `trimHistoryFront` *splices it in
     place*. Without the snapshot, a build could leak ops past the entry's `lastOpId`
     watermark (joiner receives them twice, frame + tail, and double-applies ink) or
     corrupt mid-write. This is the key faithfulness invariant.
2. **Proactive cache warm-up** (`maybePrebuildHistoryCache`, hot-path O(1) guard):
   once the tail past a cached frame crosses `HISTORY_CACHE_PREBUILD_TAIL` (default 200,
   env-tunable, 0 disables), the frame rebuilds in the background so the *next* joiner
   finds a warm cache instead of awaiting a cold rebuild. Installs only if the entry is
   still valid (`historyGen`/`hiddenGen`/`framesKey` re-checked); joiners landing
   mid-build await the same in-flight promise (which resolves to the entry, preserved).

Untouched by design: full op history remains the only authoritative catch-up (no
truncation, no client-baked pixels), the wire format, the text fallback for legacy /
small / animation rooms, the tail protocol, undo/moderation (hide/restore/remove bump
`hiddenGen`), layer/blend/eraser semantics, and concurrent-join dedup.

## Files changed

- `server/historyFrame.js`, **new**: sliced byte-faithful stringify + streamed gzip frame builder.
- `server.js`, import the builder; `buildHistoryCache` now async-sliced (was sync stringify);
  new `HISTORY_CACHE_BUILD_BUDGET_MS` (default 8) and `HISTORY_CACHE_PREBUILD_TAIL` (default 200)
  env knobs; new `maybePrebuildHistoryCache` + one call on the op-append path.
- `scripts/history-catchup-async-verify.mjs`, **new**: 28-assertion regression + benchmark suite
  (ports 8991–8994, scratch DATA_DIRs).
- `test/harness/client.mjs`, additive `binaryBytes` counter (wire-byte measurement).
- `docs/CATCHUP-IMPLEMENTATION.md`, this report.

## Measured before/after (this machine, 12000 ops × 170 pts ≈ 72MB frame JSON / 5.58MB gz, the research fixture shape)

| Metric | Baseline `bc9fe59` | Patched | Change |
|---|---|---|---|
| Cold rebuild event-loop stall (max `/healthz` RTT, external prober process) | **675 ms** | **72.5 ms** | **−89%** |
| Cold rebuild stall (server `loopLag.maxMs`) | 664 ms | 24.6 ms | −96% |
| Cold join wall (connect → history applied, incl. transfer + client-side 72MB gunzip) | 4780 ms | 4689 ms | ≈ equal |
| Warm join wall | 1788 ms | 1687 ms | ≈ equal |
| Warm join max `/healthz` RTT | 75.5 ms | 75.7 ms | unchanged |
| Wire bytes (gz frame) | 5.58 MB | 5.58 MB | identical |

The residual ~72ms during a cold rebuild is the 5.58MB frame `ws.send` (present in the
baseline's warm joins too), not the build. Cold-join wall time is unchanged: the same
CPU work happens, just interleaved, and with the default prebuild, rebuilds usually
finish *before* a joiner arrives (Part 2 of the suite proves a joiner then finds a
mid-stream warm frame: 180–270 ops in frame, 1–59-op tail, vs a full lazy rebuild with
prebuild off on the identical op stream).

## Exact checks run (all green)

- `node --check server.js` · `npm run lint` (zero-warning) · `npm run build` ✓
- `node scripts/history-catchup-async-verify.mjs`, **28 assertions**: sliced stringify
  byte-equality; snapshot isolation under append+splice mid-build; gz frame == legacy
  text history (deep-equal ops + frames); frame+tail == full history; 8 concurrent cold
  joins identical and complete; hide → excluded from join frame, restore → back,
  remove → never returns (even after restore attempt); `layer_add` → new joiner sees new
  layer structure; clear → no stale frame; prebuild warm-frame behavior + off-contrast;
  cold/warm stall < 100ms gates. Baseline comparison runnable via
  `CATCHUP_BENCH_ONLY=1 CATCHUP_BENCH_BASELINE=1 CATCHUP_BENCH_ROOT=<tree>`.
- `node scripts/history-perf-verify.mjs`: 23 assertions (pre-existing gate, unchanged) ✓
- `node scripts/modwatch-verify.mjs`: 28/28 (hide/restore/wipe/kick boundaries) ✓
- `node scripts/layer-protocol-verify.mjs`: ALL PASS ✓
- `node scripts/replay-model-verify.mjs`: 21/21 canvas replay model checks ✓

## Limitations / honest caveats

- **Renderer/replay untouched** → no browser pixel-equality suite was required; the
  equality proof is at the transport layer (frame bytes identical to `JSON.stringify(msg)`,
  integration deep-equality of gz vs text histories). Replay, brushes, layers, eraser and
  the mix map never see a difference.
- The benchmark's 12000 ops are uniform synthetic marker batches (~1.8× heavier than the
  real measured 3.3KB/op); magnitudes are machine-dependent, direction is not.
- A single pathological op larger than the slice budget (e.g. a multi-MB image op)
  still stringifies in one call; op size is bounded by the WS message limit, so worst
  case stays well under the 8ms budget's spirit but is not sliced.
- Cold-join *wall* time is not improved (same work, interleaved); the win is that the
  other ~29 rooms' painters no longer freeze during a rebuild, and (with prebuild) that
  most joins hit a warm frame. Client-side parse/replay on the main thread (research
  Tier-1 items 1/2/4) is the remaining big win and is future work.
- `loopLag` (eld) under-reports long single blocks at 40ms poll cadence; the suite's
  external prober process is the authoritative stall signal (kept in the suite).

## Not done (deliberately)

- No history truncation ("last N"), mathematically unable to reconstruct the mural
  (research §4). No client-baked snapshots, can never anchor authoritative state (§5).
- No server-authoritative checkpoint+tail (Tier 2), needs the Chromium-class renderer
  worker, `RENDERER_VERSION`, and the complete-stroke watermark protocol first (§8).
- No client worker replay / adaptive slicing / binary codec (Tier-1 items 1, 2, 5).
