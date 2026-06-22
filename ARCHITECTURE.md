# Drawesome — Architecture

A real-time, paint-together drawing studio for kids and friends, hosted at
**drawesome.art**. Mobile/tablet-first. Self-hosted in Docker behind a Cloudflare
tunnel — no cloud bill, all data on disk.

> New here? Read this file, then [AGENTS.md](AGENTS.md) (how to work in the code)
> and [ROADMAP.md](ROADMAP.md) (vision + what's next). Operational guides:
> [POCKETBASE_SETUP.md](POCKETBASE_SETUP.md), [MOVING.md](MOVING.md),
> [RUNNING.md](RUNNING.md), [DEPLOY.md](DEPLOY.md).

## The big picture

Three containers, one folder, one domain:

```
                         Cloudflare edge
                               │  (tunnel, token auth)
                    ┌──────────┴───────────┐
                    │   cloudflared (3)    │   container, profile "tunnel"
                    └──────────┬───────────┘
        drawesome.art ────────►│ http://app:8787
        pb.drawesome.art ─────►│ http://pocketbase:8090
                    ┌──────────┴───────────┐   ┌──────────────────────────┐
                    │  app (1)             │   │  pocketbase (2)          │
                    │  Node: SPA + /ws +   │──►│  Google accounts, SQLite,│
                    │  REST, port 8787     │   │  file storage, port 8090 │
                    └──────────────────────┘   └──────────────────────────┘
```

- **(1) app** — `server.js`: a single Node process that serves the built Vite SPA
  (`dist/`), a WebSocket relay at `/ws`, and the REST API. All on one port (8787)
  so one tunnel route covers page + socket.
- **(2) pocketbase** — accounts (Google OAuth), the cross-device gallery, file
  storage. The app validates PocketBase tokens but holds **no secrets**.
- **(3) cloudflared** — the Cloudflare tunnel, in the stack (compose profile
  `tunnel`). Routes the two hostnames at the **service names** `app:8787` /
  `pocketbase:8090`.

**Sign-in is OPTIONAL everywhere.** With PocketBase unconfigured (`VITE_PB_URL` /
`PB_URL` unset) the whole app runs fully local + anonymous — drawing, rooms,
coloring sheets, play-money drops all work. Accounts only add ownership/host
powers and cross-device gallery sync. **Every account feature is env-gated** so
nothing breaks when unconfigured. This is the single most important invariant.

## Frontend (React + Vite)

- **One big component.** `src/App.jsx` (~4,900 lines) is `StudioApp` — canvas,
  tools, layers, loop/animation, chat, multiplayer, economy, modals. The default
  `App()` is a tiny `pathname` router (`/`, `/studio`, `/join/:code`, `/admin`,
  else marketing site). SPA routing via `pushState` + `popstate`.
- **Canvas** lives in `src/utils/layers.js` (CANVAS_WIDTH 4000 × HEIGHT 2500,
  `MAX_LAYERS` 6). The viewport (`viewRef {scale,tx,ty}`) maps world→CSS px;
  pinch/wheel/hand-tool pan+zoom.
- **Components** in `src/components/`: `AccountPanel` (sign-in + account delete),
  `HostControlPanel` (per-room moderation), `ColoringSheetModal` (search 6k+
  sheets), `LiveAdmin` (the `/admin` portal), `WalletPanel`/`StorePanel`/
  `CreatorDashboard` (economy), `MarketingSite`.
- **Utils** in `src/utils/`: `auth.js` (PocketBase auth, lazy SDK),
  `sync.js` (gallery ↔ PocketBase `snapshots`), `economy.js` (play-money wallet),
  `accountDeletion.js` (App-Review-grade delete), `paintSpace.js`, `idb.js`, etc.

## Realtime model — one shared canvas

The defining design choice: **everyone draws onto the same layer**
(`layersRef.current[0]`). There is no per-user overlay. The server is an
op-agnostic relay + store:

- Clients send `{type:'op', op:{kind, ...}}`; the server tags it with the author,
  appends to a capped per-room history (`MAX_HISTORY` 6000), and rebroadcasts.
- **Late joiners replay the full history** → they see the whole mural.
- Room history persists to `.rooms/<ROOM>.json` (debounced 2.5s) and reloads on
  boot, so restarts and empty-then-refill keep the art.

### Op kinds (the `op` payload)
`draw` (incremental brush points keyed by `strokeId`), `shape`, `text`, `image`.

### WebSocket protocol (`/ws?room=CODE&token=…`)
The optional `token` is a PocketBase access token; the server validates it to
learn the user's identity. Message `type`s:

| Client → Server | Server → Client |
|---|---|
| `op`, `cursor`, `chat`, `ping` | `connected`, `userList`, `userJoined`, `userLeft` |
| `set_sheet` (coloring sheet) | `op`, `cursor`, `cursor_leave`, `history`, `clear`, `sheet` |
| `rename` (own name/color) | `chat`, `pong`, `room_full` |
| `clear`, `undo_clear` | `room_state` (locked), `room_renamed`, `role_changed` |
| host: `lock`/`unlock`/`kick`/`mute`/`rename_room`/`promote`/`demote` | `muted`, `kicked` |

Client hook: `src/hooks/useMultiplayer.js` (`useMultiplayer(roomId, onMessage,
token)`), returns `send*` emitters + `disconnect()`.

## Identity, ownership & host control

- **Client** `auth.js`: lazy-loads the PocketBase JS SDK, Google OAuth
  (`authWithOAuth2`, Safari-safe popup), normalizes to a `session {access_token,
  user:{id,...}}`. `getSession`/`onAuthStateChange`/`signInWithProvider`/`signOut`.
- The session's `access_token` rides the `/ws` URL. **Server** validates it in
  `server/pocketbaseAuth.js` via `POST {PB_URL}/api/collections/users/auth-refresh`
  (raw `Authorization` header, no secret) → `{profileId, displayName}`. Fails
  closed to anonymous.
- **Room ownership**: the first signed-in user to enter an unowned room becomes
  `ownerProfileId` (persisted). Owner + `coHosts` = hosts. Host-only WS actions
  (lock/clear/kick/mute/rename/promote) are enforced **server-side** behind
  `isHost(room,user)`. Hardened: kick adds a short `kickedProfiles` ban, mute is
  bound to `mutedProfileIds` (survives reconnect), and a locked room **auto-unlocks
  when the last host leaves** (no bricked canvases). Only the opaque profile id is
  persisted — never a display name (PII).
- **Two orthogonal trust tiers**: site-wide `ADMIN_KEY` (the `/admin` REST portal)
  and per-room host (profileId). Admins outrank hosts.

## Coloring-sheet library (6,294 sheets)

- Source PNGs (transparent line art) live in `coloring-library/full/`
  (~1.2 GB, git-ignored, a Docker volume). `scripts/prep-sheets.mjs` moves them
  there, generates 256px webp thumbnails (`thumbs/`), and builds `index.json`
  ({id, title, searchable text}) **straight from the descriptive filenames — no AI
  classifier**.
- Server static-serves `/coloring-sheets/full` + `/thumbs`; `GET
  /api/coloring-sheets` returns the index (client searches in-browser);
  `GET /api/coloring-sheets/today` = Today's theme (admin pick → holiday match →
  daily rotation); `POST /api/admin/sheet-theme` sets it.
- Studio: `ColoringSheetModal` (search/grid/preview/Add). A room has **one**
  active sheet; changing it clears the canvas (confirm). Library sheet ids are
  prefixed `lib:` in the `set_sheet` protocol and loaded as static PNGs.

## Economy — play-money only

`economy.js` is a local-first wallet (IndexedDB `economy:v1`). `PLAY_MONEY_ONLY =
true`: **Drops are earned by painting** (`earnDropsForPainting`, throttled), spent
on cosmetic items. The real-money rails (in-app purchase catalog, $-equivalence
display, creator payouts, tips-as-cash) are **OFF and must stay off** — real money
+ minors = app-store/COPPA/money-transmission obligations. See [ROADMAP.md](ROADMAP.md).

## Storage layout

All mutable server state lives under **`DATA_DIR`** (default the app dir; `/data`
in Docker) so one volume persists everything:
- `.rooms/<ID>.json` — per-room mural history, owner, coHosts, locked, mutes, sheet.
- `.artworks/<key>.json` — anonymous per-device saved art (capped `MAX_SAVES`).
- `.sheets.json` — admin-uploaded custom sheets. `.sheet-theme.json` — today's pick.
- `.admin-key`, `.reports.json`, `.metrics.json`.

Separate, large, read-only: **`coloring-library/`** (its own volume). PocketBase
data: **`pb_data/`** (its own volume). All three folders are git-ignored.

## REST endpoints (server.js)
`/healthz`; `/api/artworks` (CRUD, anon device key); `/api/report` (public);
`/api/admin/*` (key-gated: rooms, reports, sheets, metrics, sheet-theme);
`/api/sheets` (custom uploads); `/api/coloring-sheets` + `/today` (library);
`/coloring-sheets/full|thumbs/*` (static). SPA fallback 404s on `/api/` +
`/coloring-sheets/` misses.

## Build & deploy

- **Dev**: `npm run dev` (Vite :5173, proxies `/ws` → :8787) + `node server.js`.
- **Prod build**: `npm run build` → `dist/`, served by `server.js`.
- **Docker**: `Dockerfile` (Node app, multi-stage; bakes `VITE_PB_URL`),
  `pocketbase.Dockerfile` (binary), `docker-compose.yml`. `docker compose
  --profile tunnel up -d --build` = app + pocketbase + cloudflared.
- **Portability**: the project folder *is* the app — copy it (with `.env` +
  `pb_data`/`app_data`/`coloring-library`) to any Docker host. Tunnel token, DNS,
  and Google OAuth are account-side (cloud), not machine-bound. See
  [MOVING.md](MOVING.md).

## Key files map
| Path | Role |
|---|---|
| `server.js` | Node: WS relay + static host + REST + room persistence + coloring lib |
| `server/pocketbaseAuth.js` | Validate a PocketBase token (secret-free) |
| `src/App.jsx` | The entire studio (`StudioApp`) + router |
| `src/hooks/useMultiplayer.js` | WS client + host emitters |
| `src/utils/auth.js` / `sync.js` / `economy.js` / `accountDeletion.js` | Account, gallery sync, play-money, delete |
| `src/components/*` | AccountPanel, HostControlPanel, ColoringSheetModal, LiveAdmin, economy panels |
| `scripts/prep-sheets.mjs` | One-time coloring-library build (thumbs + index) |
| `docker-compose.yml` / `Dockerfile` / `pocketbase.Dockerfile` | The stack |
| `backend/supabase/` | **Legacy** Supabase schema (reference only — we use PocketBase) |
