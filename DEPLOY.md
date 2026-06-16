# Deploying Happy Paint (web) to DigitalOcean

The web app is a static Vite build in `dist/`. It uses **client-side routing**
(`history.pushState`) for `/studio`, `/join/:code`, and `/admin`, so the host
**must** serve `index.html` for unmatched paths or those URLs 404 on refresh.

Two supported paths on DigitalOcean:

## Option A — App Platform (managed, recommended)

Uses `.do/app.yaml`. The key line is `catchall_document: index.html` (SPA
fallback).

```sh
# one-time
doctl apps create --spec .do/app.yaml
# subsequent deploys happen on git push (deploy_on_push: true),
# or force one:
doctl apps update <APP_ID> --spec .do/app.yaml
```

Edit `.do/app.yaml` first: set `github.repo` to your repo and confirm the
branch. App Platform runs `npm ci && npm run build` and serves `dist/`.

## Option B — Droplet + nginx (self-managed)

Uses `deploy/nginx.conf` (has the `try_files ... /index.html` SPA fallback,
hashed-asset caching, and no-cache on `index.html`).

```sh
npm ci && npm run build
rsync -a dist/ root@<droplet-ip>:/var/www/happypaint/
# on the droplet:
cp deploy/nginx.conf /etc/nginx/sites-available/happypaint
ln -sf /etc/nginx/sites-available/happypaint /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d happypaint.app          # TLS
```

## Notes

- **No backend required to host the studio.** Drawing, layers, loops, gallery,
  and the Paint Space locker persist client-side (IndexedDB) — they work on a
  pure static host. Wiring real accounts/sync later means standing up the
  Supabase backend in `backend/supabase/schema.sql` and pointing the app at it.
- The GIF export Web Worker (`gif.worker-*.js`) is emitted as a normal hashed
  asset under `/assets/` and needs no special server config.
- **Mobile (iOS/Android)** ships through the App/Play stores via Expo, not
  DigitalOcean — DO only hosts the web surface (and, later, the backend/API).
