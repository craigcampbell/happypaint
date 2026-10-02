# Room-loading checkpoint release: 2026-09-29 (CDT)

## Source and merge

- Pulled canonical `git@github.com:craigcampbell/happypaint.git` main at `1bb52d3c964270838e4993433b6cefe35d73be75`.
- `e2c8abb`: preserve already-deployed navigation, painted Planet artwork, their regression tests and analytics retention limits. These local changes were not yet in upstream; this release does not revert them.
- `33f358068f7c3c98cd3c24e390b96a8627837c2c`: room-loading/catch-up, trusted layered checkpoints, bounded animation residency, whole-film playback/export and FLIPBOOK 1–3-second holds.
- Feature branch fast-forward merged into **local main**. No push performed, respecting the repository's owner-push convention.
- Git checkout: `/home/craig/Projects/happypaint-release-20260929`. Production's `/home/craig/Projects/happypaint` remains a non-Git deploy tree. Selected source files were reconciled and hash-verified before deployment; credentials and user data were not overwritten.

## Image and activation

- Running image: `sha256:f2dba41d14d095d5d4ec3fbb9cde49b9572f48b12686ac1380841effb8e07d0b`.
- OCI revision label: `33f358068f7c3c98cd3c24e390b96a8627837c2c`.
- App container: `aba00f142079a07d6dcd9c228d7f9023249ed6de42e2c7b034dd80e2aa8b18d0`, started `2026-09-30T03:34:52.438259606Z`, healthy.
- Built `checkpoint-runtime` from the committed release checkout with the existing production Compose public build arguments. A build-only context override avoids silently building unrelated/noncanonical deploy-tree files.
- Activated with `docker-compose.yml` + `docker-compose.checkpoints.yml`, project `happypaint`, **app service only**. `ENABLE_TRUSTED_CHECKPOINTS=1`, `CHECKPOINT_CHROME_PATH=/usr/bin/chromium-browser`; `ENABLE_CLIENT_SNAPSHOTS` remains unset.
- Swap used `up -d --no-deps --no-build --wait --wait-timeout 90 app`; output confirms Recreated/Healthy and the running image ID matches the build.
- PocketBase and Cloudflared IDs and start times are unchanged. No Cloudflare account/DNS/tunnel configuration was changed.

Continue using the checkpoint override for future deployments; plain base Compose omits checkpoint activation.

### Artifact hashes

- Server SHA-256: `e233b39358720cb7d274868fa6cc319e8c039e723bb76f1bbbce8f3826b4db53`.
- Public entry: `/assets/index-CMO_v1Yk.js`.
- Entry SHA-256: `b6f8e00776eb9a5d746b0df49f9b69d2f2aaa43b7b1d44b47de1d0f865e229a7`.
- Renderer fingerprint: `4af1d828247b6e4579616eebe11fa3ebfbc42d2ec3b3a909068988a6cac01f2e`.

The fingerprint differs from the earlier implementation-copy test because the canonical checkout uses LF line endings; matching server/client artifacts were built together.

## Verification

- Combined source: npm install/lockfile, lint, production build and syntax gates passed.
- Navigation: **397/397** checks; Planet: **30/30**; checkpoint/client realtime: **43/43**; focused unit: **16/16**; worker: **6/6**. Animation and FLIPBOOK server suites passed.
- Independent release integration review found no blockers.
- Actual image renderer passed as **uid 1000**, Node **v24.20.0**, network disabled, 1 GiB limit and two CPUs. It generated a validated PNG before the swap.
- Local/public `/healthz` and public PocketBase `/api/health`: **200**. Python's default user-agent initially received a 403; normal-browser/curl user agents and actual browser requests succeeded.
- Public entry filename, JavaScript MIME type and full asset hash match the image.
- Public anonymous mobile browser: navigation works, heavy room reaches ready with a real matching checkpoint, **zero browser errors and zero checkpoint nacks**. This verifies execution, not merely a marker in the bundle.
- Read-only public WS verification: **SPOOKY** initially delivered its 1,690 operations, then delivered a warm checkpoint with zero remaining tail operations. Public **FLIPBOOK** advertises `minMs=1000`, `maxMs=3000`, `defaultMs=1000`.
- MAIN had only **49 operations** when checked, below the default checkpoint eligibility threshold. The initial test's expectation of a MAIN checkpoint was therefore inappropriate; the heavier listed public room was used instead. No test ink was added to make a room eligible.
- Public probes sent no paint/clear/chat/moderation messages; the browser WS relay blocked those paths. Read-only visits and joins may increment normal analytics/presence counters. No shared artwork was edited.
- Origin service worker is v9 with network-first navigations. The plain public `/sw.js` URL was still serving CDN-cached v8; its navigation path is also network-first. A release-query URL returned v9 with the origin hash `a81c1a08b0e101c91f905c119e6b266b24a79b883c33640a0e753a52cd3fcc4f`. No cache purge/account mutation was attempted. Existing tabs should reload to pick up the client bundle.

## Backup and rollback

- Rollback image: `happypaint-app:pre-checkpoints-20260929T222233`.
- Previous image: `sha256:97c529456aac7e940c9559f6794c484fa3dbe31d83f52869b3a64bfcf55b288b`.
- App-data backup: `/home/craig/Projects/happypaint-evidence/release-room-loading-20260929/app-data-pre-deploy.tar` (42,403,840 bytes, mode 0600).
- Backup SHA-256: `124411ad940926664904072e0575c15f675e862ddba236d26d18b6c3867d4283`.
- This is a live-copy precaution, not a transactional database snapshot. A code rollback must **not** restore this archive over newer artwork.

From `/home/craig/Projects/happypaint`, roll back the app only:

```sh
docker image tag happypaint-app:pre-checkpoints-20260929T222233 happypaint-app:latest
docker compose -p happypaint -f docker-compose.yml up -d --no-deps --no-build --wait --wait-timeout 90 app
```

Using only base Compose for this rollback also removes the checkpoint opt-in environment.

## Evidence and remaining limits

Evidence directory: `/home/craig/Projects/happypaint-evidence/release-room-loading-20260929`, `predeploy.json`, `release-files.json`, `image-verified.json`, `live-http-verification.json`, `public-cold-to-warm.json`, `public-runtime-verification.json`, `public-heavy-room-mobile.png`, build/swap/test logs and source backup.

Prior implementation evidence remains under `room-loading-implementation-2026-09-29/REPORT.md`: same-host MAIN warm-load improvement, actual 150/300-frame exports, remaining slow cold-film preview, cross-device limitations, and the retained long-soak module-loading failure whose focused comparisons subsequently passed. This deployment does not claim those remaining limitations are solved.
