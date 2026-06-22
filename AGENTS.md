# Working in this codebase (for developers & AI agents)

Read [ARCHITECTURE.md](ARCHITECTURE.md) first for the system map, then this for
how to actually make changes. [ROADMAP.md](ROADMAP.md) has the vision + what's next.

## The golden rule: env-gated, anonymous-first
The app **must run fully without any accounts/cloud config**. Anonymous painting,
rooms, coloring sheets, and play-money drops all work with PocketBase unset. Every
account/sync/host feature is gated on `isCloudConfigured` (client) /
`PB_URL` (server) and fails closed to anonymous. **Never** make a core feature
require sign-in. When adding anything account-related, test the unconfigured path
doesn't regress.

## Run, build, verify
```bash
npm install
npm run dev            # Vite :5173 (proxies /ws → :8787)
node server.js         # the realtime server :8787 (serves dist/ in prod)
npm run build          # → dist/
npm run lint           # eslint, zero-warnings policy
```
Docker: `docker compose --profile tunnel up -d --build` (full stack). Plain
`docker compose up -d` = app + pocketbase only (no tunnel/token needed) for local.

### How to verify a change (do this — don't hand it to the user)
- **Build must pass** (`npm run build`) and `node --check server.js` for server edits.
- **Realtime / server logic**: write a throwaway Node WS script (`ws` is a dep)
  that spins up `server.js` with test env + a mock auth HTTP endpoint, connects
  clients, and asserts. This is how ownership/host/lock/kick/mute were verified
  without a live PocketBase. Mock `PB_URL` → an endpoint returning
  `{record:{id}}` at `POST /api/collections/users/auth-refresh`.
- **UI**: use the Preview MCP (`.claude/launch.json` runs `node server.js`,
  autoPort). Navigate via `history.pushState` + `popstate`. Snapshot / eval to
  confirm, screenshot for proof. The viewport is mobile (375px) — that's the
  primary audience.
- Always check the **anonymous path** still works after account-related changes.

## Conventions & gotchas
- **`src/App.jsx` is one ~4,900-line component.** Find the right spot with Grep,
  read the surrounding lines, match the local style. State is declared up top;
  imperative canvas/multiplayer logic uses refs (`mpRef`, `layersRef`, etc.).
- **Single shared canvas**: all draw ops land on `layersRef.current[0]`. The
  server is an op-relay; don't add per-user canvases.
- **WS protocol**: to add a realtime action, add a `send*` in
  `useMultiplayer.js`, a `case` in the `server.js` message switch (guard
  host-only actions with `isHost`), and handle the server→client message in
  App.jsx's `handleMpMessage`. Persisted room fields go in `loadRoom`/`persistRoom`/
  `getRoom` together.
- **Server data paths** all derive from `DATA_DIR` — keep it that way so one
  Docker volume captures everything.
- **Account deletion is App-Review load-bearing**: any new durable client store
  (localStorage/IDB key) MUST be added to the wipe lists in `accountDeletion.js`,
  and server-side rows must cascade. Don't silently leave data behind.
- **No secrets in the client bundle** (only `VITE_*` public values). The server
  validates PocketBase tokens with the public anon endpoint — never the
  service-role key.
- **Commits**: work on a feature branch (currently `big-changes`, not `main`).
  For multi-line messages, write a temp `.commitmsg.txt`, `git add` the *specific*
  files (not `-A`), `git commit -F`, then delete it (it's git-ignored). End
  messages with the `Co-Authored-By:` trailer. The user pushes; don't push for them.

## How to add a typical feature (the pattern)
1. **Server**: a REST endpoint and/or a WS message case in `server.js`.
2. **Client transport**: a `send*`/fetch in `useMultiplayer.js` or a util.
3. **UI**: wire into `App.jsx` (state + handler + a component/modal in
   `src/components/`). Reuse `modal-backdrop` / `studio-modal` classes; modals use
   `z-index: 200` to sit above the chat + quickbar.
4. **Verify** (above), **build**, **commit**.

## Hard "do not"s
- **Do not** wire up the real-money economy (in-app purchases, payouts, cashable
  tips). Play-money only. Real money + minors = legal/app-store/COPPA territory.
- **Do not** enter the user's credentials anywhere, or mutate their Cloudflare
  account (DNS/tunnel) on their behalf — guide them; they execute.
- **Do not** host third-party/copyrighted content publicly without confirmed
  rights. (The 6,294 coloring sheets are the owner's; the watermark swap is a
  tracked task, not a "strip someone else's mark" job.)
- **Do not** require sign-in for core features (see the golden rule).

## Docs index
`ARCHITECTURE.md` (system) · `AGENTS.md` (this) · `ROADMAP.md` (vision/status) ·
`POCKETBASE_SETUP.md` (accounts + tunnel) · `MOVING.md` (portability) ·
`RUNNING.md` (operate) · `DEPLOY.md` (legacy/DO notes).
