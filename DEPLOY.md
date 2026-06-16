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

## Supabase setup (auth + sync, optional)

Supabase is a **separate** managed service (Postgres + Auth + Storage). It is
NOT hosted on DigitalOcean — DO only needs two public env vars at build time.
Skip this section entirely to ship a local-only build (no accounts/sync).

1. **Create a Supabase project** at https://supabase.com (note the Project URL
   and the `anon` public key under Project Settings → API).
2. **Run the schema** in the SQL Editor (or via `psql`):
   - `backend/supabase/schema.sql` (tables, RLS, the `handle_new_user` trigger,
     sync columns, and the `request_account_deletion()` RPC), then
   - `backend/supabase/storage.sql` (the `artwork` / `replay` / `previews`
     buckets and their owner-folder policies).
3. **Auth redirect URLs** (Authentication → URL Configuration): add your
   DigitalOcean web domain (e.g. `https://happypaint.app`, plus
   `http://localhost:5173` for local dev) and the **Expo mobile deep-link
   scheme** (e.g. `happypaint://` / the Expo dev URL) so magic-link and OAuth
   callbacks return to the apps.
4. **Enable providers** (Authentication → Providers): email, phone, magic link,
   and **Apple** + **Google** (configure each provider's client id/secret).
5. **Copy URL + anon key into the clients:**
   - **Web:** set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as
     `BUILD_TIME` env vars in `.do/app.yaml` (or the App Platform UI). They are
     baked into the static bundle at build time.
   - **Mobile:** set `EXPO_PUBLIC_SUPABASE_URL` and
     `EXPO_PUBLIC_SUPABASE_ANON_KEY` in the mobile env / EAS build secrets.
   - See `.env.example` for the full list. The anon key is public/safe to ship;
     RLS is the security boundary. Never ship the `service_role` key.
6. **Account-deletion purge:** deploy and schedule the Edge Function —
   `supabase functions deploy purge-account` and
   `supabase secrets set SERVICE_ROLE_KEY=...`, then schedule it (pg_cron or a
   scheduled function). Details in `backend/supabase/functions/README.md`.

## Notes

- **Hosting the studio needs no backend; sync/auth are optional — configure
  Supabase to enable them.** Drawing, layers, loops, gallery, and the Paint
  Space locker persist client-side (IndexedDB) and work on a pure static host.
  Accounts and cross-device sync turn on only when the Supabase env vars above
  are set (see the "Supabase setup" section). Supabase is a separate service;
  DigitalOcean only needs the two public `VITE_SUPABASE_*` build-time vars.
- The GIF export Web Worker (`gif.worker-*.js`) is emitted as a normal hashed
  asset under `/assets/` and needs no special server config.
- **Mobile (iOS/Android)** ships through the App/Play stores via Expo, not
  DigitalOcean — DO only hosts the web surface (and, later, the backend/API).
