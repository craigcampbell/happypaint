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
4. 🟩 Web: Tiny Animation Loops + Paint Space locker UI
5. 🟩 Mobile: Tiny Animation Loops + Paint Space locker UI

Biggest-first rationale: Layer Lite + drawing tools are the foundation everything else (loops, paint-space assets, replay) builds on, so they ship first alongside the data schema.

---

## Performance & Bugs (from `performance_audit.md`, 2026-06-15)

Audit of the drawing hot path across all platforms. Severity is the auditor's estimate. Fix order: data-loss → draw hot path → memory → export freeze → visible correctness → rest. See `performance_audit.md` for evidence, locations, and fixes.

**All Critical + High items fixed (2026-06-15).** Web build + lint clean; mobile typecheck clean.

### 🟩 Critical — DONE
- **W3 — Web autosave silently loses artwork.** ✅ Moved draft autosave to IndexedDB (blobs, large quota); failures now surfaced honestly ("Couldn't autosave — storage full"), dirty flag retained; legacy localStorage draft migrated. *(`src/utils/idb.js`, `App.jsx`)*
- **M1 — Mobile re-serializes whole project on every stroke.** ✅ 1s trailing debounce + flush on background/unmount/back; per-project files (expo-file-system) + lightweight index; one-time migration from old key. *(`App.tsx`, `storage.ts`)*
- **M5 — Mobile gallery silently wiped on Android.** ✅ Per-project files avoid the ~2MB CursorWindow; read failures logged & skipped per-entry (never returns `[]` destroying data); raw data preserved; coords quantized.
- **W1 — Web full multi-layer recomposite per pointer move.** ✅ Cached below/active/above composites at stroke-start → 3 blits/move regardless of layer count; full recomposite only on stroke-end/structural change.
- **W2 — Web onion skin recomposites neighbor frames every move.** ✅ Onion neighbors precomputed once into the cached "below" composite.
- **M2 — Mobile every committed stroke is a permanent Skia node.** ✅ Committed items flattened into cached `SkPicture` per run; dropped the 24-circle paint decoration; `LayerItemsNode` memoized.

### 🟩 High — DONE
- **W4 — Web undo history clones full layer stack/stroke.** ✅ Active-layer-only snapshots for brush/fill/shape/text; full-stack snapshots only for structural ops (~4× less memory/entry).
- **W6 — Web canvas blurry on HiDPI/tablets.** ✅ Display canvas backing store sized to `css × devicePixelRatio`; recomputed on resize + DPR change; doc stays 1600×1200.
- **W7 — Web GIF encode froze the tab.** ✅ Encoding moved to a Web Worker (`gif.worker.js`) with transferable ImageData; sync fallback; button disabled + status during encode.
- **W5 — Web display update not rAF-coalesced.** ✅ Per-move render gated behind a single pending rAF; flushed on stroke-end.
- **M3 — Mobile live stroke repaints entire scene each rAF.** ✅ Committed content now cached SkPictures; only the live-stroke node is dynamic.
- **M4 — Mobile unbounded spray growth + path rebuild.** ✅ `MAX_SPRAY_DOTS = 3000` cap; live path bounded; committed spray cached.
- **M6 — Mobile export race + UI-thread GIF freeze.** ✅ Single in-flight export lock (preview snapshot coordinated); `encodeGif` async with `setTimeout(0)` yields + sample stride 4; per-frame `SkImage.dispose()`.

### 🟩 Medium — DONE
- **W8** ✅ GIF buffer now growable Uint8Array · **W9** ✅ only affected frame thumbnails regenerated · **W10** ✅ fill writes back only the dirty sub-rect · **W11** ✅ shape preview clears only previous bbox · **W12** ✅ removed `onPointerLeave` (relies on pointer capture) · **W13** ✅ opacity slider rAF-throttled + single undoable snapshot per drag.
- **M7** ✅ `latestProjectRef` + synchronous `commitProject` so rapid commits chain · **M8** ✅ monotonic counter in shared `ids.ts` (also fixed double `createDefaultLayers` bug) · **M9** ✅ eraser uses `BlendMode.Clear` inside per-layer offscreen groups → truly erases, correct on transparent/sticker/GIF export · **M10** ✅ multitouch/palm guards (`touches.length > 1`); full pen tracking would need gesture-handler · **M11** ✅ all export/preview SkImages + sprite-sheet surface disposed · **M12** ✅ `ColorType.RGBA_8888`/`AlphaType.Unpremul` enums · **M13** ✅ `useImage(null)` guard + shared font cache per size · **M14** ✅ live stroke isolated in `<LiveStrokeLayer>` (parent chrome no longer reconciles per frame).

### 🟩 Low — DONE
- **W14** ✅ pen-priority + palm (large contact) rejection · **W15** ✅ anchor appended + deferred URL revoke · **W16** ✅ guarded `makeId` everywhere · **W17** ✅ playback uses rAF + timestamp accumulator.
- **M15** ✅ sticker-apply gated on canvas layout · **M16** ✅ export min-delay aligned to preview (40ms); disposal=2 kept (loops genuinely transparent) · **M17** ✅ snapshot failure reschedules preview only, no redundant save.
