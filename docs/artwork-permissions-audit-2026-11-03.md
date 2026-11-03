# Artwork permissions audit — 2026-11-03

## Scope and baseline

Requested after an unrelated visitor saw owner withdrawal controls at
`/wall/wp_mvtkg0zmz28kxo`. Audited frozen Wall originals, private saved drawings,
artist studios, account/guest sketchbooks, inherited room mutations, revocation,
retained media, and browser account transitions.

Baseline: `2263943237017e1f05bc09e9b749c012bc3dfcfb`; running backend matched
SHA-256 `4cb711b7867e822469bdd7586b3d40f2babb0ef7d3a4f7cdf981ec647edacb56`.
Implementation is isolated in branch `fix/artwork-permissions-20261029`.
Unrelated remembered-admin/featured-room work in other source trees is excluded.
No real artwork was withdrawn, deleted, reported or edited as verification.

## Confirmed issues and fixes

1. **Misleading universal owner controls.** The public receipt previously
   rendered “Manage your drawing” and “Unpublish my drawing” to every visitor.
   Existing mutation endpoints did reject strangers; the button was not proof
   of a direct owner-check bypass. `POST /api/wall/:id/permissions` now returns
   server-computed booleans only, with no-store. Controls fail closed while
   pending, on errors and on account changes. Same-device anonymous ownership
   remains usable after later sign-in; a public post ID or account ID is not
   an ownership credential.
2. **Report-triggered takedown.** Distinct anonymous IP reports could durably
   suppress frozen Wall artwork. Reports now enter moderation review without
   changing publication. Deduplication and moderator removal/restore remain.
3. **Forged classifier moderation of protected canvases.** A viewer could submit
   a human report and corroborate it with their own flag, hiding someone else's
   strokes. Artist studios and all sketchbook pages now retain review evidence
   without automatic stroke hiding or author muting from untrusted claims.
   Authorized owner/host/moderator controls remain separate. Ordinary shared
   murals intentionally retain their pre-existing collective moderation policy.
4. **Stranger-triggered permanent capacity eviction.** Publishing into a full
   Wall could delete an older artist's metadata and frame files. Capacity now
   rejects the new submission with `409 wall_full`; it never chooses another
   artist's original as the victim. Explicit owner/admin deletion and scheduled
   seasonal-event retention are separate policies and are unchanged.
5. **Private-stream revocation gaps.** Revoked book artists retained open
   connections to future private content. The centralized book ACL update now
   closes every unauthorized session across every page, including book REST,
   inherited room REST and WebSocket revocation. Public-book former painters
   may remain public viewers. Account-deletion privacy transitions use the same
   sweep, including spectators.
6. **Damaged metadata could release reserved page identity.** A corrupt page
   file could retain private history but lose ownership/back-reference and
   become an ownable ordinary room. Book page reservations now reconstruct
   authoritative identity/ACLs even when metadata exists but is malformed or
   incomplete. Missing parents do not delegate privacy to stale page ACLs.
7. **Secondary private media leaks.** My Rooms, its cached lists/thumbnails,
   trace photos, phone images, doodles and retained audio now recheck current
   source-book visibility/membership. Private sheet JSON and audio fetches carry
   current bearer authorization; no credential-bearing image URLs are created.
   Returned inline raster decoding and the safe-image policy are unchanged.
8. **Public viewing mistaken for page authorship.** Claimed account-book Wall
   publication requires the owner or an approved artist. Public viewing alone
   is not authorship. Guest creation/publication stays anonymous-first.
9. **Same-browser cross-account gallery leakage.** Cloud-pulled drawings now
   retain owner metadata, separate IDs and account-scoped request generations.
   Inactive partitions stay stored but are not listed or uploaded under another
   account. App state/actions filter synchronously; stale cloud/server gallery
   responses cannot repopulate a new account's gallery. Ambiguous legacy cloud
   rows are quarantined without deleting their bytes. No new durable store key
   was introduced; existing deletion wipes cover the gallery metadata.
10. **Ownership capability transport/generation.** Device credentials no longer
    appear in client artwork/by-room request URLs. Anonymous reads use
    `X-Drawesome-Device-Key`, mutations use request bodies, and legacy server
    query support remains for older clients. New device keys use Web Crypto;
    existing stored capabilities are preserved verbatim rather than rotated.

## Permission contract

- Frozen Wall originals: only their authenticated owner or original anonymous
  device capability may withdraw/delete them. Invalid bearer identity never
  unlocks an account by supplying `pb_<id>`.
- Private saved galleries: server derives account ownership from validated
  identity; another account cannot read or delete the victim's original.
- Artist studios: viewers cannot paint or invoke destructive management;
  approved painters can collaborate without acquiring owner/host powers.
- Private books: owner/approved artists only; revocation covers existing streams,
  not just future joins. Missing parents fail closed. Moderation-hidden books
  retain the established team-only socket policy.
- Public/guest books: viewing is public, painting remains permission-gated.
- Public murals: shared drawing is intentional, not an individual private canvas.
- Reports request review; they do not confer ownership or protected-art takedown
  rights. Administrators retain explicit moderation powers.

## Executed verification

All identity/network mutations used synthetic fixtures and scratch data.
External account validation was mocked, not a live PocketBase account.

- New Wall/private-gallery matrix: **12/12**, including forged account keys,
  invalid tokens, reports, remix consent, withdrawal/restart, header proof and
  non-destructive capacity pressure.
- Frozen-image Docker/browser acceptance: **6/6**, actual production image,
  phone/desktop strangers, owner withdrawal plus detail/raster readback, private
  original preservation, and cloud-unconfigured anonymous easel.
- Actual receipt + real backend identity-transition browser suite: **11/11**.
- Protected-canvas moderation regression: **12/12**, studio, private/public/guest
  books, forged flags, continued painting and restart.
- New book privacy matrix: **37/37**, including Chromium authorized image decode,
  multi-page/two-tab revocation, missing/corrupt parents, thumbnails, media,
  account deletion, public viewer preservation and cloud-unset behavior.
- Existing sketchbook server suite: **180/180**. Three old missing-parent
  allowances were deliberately replaced with fail-closed expectations.
- Existing guest sketchbooks: **199/199**; private-room auth: **9/9**.
- Artist-room server: **110/110**; artist security: **46/46**.
- Artist-studio real browser integration: **29/29**, including unchanged viewer
  canvas pixels, approval/revocation and anonymous murals. Updated its stale
  directory probe from `/gallery` to the existing `/studios` destination.
- Moderator observer: **28/28**; moderation evidence hardening: **21/21**.
- Legacy Wall API contract: **37/37**, updated review-only report expectations.
- Gallery/device/receipt unit tests: **17/17**; App integration harness: **6/6**;
  real StudioApp account-transition/media fixture: **6/6**.
- PageImage browser media/auth regression: **3/3**, including bearer transport,
  account-partitioned cache, and anonymous public loading. Final review identified
  this separate loader seam; the missing-header regression failed before the fix.
- Community-event server verification: all seven scenarios passed.
- `npm run lint`, `npm run build`, `node --check server.js`, `git diff --check`:
  passed. Build retains the existing DiscoveryPage mixed-import warning.

The old discovery visual suite remains **27/29 on both baseline and candidate**:
its older font/palette and above-the-fold expectations predate the current art-wall
redesign. These are not permission regressions. Its stranger/owner receipt checks,
phone/desktop overflow checks and no-runtime-error checks pass. Symlinked test
fonts also produce Vite filesystem warnings; the built Docker acceptance loads
packaged assets instead.

Evidence root:
`/home/craig/.hermes/maintenance/drawesome-permissions/20261103/`.
Built image browser evidence:
`/home/craig/.hermes/cache/scratch/artwork-built-ui-PcdPRD/`.
Real StudioApp gallery evidence:
`/home/craig/.hermes/cache/scratch/cloud-gallery-ui-bb5cTm/`.

## Boundaries and limitations

- Public raster downloads can be copied into a separate drawing. Uploaded pixels
  do not prove provenance; omitting a claimed room cannot be detected as a copied
  image. This does not grant mutation of the original. Custom display names are
  non-unique labels, not verified identities or permissions.
- Anonymous ownership is a browser-device bearer capability. Someone with that
  browser's storage has its rights. Strong generation prevents new weak keys but
  does not invalidate existing ones or recall credentials already logged.
- Account partitions are UI/sync isolation, not encrypted browser storage.
  Previously loaded easel pixels and local drafts are intentionally not erased on
  logout. Already downloaded content cannot be recalled by server revocation.
- Legacy unlabelled cloud ownership cannot be reconstructed reliably. Quarantined
  bytes are preserved; legitimate remote rows are pulled under their real owner.
- These tests do not audit live PocketBase collection rules or token revocation
  timing, prove copyright, test every physical device, or fault-inject all disk
  failures. Audio authorization/cache wiring is exercised at the server/static
  seam; browser audio decoding and dedicated phone/doodle gameplay are not new
  acceptance claims.

Deployment is recorded separately after the reviewed code is committed and the
app-only swap has been read back. No code rollback should restore a data archive.
