# Production deployment — September 14, 2026 (Google Analytics)

The owner asked for the Google Analytics tag to be committed and released. The
release adds the `G-9TG5C3N1YP` gtag.js snippet to the app shell and was deployed
at **https://drawesome.art** through the existing local Docker Compose stack.
No money was spent.

## What shipped

`index.html` carries the tag in `<head>`, async, with no `data-seo` marker, so
one copy of the snippet covers every route the server renders (homepage, studio,
invites, wall cards) and survives both the Vite build and the server's per-route
SEO tag replacement.

## Release and rollback

- Commit: `377a648` — *Add Google Analytics (gtag.js) to the site shell*,
  pushed to `origin/codex/youth-design-refresh`.
- App image (`happypaint-app:latest`):
  `sha256:77f103a20b106a2d436e898ff333bd7d104d6633a66de4128642fbbf0cf61e98`.
- Deployed `server.js` SHA-256:
  `6b5a8814c1fc451ea09fba393637b3bdb570bdac4c63f1760bc2a1af4caed758`.
- Deployed `dist/index.html` SHA-256:
  `73e6fab2cc56e59224d8667473920d0c1c2a3ce7f7267d1b6e1d3d4748987003`.
- Public entry script: `/assets/index-DOj6SXTf.js`.
- Rollback image tag retained locally: `happypaint-app:rollback-20260914`
  (`sha256:fe193ced51e0f440b95f123a82b85fdc149110466ccae321b211dacc90f8d4e2`).
- Local app-data backup: `backups/pre-deploy-20260914-0918.tar`, 153,487,360 bytes.
- Backup SHA-256:
  `afaf7339df9f5e10e3d583e3d4896a72450cdb8c1b2b9e8f359ce8438e2b6bc4`.

Release used `docker compose up -d --no-deps --no-build --wait --wait-timeout 60
app` after `docker compose build app`. The PocketBase and Cloudflared container
IDs and start times (2026-09-14T02:51:40Z) were unchanged. Existing drawing-data,
account-data, and coloring-library mounts were retained. No DNS/tunnel changes,
credential entry, or payments were performed.

## Verification

- Zero-warning lint and the production build passed; `dist/index.html` in the
  built image contains the snippet.
- Local and public `/healthz` returned 200; the app container reached `healthy`;
  the running container's image ID matches the image just built.
- Public `/` and `/studio` both serve the snippet with the expected entry script,
  which returned `text/javascript`.
- In a real browser: `window.gtag` is a function, the `gtag/js?id=G-9TG5C3N1YP`
  request returned, the dataLayer reached `gtm.dom`/`gtm.load`, and GA4 beacons
  were sent to `google-analytics.com/g/collect?tid=G-9TG5C3N1YP` on both the
  homepage and the studio. No console errors on either.
- Anonymous drawing was exercised in a fresh private room (`HPVERIFY0914`,
  unlisted): a marker stroke painted and autosaved, and a second isolated client
  (clean profile, no local draft) replayed the same stroke. The same client saw
  its pending-service-worker shell load the current build, and `public/sw.js`
  fetches app-shell navigations network-first, so returning visitors pick the
  new HTML up. The lobby's Open Studio op count (4,019 compacted + 693 appended
  = 4,712) was unchanged across the session, i.e. no ops were written to the
  community canvas — including during a stray synthetic input burst that was
  discarded before painting.
- Public coloring catalog returned all 6,294 sheets; PocketBase health returned
  200. Checkout remained disabled.
