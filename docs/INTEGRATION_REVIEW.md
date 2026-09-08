# Uncommitted-work integration review — 2026-09-08

Reviewed and integrated the outstanding work into `codex/youth-design-refresh`
following the owner's request to improve, commit, and push the feature branch.
This includes the earlier launch improvements; it does not merge into `main` or
confirm a production deployment. No money was spent.

## Changes retained and corrected

- New brush presets and mix-prefetch performance work remain. Historical
  fixture operations and every historical pixel hash are unchanged; original
  Stage2 dab definitions live in `scripts/lab/golden-stage2-dabs.json`, with the
  new authoring presets tested in a separately appended group.
- Stroke batching retains every ordinary settings payload. The experimental
  general settings omission broke erasers and partial-history reconstruction.
  Server recovery for already-stored settings-less strokes respects author,
  frame, and stroke identity, including FIFO trimming.
- Catch-up replay yields between expensive operations, awaits image/stamp
  decoding, queues live scene changes, and cancels stale work on reconnect or
  unmount. Painting, undo, playback and frame navigation cannot start against a
  scene while it is rebuilding.
- Rejected changing animation's logical dimensions to 1920×1200: it cropped
  legacy coordinates and canvas resizing could erase existing art. Both modes
  retain 4000×2500 and the original 8-frame limit. A 3-layer cap limits new
  animation allocations; clone and thumbnail utilities respect source sizes.
- Removed the extra 40 MB throwaway canvas used solely to obtain a clone ID.
- Video loads only the selected muxer and retries failed imports. Failed
  encoders, frames, and capture streams release resources. Multi-scene exports
  fail safely if WebCodecs cannot encode, because real-time recording cannot
  preserve timing while scenes load.
- Snapshot transport validates dimensions, watermark, ownership and room
  mutation invalidation, but **snapshots remain disabled by default**. Leave
  `ENABLE_CLIENT_SNAPSHOTS` unset: live pixels are not an authoritative frozen
  snapshot of the advertised operation watermark.
- Local `.analytics.json` stays on disk and is removed from Git tracking.
  `scripts/perf-analyze.mjs` requires an explicit input directory and reports
  aggregate estimates without room identifiers. No history rewrite is included.

## Validation

All test servers used isolated temporary data, with mock account services where
needed. No production room data, real purchases, or external messages were used.

| Check | Result |
| --- | --- |
| Production build, zero-warning lint, server syntax | Passed |
| `scripts/launch-ui-verify.mjs` | 24 real Chromium checks; phone and desktop, anonymous drawing, peer relay, PNG export, animation toggle pixel equality, offline shell |
| `scripts/launch-reliability-verify.mjs` | 34 server reliability checks |
| `scripts/perf-server-test.mjs` | 8 history, payload, FIFO and settings checks |
| `scripts/replay-model-verify.mjs` | 21 real-canvas dimension, clone and replay checks |
| `node --test test/replayQueue.test.mjs` | 4 ordering, yielding and cancellation checks |
| Golden brush lab | 18 deterministic groups passed; random legacy group informational |
| Mix-prefetch equivalence | 4 cases passed; no hot-path warnings |
| Three-way brush parity | 7 groups matched local, remote and reloaded-history pixel hashes; additional drawing/opacity checks passed |
| Isolated video mocks | 20 encoder, fallback and resource-lifecycle scenarios passed |
| Synthetic performance-diagnostic fixtures | 10 scenarios passed |
| `npm run test:family` | Entitlement and billing hardening suites passed |

Initial page JavaScript remains about 170 KB before compression, including the
JSX runtime; the studio and video muxers are lazy chunks. This is a build-size
measurement, not a production Core Web Vitals or revenue result.

The remaining business and release gates are in [LAUNCH_AUDIT.md](LAUNCH_AUDIT.md)
and the zero-budget experiment in [LAUNCH_PLAN.md](LAUNCH_PLAN.md). Neither a
successful push nor passing tests establishes traffic, demand, or profitability.
