# Inktober: draw before you sign up, and a heavy-ink share card

Deployed code: `7097ec1f2178cfceaaa6609af8a4d1ec004edc78` (revision label on the
running container matches). Pushed to origin/main, fast-forwarded from `1d5107e`.
Release spans 2026-10-02 local.

## What shipped

Draw an Inktober prompt with no account, from the moment of the tap:

- `/inktober`'s prompt CTA, the homepage Inktober hero card and `/sketchbook`
  all drop an anonymous visitor straight into the drawing studio, on a PUBLIC
  UNSAVED sketchbook page for that prompt (today's, or the day they picked).
  No sign-in wall anywhere on the drawing path.
- The studio shows the strip the owner asked for: "Sign up to save your
  sketchbook", "A free account keeps every page and lets you invite artists to
  draw with you. We don't send spam.", one button (plus a quiet Log in) that
  returns to the SAME page room after sign-up.
- Signing in on the same device saves the book automatically: the pages become
  an ordinary account-owned studio, every connected member is re-roled at once,
  the strip disappears and the reader shows owner controls. An account that
  already has a book keeps it, and the unsaved pages merge into it.
- The unsaved book is public from the first stroke and appears in the Inktober
  sketchbook strip, labelled "Not saved yet", as soon as it holds real drawing.
- Only the device that started a book may draw on it. Everyone else watches,
  chats and reacts, and gets an honest read-only note plus a one-tap
  start-your-own rather than a dead canvas.
- The Inktober share card is now a heavy-ink illustration in the genre the owner
  asked for (brushed frame with dry scratchy passes and broken contours,
  cross-hatched corner wedges, spatter clusters and trails, splash crowns,
  pooling blobs, drips with end beads, a hand-inked #inktober tag over cream
  paper with fibre noise), seeded from the prompt so it renders identically
  every time, ~125-290ms to draw, classic theme untouched.
- Every em dash in the repo's copy is gone (3,644 of them across 292 files):
  commas, colons or plain hyphens, with en dashes kept in ranges (1-31) and the
  JSON that is DATA (the official prompt list, world geography, golden replay
  ops, audit dumps) deliberately untouched.

## Source and verification

Work happened in the isolated worktree
`/home/craig/Projects/happypaint-guest-sketchbook` (branch
`feature/guest-sketchbook-ink`, from `1d5107e`); changed paths were copied into
the production tree `/home/craig/Projects/happypaint` per file, and the copy was
compared back (no mismatches).

Suites run on the frozen commit, all green:

- `scripts/sketchbook-server-verify.mjs` 180/180
- `scripts/sketchbook-guest-verify.mjs` 199/199 (new; real HTTP+WS, mock
  PocketBase, scratch DATA_DIR, ports 9006/9007/9008)
- `scripts/artist-rooms-server-verify.mjs` 110/110
- `scripts/sketchbook-ui-verify.mjs` 82/82 (Playwright; includes the guest entry
  paths, the save prompt, and signing in on the same device saving the book end
  to end)
- `scripts/inktober-share-verify.mjs` 56/56 (the new card renders, exports and
  shares)
- `npm run lint` zero warnings, `npm run build` clean.

Two real defects were found by the new suite and fixed before release:

- A LIVE page moved by a merge kept pointing at the deleted unsaved book, so
  every join failed closed as `book_private`. The live flip now rewrites the
  page's back-reference to the target book.
- The empty-book sweep only ran on a hardcoded hourly interval, so a server that
  restarts on every deploy could miss it and no test could observe it. It now
  also runs at boot, with `SKETCHBOOK_GUEST_SWEEP_MS` as the period override.

## Live verification

- Container `happypaint-app-1` healthy on image
  `sha256:0e2e7317970acf1a3aae45e65235733ea971169d8750af325efdde23b1b7521a`,
  revision label `7097ec1`. Local and public `/healthz` both 200. PocketBase and
  cloudflared were not restarted (both up 6 days).
- `server.js` inside the container is byte-identical to the tree
  (`dd2ec1eb12f99ec9c664b3406555abaf2160f73017d3a0fdf74cd8e489082b14`), and the
  entry bundle served at `https://drawesome.art/assets/index-BFnnazkb.js` is
  byte-identical to the one in the image
  (`035a0215ed420ef6b8a49056c541567cf48499da8f8c55596ac08985b15c1e6c`).
- Live phone-width acceptance (390x844): tapping the prompt on `/inktober` opens
  the studio on `/join/<code>`, the save strip reads correctly, the page pins
  today's prompt (`#inktober 2026, Day 2, "Relic"`), this device may draw, the
  one-time save token is stored, and no page errors: 7/7.
- Live watcher check on that page from a different device: no horizontal
  overflow (0px), no save strip (not the owner device), the read-only note and
  the "Not saved yet" badge render: correct.
- Screenshots: `live-inktober-390px.png`, `live-guest-page-390px.png`,
  `live-watcher-390px.png` in `/home/craig/.hermes/cache/scratch/`.

Production write made by verification (disclosed): the live acceptance created
ONE empty unsaved book, `sb_82c2bfa29c02e2c2` (room `AJFRRQ`), with no drawing.
It is not gallery-visible (a book needs real drawing to list) and the sweep
reaps it 14 days after creation.

## Rollback

`happypaint-app:pre-guest-sketchbook-20261002T152008Z` is the pre-release image
(`sha256:99ca2acd5561af5c59bca5f05f06d933b210a0d0b7246cd8054adc897da70bcb`).
From `/home/craig/Projects/happypaint`:

```
docker image tag happypaint-app:pre-guest-sketchbook-20261002T152008Z happypaint-app:latest
docker compose -p happypaint -f docker-compose.yml -f docker-compose.checkpoints.yml up -d --no-deps --no-build --wait --wait-timeout 90 app
```

Warning: the old code knows nothing about unsaved guest books. Rolling back
while unsaved books exist leaves their page rooms as ordinary public rooms
(drawable by anyone who has the code). Their records, and any already-SAVED
guest book, would also be invisible to the old code. Prefer a forward fix.

## Known limits

- An unsaved book is bound to the browser that started it (the same per-browser
  device key the socket already sends). Clearing site data, or opening the site
  in another browser, means that visitor cannot save or reopen that book; the
  art stays public and unsaved.
- Unsaved books that hold artwork are never reaped, by design: artwork is never
  destroyed. Only empty ones expire, 14 days after they were started.
- The share sheet's CSS was checked for syntax and scoping, but only the canvas
  card was rendered visually; native Instagram/TikTok/Messages ingestion and
  physical stylus feel still need device checks.
- A watcher on someone else's unsaved page cannot draw on it (by design); the
  copy points them at starting their own.
