# Room loading, checkpoints and long films

## Design

Keep Node.js. The expensive part of a heavy mural join is browser replay, not simply transferring its history. Room catch-up now uses cached asynchronous scene serialization and an ordered per-connection baseline/tail gate. Optional trusted checkpoints replace expensive old replay with lossless per-layer PNGs and a shorter ordered operation tail.

A checkpoint is a **derived cache**, never a replacement for saved history. There is no two-hour deletion/window rule: prefix selection uses operation/replay budgets and safe closed-stroke boundaries. Preserve every layer separately, including hidden layers and opacity metadata; animation checkpoints are per frame and can cover only part of a scene. Uncovered frames still receive full history.

The renderer uses the existing drawing interpreter in an isolated, server-owned Chromium child process. It receives bounded frozen jobs over local IPC, with a scrubbed environment and an allowlisted local module origin. It does not accept a browser's uploaded drawing as authority, and exposes no public rendering endpoint. Wet-paint continuation state is preserved alongside the pixels.

Clients negotiate a source-derived renderer fingerprint. Asset hashes, dimensions, layer identity, generation and watermark checks run before checkpoint installation. Unsupported content, mismatched versions, missing Chromium, oversized jobs/assets, timeouts and declined checkpoints fall back to full history. Moderation/structural changes invalidate derived state. Restart starts with a cold cache and rebuilds lazily.

## Enabling the optional renderer

The ordinary Docker build and server remain functional without Chromium, PocketBase or checkpoints. Checkpoints are off by default. Do **not** enable the old experimental `ENABLE_CLIENT_SNAPSHOTS` feature.

After verifying and authorizing a deployment, use the optional Compose override:

```sh
docker compose -f docker-compose.yml -f docker-compose.checkpoints.yml up -d --build app
```

This selects `checkpoint-runtime`, installs Chromium, sets `ENABLE_TRUSTED_CHECKPOINTS=1` and `CHECKPOINT_CHROME_PATH=/usr/bin/chromium-browser`, and adds shared-memory space. No extra public port or account credential is needed. Deploy matching server/client source together; refresh existing tabs to pick up fidelity fixes. Do not run this command merely to execute tests.

For a non-Docker installation, supply an explicit installed Chrome/Chromium executable using `CHECKPOINT_CHROME_PATH` and set `ENABLE_TRUSTED_CHECKPOINTS=1`. Missing executable disables checkpoints rather than blocking anonymous joins. Do not install a browser at request time.

Selected server defaults (see `server.js` for the complete configuration):

| Setting | Default | Purpose |
| --- | ---: | --- |
| `CHECKPOINT_MIN_OPS` | 600 | Ordinary-room eligibility threshold |
| `CHECKPOINT_FRAME_MIN_OPS` | same as above | Per-animation-frame eligibility threshold |
| `CHECKPOINT_REBUILD_TAIL` | 400 | Background refresh threshold |
| `CHECKPOINT_TAIL_MAX` | 800 | Maximum retained replay tail for serving a cache entry |
| `CHECKPOINT_CACHE_MAX_ENTRIES` | 12 | Bounded checkpoint entry count |
| `CHECKPOINT_CACHE_MAX_BYTES` | 192 MiB | Global checkpoint cache byte ceiling |
| `CHECKPOINT_JOB_TIMEOUT_MS` | 45,000 | Render-job timeout |
| `CHECKPOINT_WORKER_MAX_QUEUE` | 3 | Bounded worker queue |
| `CHECKPOINT_SCENE_MAX_FRAMES` | 8 | Maximum checkpoint-covered frames in one scene delivery |
| `CHECKPOINT_SERVE_MAX_BYTES` | 14 MiB | Checkpoint-message budget |

Start with defaults; do not eagerly render all frames of every film. Requested frames receive priority. A bitmap can cost more bandwidth than compressed stroke history, so measure both transfer and visible-ready time before raising thresholds or cache limits.

## Animation behavior

- FLIPBOOK holds each frame **1–3 seconds**, with a **1-second default**. The server enforces the bounds for incoming edits, new/duplicated frames and persisted legacy durations; the existing hold control offers only in-range steps.
- Private films retain their general timing range. At 100 ms per cel, 150 distinct cels produce 15 seconds and 300 produce 30 seconds. Existing per-scene caps allow these to be split across several scenes; whole-film Play/export follow the complete scene plan, not only the current scene.
- Stop returns to the artist's scene. In-flight scene requests are deduplicated and canceled on stop/unmount. Moderation or unsolicited rebuilds cancel stale cached playback.
- Complete multi-scene video export requires WebCodecs. If unavailable, the app explains the limitation rather than silently exporting only one scene. Existing export entitlement policy is unchanged.
- A stable, byte-admitted hydration window replaces warming and immediately evicting every nearby cel. The active frame is always admitted; the number of neighbors depends on layer count. Cold frames retain operations/checkpoint state and derived rasters.
- Export checks raster freshness, not just whether a blob exists, so remote edits to cold frames are not silently omitted.

## Fidelity scope

Painting controls, brush formulas and brush assets are not redesigned. Narrow fidelity corrections make seeded eraser variation use the same randomness policy across consumers and make cold/image replay respect layer routing, visibility and opacity. Lossless checkpoint pixels do not flatten editable layer stacks.

Same-browser pixel comparisons are required for checkpoint-plus-tail versus full replay, including hidden layers and wet-paint continuation. These checks do **not** prove identical behavior across every browser/GPU/font implementation. Legacy unseeded or otherwise unsupported operations can still require full replay; no universal cross-device pixel guarantee is claimed.

Retained editable-canvas diagnostics are not total tab memory: decoded bitmap caches, temporary render/mix surfaces, blobs and the browser heap are additional. Cold long-film preparation may buffer; authored/encoded duration is not a guarantee of real-time playback on a phone. Physical-device and cross-engine verification remain separate acceptance steps.

## Regression commands

Run only in an isolated source copy with scratch data and unused ports. Never point these tests at production `DATA_DIR`.

```sh
npm run lint
npm run build
node --check server.js
node --test test/frame-hydration.test.mjs test/checkpoint-version.test.mjs test/checkpoint-prefix-guard.test.mjs test/checkpoint-worker-priority.test.mjs
node --test test/checkpoint-worker.test.mjs
node scripts/room-catchup-phase2-verify.mjs
node scripts/room-fidelity-verify.mjs
node scripts/checkpoint-client-verify.mjs
node scripts/checkpoint-client-realtime-verify.mjs
node scripts/room-loading-phase4-module-verify.mjs
node scripts/room-loading-phase4-realtime-verify.mjs
node test/checkpoint-animation.integration.mjs
node test/flipbook-timing.integration.mjs
node scripts/room-loading-full-film-verify.mjs
```

The full-film suite uses a real isolated server, synthetic layer/barcode content, 150/300 distinct cels, browser playback, rejoin/restart, checkpoint/full-history pixel comparisons, actual WebCodecs downloads and decoded frame/duration checks. Its export leg uses test-only auth configuration; it does not alter anonymous painting or the production account setup. It is CPU-heavy and should run separately from other browser suites. Preserve raw logs and exit codes; a wrapper's exit status is not enough.

Do not rerecord brush goldens to hide a mismatch. Compare against the untouched same-browser baseline and identify preexisting failures explicitly.
