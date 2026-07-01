# Drawesome roadmap — from the July 2026 full audit

Full machine-readable findings (51, all file:line-cited): `docs/audit-2026-07.json`.
Goal: best-in-class paint-together for kids **and teens**; drawing performance is paramount.

## Sprint 1 — SHIPPED (quick wins)
- Server: WS perMessageDeflate (16.5MB join → ~2MB), immutable caching for hashed assets,
  async room persistence (no more event-loop stalls), spectator history capped at 1500 ops
  (+ no chat for spectators), room prompt in the join handshake, fun unique guest names
  ("Neon Fox"), 4 teen-coded featured rooms.
- Client perf: autosave paused during strokes/gestures, cursor pump re-render bailout,
  rAF-coalesced gesture blits + remote-op renders, no full re-render at pen-down,
  pressure quantization + duplicate-point dedup (~2x op bytes).
- UX: room-full/blocked dead ends → friendly card, all shares rebranded Drawesome
  (+ share-sheet invites), welcome modal skipped on join links + teen-neutral copy,
  chat starts closed on phones, room prompt chip, "Start a room with friends" CTA on home,
  login lands in login mode, Discord sign-in button (needs PB config).
- Build: worker { format: 'es' } (5.5MB NSFW worker now code-split), SW cache exclusions.

## Next up (in rough priority order)

### 1. Brush Engine → Procreate-grade (the centerpiece)
Blueprint in audit lens 4. Staged; each stage keeps multiplayer replay deterministic and
respects the iOS canvas-memory ceiling (bbox-capped ≤2048² stroke buffer, NEVER a third
full-size canvas).
- **Stage 1 (fixes #62 + #63):** bbox stroke buffer composited once per frame at stroke
  opacity (kills per-segment opacity accumulation); velocity→pressure synthesized in
  getPoint (capture-time = replay-free); `end:true` stroke marker + idle-timeout commit
  (also fixes the remoteStrokeLastRef leak); `settings.seed` + mulberry32 PRNG replacing
  Math.random in brushes (determinism prerequisite).
- **Stage 2:** shared `makeStrokeRenderer` stamped-dab core (spacing, pressure curves,
  scatter, tangent rotation, grain), quarter-px coords, tilt capture, settings.v=2.
  Trap: PRNG/spacing state must be batch-boundary-independent; add a replay-equivalence
  image-diff test.
- **Stage 3:** oil/acrylic/watercolor (bristle sub-dabs, streaks, wet-edge, grain,
  impasto — all one-time bbox-buffer passes at commit) + smudge (always samples layer 0;
  live-view divergence is bounded + self-heals on history frames).

### 2. Structural join fix: history snapshot + tail
Server-side compaction: elected client uploads a flattened PNG keyframe tagged lastOpId;
joiners get snapshot + tail ops. Join payload becomes ~300KB regardless of room age.
Must rebuild snapshot when moderation hides an op ≤ sinceOpId. (Audit lens 2, critical.)

### 3. Remaining canvas perf (medium/large)
Viewport-rect compositing in renderStrokeFrame (biggest 120Hz win), dirty-rect undo
snapshots (kills 40MB clones + pen-down latency), chunked history replay, lazy overlay
canvas, tiled flood fill, onion-skin cache.

### 4. Discord pack part 2
Per-room OG embeds (server /join/:code HTML route, ~40 lines) + client-posted room
snapshot for og:image + host-gated webhook relay (POST /api/share/discord,
DISCORD_WEBHOOK_URL in .env). Blocker note: spectate has no audience gate — decide
before shipping any public /watch overlay (audit lens 5, last finding).

### 5. Social juice
Ephemeral emotes (non-persisted WS overlay — no op-history/perf impact), "Share GIF"
via navigator.share, surface Replay/timelapse in the top action row, session recap.

### 6. Later
Discord Activity (v1 anonymous, embedded-app-sdk, instanceId→room), Twitch OAuth +
/watch OBS overlay (gate spectate first), code-split router (React.lazy), SW LRU cap.

## User actions needed
- Discord OAuth: create app at discord.com/developers → OAuth2 redirect
  `https://pb.drawesome.art/api/oauth2-redirect` → enable Discord provider in PB Admin
  (users collection → OAuth2) with client id/secret. Button appears automatically.
- Note: Discord ToS is 13+ — sign-in is optional and guests are unaffected.
