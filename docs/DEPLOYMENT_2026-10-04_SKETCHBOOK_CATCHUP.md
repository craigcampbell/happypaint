# Sketchbook catch-up days + tablet banner fix

Deployed on hp-dev-one, 2026-10-04 21:03 and 21:08 CDT (two app swaps, the
second only adds the 44px coarse-pointer chip rule). Source branch
`fix/sketchbook-catchup-and-fab` in `/home/craig/Projects/happypaint-release-20260929`,
on top of `840aa57`; changed files copied per file into the production tree
`/home/craig/Projects/happypaint` and `cmp`-verified.

## Reported

- On an iPad Pro 12.9 / Wacom Movink, the Home / Rooms / Invite buttons rendered
  on top of the sketchbook banner's prompt chip and Prev/Next buttons.
- No way to open a prior day's Inktober prompt after missing days.

## Causes

- `.studio-rooms-fab` is `position: fixed; top: 8px` on the coarse-pointer /
  <=1024px layout, where the room bar (`.mp-bar`) is hidden, so the in-flow
  `.skb-banner-wrap` became the first strip at y=0 and the FAB row (z 45)
  painted over it. `.room-prompt-chip` already had a `top: 56px` offset for the
  same reason; the sketchbook banner did not.
- Every prompt day was always valid server-side (`promptForDay` accepts 1..31
  from the official list), but the only UI that passed an explicit day was the
  owner-only "+ Add page" picker in the studio banner. Unsaved (guest) books,
  which every "Draw today's page" CTA creates, had no day control at all, and
  the gallery's "Draw this prompt" button only appeared after filtering the
  gallery by day. The "isn't open yet" error copy was also wrong.

## What changed

- `src/App.css`: `.mp-bar + .skb-banner-wrap { padding-top: 56px }` inside the
  coarse/<=1024px block, reserving the FAB strip above the first banner.
- `src/components/SketchbookRoomBanner.jsx`: "+ Add page" became "📅 Other
  days", shown to the account owner AND the device that owns an unsaved book.
  The panel lists all 31 days (today first in the select, chips in order),
  marks days with pages, opens an existing page without a server call, mints a
  missing one (owner: `POST /api/sketchbooks/:id/pages`; guest device:
  `POST /api/sketchbooks/guest` with `day`, which resumes the same book). The
  stranger CTA duplicated the studio's watch-only strip and was reduced to one
  note; `startGuestBook` was removed as unused.
- `src/components/InktoberPage.jsx` + `src/seasonal.css`: the active hero card
  gets a "Missed a day? Draw any prompt" strip of all 31 days (today marked).
- `src/components/SketchbookPage.jsx` + `src/sketchbook.css`: the owner's
  reader gets "📅 Catch up on a day…" with the same day chips; 44px chips on
  `(pointer: coarse)`.
- `scripts/sketchbook-catchup-verify.mjs` (new, 28 checks, ports 9031-9033):
  tablet FAB/banner non-overlap, guest catch-up into the same book with the
  prior day's stamped prompt/date, no duplicate page when re-picking a drawn
  day, /inktober strip starts the picked day, owner reader + studio catch-up,
  stranger sees no picker. `sketchbook-studio-verify.mjs` selectors updated
  for the renamed button.

Server untouched (`server.js` sha256 dd2ec1eb12f99ec9 before and after).

## Verified

- `npm run lint` 0 warnings, `npm run build` ok.
- sketchbook-catchup 28/28, sketchbook-studio 37/37, sketchbook-guest 199/199,
  sketchbook-ui 82/82, sketchbook-server 180/180, inktober-share 56/56,
  artist-studio 29/29. home-inktober 12/14 is pre-existing (identical on the
  stashed baseline: the suite expects an older CTA string).
- Image `happypaint-app:latest` = `e7a8dcb98ac9` (first swap `0876cb35f6b5`),
  built with `-f docker-compose.yml -f docker-compose.checkpoints.yml`;
  Chromium present, `[checkpoints] trusted checkpoints enabled`, 31 prompts
  readable inside the image. Running container image equals the built ID.
- pocketbase (`62bf14b3…`, started 2026-09-25) and cloudflared (`6bdda9c9…`,
  started 2026-10-04T05:01Z) IDs/StartedAt unchanged.
- `/healthz` 200 locally and publicly; `/api/inktober` active day 5, 31 prompts.
- Live at 1024x1366 (touch emulation): FAB row 8..52px, prompt chip from 72px,
  no overlap. Live guest flow: /inktober Day 1 chip -> `/join/AM379J` pinned
  "Day 1 Apple"; Other days -> Day 3 -> `/join/2YNAGM` "Page 2 of 2".

## Side effects to know about

- QA left three EMPTY unsaved guest books on production (pages DFNXWQ,
  AM379J, 2YNAGM; 0 ops). They never list in the gallery (needs ops > 0) and
  the 14-day empty-book sweep removes them.
- During verification the Cloudflare tunnel dropped all four edge connections
  at 02:10:46Z and re-registered at 02:11:10Z (24s of 502s; cloudflared logs
  `connection with edge closed`). Unrelated to the swap (the app container was
  healthy and answered locally); still the http2 protocol from the 10-04 note.

## Rollback

```
cd /home/craig/Projects/happypaint
docker image tag happypaint-app:pre-sketchbook-catchup-20261005T020259Z happypaint-app:latest
docker compose -p happypaint -f docker-compose.yml -f docker-compose.checkpoints.yml up -d --no-deps --no-build --wait --wait-timeout 90 app
```

Data backup (not part of a code rollback): `backups/pre-sketchbook-catchup-20261005T020259Z.tar.gz`.
