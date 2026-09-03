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

## Brush engine (`src/utils/brushes.js`)

Every `draw` op is replayed by three consumers — the studio's local stroke,
the studio's remote strokes, and `opReplay.applyOp` (history, spectators, film
export) — and **all three must land byte-identical pixels, forever**: room
history is a stored op list, so an engine change that repaints an old op
repaints every mural on the server. The rules that follow from that:

- **Versioned strokes.** Ops without `v` are the pre-2026 legacy segment path
  (`drawBrushSegment`, verbatim). `v: 2` resolves a dab through the static
  `brushCatalog`; `v: 3` carries its own sanitized inline dab
  (`normalizeInlineDab`, strict clamps — a hostile op degrades to a bounded
  brush) embedded at pen-down from `NATURAL_DABS`, so editing that table only
  changes NEW strokes. Old shape branches are frozen; a new look is a new
  shape id.
- **One entry builder.** `makeStrokeEntryCore` decides the stroke buffer
  (`strokeBuffer.js`, bbox-capped at 2048², overflow = commit + restart), the
  dab renderer (`makeStrokeRenderer`: per-stroke walk state so wire batching
  can't move dabs; dice from `pointRand(seed, x, y)`), the commit passes, the
  pad and the commit composite (`getStrokeComposite`: multiply for marker /
  pencil / watercolor under a luma guard) for every consumer.
- **Sprite dabs** (`brushSprites.js`): the v3 shapes (wash, graphite, wax,
  softOval, matte, loaded, halo) are ONE `drawImage` of a fixed-seed 128²
  atlas variant per dab, tinted through a pre-allocated 32-slot ring. Atlases
  are built from integer / polynomial / sqrt math only (no libm, no
  rasteriser), so every client builds the same bytes; formulas are immutable
  once shipped. Prebuilt in idle time after the studio mounts (one piece per
  idle slice, deferred while a pointer is down), released on unmount / hidden.
- **Pigment mixing** (`pigment.js`, dabs with `mixModel: "km"`): a dab's
  colour is a Kubelka-Munk mix of what the bristles carry and the paint under
  it (sampled from the 1/8-scale layer-0 mix map, `mixMap.js`). Sample-free
  brushes (marker, ink, pencil, crayon, dry watercolor, glow) never touch the
  map; watercolor mixes by its multiply glaze instead.
- **Commit passes** (`prepareStrokeCommit`, order frozen: end → bleed → wet
  edge → impasto → granulation → grain) run inside the buffer before its single
  opacity-stamped commit, on the renderer's **ink bbox** (a tracked superset of
  the stroke's pixels) rather than the whole allocated buffer — pixel-identical
  and several times cheaper on CPU-raster canvases (iPad Safari).
- **Smudge / Blend** (brush id `smudge`, private rooms; `settings.v >= 3` +
  `settings.smudgeMode` "drag" | "blend", one `normalizeSmudgeSettings` for every
  consumer; ops without `v` keep the legacy square sample-and-drag verbatim).
  Both modes copy the dab rect layer 0 → 256² scratch → layer (never a
  self-referential `drawImage` of the 4000×2500 layer, ~8 ms per dab), feather
  it with the soft mask, and land in a stroke buffer sampled from the
  PRE-stroke paper (a live re-sample on a transparent layer recycles its own
  deposits and saturates). Drag carries a fading load of what the finger
  touched on a shared 128² pad; Blend redeposits a box-pyramid blur in place.
  A v3 smudge past a remote consumer's 4-buffer cap is skipped (documented
  with the symmetry-copies divergence below).

**Lab + golden workflow** (`scripts/brush-lab.mjs`): headless Chromium runs
strokes / mixing / determinism / timing / pen-up-pop scenarios and a static
guard on the per-dab hot path (no readbacks, filters, allocation). The golden
gate: `scripts/lab/golden-ops.json` is a frozen op fixture (generated by
`scripts/lab/make-golden-ops.mjs`; `--check` proves the committed file matches
the generator and runs inside every golden run), replayed group by group
through `replayFrameOnto` and SHA-256'd against `scripts/lab/golden.json`.
`node scripts/brush-lab.mjs --golden` must pass before any engine change
lands; `--golden-record` re-baselines, and only groups whose ops legitimately
changed may move (the Stage-0 groups never do). `scripts/sprite-lab.mjs`
checks the atlases (build math, determinism across builds, tint-ring
allocation, rim contrast). The engine is not allowed to add jank to the canvas
for any feature: the lab's timing tables are the budget.

**Known divergences** (local vs remote / replay; bounded, documented, and
pinned by goldens where noted rather than fixed):

- Ops carry no layer, so a remote / replay consumer commits every stroke to
  layer 0 while the studio commits to the active layer — a pre-existing class,
  widened by multiply: a multiply stroke on a layer ≥ 1 multiplies over
  different pixels locally than remotely.
- Remote / replay consumers cap concurrent buffered strokes at 4
  (`MAX_STROKE_BUFFERS` / `REMOTE_BUFFER_CAP`); a symmetry stroke with ≥ 5
  copies keeps every copy buffered locally but replays copies 5+ on the legacy
  direct-segment path (no dabs, no passes). Pinned by the `symmetry-radial8`
  golden.
- Symmetry + a stroke long enough to overflow the buffer + copies that
  overlap: the local studio banks each copy's chunk the instant that copy
  overflows, in copy order per point, while a replay consumer expands the op
  into per-copy strokes and walks them batch by batch, so overlapping chunks
  can commit in a different order (source-over shapes only).
- Non-hex colour strings: the legacy vector branches paint whatever the canvas
  parses, but sprite shapes tint through `parseColorRgb`, whose fallback is
  near-black — deterministic on every consumer, just not the legacy colour.

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
- `.admin-key`, `.reports.json`, `.metrics.json`, `.analytics.json`.

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
