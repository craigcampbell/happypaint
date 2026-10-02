# Inktober artist sketchbooks — implementation contract

Status: implemented against this document. Extends (never replaces)
docs/ARTIST-ROOMS-CONTRACT.md — every page of a sketchbook IS an ordinary
`artist_public` room and inherits its full ACL, watch, moderation and
persistence model.

## Product
- A sketchbook (BOOK) groups up to 31 daily-prompt pages for one event
  (`inktober-2026`). One book per owner account per event; creating again
  RESUMES the same book idempotently (resume NEVER changes visibility).
- Every page is a DISTINCT artist room (server-minted code), so the frozen
  brush/frame replay, spectate and persistence stacks are reused untouched.
  Art on one page never appears on another.
- Visibility is EXPLICIT at create (`public: boolean`, default `false` =
  PRIVATE, the safe end) and owner-changeable anytime via
  `POST /api/sketchbooks/:id/visibility`.
  - PUBLIC book: viewable by anyone with the link (reader, by-room banner,
    spectator + member joins); gallery-eligible once a page has real drawing.
  - PRIVATE book: the owner + invited book artists ONLY. Reader, by-room,
    spectator and member joins all refuse everyone else (indistinguishable
    404s / `room_blocked book_private`), the book never appears in the public
    gallery, and its pages cannot be wall-posted or event-attributed by
    quoting the room code (`403 book_private`). Private means non-invited
    accounts cannot VIEW at all — not merely unlisted.
  - Drawing is always the owner plus at most 5 invitees — 6 distinct
    ACCOUNTS across the whole book, counted by verified account id, never
    sockets (unchanged by visibility).
- Page rooms carry the official prompt list's day/prompt/date, chosen from
  the server's verified list (invalid days rejected), stamped SERVER-SIDE at
  page creation and IMMUTABLE across the UTC-midnight rollover. Omitting the
  day during the active event picks today server-side.
- Page rooms are Inktober-opted (`inktober: true`): ink & pencil enforcement
  applies during the active event, and the server event state rides the
  existing WS handshake — the page's own pinned prompt never rotates.
- Page rooms are canvas-only by design: chat + tapbacks are rejected
  server-side (`chat_blocked reason:'book_page'`), and animation can never be
  enabled (they are `artist_public`, which `set_animation` and every
  frame/scene mutation already refuse) — ordinary painting layers are
  unaffected. Page rooms are never listed in the artist room gallery
  (`listed: false`) and the direct room publish/unpublish endpoints refuse
  them (`409 book_managed`); discovery is the BOOK's alone.
- Guests browse freely everywhere PUBLIC; the anonymous shared INKTOBER room
  is unchanged. Durable ownership (creating a book, accepting an invite)
  needs a real PocketBase account with a sign-in-return path; identities are
  never faked (`accounts_required` fail-closed, same as artist studios).

## Data
- `DATA_DIR/.sketchbooks/<id>.json` — one normalized file per book:
  `{ id: 'sb_<16hex>', event, ownerProfileId, title?, public, moderationHidden,
    artists: [owner, ...invitees] (<=6 opaque account ids), pages: [{ room,
    day, prompt, date, createdAt }] (<=31, unique days, sorted),
    invites: [{ id, hash, createdAt, revokedAt, uses }], createdAt }`.
- Page rooms persist `sketchbook: { book, day, prompt, date }` in the
  ordinary room meta file (loaded/saved/dormant-meta everywhere the artist
  fields are), so a restart never loses the back-reference.
- Invite tokens are `sbk_<base64url>` shown to the inviter ONCE; only the
  SHA-256 hash persists. Tokens never appear in any list or public response.

## REST
- `POST /api/sketchbooks` `{ event?, public?: boolean, title? }` → create or
  resume (verified account; 401 `accounts_required` when unconfigured/guest).
  `public` defaults to `false` (PRIVATE) when omitted; an existing book
  resumes UNCHANGED (resume never alters visibility). The response's book
  view always carries the `public` boolean. Resume check → mint →
  index-write is synchronous: racing requests mint one book.
- `POST /api/sketchbooks/:id/visibility` `{ public: boolean }` (owner) →
  `{ ok, book }` (owner view, `Cache-Control: no-store`). Persists the flag.
  A public→private DOWNGRADE immediately sweeps every page room: anonymous
  spectators and non-team members on EVERY page get
  `room_blocked reason:'book_private'` and are disconnected; the book's
  owner + artists keep their sessions. 400 `bad_visibility` for non-boolean.
- `GET /api/sketchbooks?event=&offset=&limit=` → `{ books, total }`.
  Eligible: PUBLIC, not moderation-hidden, at least one visible page
  with real drawing (ops > 0). limit <= 60, honest total — load-more walks
  the whole set, no silent cap. Cards carry no account material. One
  dormant-room meta scan per request, shared across all books.
- `GET /api/sketchbooks/mine?event=` (auth) → owner view or 404.
- `GET /api/sketchbooks/:id` → PUBLIC book: public book view (pages with
  room codes, day/prompt/date, ops, watching; moderation-hidden pages
  omitted for strangers, owner sees them flagged; no account ids, no invite
  material). PRIVATE book: 404 for everyone but the owner + book artists.
  Moderation-hidden book: 404 for everyone but the owner. The owner
  (verified session) additionally gets `artists` (opaque ids) and redacted
  `invites` (never tokens/hashes).
- `POST /api/sketchbooks/:id/pages` `{ day? }` (owner) → server-stamped page
  or idempotent resume of an existing day; 400 `bad_day` for days outside
  the official list; 400 `book_full` past 31. Synchronous mint: racing adds
  cannot duplicate a day.
- `GET /api/sketchbooks/by-room/:code` → banner data for a page room
  (book id, pinned day/prompt/date, `public` boolean, prev/next rooms,
  caller's isOwner/isArtist/canDraw) or 404 `not_a_page`. PRIVATE book:
  owner + artists only; moderation-hidden book: owner only (same 404).
- `POST /api/sketchbooks/:id/invites` (owner) → `{ inviteId, token, url }`
  ONCE. Bounded active invites.
- `POST /api/sketchbooks/:id/invites/:inviteId/revoke` (owner) → future
  redemptions fail; existing artists keep access.
- `POST /api/sketchbooks/accept` `{ token }` (verified account) → resolves
  the AUTHENTICATED account (never a client-asserted identity), enforces
  the 6-account cap (`403 book_full`), is idempotent for existing artists,
  and applies the grant to every page room (live role flip on every
  connected tab + persisted offline files). Redemption is synchronous.
- `POST /api/sketchbooks/:id/artists/revoke` `{ profileId }` (owner) →
  removes the artist from the WHOLE book: every page room's ACL, every live
  tab notified (`role_changed` + `paint_requested revoked`), offline page
  files rewritten, future joins find no grant. The owner can't be removed.
- The direct room endpoints can NOT desynchronize a page from its book:
  - `POST /api/rooms/:code/publish` and `/unpublish` on a page room →
    `409 book_managed` (listing + the Inktober flag belong to the book).
  - `POST /api/rooms/:code/painters/revoke` on a page room ROUTES through
    the whole book (the only honest semantics — a room-local edit would be
    re-granted by the next book ACL sync): removes the artist from every
    page at once; `400 cannot_revoke_owner`; `409 book_missing` when the
    book record is gone (ACL left untouched, fail closed).
- `POST /api/admin/sketchbooks/:id/hide|restore` (admin) → a DISTINCT
  `moderationHidden` flag the owner cannot override; hidden books leave the
  gallery immediately, their reader/by-room 404 for non-owners, and their
  pages refuse spectators + non-team member joins
  (`room_blocked reason:'moderation_hidden'`). Pages stay covered by the
  existing room-level report (WS `flag`) and admin pathways
  (`/api/admin/rooms/:code/unpublish` hides a page from its book's public
  view and, when it was the last drawn page, from the gallery).
- `POST /api/admin/rooms/:id/delete` on a page room first drops the book's
  page reference (no dangling, code-reserving page), then deletes the room.
- `POST /api/wall` quoting a PRIVATE book's page room → `403 book_private`;
  public books' pages post and attribute normally.

## WS
- Page rooms reuse the artist_public guards untouched: viewers are limited
  to the read/social allowlist, painters keep the ordinary draw guards,
  room management stays host-only, spectators watch read-only.
- Book access is enforced BEFORE any room handshake, spectator
  materialization or read: PRIVATE or moderation-hidden books refuse
  spectators outright (anonymous — `room_blocked book_private` /
  `moderation_hidden`) and refuse member joins from everyone but the book's
  owner + artists. Public books watch freely.
- `chat` on a page room → `chat_blocked reason:'book_page'` (nothing
  buffered/relayed); `chat_react` is a no-op. `set_animation` and every
  frame/scene mutation stay refused (artist_public rooms can never enable
  the film strip); ordinary painting layers are unaffected.
- `paint_request` is unchanged. `paint_approve`/`paint_revoke` on a page
  room route through the BOOK: approve enforces the 6-account cap
  (`paint_requested status:'book_full'` to the owner, no grant) and lands on
  every page at once; revoke strips every page at once. No direct-room
  bypass of the invitation model or the cap exists. When the book record is
  MISSING, both fail CLOSED — approve answers
  `paint_requested status:'book_missing'` with no grant, revoke leaves the
  persisted grant untouched; neither falls back to a direct-room ACL edit.

## Lifecycle
- Books and their page ACLs survive restarts (verify suite boot 2).
- Page rooms NEVER idle-expire while a book references them (`allowedIdleMs`
  is unbounded for sketchbook-referenced rooms, live and on-disk) — the only
  removal path is admin delete, which drops the page reference first.
- Page room codes are RESERVED while referenced: `genRoomCode` never re-mints
  one, and if a referenced page's room file is missing, `getRoom`
  REMATERIALIZES the page with its book-stamped shape (owner, painter ACL,
  inktober, immutable prompt metadata) instead of letting the code load as a
  generic, ownable room (no squatting / generic-room takeover).
- Account deletion: a deleted owner's books leave discovery
  (`public: false`, art kept — the same "unpublish, never delete" stance as
  artist studios) and the account is cut from every other book's artist
  list, applied across all page rooms.

## Frontend
- `/sketchbook` — entry route: create/resume with sign-in recovery (the page
  proceeds automatically when a session appears; guests get an honest
  account card with the anonymous shared room one tap away).
- `/sketchbook/:id` — public reader: pinned `#inktober 2026` prompt chip in
  the top corner, prev/next flipping + day strip, ONLY the selected page's
  heavy canvas loads, start-your-own CTA for visitors.
- `/sketchbook/invite/:token` — acceptance under the real session.
- `SketchbookRoomBanner` (src/components/SketchbookRoomBanner.jsx) — mounted
  by the studio shell per room; renders nothing for non-page rooms. Props:
  `roomCode`, `session`, `onNavigate`. Shows the pinned prompt chip,
  prev/next flip, view-book, owner-only add-page + invitation management,
  and the viewer start-own CTA.
- Homepage: the Inktober hero card's draw CTA opens the visitor's OWN
  sketchbook; the shared public INKTOBER room remains one quiet link away;
  a "New Inktober sketchbooks" strip surfaces the gallery.
- InktoberPage: prominent own-sketchbook CTA (shared room kept as
  secondary), the sketchbook section with load-more pagination.
- PublicWatch (`/live/:code`) links a page room back to its book.

## Verification
`node scripts/sketchbook-server-verify.mjs` — 174 checks, strictly isolated
(scratch DATA_DIR, mock PocketBase, ports 9003/9004/9005): fail-closed
creation, private-by-default visibility + resume-never-changes + the
owner-only visibility endpoint (validation, persistence, downgrade session
sweep across every page), idempotent resume under races, page
validation/cap/races, direct room endpoint guards (`book_managed`,
book-routed painters/revoke), guest/stranger/owner roles, distinct page
canvases, ink enforcement, canvas-only pages (chat/chat_react/animation
rejected; ordinary rooms unaffected), token hygiene (hash-only on disk,
never in responses), acceptance, 6-cap under REST AND direct-WS bypass
attempts, revoke across every tab/page + restart, rollover immutability,
gallery eligibility/pagination/moderation, hidden-book consistency
(reader/by-room/spectate/join), private-book consistency (404s,
pre-materialization spectator refusal, no gallery/wall exposure), public
flip + downgrade tab closure, public-view privacy, restart persistence,
idle-sweep protection (page rooms survive, plain studios reap), missing
page-file rematerialization (no squatting), missing-book fail-closed WS
approve/revoke, and safe admin page-room deletion.
