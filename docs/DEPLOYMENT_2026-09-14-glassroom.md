# Production deployment — September 14, 2026 (admin glass room)

The owner asked for the admin watch feature to be committed and released. The
release adds the invisible, read-only moderator view of any room and was deployed
at **https://drawesome.art** through the existing local Docker Compose stack. No
money was spent.

## What shipped

`/watch/<code>` + `GET /ws?room=<code>&modwatch=1`: an authenticated observer
socket that lives in `room.mods` rather than `room.users` (absent from the roster,
headcount, presence, beacons, metrics and analytics), may watch PRIVATE rooms,
and is allowlisted to moderation actions only — it cannot draw, chat or
impersonate. The console's room and report rows now open it instead of a real
join. Host and admin moderation share one implementation (`moderateClear`,
`moderateHideOps`, `moderateKick`, …). Full contract: `docs/CONTENT_MODERATION.md`
§7–§8.

## Release and rollback

- Commit: `dccc22b` — *Admin glass room: watch any room invisibly, read-only, with
  moderation powers*, pushed to `origin/codex/youth-design-refresh`.
- App image (`happypaint-app:latest`):
  `sha256:c9ab1381399e7c47fcd63c66f7a91e9b9f120a1ce0ce54245b368d12ecc74cfb`.
- Deployed `server.js` SHA-256:
  `38ea6539f626d8799d7e86a8e07de494f02ad6168c74d7c39eb22887672979f6`.
- Deployed `dist/index.html` SHA-256:
  `d38d30b264a80b151687317ccaccaf2fe4b2ef72f5dcced83006961e429648d5`.
- Public entry script: `/assets/index-B6urHuBd.js`; watch chunk:
  `/assets/RoomWatch-BP63PfkZ.js`.
- Rollback image tag retained locally: `happypaint-app:rollback-20260914b`
  (`sha256:77f103a20b106a2d436e898ff333bd7d104d6633a66de4128642fbbf0cf61e98`,
  the Google-Analytics release from the morning).
- Local app-data backup: `backups/pre-deploy-20260914-glassroom.tar`,
  154,060,800 bytes; SHA-256
  `0a043e9ff450a2000ef52c25f0b70b23d9641ac452b32576eccc978c146deb30`.

Release used `docker compose up -d --no-deps --no-build --wait --wait-timeout 60
app` after `docker compose build app`. The PocketBase and Cloudflared container
IDs and start times (2026-09-14T02:51:40Z) were unchanged. Existing drawing-data,
account-data, and coloring-library mounts were retained. No DNS/tunnel changes,
credential entry, or payments were performed.

## Verification

- Zero-warning lint and the production build passed; the built image contains the
  watch bundle.
- Local and public `/healthz` returned 200; the app container reached `healthy`;
  the running container's image ID matches the image just built.
- Pre-deploy, against a hermetic scratch server: `scripts/modwatch-verify.mjs`
  28/28 (raw WS — invisibility, the no-draw/no-chat boundary, hide/restore/wipe/
  undo/kick landing on members, bad key / unknown room / silent socket refused,
  public spectating of private rooms still refused, flag filed to the reports
  queue) and `scripts/modwatch-ui-verify.mjs` 16/16 (a real browser — key gate,
  no studio/brush/composer on the page, stroke attribution, flag-and-hide and
  wipe reaching the painter's canvas, the room still counting one person and
  seeing only "a moderator"). `test/harness/run.mjs` and
  `scripts/safety-verify.mjs` matched their pre-change baselines exactly (3/6 and
  18/21; those failures predate this work).
- Post-deploy, on the live server: `/watch/MAIN` serves the shell with its own
  head and canonical, robots.txt disallows `/watch/`, the watch bundle returns
  `text/javascript`, a wrong admin key is refused (`mod_denied: bad_key`), the
  real key attached as a watcher (`moderator: true, ghost: true`) and was handed
  the roster, history, chat history and mod log, and the room's headcount read
  zero throughout — the watcher was never counted as a participant. Nothing was
  drawn, chatted, cleared or kicked during these checks; the watcher disconnected
  without sending a frame.
- Public coloring catalog returned all 6,294 sheets; PocketBase health returned
  200; the homepage, studio and admin pages returned 200; the Google Analytics tag
  from the morning release is still present and collecting. Checkout remained
  disabled.
