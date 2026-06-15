# Happy Paint — Feature Kanban

Derived from `docs/product-research.md`, `docs/paint-economy.md`, and `docs/social-backend.md` (research pass 2026-06-15).

Cards are ordered by **product-bet impact** (research §"Product Bets"). Every feature card calls out the work needed per platform:
- **Web** — `src/` (React, immediate-mode 2D `<canvas>`)
- **Mobile** — `mobile/` (Expo + Skia; one codebase serves **iOS and Android**)
- **Backend** — `backend/supabase/schema.sql`

Legend: 🟥 Backlog · 🟨 In Progress · 🟩 Done · ⬛ Deferred (needs prior phase / external dependency)

---

## Done (already in product)

🟩 Fast web canvas + Skia-native mobile drawing surface
🟩 Browser studio + native mobile app shells
🟩 Invite rooms / share links / planned sessions (`TogetherPanel`, `TogetherScreen`)
🟩 Discovery hub: topics, tags, events, gallery voting (`DiscoveryHub`, `DiscoverScreen`)
🟩 Host-configured artist/viewer roles
🟩 Admin moderation, room monitoring, bans, network controls (`AdminConsole`)
🟩 Kid-safe / friends / adult room gates
🟩 Backend schema: sessions, discovery snapshots, events, gallery posts, votes, admin audit
🟩 Local gallery + autosave draft + PNG export/share (web + mobile)
🟩 Image import (mobile)

---

## Critical Gaps → Backlog (ordered, biggest first)

### Bet #1 — Paint Spaces (personal asset locker + identity)  🟥
Product's "center of gravity." Personal creative locker for stickers, palettes, templates, loops, brushes.
- **Backend**: `space_profiles`, `space_assets`, `asset_packs`, `asset_uses`, `remix_lineage` tables + RLS.
- **Web**: "Save to Paint Space" from canvas; locker view; reuse asset on canvas; personal palettes.
- **Mobile**: same locker + asset picker, AsyncStorage-backed offline + sync-ready shape.

### Bet #2 — Tiny Animation Loops  🟥
2/4/8-frame loops, onion skin, duplicate-frame, per-frame duration, GIF/APNG export.
- **Web**: frame model on canvas, onion-skin overlay, GIF encode + download.
- **Mobile**: frames as stroke-list array, onion skin via Skia opacity, GIF export via frame snapshots.
- **Backend**: loop persistence columns on project/asset (frame count, durations).

### Bet #3 — Layer Lite  🟥 (FOUNDATION — table stakes)
MVP layers: Background / Sketch / Color / Detail / Sticker-import. Rename, hide/show, opacity, lock, reorder, merge-down, duplicate.
- **Web**: refactor single canvas → stacked layer canvases; layer panel UI; composite on export.
- **Mobile**: add `layerId` to strokes + `layers[]` on project; layer panel; render grouped by layer.
- **Backend**: per-layer autosave format (layer metadata on session/asset).

### Foundation drawing tools (Priority 0)  🟥
Required for "drawing credibility." Bundle with Layer Lite where files overlap.
- Fill / bucket
- Shape / line tool (rect, ellipse, line)
- Text tool
- Rectangle selection + move/scale/rotate selected content
- **Transparent PNG export** (web composite currently forces a paper background)
- Import image into a *movable* layer (web; mobile has static import today)

### Bet #4 — Community Brush Packs  🟥
Brush Studio Lite + brush cards (name, thumbnail, tags, age rating, remix permission) + packs + admin review.
- **Backend**: extend asset model with brush-recipe `space_assets` of kind `brush`; moderation queue.
- **Web/Mobile**: Brush Studio Lite editor; save/share brush recipe; apply community brush.

### Bet #5 — Event Engine  🟥 (partially present)
Daily prompt, weekend challenge, voting window, gallery winner. Lifecycle `draft→upcoming→live→voting→ended` exists in schema; needs UI loop + prompt packs.

### Bet #6 — Room Replay & Timelapse  🟥
Timelapse export, room replay of stroke stream, "remix from timestamp," before/after, process cards.
- **Backend**: `stroke_events` exists — add replay snapshot/timelapse asset records.
- **Web/Mobile**: record stroke stream, replay player, timelapse video/GIF export.

### Bet #7 — AI Assist (safety-gated)  🟥
Palette-from-theme, kid-safe prompt cards, sketch→line cleanup, brush-recipe from text. Needs AI policy + consent + generated-asset moderation queue first.

### Economy foundation — Drops & Kudos  🟥 (schema-first)
Replaces today's "Demo Drops" placeholder toggle with real model.
- **Backend**: `wallets`, `wallet_ledger_entries` (append-only), `drop_products`, `purchase_receipts`, `asset_products`, `tips`, `creator_payout_accounts`, `creator_payouts`, `economy_admin_actions` + entitlement flags.
- **Web/Mobile**: wallet UI, store, creator dashboard (mock until purchases wired).

### Bet #8 — Discord Activity Pilot  ⬛ (external surface, late-stage)

---

## Cross-cutting / Compliance  🟥
- Real cloud account/sync implementation (Supabase auth wiring)
- Entitlements/subscriptions/purchase schema
- AI safety policy + consent model
- Creator payout / UGC licensing model (phased, guardian-gated)
- In-app account deletion (App Review requirement)

---

## Active Implementation Plan (this session)

**Wave 1 (parallel — no file conflicts):**
1. 🟨 Backend schema: Economy + Paint Spaces + entitlements + layer/frame persistence → `schema.sql`
2. 🟨 Web Studio: Layer Lite + fill + shapes/line + text + transparent PNG export
3. 🟨 Mobile Studio: Layer Lite + fill + shapes/line + text + transparent PNG export

**Wave 2 (builds on Wave 1 layers):**
4. 🟥 Web: Tiny Animation Loops + Paint Space locker UI
5. 🟥 Mobile: Tiny Animation Loops + Paint Space locker UI

Biggest-first rationale: Layer Lite + drawing tools are the foundation everything else (loops, paint-space assets, replay) builds on, so they ship first alongside the data schema.
