# Artwork permissions release — 2026-11-03

## Shipped

- Code commit: `a5a337a564c9bd0e19aa8657da6a20ba9e57e429`
- Branch: `fix/artwork-permissions-20261029` (local; not pushed)
- Image tag: `happypaint-app:permissions-20261103-204110`
- Image ID: `sha256:2ef872f6930c2e4ff264cf9ca93231850b15a2ebbad379a0acfdff02add6c19a`
- Backend SHA-256: `7d2ce004d4928fdb1df0e4c5868a02f00b31d940c48e95d6e3faa04c589918ab`
- App container: `781fab680ce9ca3476f7482ea0912c24cb0049e77562445068d1124c80db7197`
- Started: `2026-11-03T20:56:27.220864271Z`; healthy on follow-up inspection.

See [the permission audit](artwork-permissions-audit-2026-11-03.md) for findings,
contracts, test coverage and limitations. Final review's separate PageImage
fetch/cache seam and blocked-storage receipt identity were fixed before commit.

## Release isolation and preservation

Built the reviewed Git worktree, **not** the loose deployment tree containing
unshipped remembered-admin/featured-room work. Used the existing lightweight
`default` runtime target, public PocketBase build URL, empty advertising unit
arguments and ten-minute ad-break argument, matching existing build settings.
Runtime environment was compared with the running container; no drift keys.

Applied the task's exact delta to the loose deployment source using 90 guarded
hunks/new-file writes. All 26 source paths matched the archived prior content
plus only that delta. Unrelated WIP was preserved, not silently shipped or
replaced. Future rebuilds should use this reviewed commit or a reviewed successor,
not assume that the loose tree is otherwise clean.

Swapped only `app` with `--no-deps --no-build --pull never --force-recreate --wait`.
PocketBase and cloudflared IDs and start times were identical before/after and
again on follow-up. No credentials, enrollment, database schema, tunnel or DNS
configuration was changed.

## Backups

Directory: `/home/craig/Backups/drawesome/artwork-permissions-20261103-204110`

- `app-data-before.tar.gz`: online filesystem backup, not a database snapshot.
- Backup SHA-256: `44caa0d5d7d5e92a2ffc2afdd9b763f95ca53156921f8a8d8a00c3630cbe575b`
- `source-before.tar.gz`, `source-final-preapply.tar.gz`: prior source preservation.
- Rollback image: `happypaint-app:pre-permissions-20261103-204110`.
- Prior image: `sha256:cd8b941c396b65fd77a7ed9214607160895af716dee4e17712bb18e23ec7b035`.

Do not restore the data archive as a code rollback: it would discard newer art.
The prior image reintroduces known permission defects; prefer a forward fix or
maintenance isolation. Emergency code-only rollback, if deliberately approved:

```sh
docker image tag happypaint-app:pre-permissions-20261103-204110 happypaint-app:latest
docker compose -p happypaint -f /home/craig/Projects/happypaint/docker-compose.yml up -d --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 90 app
```

## Verified after deployment

- Running image equals the tested final Docker image and backend hash.
- All **61/61** shipped JavaScript, CSS and WOFF2 assets matched public decoded
  bytes against the running image, with expected content types.
- Local/public health, admin auth-mode, PocketBase health and the reported artwork
  route returned HTTP 200.
- Fresh anonymous Chromium sessions at **375px and 1280px** displayed the real
  reported artwork, had no owner management/withdrawal controls, and received
  `{canUnpublish:false, canDelete:false}` from the actual permission endpoint.
- Those live views had no runtime errors, overflow or application WebSockets.
- Only read-only production behavior was exercised: no real drawing was reported,
  withdrawn, deleted or edited.
- Disposable QA Docker container was removed; final production health remained
  green, with database/tunnel neighbors unchanged.

Evidence in the backup directory: `before.json`, `post-swap.json`,
`final-health.json`, `asset-parity.json`, `live-browser.json`,
`source-integration-verification.json`, deploy/build logs and live screenshots.
Final image synthetic browser acceptance is in
`/home/craig/.hermes/cache/scratch/artwork-built-ui-PcdPRD/`.

Known non-permission failures: the old discovery visual harness is 27/29 on both
baseline and candidate, with stale font/palette/above-the-fold expectations. The
permission/browser/build gates in the audit passed. This release does not claim
copyright provenance, encrypted shared-browser caches, or erasure of previously
downloaded pixels/local easel drafts on logout.
