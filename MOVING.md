# Moving the whole stack to another machine

The entire app is **three containers** (app + PocketBase + the Cloudflare tunnel)
plus the project folder. There are **no host services** to install or configure —
once `.env` has a valid `TUNNEL_TOKEN`, everything runs in Docker and travels with
the folder.

## What makes up "the app"
- **Code** — the repo (Dockerfiles, `docker-compose.yml`, `server.js`, `src/`, …).
  Rebuilt into the image on the target machine; nothing machine-specific.
- **Config** — `.env` (`TUNNEL_TOKEN`, `VITE_PB_URL`, `PB_URL`). Just a file.
- **Data** — bind-mounted folders, so they live right in the project dir:
  - `pb_data/` — PocketBase: accounts, Google-provider config, galleries, uploads.
  - `app_data/` — room murals, saved art, coloring-sheet picks, admin key, metrics.
  - `coloring-library/` — the 6,294 sheets (full PNGs + thumbnails). ~1.2 GB.
- **Cloud-side (nothing to move)** — your Cloudflare tunnel + DNS + hostname routing,
  and the Google OAuth client. These live in your Cloudflare/Google accounts and
  work from any machine running the containers. The tunnel token is account-scoped,
  not tied to a PC.

## Move it
1. Install **Docker Desktop** on the new machine.
2. Copy the **whole project folder** across — *including* `.env`, `pb_data/`,
   `app_data/`, and `coloring-library/`. **Skip** `node_modules/` and `dist/`
   (they rebuild inside the image) to save ~hundreds of MB.
   - Any transfer works: an external drive, `robocopy`/`rsync`, or a cloud sync.
   - One-file option: `sh scripts/backup.sh` makes a tarball of `pb_data` +
     `app_data` + `.env`; bring that plus the repo and `coloring-library/`.
3. On the new machine, from the folder:
   ```bash
   docker compose --profile tunnel up -d --build
   ```
4. Done. The tunnel reconnects with the token in `.env`, `drawesome.art` +
   `pb.drawesome.art` route through Cloudflare as before, and Google sign-in keeps
   working (its config is in `pb_data` + your Google account).

> Run it on **one** machine at a time. Before moving, stop the old one with
> `docker compose --profile tunnel down` so you don't have two tunnel connectors
> live at once (two replicas technically works as HA, but for a home setup keep it
> to one).

## Tips for truly clean portability
- Treat `coloring-library/` as read-only data — it rarely changes, so you only copy
  it once. Day-to-day backups (`scripts/backup.sh`) skip it and just grab the
  mutable `pb_data` + `app_data` + `.env`.
- `.env` holds secrets (the tunnel token). Keep the backup tarball private.
- Nothing uses absolute host paths — every volume in `docker-compose.yml` is
  relative to the folder, so the same compose file works wherever the folder lands.
