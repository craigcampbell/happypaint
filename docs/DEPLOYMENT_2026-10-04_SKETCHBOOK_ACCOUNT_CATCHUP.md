# Sketchbook catch-up follow-up: account routing and guest reader

Deployed to drawesome.art on 2026-10-05 at approximately 03:18 UTC (2026-10-04 CDT), on branch `fix/sketchbook-catchup-and-fab`, following `5f08593`.

## Additional defects reproduced and fixed

- Signed-in artists picking a prompt from `/inktober` created a public guest page instead of resuming the account's existing day. Home, shared-room and visitor-reader entry buttons had the same defect. Regression assertions failed on the preceding source and pass after the fix.
- The guest author opening their unsaved book's reader had no catch-up controls. The reader now verifies guest ownership using the existing by-room endpoint, then adds/resumes pages through the device endpoint. Visitors still have no author controls.
- Account entries now use the shared `openSketchbookPrompt` helper: create/resume the account book with explicit private visibility for new books (existing visibility is preserved), add/resume the requested day, open its canonical room. They do not create temporary public guest books or overwrite guest claim records.

Server, ownership enforcement, persistence and drawing code are unchanged. The earlier tablet banner spacing and 44px coarse-pointer day targets remain deployed.

## Verification

- Zero-warning lint and isolated production-bundle build succeeded.
- Catch-up browser suite: Chromium 38/38 and WebKit 38/38, using the built frontend, isolated data and ports 9031–9033. Includes actual touch taps, 44x44 day targets, both iPad orientations, guest reader catch-up, account existing-day routing through all four entry paths and stranger denial.
- Regression suites: sketchbook-studio 37/37, sketchbook-guest 199/199, sketchbook-ui 82/82, sketchbook-server 180/180, inktober-share 56/56, artist-studio 29/29.
- Live read-only browser checks: Chromium and WebKit at 1024x1366, 1366x1024 and 1920x1080; no FAB overlap with prompt or page navigation; all 31 catch-up days displayed.
- Origin and public health 200. Public event endpoint and prompt file inside image both contain 31 prompts.
- All 43 JavaScript/CSS asset responses were fetched in a real browser and byte-compared with the running image's dist files. All matched with expected content types. Python urllib was rejected with 403; browser fetches succeeded.
- Running image equals built image: `sha256:3e3d424de203cb3d168cc41fb4b8c1d6944d94a74a55ed26537aea61905d71d2`.
- PocketBase and cloudflared container IDs and StartedAt are identical before and after. Only app was rebuilt/recreated with both compose files.
- No live artwork or book write paths were exercised during follow-up verification. Browser presence is transient; analytics was opted out before navigation.

## Test-environment findings and limitations

- WebKit's service worker intercepted API requests, bypassing Playwright route fixtures and returning the Vite shell. Block service workers in this isolated routing harness; this is not a production application change.
- Linux Playwright WebKit reports maxTouchPoints=0 under hasTouch. Assert the actual coarse-pointer media query and exercise tap; do not claim physical iPad touch/Apple Pencil behavior from emulation.
- WebKit needed libwoff1. It was downloaded and extracted to scratch, with links in the Playwright browser cache; no system packages or production images were modified for this test dependency.
- Physical Movink pen, Apple Pencil pressure, palm rejection and device-specific Safari behavior have not been tested.

## Release safety handles

Rollback image: `happypaint-app:pre-account-catchup-20261005T031552Z`.
Previous image: `sha256:e7a8dcb98ac98dcf5afcebfb0ef8aca05d02806c9ae1fff17a9a92636cc0c631`.
Data backup: `/home/craig/Projects/happypaint/backups/pre-account-catchup-20261005T031552Z.tar.gz`.
Backup SHA-256: `3b91dcc19e7683b7553d10c0d4bdad604cfddb1809c44b45b8c551b6e98e07e6`.

```bash
cd /home/craig/Projects/happypaint
docker image tag happypaint-app:pre-account-catchup-20261005T031552Z happypaint-app:latest
docker compose -p happypaint -f docker-compose.yml -f docker-compose.checkpoints.yml up -d --no-deps --no-build --wait --wait-timeout 90 app
```

Do not restore the data backup during a code rollback. Changed source/test files were copied individually and byte-verified against the release worktree; no unrelated source drift was found after CRLF normalization. Commits remain local; no push was performed.
