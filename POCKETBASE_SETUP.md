# Self-hosting drawesome.art with PocketBase (accounts) in Docker

Everything runs in two containers on your machine, behind your existing
Cloudflare tunnel. No monthly bill, all data on your disk.

```
  drawesome.art      ──tunnel──▶  localhost:8787   app   (Node: SPA + live drawing)
  pb.drawesome.art   ──tunnel──▶  localhost:8090   pocketbase  (Google accounts + SQLite + files)
```

> Versions matter: this targets **PocketBase v0.39.x**. PocketBase moves fast and
> v0.23 was a breaking rewrite — ignore any older tutorial (admins → superusers,
> first-superuser-via-CLI, etc.).

The two values you'll create: a **Google OAuth Client ID + secret** (you paste
these into PocketBase, not to me) and a **PocketBase superuser** login. Nothing
secret needs to leave your machine.

---

## 1. Bring up the stack
From the repo root:
```bash
docker compose up -d --build
```
This builds the app + PocketBase, creates the `pb_data/` and `app_data/` folders
(your persistent data), and starts both. Ports bind to `127.0.0.1` only — the
tunnel is the only way in.

## 2. Create the PocketBase admin (superuser) **[you]**
Since v0.23 the first admin can't be made by visiting the dashboard — create it
via the CLI:
```bash
docker compose exec pocketbase /pb/pocketbase superuser upsert you@example.com a-strong-password
```
You can now log into the dashboard (after step 3) at `https://pb.drawesome.art/_/`.

## 3. Add the PocketBase hostname to your Cloudflare tunnel **[you]**
In the Cloudflare Zero Trust dashboard (or your tunnel config), add a **public
hostname**:
- **Subdomain/host:** `pb.drawesome.art`
- **Service:** `http://localhost:8090`

(Your existing `drawesome.art → http://localhost:8787` route stays as-is.)

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

## 7. Point the app at PocketBase and rebuild **[you]**
Create a repo-root `.env`:
```
VITE_PB_URL=https://pb.drawesome.art
```
Then rebuild just the app so the value bakes into the SPA:
```bash
docker compose up -d --build app
```
That's it — open `https://drawesome.art`, the avatar/Account panel now has a
working **Continue with Google**, and a signed-in grown-up owns + hosts their
room and gets a cross-device gallery.

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
