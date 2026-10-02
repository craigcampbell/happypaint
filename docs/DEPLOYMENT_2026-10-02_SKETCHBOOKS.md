# Inktober sketchbooks, sharing and pen-pressure release

Feature commit: `9b9f641c20ff161bb67f7e3a3f26bc937375a9d2`; final deployed code: `bac501d34672dc2ec1ee6da1a4b10b86796995fb` (privacy copy follow-up). Both pushed to origin/main; remote SHA read back. Release spans Oct 1 local / Oct 2 UTC.

## Source reconciliation

Repeated fetches showed prior main `eb91fc4`, including the earlier Inktober homepage/planet release. Production tracked source matched that baseline after CRLF normalization (only kanban.md absent). No additional just-deployed update was found. Final build came from the committed isolated checkout `/home/craig/Projects/happypaint-inktober-sharing`, using the production Compose project and checkpoint-runtime target. Changed source paths were copied to `/home/craig/Projects/happypaint` only after per-file comparison against the baseline rejected concurrent edits.

## Shipped

- Account-owned private (default) or public Inktober sketchbooks, up to 31 separately persisted daily-prompt page rooms, immutable prompt labels, owner plus five invited artists.
- Public books with artwork discovered from homepage/event page; private books excluded from public readers, room joins, spectator access and new Wall posts. Public visibility is an explicit choice; downgrade disconnects unauthorized live viewers.
- Invite/revoke across all pages and account sessions; hashed invitations; book-managed room controls; reserved page codes and idle protection. Missing book records deny public history while persisted owner/team can recover artwork. Admin hide disconnects public viewers and prevents new Wall posts.
- Studio page navigation/add-page/invitation controls, private/public badges and controls, shared INKTOBER room's own-sketchbook CTA. Chat/animation UI hidden and server mutations denied on pages.
- Original cream-paper/rough-ink Inktober share frames; Instagram/TikTok/native image sharing, saved PNG, SMS/email link+manual attachment fallbacks; page metadata remains pinned after October. No official affiliation or artist imitation.
- Zero-pressure pen events stay in stylus calibration rather than falling into mouse/finger velocity pressure; old brush/replay formulas unchanged.

## Verification

Parent executed: backend 180/180; sketchbook UI 70/70; studio integration 37/37; share 56/56; pen browser 7/7; existing artist backend 110/110; unit tests 92/92. Full lint and production build pass. Fail-first regressions reproduced missing-book history exposure, connected viewers surviving moderation hide, hidden-book wall posting, corrupt animation film export, and signup return rejection before fixes.

Public Chromium verification at 390px: homepage own-sketchbook CTA, guest account entry/private-default disclosure, actual shared INKTOBER studio CTA, event gallery, no horizontal overflow, no page errors. No drawing/chat/public artwork mutations were made by live verification. Authenticated owner/invite flows exercised against an isolated real server with mocked PocketBase authentication, not a real production account.

Live image: `sha256:99ca2acd5561af5c59bca5f05f06d933b210a0d0b7246cd8054adc897da70bcb`, healthy and equal to built image. Revision label matches bac501d. Local/public health pass; API `/api/sketchbooks` returns an empty real gallery at release, not seeded marketing content. All 31 prompts and sketchbooks module present in image.

Public entry `/assets/index-MUm1IijO.js`: SHA256 `258545542dcef1dd5ddb3e60ee980aa2da5b681dbe4d89774a5c4445a82b921c`, identical to container file. Server SHA256 `18f01c248f18c738b004bb9d136b7b7c72ea49ccf5a95f7169b83b61b4e34b19`. Served service worker retains network-first navigations. PocketBase and cloudflared container IDs/start times unchanged through release.

Evidence: `/home/craig/.hermes/cache/scratch/inktober-live-evidence.json`, `inktober-live-home.png`, `inktober-live-entry.png`, `inktober-live-shared-cta.png`, `sketchbook-final-green.log`, `inktober-unit-final.log`, `inktober-rerun-*.log`.

## Limitations / incident

- Physical iPad/Apple Pencil response and Instagram/TikTok/Messages/Mail app ingestion not tested; browser pressure and native-share payload paths were exercised.
- Private book readers show metadata and open authorized page studios for viewing/editing, rather than anonymous spectator previews.
- Previously public bytes or explicitly posted Wall snapshots cannot be made secret retroactively by switching book visibility.
- Before release, a delegated worker mistakenly killed production Node processes during test cleanup. Docker recorded two restarts; logs included `Shutdown timed out before all requests and room saves completed.` The site recovered, but no claim is made that all in-flight artwork saved. Incident disclosed to user; subsequent cleanup restricted to handles created by each test. No PocketBase/tunnel restart.
- Preflight activity was UNKNOWN (zero public/TCP observed does not cover private users). App replacement can reconnect visitors; source and data were not rolled back.

## Rollback

Pre-feature image tag: `happypaint-app:pre-sketchbooks-9b9f641` (image `sha256:f3eceeadce01ebaa89ad95e08a78f819c40c28355dc8e5d1b0b39b5b350cdd41`). App-data precautionary live backup `/home/craig/Projects/happypaint/backups/pre-sketchbooks-9b9f641.tar`, SHA256 `b1faca28fbd2a14f317ae86ca91b7c3d917c867d7366417c426eb2c2e2970f6a`. Do not restore it for a code rollback.

From `/home/craig/Projects/happypaint`:

```
docker image tag happypaint-app:pre-sketchbooks-9b9f641 happypaint-app:latest
docker compose -p happypaint -f docker-compose.yml -f docker-compose.checkpoints.yml up -d --no-deps --no-build --wait --wait-timeout 90 app
```

Warning: old code predates book privacy guards. Do not blindly roll back once private sketchbooks contain artwork; old code treats page rooms as ordinary publicly viewable artist rooms. Prefer a forward fix, or take the app offline before reverting to an image without sketchbook access controls. Preserve all current data.
