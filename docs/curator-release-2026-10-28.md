# Art-wall + Curator release

Application commit: 28cf988d0b8c177a6e23748b4162e17abf91c965 (pushed to main).
Image: sha256:cd8b941c396b65fd77a7ed9214607160895af716dee4e17712bb18e23ec7b035.
Server SHA-256: 4cb711b7867e822469bdd7586b3d40f2babb0ef7d3a4f7cdf981ec647edacb56.

## Curator quick start

Visit https://drawesome.art/admin/curator or Admin overview → Curator.
Sign in through the existing admin/2FA flow.

1. Choose Homepage, Artwork gallery, Events index, or Artist studios.
2. Edit kicker, headline (up to three lines), description, margin note and CTA.
3. Choose a bounded palette and artwork preset; inspect the live draft preview.
4. Save draft. Public content remains unchanged.
5. Publish saved draft, confirm, and wait for verified success.
6. Restore defaults resets both draft and public header after confirmation.

The published-header disclosure shows the current live version. Unsaved edits stay
in this tab only. Conflicts block further writes until explicit reload; copy any
local text you want to retain before choosing to discard it. A disabled Publish
button means the current draft is unsaved, invalid, blocked, or already published.

This is a structured header editor, not an arbitrary page builder: no HTML/CSS,
external CTA URLs, arbitrary image uploads, event registry editing, or section
reordering. Sensitive tribute detail pages are intentionally outside its scope.
SEO metadata and canonical URLs remain controlled by the existing code; published
header copy is also rendered into crawlable initial HTML.

## Storage and protection

DATA_DIR/.curator.json holds draft/published records and a global revision.
Atomic writes precede success. Public API exposes published content only.
Existing adminGuard/2FA protects all admin routes; no account requirement was
introduced on public drawing. No new persistent client store was added.
The first publication requires no rebuild or deployment.

## Verification

- Lint/build, schema/privacy/SEO/retraction unit tests passed.
- Curator real-server suite passed unauthorized requests, bounded validation,
  oversized/malformed JSON, conflicts/concurrent edits, draft isolation, publication,
  reset, restart, corrupted-store fallback, persistence failure and real 2FA sessions.
- Built React + real isolated server browser suite completed save → draft isolation
  → publish → public DOM/API/initial HTML → reset for all four pages.
- Built 375px/1440px public headers and editor passed overflow checks. Screenshots
  reviewed. Unauthenticated users see sign-in, not the editor.
- Private drawing/publish/unpublish browser regression and SEO HTTP suite passed.
- Live homepage/gallery/events/studios and Curator login passed mobile checks with
  no browser errors. Production writes were not used for verification.
- All 52 public JS/CSS artifacts and both fonts byte-match the release; server
  source matches the running container. Local/public health passed.
- Sitemap URL set is exactly unchanged from immediately before deployment.

## Deployment and rollback

Only app recreated. Database and tunnel IDs/StartedAt unchanged.
Backup: /home/craig/Backups/drawesome/curator-20261028-211301
Data backup SHA-256: e1a244bbef89e8728d4e94ce8ffc703d5f3f4efa2aa01d36cd6113365a64d524.
Rollback tag: happypaint-app:pre-curator-20261028-211301.

    docker tag happypaint-app:pre-curator-20261028-211301 happypaint-app:latest
    docker compose -p happypaint -f /home/craig/Projects/happypaint/docker-compose.yml up -d --no-deps --no-build --force-recreate --wait --wait-timeout 90 app

Do not restore data during code rollback. The previous image ignores Curator
content; a subsequent rebuild rolls forward unless source is explicitly reverted.
Previously deployed uncommitted room-gallery/browse work was preserved in this
release. Unrelated live mobile lockfile and test-script drift was untouched.

Source: /home/craig/Projects/happypaint-artwall-20261026
Evidence: /home/craig/.hermes/cache/scratch/curator-release.json and
/home/craig/.hermes/cache/scratch/curator-built-8BUUmC/.
