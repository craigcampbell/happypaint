# Artist Profiles — Engineering Spec

**Status:** draft for review · **Audience:** kids and teens (kid-safety-first, always)
**Scope:** opt-in public profiles with avatar, gallery, favorites, brush/color stats, and clickable chat identities.
**Stack touched:** PocketBase (new collection), Node ws server (`server.js`), React client (router page + chat wire).

Everything here defaults to **private**. A profile does not exist publicly until its owner passes an age gate and explicitly flips it visible. No feature below may add work to the canvas hot path (see MEMORY: drawing performance is paramount).

---

## 1. Data model

### New PB collection: `profiles`

One row per user who opens their profile settings (lazily created, not at signup).

| Field | Type | Notes |
|---|---|---|
| `owner` | relation → `users`, **cascade delete**, unique | one profile per account |
| `slug` | text, unique, indexed | short public handle; generated, never the email local-part |
| `display_name` | text, required | chosen by user; filtered (§2) |
| `avatar` | text (preset id) now; file field later | preset picker first — see below |
| `bio` | text ≤ 280 | filtered (§2) |
| `fav_movies`, `fav_comics`, `fav_books` | text ≤ 120 each | filtered (§2) |
| `visible` | bool, **default `false`** | the single public/private switch |
| `show_activity` | bool, default `false` | opt-in "seen on other boards" |
| `tier` | text | premium tier; drives `MAX_SAVES` (§5) and theming extras |

**API rules:** list/view filtered to `visible = true`; create/update/delete restricted to `owner = @request.auth.id`. Stats and moderation fields writable only by admin/server token.

### Why NOT open up the `users` collection

- PocketBase has **no field-level read rules**: exposing `users` rows for `/artist/:id` exposes `email`. That is a hard no on a kid site.
- The client only relies on three `users` fields today (`id`, `email`, `name`) — recon confirmed no avatar/age/bio/visibility fields exist anywhere. A separate collection keeps the auth record boring and the public surface auditable.
- Cascade delete on the `owner` relation means account deletion tears down the public profile for free (artwork erasure still needs §2's fix — PB cascade does not reach the Node server's files).

### Avatar strategy

- **Phase 1: curated preset picker** (~30 in-house drawn avatars). Zero moderation cost, zero image-PII risk, zero COPPA exposure. Stored as a preset id string.
- **Phase 2 (last item in build order):** PB file-field upload, offered **only** to age-verified 13+ accounts, every upload landing in a **moderation queue** reusing the existing reports/admin plumbing (`server.js:1417+`). Auto-scan with the nsfwjs pipeline we already ship, human-approve before it ever renders publicly.

---

## 2. Safety gating — non-negotiable

1. **`visible` defaults to `false`.** A freshly created profile is invisible to everyone but its owner. There is no "public by default" path anywhere in the code.
2. **Age gate at first flip-to-visible, never at signup.** Signup friction stays zero. The moment a user first toggles `visible` on, we collect birth year; under-13 requires a 13+ attestation path replaced by a **guardian email** consent flow (COPPA: no public display of a child's persistent identifier, avatar, or free-text favorites without verifiable parental consent). Until the flow completes, the toggle stays off.
3. **All free-text fields run through the existing chat text filter** (`display_name`, `bio`, `fav_*`) at write time, server-side. These fields are PII-entry vectors — kids type school names and social handles into anything. Same blocklist, same normalization as chat; reject on match, don't silently strip.
4. **Forced display-name pick — kill the email local-part fallbacks.** Three sites currently derive a name from the email, which would leak partial emails onto public profiles:
   - `src/utils/auth.js:169` — signup default (`id.split("@")[0]`)
   - `server/pocketbaseAuth.js:35` — ws relay fallback (`rec.email.split('@')[0]`)
   - `src/App.jsx:5809` — gallery header (`session.user.email.split("@")[0]`)
   Profiles work replaces all three with a mandatory chosen-name step (filtered per item 3). No profile can go visible while its display name is an email derivative.
5. **COPPA erasure fix — REQUIRED BEFORE LAUNCH.** Account deletion today scrubs chat logs and deletes the PB record with snapshot cascade (`accountDeletion.js:105-142`), but **never deletes `ARTWORK_DIR/pb_<profileId>.json`** — the Node server's saved-art store (`server.js:1303-1310`). This is a live gap right now; public galleries would surface a deleted child's art indefinitely. Fix: the deletion scrub endpoint also unlinks `ARTWORK_DIR/pb_<id>.json` (and, post-§5 migration, the per-artwork image files). Ship this before any profile UI, even private-only.
6. **Token hygiene (amplified risk):** the ws access token rides in the URL query string (`useMultiplayer.js:16-27`, task #40). Profiles raise the value of a stolen token (public identity + gallery + PB record). Task #40 moves onto the launch-blocking list.

---

## 3. Clickable chat profiles

Today the wire deliberately never carries `profileId` — chat/userList ops carry only per-session `userId` + display name + color (explicit privacy decision, comments at `server.js:535` and `174-176`). We keep that decision and add a **separate, opt-in public handle**:

- At ws connect, the server already resolves `{ profileId, displayName }` from the JWT. It additionally fetches (and caches on the connection) the user's profile `slug` **iff `visible = true`**.
- Chat and userList frames gain an **optional `profileSlug` field, present only when visible**. Anonymous users, signed-in-but-private users, and all existing clients are **wire-identical to today** — the field is simply absent, and unknown fields already fall through silently everywhere.
- Flipping `visible` off invalidates the cached slug on live connections (server pushes a userList refresh).
- Client: chat names and userList entries with a `profileSlug` render as links opening `/artist/:slug` **in a new tab** (never navigating the studio away mid-stroke). Names without a slug keep today's behavior (focusUser cursor-find only).
- `/artist/:slug` is a new page in the existing lightweight router (SignupPage-style `onNavigate` pages) — no router dependency added. It reads the `profiles` row (PB rules already enforce `visible = true`), the public gallery slice (§5), stats theming (§4), and — only if `show_activity` — a recent-boards strip.

---

## 4. Frequent-brush / frequent-color stats

**Server-side only. Zero client work, zero canvas cost.** The client-side alternative (extending `recentColors` / `lastPaintBrushRef`) sees one device and dies with localStorage — rejected.

- In the existing `'op'` relay handler (`server.js:925`), where `op.settings` already carries brush id and color for every draw op, increment an in-memory `Map<profileId, { brushCounts: Map, colorCounts: Map }>`. Only for connections that have a `profileId` (anonymous ops are never attributed). One map lookup + two increments per relayed op — negligible next to the JSON relay itself.
- **Periodic flush** (every few minutes, and on graceful shutdown) to a small per-profile JSON or a server-token-writable PB stats row. Never piggyback on the room persist path — `saveRoomNow` is already a heavy synchronous whole-room stringify (`server.js:216-232`) and must not gain passengers.
- Retention: keep top-N (N=8) per category with decayed counts; this is taste data, not surveillance — no per-room or timestamped breakdown is stored.
- **Gallery theming:** `/artist/:slug` derives its accent from the profile's top color (CSS custom property on the page root — the token-file work from the ui-css recon makes this trivial), and renders "brush badges" for the top 3 brushes using the catalog's existing `icon:` fields. Stats are public only when the profile is; the stats endpoint checks `visible` server-side.

---

## 5. Gallery consolidation

Two disjoint stores exist today: (1) the Node server's `ARTWORK_DIR` — one JSON file per owner key with up to `MAX_SAVES=12` items and **full base64 data-URL images inline** (`server.js:1303-1414`); (2) the PB `snapshots` collection mirroring local quick-saves. Adding public galleries on top of both would triple the erasure/moderation surface. Consolidate first:

- **Per-artwork `visible` flag** (default false, naturally). "Save to my gallery" from a board stays private; publishing an item to the public profile is a second, deliberate action, only available once the profile itself is visible.
- **Migrate images out of per-user JSON to real files on disk** (or PB file fields), served with cache headers; the JSON keeps only a small metadata index (id, title, created, visible, file ref). Kills the whole-file read/write-per-request pattern and the 16 MB body-cap pressure.
- **`MAX_SAVES` becomes per-user, read from `profiles.tier`** — today it's a single global env value (`server.js:1304`), which blocks premium caps.
- Public artwork ids run through the same moderation/report plumbing as rooms; a reported gallery item is hideable by admins without touching the owner's private copies.
- Erasure (§2 item 5) extends to the migrated files: deletion removes the metadata index **and** every image file it references.
- Fix the PB filter-string interpolation in `sync.js:149,201` (unescaped `client_id="${item.id}"`) before profile-scoped queries copy that pattern.

---

## 6. Build order

Each stage ships independently; safety prerequisites front-loaded.

1. **Foundations (launch-blocking safety):** COPPA erasure fix (`ARTWORK_DIR/pb_<id>.json` deleted on account deletion) · forced display-name pick + removal of the three email local-part fallbacks · `profiles` PB collection + private-only profile editor (presets avatar, filtered text fields) · task #40 (ws token out of URL).
2. **Visibility + page:** age gate / guardian-email flow on first flip-to-visible · `/artist/:slug` page · chat/userList `profileSlug` wiring + new-tab links.
3. **Gallery:** store consolidation + image-file migration · per-artwork visible flag · per-tier `MAX_SAVES` · gallery moderation hooks.
4. **Stats:** op-relay accumulation + periodic flush · public stats endpoint gated on `visible`.
5. **Theming:** accent-from-top-color + brush badges on the profile page.
6. **Avatar upload (last):** file field for age-verified 13+ accounts only, nsfwjs pre-scan + human moderation queue before public render.
