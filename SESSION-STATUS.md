# Happy Paint — Session Status & Resume Notes

_Last updated: 2026-06-16. Branch: `big-changes`. Working tree: **clean** (everything committed)._

This file is a handoff so we can pick up exactly where we left off after a restart.

---

## TL;DR — where we are

A full session of feature work + a performance/bug audit + all fixes + Supabase
wiring is **built, committed, and passing static checks** (web build+lint, mobile
typecheck). **Nothing has been run at runtime yet** — that's the next phase.

We just decided to set up **actual testing**. Two decisions were made right before
the restart:

1. **Test scope = "Full local pyramid"** — Vitest unit tests (web + shared mobile
   logic) + Playwright headless web smoke + **local Supabase via Docker** for real
   auth/sync integration tests. All local, free, no accounts needed.
2. **DigitalOcean MCP = "Yes, guide me through it"** — set up the DO MCP server +
   API token in Claude Code settings so the assistant can deploy + read build logs
   later. (This is the deploy layer, separate from testing; it creates real billable
   resources, so we do it deliberately.)

**➡️ NEXT ACTION when we resume: start building the Full Local Pyramid test setup
(begin with Vitest unit tests), and separately walk through DO MCP setup.**

---

## Environment facts (confirmed this session)

- Node v22.18.0, npm 11.6.0.
- **Docker is installed AND running** (28.0.4) → local Supabase stack is feasible.
- **No** Supabase CLI installed yet (need `npm i -g supabase` or `npx supabase`).
- **No** test tooling yet (no Vitest/Jest/Playwright, no test files).
- Network/installs work in this environment (we installed deps successfully).
- Web: `npm run build` + `npm run lint` clean. Mobile: `npm run typecheck` clean.

---

## What's been built & committed (this session)

Branch `big-changes`, 11 commits (newest first):

| Commit | What |
|--------|------|
| `3bcdc69` | Code-split web Supabase SDK (own chunk, lazy) + `HOSTING.md` beginner guide |
| `be3ac43` | **Supabase wiring**: real auth + local-first sync + account purge (web + mobile) |
| `b98bd7e` | Admin moderation queues + optional auth/sync + in-app account deletion |
| `85cc835` | Event Engine UI + Community Brush Pack publish/browse (web + mobile) |
| `101ed28` | Snapshot replay/timelapse + local AI assist v1 + Brush Studio Lite (web + mobile) |
| `bcd22b0` | Backend schema + `docs/ai-policy.md` for replay/brushes/AI/account-deletion |
| `fda988c` | Drops/Kudos economy UI (wallet/store/creator dashboard) web + mobile |
| `d464af3` | gesture-handler input + IndexedDB gallery/Paint Space + DO deploy config |
| `3db15b1` | Fixed all Medium+Low drawing findings (W8–W17, M7–M17) |
| `9438540` | Fixed all Critical+High drawing findings (W1–W7, M1–M6) |
| `2decf1a` | Drawing performance/bug audit (`performance_audit.md`) + kanban |
| `7d1aa1c` | Layer Lite + tools + tiny loops + Paint Spaces + economy/paint-space schema |

### Feature areas now in the codebase (all local-first; backend optional)
- **Drawing**: Layer Lite, fill/shapes/text, transparent export, tiny animation
  loops (onion skin + GIF), snapshot-based replay/timelapse.
- **Paint Spaces** locker, **Brush Studio Lite** (create/apply brushes).
- **Economy** (Drops/Kudos wallet, store, creator dashboard) — mock, no real IAP.
- **Events** (lifecycle + voting) + **Community Brush Packs** (publish/browse/admin review).
- **AI Assist v1** — local/deterministic (palette/prompt/brush-recipe), consent-gated.
- **Auth/sync** — env-gated Supabase (magic link + Apple/Google OAuth), local-first
  sync of drawings→`project_snapshots` & paint space→`space_assets` (last-write-wins).
  Unset env = fully local-only.
- **Account deletion** (App Review requirement) — wipes all local stores + RPC.
- **Admin** moderation queues (brush packs + AI assets).

### Key docs to read on resume
- `kanban.md` — full feature board + status + what's deferred.
- `performance_audit.md` — the 34-finding audit (all Critical→Low fixed).
- `HOSTING.md` — beginner DigitalOcean + Supabase setup.
- `DEPLOY.md` — concise deploy reference + Supabase setup section.
- `docs/ai-policy.md` — AI consent/safety model.
- `backend/supabase/schema.sql`, `storage.sql`, `functions/purge-account/` — backend.

---

## The IMPORTANT caveat (why we're setting up testing)

Everything passes **build / lint / typecheck**, but **none of it has been run**:
no browser run, no mobile simulator/device, no live (or local) Supabase, no tests.
Much was authored by subagents. So treat it as "compiles + architecturally sound,
expect runtime bugs to surface on first real use." Testing is the next phase.

---

## Resume plan — Full Local Pyramid (do these in order)

### 1. Vitest unit tests (web + shared mobile logic) — start here
- `npm i -D vitest` (web root). Add `"test": "vitest run"` script.
- Target pure logic (no DOM/canvas needed): `src/utils/` — `layers.js`, `frames.js`,
  `fill.js`, `gif.js` (assert GIF89a header `GIF89a` + trailer `0x3B`), `economy.js`
  (ledger→balance, spend/credit/tip), `sync.js` (last-write-wins merge), `aiAssist.js`
  (deterministic palette/brush-recipe), `eventEngine.js` (lifecycle + one-vote),
  `brushPacks.js`, `paintSpace.js`.
- Mobile shared logic (TS): consider a separate Vitest/Jest project for
  `mobile/src/` pure modules (`gif.ts`, `economy.ts`, `sync.ts`, `aiAssist.ts`,
  `brushStudio.ts`, `eventEngine.ts`, `ids.ts`). Skia/RN-native parts can't run in Node.

### 2. Playwright headless web smoke
- `npm i -D @playwright/test && npx playwright install chromium`.
- Build (`npm run build`) + `npm run preview`, point Playwright at it (or use Vite
  dev server). Smoke flows: load `/studio`, draw via synthetic pointer events on the
  canvas, save to gallery, undo/redo, switch layers + frames, open Replay / AI /
  Brush Studio / Wallet / Store panels, export PNG. Assert no console errors.
- Also smoke `/` (marketing), `/admin`, `/join/CODE` routes render.

### 3. Local Supabase (Docker) integration tests
- Install CLI: `npx supabase init` then `npx supabase start` (boots Postgres+Auth+
  Storage in Docker; prints local URL + anon key + service_role).
- Apply `backend/supabase/schema.sql` then `storage.sql` to the local DB.
- Integration tests (Node + `@supabase/supabase-js`): sign up a user (verify the
  `handle_new_user` trigger creates a `profiles` row), upsert/select
  `project_snapshots` & `space_assets` by `(profile_id/owner_profile_id, client_id)`,
  verify RLS (user A can't read user B's rows), call `request_account_deletion()` RPC.
  Run the web app against the local URL/anon key to verify auth + sync end-to-end.
- `npx supabase stop` when done.

### 4. Mobile (cannot fully run here)
- Add Jest + react-native-testing-library for `mobile/src/` logic/component tests.
- True device runtime is the user's task: `cd mobile && npx expo start` → Expo Go on
  a phone, or a simulator. Provide a manual QA checklist (draw, layers, loops, GIF
  export, replay, economy/events/brush screens, account deletion, sign-in if cloud
  configured). Cross-device sync needs the local or cloud Supabase.

### 5. DigitalOcean MCP setup (deploy layer — user opted in)
- User wants guidance. Steps: create a DO API token (DO dashboard → API → Generate
  New Token, write scope); add the DigitalOcean MCP server to Claude Code MCP
  settings (the `update-config` skill / `.claude/settings.json` or `claude mcp add`),
  with the token as the credential.
- Then it can: create/inspect the App Platform app, set the `VITE_SUPABASE_*`
  build-time env vars, trigger deploys, and read build/deploy logs.
- ⚠️ Real billable, public resources — do deliberately, confirm before creating/deploying.

---

## Deferred / not yet done (tracked in kanban.md)
- Sync of economy/events/replay; binary file sync (PNG/replay/GIF) → Storage buckets.
- Real IAP (App Store / Play Billing) on the mock economy.
- Server-side AI (sketch cleanup, etc.) behind credits + the moderation queue.
- Creator payouts / UGC licensing (phased, guardian-gated).
- Bet #8 Discord Activity.
- Runtime E2E against a live (cloud) Supabase project + real device store builds.

---

## Quick resume checklist
- [ ] `git status` clean, on `big-changes`.
- [ ] Re-read this file + `kanban.md`.
- [ ] Start step 1 (Vitest unit tests).
- [ ] Then Playwright (step 2), then local Supabase (step 3).
- [ ] Add mobile Jest tests + QA checklist (step 4).
- [ ] Walk through DO MCP setup (step 5) when ready to deploy.
