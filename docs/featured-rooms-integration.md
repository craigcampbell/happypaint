# Featured public-room snapshots: integration contract

The module is now wired into the real `server.js`, authenticated `RoomWatch.jsx`, and Curator management area. No Wall posts, consent fields, historic renderer, or authentication semantics are changed. The original feature-worker contract and its fixture evidence are retained below; combined integration evidence follows at the end.

## Server placement

```js
import { createFeaturedRooms } from './server/featuredRooms.js';

// Instantiate after the authoritative room/privacy/moderation helpers exist.
const featuredRooms = createFeaturedRooms({
  dataDir: DATA_DIR,
  getRoomEligibility(code) {
    // AUTHORITATIVE ADAPTER REQUIRED: see exact contract below.
    return authoritativeFeaturedSource(code);
  },
});
// Before SPA/API catchalls. Use the EXISTING boolean session/2FA-aware guard.
featuredRooms.registerRoutes(app, adminGuard);
```

`getRoomEligibility(code)` must be **synchronous**, side-effect-free and authoritative. It must not call `getRoom` in a way that creates missing/deleted rooms. Prefer live `rooms.get(code)` and otherwise the existing persisted room loader, with an explicit existence check. Public-lobby membership alone is insufficient: that API omits dormant rooms, and its current generic kid-safe filter is not a sketchbook safety check.

Return `null` for absent/deleted/ineligible rooms, or an object with these **explicit** values:

```js
{
  exists: true,
  audience: 'kid_safe', // or 'artist_public' ONLY if explicitly published
  listed: true,
  hidden: false,
  sketchbook: false,   // ALL books excluded: saved/unsaved/public/private
  published: true,     // mandatory for artist_public, ignored for kid_safe
  version: 'stable-room-incarnation:permission-and-moderation-generation',
}
```

The module itself rejects every other audience, non-explicit public/listed flags, all sketchbook values except `false`, hidden sources and unpublished artist rooms. Resolve artist publication through its existing gallery publication/moderation helpers; do not confuse the ordinary-room `listed` field with artist gallery opt-in. Do not invent consent or turn a room public to feature it.

### Version is a safety boundary

`version` is a nonempty string of at most 512 code units. It identifies **both room incarnation and the permission/moderation generation** of the captured content. It must survive restart; change after room deletion/recreation and artwork hide/remove. Also change on publication/privacy withdrawal if a restored room must not resurrect older selections. Do not use an in-memory generation alone, generic disk mtime, lastActivity, or history length: those either reset after restart or change on ordinary drawing, defeating frozen features. A persisted room-specific epoch or a deterministic fingerprint of persisted incarnation/privacy/moderation evidence is appropriate. A constant room code is not.

An eligible source with a different version cannot expose an older selection. The module checks before decoding, after asynchronous `sharp` normalization, on **every public list read**, and **every raster read**. Adapter failures deny access. Existing browser-displayed bytes cannot be remotely recalled; the public component revalidates every 30 seconds and on tab return, clearing hidden-tab state, and public endpoints use `Cache-Control: no-store` (never mount `.featured-rooms` as static files).

Existing checkpoints are trusted replay acceleration, not an artwork publication/consent mechanism; this implementation deliberately does not reuse checkpoint storage or enable experimental client snapshots.

## UI placement

```jsx
import AdminFeaturedRooms from './AdminFeaturedRooms';

// In RoomWatch, alongside existing controls; key forces reset when switching.
<AdminFeaturedRooms key={roomCode} roomCode={roomCode} adminKey={adminKey} />

// Optional list/remove-only placement in Curator or admin gallery:
<AdminFeaturedRooms adminKey={adminKey} />
```

Use the current session token already supplied as `adminKey`, not the raw root key when 2FA is enrolled. Optional `onChanged()` runs after verified publish/remove. No new durable client stores or new auth flows.

The control obtains eligibility before opening a **normal public spectator** `LiveRoomCanvas` (never a privileged moderator capture of private work). After public history arrives, “Preview current picture” takes that rendered visible canvas's PNG, freezes it locally, requires an explicit confirmation and optional bounded title, then uploads that exact preview with its source version. The server rechecks eligibility and normalizes decoded raster bytes to bounded WebP. The admin reads back list membership before reporting success. Removing also reads back the collection.

`DiscoveryPage.jsx` already places the anonymous `FeaturedRooms` section before the community Wall, only on unsearched artwork gallery mode; it does not show on Events or Room shuffle. No new sockets on the ordinary public gallery, only stored rasters. Empty/unavailable selections consume no empty module space. Artwork is not rotated, recolored or decoratively cropped. Captions say collective work, room code and selected date, never a fabricated individual artist.

## HTTP contract

- `GET /api/featured-rooms` → `{items:[{id,roomCode,title,capturedAt,imageUrl}]}` (eligible only).
- `GET /api/featured-rooms/:id/image` → actual normalized WebP, or 404 on missing/withdrawn/version mismatch.
- Admin guard on **all** `/api/admin/featured-rooms` paths:
  - `GET /` → `{items:[{...publicItem,available}],limits}` (unavailable items remain removable).
  - `GET /source/:code` → `{roomCode,version}` or 403.
  - `POST /` JSON `{roomCode,title,image,version,confirmed:true}` → 201 `{item}`.
  - `DELETE /:id` → `{removed:id}` or 404.
- Writes require current admin session. Room codes preserved exactly, uppercase ASCII letters/digits/underscore/hyphen, 1–16 characters (the actual server WS constraint); title ≤80 code units; explicit confirmation; strict JSON fields.
- Only PNG/JPEG/WebP data URLs, decoded actual format must match; SVG, remote URLs, spoofed images, animations and >16MP decompression rejected.
- Caps: 24 selections; 3MiB input raster; 2MiB normalized image; 24MiB total. Output fits inside 1600×1200 without enlargement and strips metadata. Bounded admin JSON parser.
- Storage: `DATA_DIR/.featured-rooms/index.json` plus `<uuid>.webp`; atomic fsynced-file rename, metadata persisted before acknowledgment/memory update; removal updates metadata before deleting bytes. Interrupted-write orphans cleaned at startup. Invalid metadata disables writes rather than overwriting it. Public routes are no-store, including denials.

## Verification performed by feature worker

```
node --test test/featured-rooms.test.mjs
node scripts/featured-rooms-ui-verify.mjs
npx eslint server/featuredRooms.js src/components/FeaturedRooms.jsx src/components/AdminFeaturedRooms.jsx src/components/DiscoveryPage.jsx
```

Unit/HTTP tests mount the real module in Express with an **injected synthetic authoritative source adapter**, exercise authentication refusals, private/friends/unpublished/book exclusion, hide/privacy/delete withdrawal on list and raster, version recheck, invalid inputs, size/count caps, persistence/restart and removal. This is not proof of the combined real server adapter.

Browser suite reserves API **9241**, Vite **9242**, uses scratch-only DATA_DIR and an actual feature module plus **synthetic spectator stream**. Verifies capture → preview (not public) → confirmation → publish/readback → raster decode → remove/readback, zero public feature canvases, mobile/intermediate/desktop overflow. It does not build the shared tree or contact production. Parent must run combined server/RoomWatch, existing 2FA, privacy/moderation/account-deletion and built `/gallery` regression checks after wiring. Neither production nor `.env` nor real admin credentials were used.

## Combined real-server integration verification

`node scripts/featured-rooms-real-verify.mjs` uses API **9251** and Vite **9252**. It copies only explicit source files to scratch (no `.env`), builds the actual app into that scratch runtime, and exercises the built RoomWatch → preview → confirmation → publish → anonymous gallery → Curator removal flow. It measures real replay pixels, denies private capture, checks 375/768/1440 gallery overflow, and verifies no public feature sockets/canvases. The shared worktree `dist` is never rebuilt by this script.

Real-server scenarios also pin anonymous-unconfigured drawing, cold/dormant eligibility without absent-room creation, all book exclusions, legacy-epoch migration, actual room-code constraints, byte-identical frozen snapshots after ordinary strokes, restart persistence, moderation hide/remove/restore and artist hide/restore, room deletion/recreation, and owner publication withdrawal. Synthetic TOTP/recovery auth and an isolated mock PocketBase endpoint are used only under scratch data.

`featuredVersion` is persisted on the room; permission/moderation changes rotate it and synchronously erase associated selections before the debounced room save. Legacy dormant rooms with a persisted creation timestamp derive a stable initial epoch without materialization. Ordinary strokes do not rotate the epoch.

Publication stores private capture-time `sourceProfiles`, derived from ownership/ACL, analytics involvement, and new durable room `featuredContributors` (signed drawing authors, never sent on the wire). Account erasure removes corresponding metadata rows and physical rasters, including after restart, while preserving unrelated sources. Unknown-attribution legacy selections are erased conservatively. Contributor ids cascade from live and dormant room metadata on deletion. `scrubSources(predicate)` and `scrubProfile(profileId, relatedRooms)` are internal erasure hooks, not public routes. Neither provenance nor source versions appear in public/admin collection items.

Dedicated erasure tests: `node --test test/featured-rooms.test.mjs test/featured-source-erasure.test.mjs`. Parent still owns the final combined lint/build/auth review; this integration suite is not a production-deployment check. One pre-existing UI gap remains outside the feature-only mounts: `/watch` routing and RoomWatch's moderator code normalizer strip underscore/hyphen even though server WS and featured APIs accept them. Generated ordinary room codes and the verified `ARTQA` UI flow are unaffected; punctuation-containing legacy codes need a separate routing correction.
