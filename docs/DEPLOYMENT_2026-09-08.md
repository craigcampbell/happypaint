# Production deployment — September 8, 2026

The owner authorized deployment of the reviewed `codex/youth-design-refresh`
work. The application was released at **https://drawesome.art** through the
existing local Docker Compose stack. No money was spent.

## Release and rollback

- App image: `sha256:b41641535d08d99fbcf2a1ab3904fe1f33389400e6d28ab4cd2105d46c8937d4`.
- Deployed `server.js` SHA-256: `de68dd4dd94c32df48efc71ec8fc68a4dc888b42fc60ebfc29ad5b5a7b1268cc`.
- Public entry script: `/assets/index-DTQLGPYI.js`; studio: `/assets/App-D0oLOHQ3.js`.
- Rollback image tag retained locally: `happypaint-app:rollback-20260908`.
- Previous image: `sha256:3aa1fad9242e72dfccef62355d071e4c6165174f02905d811544f915fe450a3d`.
- Local app-data backup: `backups/pre-deploy-20260908-074049.tar`, 171,024,384 bytes.
- Backup SHA-256: `41ba2832091b366ecfccfe4b585674422cef7afe1c2a56d6db5e976528aeb26a`.

The live app had zero established app-port connections immediately before
replacement. Build and isolated image verification completed first. Release used
`docker compose up -d --no-deps --no-build --wait --wait-timeout 60 app`.
The PocketBase and Cloudflared container IDs/start times remained unchanged.
Existing drawing-data, account-data, and coloring-library mounts were retained.
No DNS/tunnel changes, account credential entry, or payments were performed.

## Deployment fixes

The previous shutdown could exit before the 2.5-second room-save debounce.
Shutdown now closes WebSockets with restart code 1012, waits for accepted HTTP
requests, drains queued/in-flight room writes, and flushes disconnect analytics.
Failure to complete within 8 seconds exits unsuccessfully rather than claiming
success. This does not protect against forced kills or power loss.

Docker build context now excludes local environment variants, runtime data,
secrets, and generated browser artifacts. Runtime image inspection confirmed
none of the checked private files were present. `RUNNING.md` now documents the
actual Docker deployment and rollback procedure.

## Verification

- Production-configured local Vite build and Docker image build passed.
- Zero-warning lint, server syntax, and 17 isolated shutdown regressions passed.
- Candidate image passed health, shell/asset, disabled billing, anonymous
  two-client relay and fresh-client history checks. Actual Docker SIGTERM exited 0.
- Replacement app became healthy; public `/healthz` returned success.
- The public shell referenced the expected new assets, which returned JS/CSS.
- Public anonymous relay and history checks passed in a new private test room.
- A browser that visited the previous release loaded the new homepage and studio
  with its existing service-worker cache. At 375×812, drawing worked, Invite was
  visible, there was no horizontal overflow, and the console had no errors.
- Public coloring catalog returned all 6,294 sheets; PocketBase health returned 200.
- Checkout remained disabled; `ENABLE_CLIENT_SNAPSHOTS` remained unset/disabled.
- No artwork, clear actions, or chat messages were sent to existing community rooms.

Screenshots and the temporary smoke script are under ignored
`output/playwright/`. The disposable candidate container was stopped and removed.
The original business validation and remaining release limits are described in
[LAUNCH_AUDIT.md](LAUNCH_AUDIT.md) and [LAUNCH_PLAN.md](LAUNCH_PLAN.md).
