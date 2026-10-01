# Drawesome US-spelling pass release

Released from hp-dev-one, UTC 2026-10-01 (local CDT morning).

## Source and artifact
- Commit: ca57a33 "US spelling pass: colour->color, grey->gray, centre->center and friends" on branch fix/us-spellings, fast-forward merged to main. **Not pushed** — `main` is ahead of `origin/main` by 4 (this commit plus the 3 checkpoint commits that were already unpushed); the owner pushes.
- Canonical repo: git@github.com:craigcampbell/happypaint.git. Committed from /home/craig/Projects/happypaint-release-20260929 (HEAD before this release: 54c4b80).
- Production source: /home/craig/Projects/happypaint. Before the change, every path touched matched 54c4b80 byte-for-byte; the commit carries exactly the spelling change (470 changed lines, verified substitutions-only) and nothing else. Scripts consumed by the image build (scripts/, *.md, mobile/) are excluded by .dockerignore, so the image difference is src/** + server.js + server/**.
- 11 touched files carried CRLF in the prod tree where the repo stores LF (src/App.css, src/quick-stroke.css, src/utils/idb.js, src/components/SignupPage.jsx, scripts/animation-sync-verify.mjs, scripts/quick-stroke-verify.mjs, ARCHITECTURE.md, DEPLOY.md, KANBAN.md, state/kanban.json, state/questions.md). They were normalised to LF so the commit stays reviewable, and prod now matches the repo byte-for-byte.
- New running image: sha256:85725801931d2f612e88dceaec1879475d6c1623db58ab9eabb2dbddf8da0c32 (checkpoint-runtime target — the stack runs with `-f docker-compose.yml -f docker-compose.checkpoints.yml`, so the override MUST be passed on every compose command).
- Previous image / rollback tag: happypaint-app:pre-us-spellings-20261001T115635Z -> sha256:f2dba41d14d095d5d4ec3fbb9cde49b9572f48b12686ac1380841effb8e07d0b (older rollback tags untouched, verified after tagging).
- Container server.js SHA-256: 60e07b6e984c3fbff901e01645dceeed73d2de43011c4679d2499c2d7a9b54d0
- Public entry: /assets/index-DKI0lVSa.js (was index-CMO_v1Yk.js); App chunk App-DvIGA7Bd.js
- Data backup: backups/pre-us-spellings-20261001T115635Z.tar, SHA-256 1cd385dfc25261e156c3bdbc494efcc7… (app_data, 62M; code-only release, no schema change). Library data backup: backups/index.json.pre-us-spellings-20261001T115635Z (sha256 e2bfef1db0ba…).

## Shipped
- Every user-visible UK spelling in the app is now US: "colour" -> "color" (plus colours/coloured/colouring/colourful/colourway/watercolour/discolour/recolour), grey -> gray, centre -> center, neighbour -> neighbor, behaviour -> behavior, honour -> honor, favour/favourite -> favor/favorite, licence -> license, defence -> defense, offence -> offense, maths -> math, litre -> liter, metre -> meter, theatre -> theater, jewellery -> jewelry, armour-family forms, whilst -> while, amongst -> among, labelled -> labeled, travelled -> traveled, modelling -> modeled, signalling -> signaling, ana+logue -> catalog/analog, and the -ise verbs (organise/recognise/realise/specialise/customise/prioritise/minimise/maximise/optimise/summarise/utilise/normalise/serialise/initialise/visualise/sanitise/capitalise/categorise/memorise/socialise/harmonise/emphasise/apologise/analyse/practise).
- Covered: UI copy, aria-labels, titles, toasts, tooltips, SEO titles + descriptions + OG cards, help/legal copy, code comments, docs, and the verify scripts whose assertions quote that copy (changed in the same commit so they stay in sync).
- The 6,294 coloring-sheet descriptions in coloring-library/index.json ("about 64 areas to colour") said it 7,881 times. The file is gitignored volume data, so it was rewritten in place on the deploy host and its generator scripts/enrich-index.py was updated so a regeneration stays US.
- Deliberately NOT changed: "cancelled" (endWipeRequest WS reason, the client's token.cancelled stop flag, the mobile app's persisted status enum — a machine value, and both spellings are valid US English); identifiers/camelCase (sheetColour, probeCentreRgba); the aria-labelledby attribute; and words that only look British (optimistic, realistic/realism, sombrero, fulfil/fulfilled, analysis/analyst, honorary).

## Verification
- `node --check server.js` OK; `npm run lint` 0 warnings; `npm run build` green; `node --test` units + integration suites pass. The full-suite run shows 2 timing-sensitive assertions failing in test/checkpoint-animation.integration.mjs ("no rebuild for a short tail", "no rebuild from an unrelated frame layer change") — it passes 10/10 in isolation both on the pre-change tree and on the post-change tree, and it touches no changed string, so the failures are load-induced (that run overlapped a docker build), not a regression.
- Staged diff proven to be substitutions only, line-pair by line-pair: 470 changed lines, 0 non-substitution hunks.
- Image inspected before the swap: entry asset index-DKI0lVSa.js equals the one a fresh host `npm run build` produces; 0 UK spellings anywhere in dist/; "Lines on top (color under)", "no color needed", "Recent colors", "Pick a color", "areas to color" all present; /usr/bin/chromium-browser present (checkpoints target).
- Swap: docker compose -f docker-compose.yml -f docker-compose.checkpoints.yml up -d --no-deps --no-build --wait app -> Recreated, Healthy. Running image == 85725801….
- Blast radius: pocketbase (62bf14b3…, started 2026-09-25T23:54:33Z) and cloudflared (80fcb2da…, started 2026-09-25T23:55:29Z) unchanged — ids and StartedAt identical before and after.
- Live: https://drawesome.art/healthz 200 (localhost also 200); public entry asset 200 text/javascript 171,555 bytes and equal to the image copy; the served App chunk (426,244 bytes) carries the new US copy and zero UK strings; /api/coloring-sheets serves 6,294 sheets with "areas to color" x6,294 and "areas to colour" x0; /api/paintjar 200; /api/sheets contract unchanged ({"sheets":[]}, no user sheets); admin radar 200 with the key / 401 without (read-only probes).
- Must-not-regress: served index.html identical to the previous image's apart from asset hashes, so the Google Analytics tag (G-9TG5C3N1YP) is intact; STRIPE_CHECKOUT_ENABLED=false in the running container and /api/billing/config reports configured:false with plans off (display prices only); ENABLE_TRUSTED_CHECKPOINTS=1 unchanged.

## Remaining / follow-ups
- Nothing was pushed. To publish: `cd /home/craig/Projects/happypaint-release-20260929 && git push origin main`.
- "cancelled" remains UK-spelled by design (protocol value + persisted enum). Say the word if you want it renamed; it needs a client+server+realtime change in one release.
- coloring-library/index.json is not in git (gitignored volume data), so a future library rebuild must run the updated scripts/enrich-index.py to stay US.

## Rollback
```
docker image tag happypaint-app:pre-us-spellings-20261001T115635Z happypaint-app:latest
cd /home/craig/Projects/happypaint
docker compose -f docker-compose.yml -f docker-compose.checkpoints.yml up -d --no-deps --no-build --wait app
```
Do NOT restore the app_data tar as part of a code rollback.
