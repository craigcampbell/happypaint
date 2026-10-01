# Spinning Painted Planet + Inktober release

Released 2026-10-01 from hp-dev-one.

## Source and artifact

- Feature commit: `b057b5551b9957edfe04befd9a4570077430fd84`, fast-forward merged into `main` and pushed to `origin/main` (remote SHA verified).
- Git checkout: `/home/craig/Projects/happypaint-release-20260929`; isolated implementation: `/home/craig/Projects/happypaint-ink-globe`.
- Production source: `/home/craig/Projects/happypaint` (no Git directory). Existing production files matched the prior Git baseline after CRLF normalization. Each of the 39 changed/new files was checked for concurrent edits before copying, then verified byte-for-byte against the feature checkout.
- Running image: `sha256:f3eceeadce01ebaa89ad95e08a78f819c40c28355dc8e5d1b0b39b5b350cdd41`, built with the `checkpoint-runtime` target.
- Server SHA-256: `2d4b5ec79da93dab4f19b808fe2f94038843ee067cd2435047e7a2a34f4632ce`.
- Public entry: `/assets/index-CEdmrq-M.js`; globe chunk: `/assets/PlanetPage-BMdNGZ7c.js`.
- Public entry, globe chunk and bundled Caveat font were fetched and compared byte-for-byte with the running image. The host build produced different chunk filenames; its entry text was identical after normalizing imported chunk hashes, not byte-identical. The image/public comparison is the release artifact gate.

## Shipped

- Orthographic spherical geography, north-up, with painterly country glazes, ocean texture, spherical shading, spinning motion and hanging paint drips.
- Drag and keyboard rotation, pause/play, reduced-motion behavior, offscreen/hidden-tab suspension, high-DPI country hit testing and actionable country selector entries even when a flag has no geographic polygon.
- Static textured landscape: seeded paint marks and scene milestones remain, but no animation. Recorded activity still controls which parts are revealed.
- Homepage ink-lettered “Inktober is here!” card, today's server-provided prompt and “Draw yours today!” CTA. Bundled OFL-licensed Caveat font, original ink splatters, anonymous entry to INKTOBER, phase handling, midnight rollover and bounded failure retries.
- Canonical `canceled` enum/protocol values with legacy `cancelled` reads supported. Legacy Supabase migration included but NOT applied to production: production uses PocketBase, not those PostgreSQL enums. No real-money features enabled.

## Verification

- `npm run build`, `npm run lint`, `node --check server.js`: pass.
- `node --test test/*.test.mjs`: 79/79 pass.
- `scripts/planet-globe-verify.mjs`: 66/66 pass, including north-up projection, horizon clipping, DPR 1/2/2.5 pointer clicks, missing-geometry selection, paused/reduced-motion pixel stability, mobile overflow and static-scene pixel equality.
- `scripts/planet-verify.mjs`: 27/27 pass against the built frontend and isolated real server, including anonymous flag-room navigation, pinned sheets and WS contracts.
- `scripts/home-inktober-verify.mjs`: 26/26 pass, including anonymous navigation, actual bundled font loading, UTC rollover, HTTP recovery, upcoming/ended phases and timer-overflow prevention.
- `scripts/test-billing-hardening.mjs`: pass. `npm run test:family` fails with a WebSocket timeout in the older entitlement test; reproduced unchanged on a clean pre-feature Git archive. Not attributed to this release.
- `scripts/wipe-vote-verify.mjs` was not run: tool approval expired. Its modified assertions are not claimed as verified.
- Optional Supabase migration executed twice in a disposable PostgreSQL 17 container: all three enum renames preserve fixture rows; legacy account-deletion RPC works after its stored string literal is rewritten. Container removed; no production database changes.
- Independent read-only review found no blocking security or logic issues. Follow-up suggestions include validation of optional mobile stored event statuses and an absent upcoming warm-up prompt.
- Screenshot image-review service timed out, so no independent aesthetic review is claimed. Actual browser interaction, geometry and pixel assertions passed.

## Production readback

- App-only recreate with both Compose files and `--no-deps --no-build --wait`: healthy; running image equals built image.
- PocketBase and cloudflared IDs and StartedAt timestamps unchanged.
- Local and public `/healthz`, `/api/planet`, `/api/inktober`, `/api/billing/config`: success. Live Inktober prompt: Apple (day 1); billing remains unconfigured.
- Google Analytics shell tag remains present; Chromium and all 31 server prompt entries present inside the image.
- Live Chromium at 375px/DPR 2 confirmed the Inktober card, server prompt, cursive font, spinning globe, pause pixel freeze, static landscape pixels, no page errors and no mobile overflow. Desktop screenshot also captured. No drawing, room mutations or account changes made; normal page visits can contribute visit telemetry.
- Public Python urllib request received 403; curl and Chromium reached and verified the live site normally.
- Evidence directory: `/home/craig/.hermes/cache/scratch/ink-globe-release` (live-home-375.png, live-planet-375.png, live-planet-1280.png, release-state.json).

## Rollback

- Previous image: `sha256:85725801931d2f612e88dceaec1879475d6c1623db58ab9eabb2dbddf8da0c32`.
- Rollback tag: `happypaint-app:pre-ink-globe-20261001T222607Z`.
- App-data backup: `/home/craig/Projects/happypaint/backups/pre-ink-globe-20261001T222607Z.tar` (mode 0600).
- Backup SHA-256: `ad7a86921b740fc72baea80243573cdcbb05ad23b36187242feb938013967e2c`.

```sh
cd /home/craig/Projects/happypaint
docker image tag happypaint-app:pre-ink-globe-20261001T222607Z happypaint-app:latest
docker compose -p happypaint -f docker-compose.yml -f docker-compose.checkpoints.yml up -d --no-deps --no-build --wait --wait-timeout 90 app
```

Do not restore app-data for a code rollback. A later rebuild uses the new source unless it is explicitly reverted too.
