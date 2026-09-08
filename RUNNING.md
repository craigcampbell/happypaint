# Running and deploying Drawesome

The live stack at **https://drawesome.art** runs in Docker Desktop on this PC.
Keep the PC awake and Docker running. The app, PocketBase, and the existing
Cloudflare tunnel are separate services in `docker-compose.yml`.

- App: `http://127.0.0.1:8787`, serving the built frontend and `/ws`.
- PocketBase: `http://127.0.0.1:8090`, optional accounts and cloud galleries.
- Cloudflared routes the public domains to the existing services.
- Persistent app state is in `app_data/`; account data is in `pb_data/`.
  Coloring sheets are mounted read-only from `coloring-library/`.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the current system map and
[MOVING.md](MOVING.md) for moving the stack. This guide supersedes the older
standalone-Node operating instructions.

## Deploy an app update

Run from the repository root. Build before replacing the running app, keep a
rollback image, and back up `app_data/` before the update. A live copy of app data
is a precautionary backup, not a transactionally consistent database snapshot;
prefer a quiet period. PocketBase has its own backup process.

```powershell
docker compose ps
$previousAppImage = docker inspect happypaint-app-1 --format '{{.Image}}'
docker image tag $previousAppImage happypaint-app:rollback
# Keep a dated local app_data backup under the git-ignored backups/ folder.
docker compose build app
docker compose up -d --no-deps --no-build --wait --wait-timeout 60 app
```

Only the app service needs replacement for frontend/server changes. The build
uses the public `VITE_*` arguments from Compose; rebuilding `dist/` on the host
does not update the files inside the running container. Local environment files
and mutable app data are excluded from the Docker build context.

Clients briefly reconnect during replacement. The server closes sockets with
restart code 1012 and drains pending room writes before exiting; graceful shutdown
is bounded at 8 seconds and reports failure if the drain cannot complete.
A forced process kill or machine power loss cannot provide that guarantee.

Do not use `docker compose down -v`, prune volumes, replace PocketBase, or alter
the tunnel for a routine app update. Keep `ENABLE_CLIENT_SNAPSHOTS` unset;
client-rendered catch-up snapshots remain experimental. Preserve the existing
billing configuration; this deployment does not enable payments.

## Verify the release

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
Invoke-RestMethod https://drawesome.art/healthz
docker inspect happypaint-app-1 --format '{{.State.Health.Status}}'
```

Also verify that the public HTML references the newly built asset filenames,
those assets return JavaScript/CSS, and the homepage and mobile studio load in a
real browser. Test anonymous drawing and a second client's replay in a fresh
private room. Do not test paint, clear, or chat in a community room. Confirm
coloring sheets and the existing account-service health still work.

## Roll back the app

```powershell
docker image tag happypaint-app:rollback happypaint-app:latest
docker compose up -d --no-deps --no-build --wait --wait-timeout 60 app
```

Use the exact dated rollback tag recorded for a release when available. Keep the
existing data mounts; never overwrite newer user artwork with an old backup as
part of an ordinary code rollback. Restore data only as a separately reviewed
recovery operation.

## Start locally for development

```powershell
npm run dev
# In another terminal, with isolated DATA_DIR and PORT as needed:
node server.js
```

Vite uses port 5173 and proxies `/ws` to port 8787. Avoid starting another server
on the production port or pointing tests at production `app_data/`. Empty
PocketBase and billing variables leave drawing and rooms available anonymously.

## Troubleshooting

- Check Docker is running and `docker compose ps` shows the app healthy.
- If local health succeeds but the public URL fails, inspect the existing tunnel
  status. DNS/tunnel account changes are owner-operated; do not recreate them.
- If a deploy serves stale UI, inspect the public entry-script filename and try
  an ordinary reload. The service worker refreshes the shell from the network;
  API and billing responses are never cached by it.
- Review app logs locally for errors. Do not paste credentials, private room
  contents, or account records into public issues.
