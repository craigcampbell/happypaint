# Self-hosting drawesome.art with PocketBase (accounts) in Docker

Everything runs in three containers on your machine — the app, PocketBase, and
the Cloudflare tunnel itself. One `docker compose` command brings the whole thing
up and Docker restarts it on reboot. No monthly bill, all data on your disk.

```
  drawesome.art     ─┐                   ┌─▶ app:8787         (Node: SPA + live drawing)
                     ├─ cloudflared ─────┤
  pb.drawesome.art  ─┘   (in the stack)  └─▶ pocketbase:8090  (Google accounts + SQLite + files)
```

Because the tunnel runs *inside* the Docker network, its public hostnames point
at the **service names** (`app:8787`, `pocketbase:8090`) — not `localhost`.

> Versions matter: this targets **PocketBase v0.39.x**. PocketBase moves fast and
> v0.23 was a breaking rewrite — ignore any older tutorial (admins → superusers,
> first-superuser-via-CLI, etc.).

The two values you'll create: a **Google OAuth Client ID + secret** (you paste
these into PocketBase, not to me) and a **PocketBase superuser** login. Nothing
secret needs to leave your machine.

---

## 1. Bring up app + PocketBase (for setup)
From the repo root:
```bash
docker compose up -d --build
```
This builds + starts the app and PocketBase and creates `pb_data/` + `app_data/`
(your persistent data). The tunnel is added in step 3 and started in step 8.
During setup you can reach PocketBase's admin at `http://localhost:8090/_/`.

## 2. Create the PocketBase admin (superuser) **[you]**
Since v0.23 the first admin can't be made by visiting the dashboard — create it
via the CLI:
```bash
docker compose exec pocketbase /pb/pocketbase superuser upsert you@example.com a-strong-password
```
You can now log into the dashboard (after step 3) at `https://pb.drawesome.art/_/`.

## 3. Move the tunnel into the stack **[you]**
The tunnel now runs as the `cloudflared` container, so three things change:

1. **Point the hostnames at the service names.** In Cloudflare Zero Trust →
   Networks → Tunnels → your tunnel → **Public Hostnames**:
   - `drawesome.art` → Service `http://app:8787` *(change from `localhost:8787`)*
   - `pb.drawesome.art` → Service `http://pocketbase:8090` *(add this one)*

   These are the Docker **service names** — cloudflared reaches them because it's
   on the same network.

2. **Give the container your tunnel token.** On the host:
   ```bash
   cloudflared tunnel token drawesome.art
   ```
   (or copy it from the dashboard's `cloudflared service install <TOKEN>` line).
   Put it in your repo-root `.env`:
   ```
   TUNNEL_TOKEN=eyJ...your token...
   ```

3. **Stop the host cloudflared** so the connector lives only in Docker — otherwise
   the old host connector keeps trying the now-`app:8787` route it can't reach:
   ```bash
   # Windows: stop the "cloudflared" service (services.msc) or Ctrl-C its terminal
   # Linux:   sudo systemctl stop cloudflared
   ```

## 4. Create the Google OAuth client **[you]**
In **Google Cloud Console → APIs & Services → Credentials → Create credentials →
OAuth client ID → Web application**:
- **Authorized redirect URIs:** `https://pb.drawesome.art/api/oauth2-redirect`
- **Authorized JavaScript origins:** `https://drawesome.art`
- (Configure the **OAuth consent screen** first if prompted. Keeping it in
  "Testing" is fine while it's just family — add testers' emails.)

Copy the **Client ID** and **Client secret**.

## 5. Turn on Google in PocketBase **[you]**
In `https://pb.drawesome.art/_/`: open the **`users`** collection → **Options**
(the gear) → enable the **Google** OAuth2 provider → paste the **Client ID** and
**secret** → **Save**. Then **Settings → Application URL** = `https://pb.drawesome.art`,
and **Settings → ... → User IP proxy headers** = `CF-Connecting-IP` (so logs show
real IPs behind the tunnel).

> The redirect host must match exactly — `https://pb.drawesome.art`. A mismatch
> (e.g. `127.0.0.1`) is the #1 cause of "redirect_uri_mismatch".

## 6. Create the `snapshots` collection (for the cross-device gallery)
In the dashboard → **New collection** → name `snapshots` (Base type), fields:

| Field | Type | Notes |
|-------|------|-------|
| `owner` | Relation → `users` | required, max-select 1, **enable "Cascade delete"** |
| `client_id` | Text | the gallery item id |
| `title` | Text | |
| `image` | Text | the drawing (data URL) |
| `texture_id` | Text | |
| `preview` | Text | thumbnail (data URL) |
| `client_updated` | Text | last-edit timestamp (ISO) |

**API rules** (so each kid sees only their own art):
- **List / View / Update / Delete:** `owner = @request.auth.id`
- **Create:** `@request.auth.id != "" && @request.data.owner = @request.auth.id`

(Cascade-delete on `owner` means "delete my account" also removes their saved art.)

## 7. Point the app at PocketBase **[you]**
In the same repo-root `.env` (it now also has `TUNNEL_TOKEN` from step 3), add:
```
VITE_PB_URL=https://pb.drawesome.art
```
This is baked into the SPA at build time.

## 8. Start the full stack — with the tunnel
```bash
docker compose --profile tunnel up -d --build
```
This brings up **app + PocketBase + cloudflared** together (the `--profile tunnel`
is what includes the tunnel container). Now `https://drawesome.art` and
`https://pb.drawesome.art` are live through the containerized tunnel, sign-in
works, and the whole stack comes back automatically after a reboot.

> Open `https://drawesome.art` → the Account panel's **Continue with Google** now
> works, and a signed-in grown-up owns + hosts their room with a cross-device
> gallery. (Plain `docker compose up -d` — no `--profile tunnel` — runs app +
> PocketBase only, handy for local testing without exposing anything.)

---

## Backups
Everything lives under `pb_data/` (accounts, galleries, files) and `app_data/`
(room murals, saved art, coloring sheets). To snapshot both:
```bash
sh scripts/backup.sh           # writes ./backups/drawesome-backup-<stamp>.tgz
```
For a fully consistent copy, `docker compose down` first, back up, then `up -d`.
PocketBase also has built-in scheduled **Backups** (Dashboard → Settings →
Backups) that can push to S3 — nice for off-machine safety.

## Good to know
- **Sign-in is optional** — anonymous painting always works; accounts only add
  ownership/host powers and the cross-device gallery.
- **Account deletion is a true hard delete** (PocketBase removes the user record
  and cascade-deletes their gallery) — free and always available in the app.
- **Apple sign-in** can be added later (PocketBase supports it; it needs the
  $99/yr Apple Developer Program and a Services ID, same as anywhere).
- The **~1GB of coloring pages** import is a separate step I'll wire next — those
  become files on the `app_data` volume.
