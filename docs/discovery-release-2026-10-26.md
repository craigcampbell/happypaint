# Discovery and community invitations release — 2026-10-26

Application commit: ccd44ccdab33d3ee91805affce13074c97eaedba (pushed to main).
Running image: sha256:328e424b003afa03bf65e58883088528b2e5099250559b4844baa2dc1acf2863.
Server SHA-256: 0327ac7785575a7316599b87de6978361b542c92552288511a6ec30ec1ac6a12.
Built index SHA-256: 1c1e465105f6f38922b2ac8f6951979271790452138d9093cee4aae0a277a4cc.

## Shipped

Artwork-first homepage and gallery; separate Studios and Events discovery.
Curated Draw for Rhoam, Inktober and Little Joys invitations. Event participation
starts on a local-only canvas without an account or multiplayer connection.
Publishing requires explicit confirmation; a sharing receipt supports owner-only
unpublishing. Local-only gallery items cannot upload through later cloud sync.
Sensitive tribute contributions have no votes, remix or competitive ranking.
Studios retain owner/painter ACLs and explicit listing consent.

## SEO

Every URL from the pre-release public sitemap remains present. No duplicate URLs.
Only five URLs were added: /draw, /events, /events/draw-for-rhoam,
/events/little-joys, /studios. Existing /gallery and /inktober remain canonical.
Discovery landing pages have crawlable initial HTML, unique metadata and internal
links. Unknown event pages return 404; invite/admin/watch surfaces are noindex.
Existing analytics remains in the shell. This is technical SEO, not a guarantee
of rankings or indexing.

## Verification

- npm run lint and npm run build passed (Vite notes that DiscoveryPage is also
  statically imported; build succeeds).
- New unit/privacy/return/SEO tests: 10 passed.
- scripts/discovery-seo-verify.mjs: 122 HTTP checks passed.
- scripts/discovery-ui-verify.mjs: 28 checks passed at 375px and 1280px.
- scripts/event-drawing-ui-verify.mjs: passed real drawing, zero pre-consent writes,
  explicit publication, event readback, retraction, seasonal receipt, anonymous
  room regression and no runtime errors against isolated servers/data.
- scripts/community-events-server-verify.mjs: passed attribution/ACL/restart,
  sensitive-event protections, retraction and SEO scenarios.
- scripts/artist-rooms-server-verify.mjs: exit 0.
- Production app healthy locally and publicly; running image matches build.
- All 50 public JS/CSS assets byte-match the running image.
- Live mobile homepage, gallery, events, tribute, studios and Inktober load with
  no horizontal overflow. Tribute CTA retains event context on the private canvas.
  No production artwork was posted by these probes.
- A first live CTA probe selected the footer's generic Draw my own link, not the
  event CTA; scoped event-hero probe passes. urllib public probes were blocked
  with 403; curl and Chromium succeeded. Neither was an application regression.

## Deployment safety and rollback

Only app recreated. PocketBase and cloudflared IDs and StartedAt remained unchanged.
Deployment tree /home/craig/Projects/happypaint is not a Git checkout. Release
source is /home/craig/Projects/happypaint-discovery-20261026. Changed paths were
copied into the deployment tree; unrelated mobile lockfile and test-script drift
was left untouched. Existing deploy-tree auth/dependency hardening was preserved
in the preceding commits, not rolled back to the older origin baseline.

Backup: /home/craig/Backups/drawesome/discovery-20261026-195233
Contains source.tar.gz, app-data.tar.gz and release.json.
Data backup SHA-256: 1dcf2ceae0376af72b1d77deb12df4cd985ea3c096f0aa672a4ac72e378cd979.
Rollback image: happypaint-app:pre-discovery-20261026-195233.

Code rollback (do NOT restore the data backup):

    docker tag happypaint-app:pre-discovery-20261026-195233 happypaint-app:latest
    docker compose -p happypaint -f /home/craig/Projects/happypaint/docker-compose.yml up -d --no-deps --no-build --force-recreate --wait --wait-timeout 90 app

The next rebuild would roll forward again unless the source is also deliberately
reverted. Evidence: /home/craig/.hermes/cache/scratch/drawesome-discovery-release/.

## Integration-review follow-up

Application commit 9f1aa657fa8968fe648e1536069808864afd1a52 is now live.
Image: sha256:5da969322a3ead928c8bf62a0cf2b1212739ba67dbe6662f3c2bc4809c064aea.
Server SHA-256: a16113aeeb4c44b3d7f127eb1a9127eef497dc5de471bf99a59de08a04516d37.

Legacy studio settings now preserve non-Inktober event associations. Shared-studio
publication uses event-aware consent and server-authoritative event receipts.
Retraction retries the original anonymous device capability after account sign-in,
without permitting account-key spoofing. Artwork detail pages also expose the
ownership-checked withdrawal action; Inktober receipts were already present.

Lint/build, backend integration and both browser suites passed again. Two receipt
regression tests passed. Live health, server hash, all 50 public asset byte matches,
unchanged database/tunnel and preservation of the original sitemap were verified.
Backup: /home/craig/Backups/drawesome/discovery-followup-9f1aa65.
Rollback to the initial discovery release by tagging
`happypaint-app:pre-discovery-followup-9f1aa65` as `happypaint-app:latest`, then
running the same app-only no-build recreate command above. Do not restore data.

## Scope remaining

Invitations are curated in src/data/communityEvents.js, not auto-discovered trends.
This release does not add streaming video, followers, or a new invite-only guest
studio model. Existing shared rooms and account-owned studio permissions remain.
