# Drawesome — Vision, Status & Roadmap

## What we're building
A **real-time, paint-together studio for kids and friends**, live at
**drawesome.art**. Mobile/tablet-first. Fun, safe, and self-hosted so it costs
nothing to run and the family owns all the data. An iOS app (Expo) shares the
same backend later.

**Guiding principles**
- **Anonymous-first**: you can paint immediately, no account. Sign-in only adds
  ownership, hosting, and a cross-device gallery.
- **Kid-safe**: a grown-up signs in and owns/hosts a room; per-room moderation
  (lock/clear/kick/mute); a report flow to a `/admin` portal. Real-money features
  are deliberately off.
- **Self-hosted & portable**: one folder, three Docker containers, your Cloudflare
  tunnel. Move it to any machine by copying the folder.
- **Nothing precious is lost**: room murals persist; signed-in art syncs to a
  per-account gallery.

## Status — what's built ✅
- **Realtime multiplayer** on one shared canvas (op relay + history replay); rooms
  persist across restarts; public `MAIN` + private invite rooms.
- **Big mobile-first studio**: huge pan/zoom canvas, brushes/colors/size/opacity,
  layers (capped), animation loop + GIF export, draggable/resizable chat, tools
  drawer + quickbar, avatar/profile.
- **Accounts via PocketBase** (Google OAuth, optional), bridged into the live
  socket; **per-room host controls** (own/host, lock/clear/kick/mute/rename/promote)
  enforced server-side and hardened (kick-ban, persistent mute, auto-unlock, no PII).
- **Coloring sheets**: a **6,294-sheet searchable library** (filename-derived
  search, no AI classifier), served from a volume with generated thumbnails; a
  studio search modal (search/preview/add); one-sheet-per-room with wipe-on-change;
  "Today's theme" (admin → holiday → daily rotation). Plus admin custom uploads.
- **Play-money "drops"**: earn by painting, spend on cosmetics; real-money OFF.
- **Monetization foundation**: adult-owned Drawesome Family ($4.99/month or
  $39/year) with Stripe-hosted checkout/portal, owner-level ad-free rooms that
  include anonymous invitees, child-treated chat display inventory, and manual
  interstitials triggered only at saves/exports/game-round breaks. All rails are
  env-gated; Family prices are verified against Stripe, webhook state is
  durable/order-safe, payment failure has a bounded grace window, and account
  deletion queues cancellation until Stripe confirms it. Paid coins, tips,
  payouts, and child-facing purchases remain OFF.
- **Save & return**: anonymous "My Art" + a signed-in gallery synced to PocketBase
  `snapshots`.
- **Moderation**: `/admin` portal (live metrics — peak users, CPU%, event-loop lag,
  per-room activity — reports, room clear, sheet management).
- **Self-hosting**: Dockerized stack (Node app + PocketBase + cloudflared), one
  `DATA_DIR` volume + `pb_data` + `coloring-library`, a backup script, full
  portability docs.

## In-flight / next ⏳
(Tracked in the session task list; pick up here.)
- **Gallery autosave + live cross-device verify** — the signed-in `snapshots`
  sync is wired but needs verification against a live PocketBase + a "My Gallery"
  view and autosave-on-save polish. (#36)
- **New-room modal** — Blank canvas / Today's theme / Pick a coloring sheet, plus
  a **copyable short join link** to text a friend. (requested, not yet built)
- **Admin: set Today's theme** — endpoint exists (`POST /api/admin/sheet-theme`);
  needs a button in `LiveAdmin`.
- **Harden WS auth transport** — move the token out of the `/ws` URL (first-message
  auth or subprotocol), register the message listener synchronously, keep the token
  in a ref so hourly refresh doesn't force a reconnect, and add a full owner-reclaim
  path beyond auto-unlock. (#40)
- **Watermark swap** — the 6,294 sheets carry the owner's old "DirectColoring.com"
  watermark; once logo/domain are final, a batch job replaces it + regenerates
  thumbnails. (#41)

## Deferred / future 🔭
- **Apple sign-in** — PocketBase supports it; needs the $99/yr Apple Developer
  Program + a Services ID. Google ships first.
- **iOS app** — the Expo target under `mobile/` shares the PocketBase backend.
- **A real economy** — explicitly NOT without legal review. In-app purchases,
  creator payouts, and cashable tips involve minors + money = app-store rules,
  COPPA, and money-transmission obligations. A safe **play-money** "drops" stand-in
  is what ships.
- **Coloring sheets at scale** — move sheet images to a CDN/object store + signed
  URLs if the library grows well beyond ~6k or traffic spikes.

## Key product decisions (the "why")
- **PocketBase over Supabase** — the repo originally shipped a (dormant) Supabase
  backend; we switched to self-hosted PocketBase to avoid a monthly bill + a 1 GB
  storage cap that collides with the coloring-sheet library. The Supabase schema
  remains under `backend/supabase/` as reference only.
- **Tunnel in the Docker stack** — cloudflared runs as a compose service so the
  whole thing is one command + portable. Its public hostnames must point at the
  **service names** (`app:8787`, `pocketbase:8090`), not `localhost`.
- **Filenames, not a classifier** — the coloring-sheet filenames are descriptive
  English, so search is free and instant; no vision model needed.
- **Owner-confirmed content** — the 6,294 sheets are the owner's; we keep the
  existing watermark (don't strip third-party marks) pending a deliberate swap.
