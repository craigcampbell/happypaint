# Remembered admin sessions and featured public-room art

## Status

Deployed and publicly verified on 2026-11-10. Application commit `9767b76`. See [the release record](admin-feature-release-2026-11-10.md) for verification, backup and rollback details. Committed locally; not pushed by this deployment.

## Why

Opening invisible room views in independent tabs repeatedly demanded the admin key and authenticator because transport sessions were stored per tab. The owner requested seven-day device recognition with a fresh authenticator code every four hours, and editorial selection of pictures from public rooms for the gallery.

## Admin sign-in

- Successful key + second-factor login remembers this browser for seven days.
- A separate fixed four-hour authorization permits same-origin session resume across admin pages and independent watch tabs. Opening another tab does not extend the deadline.
- After four hours, the remembered device needs a new authenticator code, not the key. After seven days, both are required again.
- Opaque HttpOnly, SameSite=Strict cookies hold device recognition and authorization, never the raw admin key. Production cookies are Secure.
- Admin APIs and moderator WebSockets still require explicit short-lived transport tokens. The remembered-device cookie alone is insufficient.
- Logout revokes shared authorization; Forget this device removes recognition. Failed logout blocks silent auto-resume and offers an explicit Retry sign out action.
- Key/enrollment rotation invalidates remembered devices and sessions. Disk errors fail closed without crashing anonymous drawing. Resume is bounded, and expiry is server enforced.
- Old twelve-hour sessions intentionally do not migrate. The first sign-in after rollout will require both factors. `ADMIN_SESSION_HOURS` no longer overrides the fixed policy.
- Remembering is browser/profile-specific, not shared across devices. Clearing cookies removes it.

## Featuring artwork

1. Open a room through the authenticated invisible watch view.
2. In **Feature a public-room picture**, inspect the separate public preview.
3. Choose **Preview current picture** to freeze the image.
4. Optionally add a title, confirm it is appropriate to highlight, then select **Feature this picture**.
5. The exact selected picture appears in **Featured from public rooms** on `/gallery`.
6. Remove selections from the watch view or Curator's featured-picture manager.

The selection is a frozen raster, not a live room feed. Continuing to draw does not alter it. This version selects the full rendered picture; it is not a crop editor or an animation publication tool. Captions identify collective room work and selection date, rather than inventing individual artist attribution. Featuring does not manufacture a Wall post.

Only listed public rooms and explicitly published artist studios qualify. Private/friends rooms, unpublished studios, and all sketchbooks are excluded. Capture uses public spectator access, never the moderator's ability to see private work.

Permissions and persisted source generations are rechecked at publication and on every public list/image request. Moderation or withdrawal invalidates prior selections; restoring a room must not resurrect them. Account deletion removes affected stored rows/rasters, preserving unrelated selections. Already downloaded bytes cannot be recalled.

Storage is under `DATA_DIR/.featured-rooms`, with bounded raster normalization and atomic metadata. Do not expose the directory through a static mount. Limits: 24 selections, 3 MiB input per raster, 2 MiB normalized output, 24 MiB total.

## Verification

Parent reran on the integrated tree:

- `npm run lint`
- `npm run build`
- `node --check server.js`
- Auth, room-code, feature and erasure unit suites: 22 tests passed.
- `node scripts/admin-remembered-verify.mjs`: 49 real HTTP/browser checks passed, including independent tabs, logout failure, stale-tab logout, restart, rotation write failure and live watch revocation.
- `node scripts/featured-rooms-real-verify.mjs`: real server plus scratch-built browser flow passed, including actual replay pixels, preview/confirmation, gallery rendering, Curator removal, source withdrawal and account erasure.
- `node scripts/discovery-seo-verify.mjs`: 122 checks passed.
- `git diff --check` passed.

Final logs are under `/home/craig/.hermes/cache/scratch/admin-feature-final-{build,auth,gallery}.log`. All feature writes and auth credentials in verification were synthetic and isolated; no real account credentials were used.

## Release notes

Use the Git worktree as the completed integration source. An early feature worker mistakenly wrote initial feature files and the DiscoveryPage insertion to the non-Git deployment source `/home/craig/Projects/happypaint`; those were copied and integrated in the worktree. The deployment source was reconciled with the final implementation and newer live privacy fixes before the 2026-11-10 app-only deployment.

Before release, retain a rollback image/data backup, deploy only the app, and verify public health, auth-mode policy, source/asset parity and unchanged sitemap. Do not use production publication or real authenticator codes as automated QA.
