# Creative Engine Roadmap — Gooey Finger-Paint, Brush Pack Imports, Vector Tools

Status: draft spec, branch TBD (post `content-moderation`)
Scope: three features layered on the stamped-dab engine (`src/utils/brushes.js`,
`src/utils/strokeBuffer.js`, `src/utils/mixMap.js`).

Two invariants outrank every feature below:

1. **Pixel-identical multiplayer replay.** Every consumer (local, remote, spectator,
   history rebuild) renders the same op stream to the same pixels. All randomness is
   seeded per stroke and derived from dab coordinates; walk state lives in per-stroke
   renderer instances; the bristle roll order is frozen (`brushes.js:536-538`) and
   existing catalog dab values are load-bearing for persisted history. We **extend**,
   never touch. Anything wall-clock-driven, `Math.random`-driven, or dependent on
   optional canvas features is banned from the dab path (the one accepted fork —
   wetEdge/impasto skipping on non-filter browsers, `brushes.js:944-957` — stays the
   only one).
2. **No canvas jank.** No parsing, decoding, allocation, or network on the draw hot
   path. Import-time work is import-time work.

---

## 1. Gooey finger-paint family (toddler room)

### Renderer: merge smudge + wet into one dab walk

Today displacement and pigment are separate: `makeSmudgeRenderer` drags layer-0 pixels
(drawImage sample-behind-motion, no pigment, `SMUDGE_STRENGTH=0.45`, `SMUDGE_DRAG=0.35`)
while wet mixing (`settings.wet`) tints deposits via the 1/8-scale `mixMap` mirror of
layer 0 (`WET_DRAG=0.15`, per-brush `WET_PICKUP`) but never moves paint. The gooey
renderer merges them: **per dab, displacement drawImage first, then the wet-tinted
deposit.** Four new dab params generalize the hardcoded constants:

| Param      | Generalizes                    | Meaning |
|------------|--------------------------------|---------|
| `smear`    | `SMUDGE_STRENGTH` (0.45)       | Re-stamp alpha of the dragged layer-0 rect per dab |
| `drag`     | `SMUDGE_DRAG` (0.35)           | Sample offset behind motion, fraction of dab size |
| `pickup`   | `WET_PICKUP` table             | How fast dab color bends toward sampled paint |
| `dragRate` | `WET_DRAG` (0.15)              | How fast the carried RGB chases crossed paint |

**Viscosity = presets over those four**, not a fluid sim:

- `goo-thick`: smear 0.5–0.6, drag 0.25, dragRate 0.08 — pudding.
- `paint-runny`: smear 0.2, drag 0.5, pickup 0.5, dragRate 0.3 — drippy tempera.

Perf contract: inherit the smudge drawImage trick (tiny source rects, source ===
destination is well-defined, **no getImageData**, `brushes.js:786-788`) plus the
existing `DAB_MIN_STEP`/`DAB_CAP` guardrails. A per-pixel sim or per-dab readback is a
non-starter under the no-jank rule.

### Room contract: direct-to-layer-0, single layer, always wet

Gooey renders **directly onto layer 0** like smudge — the op stream is the source of
truth and replay in server op order is deterministic; live concurrent overlap can
diverge briefly and self-heals on the next history frame (documented smudge caveat,
now inherited). To make that safe, toddler rooms pin the whole config:

- **Single layer, layer 0 only** — `mixMap` mirrors layer 0 only at 8px granularity;
  a second layer would make wet sampling read the wrong pixels. No layer UI at all.
- **Opacity locked to 1** — direct-to-layer rendering forfeits the uniform-opacity
  stroke-buffer commit; locking opacity means that path is simply never needed.
- **Ops always `wet:true`** — captured at pen-down as today; the toddler room has no
  dry mode, so every consumer takes the same branch. (Wet sampling is already accepted
  as not bit-exact cross-client due to canvas AA; gooey smearing widens that tolerance
  slightly — same class of divergence, wider window, documented.)

### Sound: dab-cadence triggers, zero canvas cost

SFX hook the **dab-emission cadence the renderer already produces** — the walk emits
dabs at spaced intervals, so "finger is smearing at speed X" is free information; no
extra canvas reads, no timers on the draw path. Triggers map 1:1 to the SFX inventory
in `docs/ASSETS-NEEDED.md` §3 (goo-smear-loop pitched by dab rate, goo-squish round-
robin on pen-down, goo-mix when pickup detects a color delta, goo-splat on large fast
dabs, goo-squeegee on clear, etc.). Sounds are **local-only — never networked** — and
the **global mute toggle is a hard requirement** (both already specced in
ASSETS-NEEDED §3). Audio scheduling runs off the dab callback into WebAudio; if audio
ever stalls, painting must not.

### Room design

- **Palette = 8–10 big paint blobs** (`icons/blob-*.svg`, ASSETS-NEEDED §4), not
  swatches. **Chunky sizes only** (3 sizes, all large). Butcher-paper canvas texture
  (`textures/butcher-paper.png`), fingerpaint grain multiplied into strokes.
- **Decision: chat is OFF entirely in toddler rooms.** Pre-readers can't read it, and
  every text surface is a moderation surface we'd have to staff (see safety audit).
  No text tool, no chat pane, no reactions requiring reading. Not a toggle — the room
  kind omits the feature, server-side (op kind allowlist, §4) and client-side.

---

## 2. Brush pack imports (.abr / .brush / .brushset)

### The v3 op contract: self-describing, asset-gated

Today `getDab` resolves only static catalog ids; unknown ids return null and the op
**falls to the legacy line path** (`brushes.js:144-147`) — a remote client that lacks
an imported brush would render a plain line and **bake it into layer pixels
permanently**. That fallback is correct for legacy ops and catastrophic for imports,
so v3 makes ops self-describing:

- **`settings.dab` inline in the op** (~100 bytes of params) — routing predicate
  extends cleanly: `v >= 3 → use settings.dab`, `v == 2 → getDab(brush)`, else legacy.
  Ops become immutable and replayable forever without catalog lookups.
- **Assets by content hash**: `stampId`/`grainId` are content hashes into a PocketBase
  `brush_assets` collection (tip PNG ≤ 512px, optional grain ≤ 256px). Content-hashing
  makes assets immutable and cache-forever.
- **Prefetch before render, always**: clients resolve and decode hashed assets
  *before* rendering or replaying a v3 stroke — never on the dab path. **Never relay a
  stroke a client can't render**: the sender prefetch-confirms its own assets are
  uploaded before emitting; receivers block that op (and only that op) behind asset
  fetch rather than falling through to the line-bake path.
- Import produces catalog-shaped records `{ id: 'imp_'+hash, tier: 'studio',
  custom: true, dab: { shape:'stamp', stampId, grainId?, ... } }` in a user-scoped
  dynamic catalog beside the static one.
- **Entitlement**: imports gated behind a `brush_import` tier flag. Playback of v3 ops
  is *not* gated — everyone must render everyone's strokes identically.

### .abr mapping table

| ABR feature | Maps to | Notes |
|---|---|---|
| Sampled tip (`samp` 8BIM) | new dab `shape:'stamp'` + `stampId` | pure drawImage, no filters |
| Spacing % | `dab.spacing` | identical semantic (fraction of diameter) |
| Scatter | `dab.scatter` + new `scatterCount`, both-axes flag | ABR stamps N dabs/step |
| Transfer (flow/opacity jitter) | `flow` + new seeded `flowJitter` | cheap, deterministic |
| Size dynamics min diameter | `minSize` (+ optional `sizeCurve`) | else accept our pressure^1.35 |
| Angle / roundness + jitter | `rotJitter` + new `angle` / `roundness` | ellipse squash on stamp |
| Texture | per-brush grain tile + strength only | no per-tip texture dynamics |
| Color dynamics | approximate: new seeded `tintJitter` | per-bristle tint machinery exists |
| Dual brush | **dropped** | |
| Airbrush time-buildup | **NEVER imported** | wall-clock breaks replay — clamp to flow |
| Erodible / bristle-3D tips, blend modes | dropped / deferred | `strokeBuffer.commit` already takes a composite arg if v3 wants modes later |

### Procreate .brush / .brushset (zip)

`Shape.png` → same `'stamp'` tip asset. `Grain.png` → per-brush grain tile via the
existing commit-time destination-out `applyGrain` path (world-aligned = Procreate's
"texturized"; "moving" grain needs per-dab texturing — skip). `Brush.archive`
(NSKeyedArchiver bplist): `plotSpacing→spacing`, `plotJitter/shapeScatter→scatter/
scatterCount`, `shapeRotation→rotJitter`, pressure size/min→`minSize`, pressure
opacity/flow→`flow`+`flowJitter`, `stampColorJitter→tintJitter`, taper → parked on the
reserved renderer `end()` hook (`brushes.js:768-772`). Procreate's wet engine
(dilution/charge/pull) maps to nothing — approximate with §1 gooey params or import dry.

### Hard rules

- **Tip downscale cap 512px at import** (ABR tips reach ~5000px) — respects the iOS
  canvas-memory guard already in `strokeBuffer.js:9-16`.
- **Parsing is import-time only.** .abr (undocumented 8BIM) and NSKeyedArchiver bplist
  parsers run in an import worker/flow, never at draw or replay time. The hot path
  sees only finished dab params and decoded bitmaps.

---

## 3. Vector tools (private / animation rooms)

**v1 vectors are commit-once and immutable — not retained/editable.** The whole
moderation and replay design rests on op independence: `mod_hide`/`mod_remove` filter
individual opId sets and rebuild the canvas from filtered history
(server.js:355-358, 1195-1204; App.jsx:4389-4419). An edit/transform op referencing a
hidden or removed create-op **dangles silently on replay** — the mural diverges per
client with no signal. So in v1 a vector shape is drawn client-side with full
node-editing UX, then committed as **one immutable op** on deselect/confirm.

- **If editing comes later**: moderation becomes group-aware first — a server-side
  `vectorId → [opIds]` index so hide/remove always takes the create-op and all its
  edit-ops together, preserving filter-and-rebuild with no dangling refs. Also scope
  the NSFW watcher's opId-**range** flags (server.js:1222-1236) so a corroborated
  auto-hide can't take unrelated concurrent work.
- **Bake-on-deselect option**: rasterize the committed vector into history as a
  snapshot-style op to bound replay cost in long-lived rooms (mirrors the keyframe
  plan for animation history trimming).
- **Gating**: vector op kinds allowed only where a room flag enables them
  (private/animation rooms — same pattern as the `wetCanvas` flag, server.js:875).
  Plus **`op.v` versioning: mixed-version rooms refuse entry rather than half-render**
  — today old clients silently no-op unknown kinds (App.jsx:4286-4298), which for
  vectors means two users see different murals with zero error.

---

## 4. Shared prerequisites + build order

**Step 0 — server-side op validation lands BEFORE any new op kind.** The relay spreads
whatever clients send (server.js:925), only `text` and smudge are inspected
(server.js:914-922), and there is no ws `maxPayload` (server.js:75-81 → ws default
100 MiB). Required before v3/gooey/vector ops exist: per-room-kind **op kind
allowlist** (toddler rooms accept only gooey draw ops — no text/image/chat; vector
kinds only where flagged), **per-op serialized size cap** at ingest, and an explicit
**ws maxPayload (1–2 MB)**. Cheap, and it closes the unbounded-payload hole before
three new op families multiply it.

**Step 1 — `'stamp'` dab shape + v3 inline-dab contract.** The shared substrate:
imports need it for tips, gooey wants it for fingertip/sponge tips (ASSETS-NEEDED §7
tips double as import test fixtures). Includes the asset prefetch gate and
`brush_assets` plumbing. Extend the routing predicate; do not touch v2 semantics,
pointRand hashing, rand consumption order, or catalog values — all frozen by
persisted history.

**Step 2 — gooey renderer + toddler room.** Pure param work over existing smudge+wet
code once `stamp` exists. Room kind (single layer, opacity 1, wet-only, chat off,
allowlist) plus SFX wiring. Gated on ASSETS-NEEDED §3/§4 assets.

**Step 3 — format parsers.** Offline import-time converters (.abr first — the mapping
is cleaner — then Procreate), producing v3 catalog records + hashed assets. The draw
hot path never sees a parser.

Each step ships with a three-way replay parity check (local vs remote vs history
rebuild) on golden op streams — that harness is the acceptance test for all of this.
