# Drawesome seasonal and artist-studio release

Released from hp-dev-one, UTC 2026-09-28 (local Austin September 27).

## Source and artifact
- Feature commit: cbaaa2a6489f32f588ee03107a799ef8077fbc6e
- Canonical repo: git@github.com:craigcampbell/happypaint.git, main.
- Existing Linux production-source synchronization commit: 2289f11 (the deployment source was ahead of GitHub; this preserves previously running changes rather than rolling them back).
- Production source: /home/craig/Projects/happypaint
- Isolated verification copy: /home/craig/Projects/happypaint-seasonal
- Running image: sha256:7f52e5edba6408d894fc9fa929d0a097af3505dc3015aa7e5fbac5bef25a867b
- Public entry: /assets/index-D95ZH9MA.js
- Container server.js SHA-256: 851950a8aecd1ac9e47f74f0e451061071186fda9bf9823cb98a6ca4b955e04b
- Container dist/index.html SHA-256: 0094de6a8f7a0a126f65998ee00e8e85a7a06b0d011d621b691e527a20fe68df

## Shipped
- MAIN spectator-rendered homepage snapshots refreshed every two minutes while visible. This is NOT a shared server-rendered thumbnail cache; each visitor renders the public op stream. Moderation/clear invalidates immediately.
- Inktober banner, MAIN then INKTOBER room discovery, official 2026 prompts, UTC rotation, /inktober public participation gallery and artist-room discovery. Source https://inktober.com/rules; independent participation, no official logo.
- Shared INKTOBER permits ink/pencil/eraser only. Opted-in artist studios apply this restriction during active October; warm-up/ended phases retain their regular tools. Prompt rotation does not wipe art. Shared INKTOBER and retired DINOS ordinary visitor wipes denied; admin moderation retained.
- SPOOKY Halloween discovery replaces DINOS; old DINOS remains accessible and protected from ordinary room expiry/wipe.
- /gallery: signed-in artist studios, opt-in searchable public descriptions/hashtags. Anyone watches; owner and approved accounts paint. Approval/revocation reaches all tabs. Owner controls publish/unpublish, approval and offline revocation. Delisting does not make a known URL private.
- Sign in beside Draw now. App download/share export actions require an account; anonymous drawing and local recovery remain. No new Drops charge or real-money tipping enabled.
- Replay share exports H.264 MP4 where supported with explicit finished-frame PNG fallback; optional Inktober export border. GIF download remains an account-gated choice. No direct TikTok/YouTube publish integration.
- /paintjar: Earth/jar visualization, aggregate recorded activity, country groups suppressed below five. Paper equivalents explicitly illustrative, not measured environmental savings.

## Verification
Parent reran build, changed-file lint (zero warnings/errors), and 11 suites totaling 452 checks on the combined tree:
- artist-security: 46/46
- artist-rooms-server: 110/110
- seasonal-server: 47/47
- artist-studio: 29/29
- seasonal-replay: 54/54
- seasonal-studio: 22/22
- artist-gallery-integration: 25/25
- seasonal-marketing: 44/44
- seasonal-preview: 14/14
- modwatch: 28/28
- security: 33/33

Live browser: 15/15 checks on https://drawesome.art at 390px: homepage, Sign in/Draw now, /inktober (31 prompts), /gallery, /paintjar, no horizontal overflow, MAIN/INKTOBER ordering, SPOOKY discovery, anonymous Inktober studio load, zero JavaScript page errors. Public + loopback health 200; PocketBase health 200; public entry matches running image. Python urllib's default client received a Cloudflare 403, but curl and real Chromium passed; no WAF configuration changed.

Real native Android Instagram/TikTok/YouTube composer ingestion is NOT tested. MP4 bytes were decoded in Chromium and final artwork pixels verified. Current replay source snapshots remain 480x360; MP4 avoids GIF palette/flattening problems, but this is not a new HD replay recorder. Public artwork remains screenshot/capture-able: account export gating is product UX, not DRM. Inktober public posts denote prompt participation, not certified ink-only provenance; artist-room event attribution requires owner/approved-account identity.

Older safety/harness/signin suites have documented baseline failures and Windows-path assumptions; not claimed globally green. No production drawing, chat or wall post was created by verification. Viewing pages/studio adds normal analytics/session activity.

## Backup and rollback
- Backup: /home/craig/Projects/happypaint/backups/pre-seasonal-20260928T031715Z.tar.gz
- Backup SHA-256: 85e66d0f27c15376437fc2cb1c144c3e4c71d4e1836b40c76c01f3ccb922ce46
- This live directory backup is precautionary, not a transaction-consistent snapshot.
- Rollback image: happypaint-app:pre-seasonal-20260928T031715Z
- Prior image: sha256:f571ffa551cc4986017502df1fe740ab97118e8d0c729c560c19ef3ab5b6cc60

Rollback commands (code only, NEVER restore the backup over newer artwork automatically):

    docker image tag happypaint-app:pre-seasonal-20260928T031715Z happypaint-app:latest
    docker compose -p happypaint -f /home/craig/Projects/happypaint/docker-compose.yml up -d --no-deps --no-build --wait --wait-timeout 60 app

PocketBase and cloudflared IDs/start times verified unchanged:
- /happypaint-pocketbase-1: 62bf14b3dd3ab368548b98a7a9efc5e8df80de923cd8bc4961d3c02344801e12, 2026-09-25T23:54:33.33364521Z
- /happypaint-cloudflared-1: 80fcb2dac9c469014955b1a470f774e89ec83b211cbd540a5eb70c2de606e055, 2026-09-25T23:55:29.907664954Z
