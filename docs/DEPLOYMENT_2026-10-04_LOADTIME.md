# Load-time fixes: tunnel transport, and a checkpoint render that can finish

Deployed on hp-dev-one, 2026-10-04 local (about 00:00-01:15 CDT). Two compose
changes on top of `origin/main` @ `b1639bd`; the app image content is the
running `b1639bd` build plus Chromium (see "Image" below).

## Why (measured, not guessed)

The complaint was "pages take a long time to load, even from the system machine".
Four layers were measured separately.

- **Static pages are fine.** Cold headless loads: `/` 0.55s, `/gallery` 0.55s,
  `/inktober` 0.62s, `/planet` 0.75s; first contentful paint ~0.24s; every
  subresource under 100ms through Cloudflare; origin 2-5ms.
- **The QUIC tunnel dies in bursts.** `docker logs happypaint-cloudflared-1`
  showed ~150 `Serve tunnel error: timeout: no recent network activity` events
  in 48h, in ~24 bursts of 30-126s (12.8 min total, 0.44% of the time), with
  every tunnel on this host stalling in the same minute, so the shared UDP path
  is the cause rather than one project. During a burst a request hangs for
  seconds; `/rooms` returned a Cloudflare 502 after 5.1s while the origin
  answered in 5ms.
- **Room joins replayed the whole history in the browser.** A real client
  (`gz=1`) receives one gzipped history frame and replays every op. Measured
  time to "Your canvas is ready" in a desktop Chromium on the server: DINOS
  instant (31KB), INKTOBER 1.9s (1,154 ops / 1.96MB), **MAIN 70.5s** (3,518
  plain stroke ops, 45,216 points, one layer). MAIN is the room the homepage and
  the Inktober CTAs drop visitors into.
- **The feature that exists to fix that was inert.** Trusted checkpoints were
  "enabled" in the container env but the image had no Chromium
  (`[checkpoints] disabled: chrome_missing`). After restoring Chromium the
  pipeline ran but could not finish: `/api/admin/metrics` reported 11 worker job
  timeouts, 11 restarts, 1 completed build and 25 fallback joins, i.e. the 45s
  `CHECKPOINT_JOB_TIMEOUT_MS` killed the baseline render of every large mural, so
  the cache never warmed and every joiner fell back to full replay.

## What changed

1. `docker-compose.yml`: the Cloudflare tunnel now runs
   `tunnel --no-autoupdate --protocol http2 run`. HTTP/2 over TCP removes the
   QUIC `no recent network activity` stalls. Verified: all four connections
   register `protocol=http2`, 0 stall events in the first hour (QUIC averaged
   ~3/hour), and latency did not regress (60 requests: p50 131ms, p90 159ms,
   max 187ms, vs QUIC's p50 128ms / p90 146ms / max 192ms).
2. `docker-compose.checkpoints.yml`: `CHECKPOINT_JOB_TIMEOUT_MS: "240000"`.
   An isolated container built from the same image rendered a 1,154-op frame in
   ~17s, so 240s covers the pre-clear MAIN-sized murals (measured in production:
   the INKTOBER baseline render now completes with 0 timeouts).
3. Image: `happypaint-app:checkpoints-20261004T050206Z` (2.07GB) was built as
   `FROM` the then-running `83627b063471` runtime image plus
   `apk add --no-cache chromium font-noto` and `CHECKPOINT_CHROME_PATH`, so the
   app code stayed byte-identical to the deployed revision instead of being
   rebuilt from this source tree. The documented `-f docker-compose.yml -f
   docker-compose.checkpoints.yml up -d --build app` produces the same shape
   from source and supersedes it. Rollback image:
   `happypaint-app:pre-checkpoint-restore-20261004T050206Z` (934MB, no Chromium).

## Verified after the change

- `[checkpoints] trusted checkpoints enabled`; container healthy; `/healthz` 200.
- A capable join of INKTOBER now receives
  `{type:history, ops:[], frames:[...], checkpoint:{schemaVersion:1,
  rendererVersion:d82b4a5d..., frames:[{frameId:f0, throughOpId:1154, layersKey,
  layers:[{id:L0, pngBase64...}]}]}}` - the whole 1,154-op prefix replaced by one
  raster and a zero-op tail. `checkpoints.metrics()`: builds 1, completed 1,
  timeouts 0, hits 2, fallback joins 2.
- Anonymous drawing path untouched; no account or sign-in behaviour changed.

## Must-not-regress

- `curl -I https://drawesome.art/` from the host, and a plain browser load of
  `/`, `/studio`, `/join/DINOS` (fast joins auto-close the curtain; the stuck
  path renders "This room is taking its time").
- `/api/admin/metrics` -> `checkpoints.workerTimeouts` must stay 0 as the busy
  rooms refill after the 01:01 fresh-canvas rotation.
- `/rooms` must not 502; the 502 seen during this work was a QUIC burst, so if it
  returns, check `docker logs happypaint-cloudflared-1 | grep 'Serve tunnel error'`.

## Open follow-up

`/studio` and `/join/MAIN` reached "ready" in 70.5s then, and MAIN's history was
3,518 plain stroke ops, i.e. ~3x INKTOBER's op count but ~37x its load time, so
per-op cost is not uniform. Worth profiling the client replay (thumbnail and
wet-mix work) when a big canvas exists again; the checkpoint path now removes the
old replay entirely, which is the largest lever either way.
