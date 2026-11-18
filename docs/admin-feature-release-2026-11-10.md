# Remembered admin + featured public-room release — 2026-11-10

Application commit: 9767b761a2beb66c96794f157bfbb4df6ea34153 (local branch feature/artwall-curator; not pushed).
Image: sha256:df7713743658008d9ff189e95ba0fb54c06a7d4513e88873aef434c468944edb
Previous image: sha256:2ef872f6930c2e4ff264cf9ca93231850b15a2ebbad379a0acfdff02add6c19a

## Reconciliation and fixes

Preserved newer deployed artwork privacy/account-erasure/ownership protections before integrating the pending work. Moved sharp from devDependencies to dependencies so the production image includes its native raster decoder/encoder. Unrelated mobile lockfile drift and unrequested preview/streaming documents were not part of the release.

## Verification

- Lint/build/server syntax passed.
- 36 unit tests passed, including clock-injected exact four-hour/seven-day boundaries and imported cloud-gallery/security regressions.
- 49 isolated real HTTP/Chromium auth checks passed.
- 40 real-server/scratch-built browser featured-room assertions passed.
- 122 SEO checks passed.
- Exact production candidate image exercised with generated synthetic enrollment: login, HTTPS origin validation, Secure/HttpOnly/SameSite=Strict cookies, feature admin routes and native sharp encoding passed. Initial smoke attempts correctly rejected an HTTP origin and an enrollment file written as root; corrected fixture used HTTPS proxy origin and the runtime node user.
- Running image ID equals candidate; local/public health passed.
- Public auth-mode reports enrolled 2FA, sessionHours=4, rememberDays=7.
- Public feature endpoint works; unauthorized admin requests return 401.
- All 54 public JS/CSS files match image bytes; changed server modules match committed source.
- Mobile gallery, Curator sign-in and watch sign-in render without overflow or runtime errors.
- Sitemap URL set unchanged, no duplicate entries.
- PocketBase and tunnel IDs/StartedAt unchanged; only app restarted.

No real admin secrets/codes were used for QA and no production artwork was published or removed. Full authenticated UI behavior was verified on isolated real-server builds, not by signing into the owner's live account.

## Operating behavior

After rollout, sign in once with key + authenticator. Browser recognition lasts seven days; authorization lasts a fixed four hours and is shared across tabs. Old twelve-hour sessions do not migrate. Feature a picture through a room watch view's preview/confirmation controls; manage removals there or in Curator. Private/friends rooms, unpublished studios and every sketchbook are excluded.

## Backup and rollback

Backup directory: /home/craig/Backups/drawesome/admin-feature-20261110-100821
Data archive SHA-256: b593138ce42b55946e430e732b746fbdc2e01f02fba76ddd4ee6b5423c132eda
Rollback image tag: happypaint-app:pre-admin-feature-20261110-100821

```sh
docker tag happypaint-app:pre-admin-feature-20261110-100821 happypaint-app:latest
docker compose -p happypaint -f /home/craig/Projects/happypaint/docker-compose.yml up -d --no-deps --no-build --force-recreate --wait --wait-timeout 90 app
```

Do not restore old data as part of code rollback. Previously granted tokens may require signing in again. Loose deployment source remains the new version; rebuilding it rolls forward unless source is deliberately reconciled.

Evidence: /home/craig/.hermes/cache/scratch/admin-feature-release-20261110-100252
Final test logs: /home/craig/.hermes/cache/scratch/deploy-admin-{unit,auth,featured,seo,docker-build}.log
