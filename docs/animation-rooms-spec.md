# Drawesome Animation Rooms — Architecture Spec

Source: 6-agent engine recon + 3-lens design panel (performance / multiplayer-consistency /
product) + judge synthesis, 2026-07-03. Winner: the **consistency-first skeleton** — the only
design where everything that defines the animation (pixels AND structure) lives in one
opId-ordered log — grafted with the performance discipline and product skin of the other two.

## What we're building
A new room kind for collaborative 2D animation: skeuomorphic film-strip UI along the bottom
(scrub, select, per-frame eyeball), real onion skinning, multiple people drawing on their own
frames with presence ("Maya is drawing here"), multiple tracks on one timeline (art /
background / effects / storyboard / audio), ink-and-paint layer workflow, GIF now → real
video later. One public kid-safe playground room (**FLIPBOOK**); private animation rooms are
premium. A fun-first Toon Boom alternative.

## Found buried treasure
The client already ships a local-only "Tiny Animation Loops" feature: per-frame layer stacks
(`src/utils/frames.js`), onion-skin compositor, rAF playback, GIF89a worker export, and a
`FrameStrip` component in the tool rail with exactly the prop contract a film strip needs.
Increment 1 is a **relocation + upgrade**, not a greenfield build. Known debts it carries:
frames don't survive reload (draft saves active frame only), remote ops land on whatever frame
you're viewing (divergence), all downscale paths are squashed 4:3 (canvas is 8:5).

## Architecture (target state)

### Server data model
- `room.kind: 'canvas' | 'animation'` — touch the 3 whitelist sites (getRoom / loadRoom / saveRoomNow).
- `room.anim = { docW:1920, docH:1200, timelineLog, tracks, slots, cells, audio, caps }`
  - **Track** `{ id, name, kind:'raster'|'audio', order, visible, locked, exportable }` — storyboard = raster track with `exportable:false`, rendered picture-in-picture.
  - **Slot** `{ frameId (stable id, never index), durationMs 40–2000 (default 120), createdBy }` — one shared timeline across tracks so audio math stays trivial. Per-cell `hold` is a reserved later op.
  - **Cell** `{ trackId, frameId, ops[], opCount, byteCount, rev, lastCleared }` — created lazily on first op. A cell is "almost its own room": its own op log, clear/undo-clear, and moderation scope.
  - **Structural mutations are ops**: `TlOp { opId, kind:'tl', t: slot_add|slot_del|slot_move|slot_duration|track_add|track_del|track_set, …, userId }` — replayed FIRST on join → total order, no reorder-vs-delete-vs-join races. opId stays **room-globally monotonic** so existing moderation (hiddenOpIds, range hides) works unchanged; `opIndex: Map<opId, cellKey>` scopes hides to one cell.
- Draw ops gain `{ trackId, frameId }` tags (relay is payload-agnostic; old clients no-op unknown fields — verified forward-compatible).

### Messages
- Join: `connected` (+kind, doc size, caps, entitlements; client sends featureVersion — stale clients get a friendly refusal, not degradation) → `timeline { tracks, slots, cellMeta[{opCount, rev, thumb?}], audio }` → `cell_history` for the active cell only. **No more whole-room history burst.**
- Client→server: tagged `op`, `tl`, `cell_fetch`, `cell_clear` / `cell_undo_clear`, `presence_cell`, `thumb` (≤16KB, ≥2s throttle, cosmetic only — never in replay/export), `frame_claim`/release (soft).
- Server→client: `cell_history {…, replaces:true}`, relayed `tl`, `frame_full`, userList + `activeCell`, `audio_set`.

### Hardening (ships FIRST — fixes murals too)
- ws `maxPayload` 2MB; per-op serialized cap 256KB; per-user op-rate cap (rolling-window, same pattern as reactions).
- `FRAME_OP_CAP` 1200 (playground) / 2500 (private) with a visible fill meter and friendly `frame_full` — **never FIFO trim** (silently rots early frames).
- Persistence: `.rooms/<CODE>/meta.json` + `cell-<t>-<f>.json`, dirty-only, debounced, temp+rename. No stringify over ~2.2MB → kills the whole-room sync-stringify event-loop stall (which today can hit ~17MB on one busy mural). Sweep parses meta only; cold cells LRU-unload.

### Client
- The live-alias frames machinery stays. Only the **active cell** hydrates a full layer stack (named **Rough / Ink / Paint** in animation rooms — the ink-and-paint workflow is just named layers). Other cells hold `{ ops, proxy (960×600 desktop / 480×300 mobile), rev }`, replayed in `requestIdleCallback`.
- Onion skin: pre-composited neighbour proxies, rebuilt off the pointer path, baked into the below-cache at pen-down — the existing zero-cost-per-pointermove invariant, kept byte-for-byte.
- Playback: ring of 3 composites; doubles as the onion source. Memory arithmetic closes at ~200MB worst case vs ~1.9GB naive.
- Draft schema v5 persists the FULL frames array (loops finally survive reload).

### Moderation
NSFW-watcher flags carry `{trackId, frameId}`; range-hides intersect ONE cell via opIndex;
rebuilds ship one `cell_history` — never the whole movie.

### Audio (private + `anim_audio` entitlement only)
Host-only HTTP multipart upload, sha256 content-addressed, server-side mime sniff, **2 clips ×
6MB × 90s**, never in the op log. Playback: rAF compositor derives the playhead FROM
`AudioContext.currentTime` (drift-free). Export mix via OfflineAudioContext. Files deleted on
room close + account scrub; reportable via existing plumbing. Copyright posture: DMCA contact
+ takedown flow before launch (see open questions).

### Export
100% client-side, always: GIF89a worker today (at fixed 320×200), WebCodecs + JS muxer
(mp4-muxer/webm-muxer) later for real video; OfflineAudioContext for the mix. No ffmpeg, no
server rendering — the brush engine only exists in the browser.

### Premium gating
PB entitlement flags `{ anim_private, anim_audio, anim_vector, brush_import }` read at WS
auth, **server-enforced**, client flags cosmetic. Public playground FLIPBOOK: 1 raster track,
12 slots, no audio/vector/smudge, full public-room moderation. Private rooms: 24 slots (hard
48), 3 raster + 1 audio track. `adult_18` refusals re-applied verbatim at creation AND join.

### Collaboration feel (the fun layer)
Presence rings pulsing on cels while someone draws; tap a ring to spectate that cel; **soft
claims** with a friendly "Maya is drawing here — pick a free frame?" nudge; host can
hard-lock cels (server-enforced locks, soft claims stay social); projector-glow active cel;
film-splice reorder animation; scrub rail with waveform under it when audio exists.

## Shippable increments
1. **Film strip + onion rework (client-only, no wire changes)** — SHIPPING NOW. Bottom
   skeuomorphic strip (sprocket holes in pure CSS), scrub rail, per-frame local eyeball,
   onion-skin neighbour cache (kills 40MB-per-recomposite churn), thumbnails off the pen-up
   path, 8:5 aspect fixes everywhere, remote ops pinned deterministically to frame 1 in
   shared rooms (divergence guard) with a LIVE badge.
2. **Persistence + HUD extraction** — draft v5 (full frames array); extract Topbar/quickbar/
   modals from the 6,899-line App.jsx so film-strip work and restyling stop colliding.
3. **Server hardening** — maxPayload, op caps, rate caps, per-cell persistence files. Helps
   murals immediately; prerequisite for animation rooms.
4. **Animation room kind** — timelineLog + cells + lazy join + FLIPBOOK playground (12 slots).
5. **Collab presence** — presence_cell, soft claims, cel spectate, host locks.
6. **Tracks** — background/effects/storyboard lanes; PiP storyboard.
7. **Audio track** (premium) + waveform scrub.
8. **Real video export** (WebCodecs) + premium private rooms GA.
9. **Vector ops** (commit-once immutable) in private/animation rooms — last.

## Open product decisions (Craig)
1. Playground generosity: 12 frames / ~6s enough for the free taste?
2. Conflict model: soft claims everywhere, or server-enforced claims in the public playground
   (griefing risk)? Middle ground = host-lockable cels.
3. Confirm 1920×1200 animation doc (vs 4000×2500 murals); drop playground to 1600×1000?
4. Increment-1 posture: remote ops pin to frame 1 (chosen — least surprising), or hide
   add-frame in shared rooms entirely?
5. Eyeball = LOCAL preview mute only (chosen). A shared/host-forced hide would drag
   presentation state into replay + moderation scope. OK?
6. Audio launch caps (2×6MB×90s) + copyright stance (hash blocklist? DMCA contact page?).
7. Which entitlements bundle into the first paid tier (see docs/pricing-tiers.md).
8. Is GIF-only OK for playground launch, with MP4/WebM as the premium hook?
