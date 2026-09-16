# Plan: shared layers in rooms (layers that survive leaving, rejoining, and collaborators)

Status: EXECUTED (implemented the same day on `codex/youth-design-refresh`).
Shipped as written below, plus what the work forced: `layer_dup` / `layer_merge`
/ `layer_flatten` are server-side too (duplicate copies the source layer's ops
under fresh ids the way a duplicated frame does; merge re-tags onto the layer
below and refuses a layer with erased strokes or a non-100% opacity; fun mode
collapses the room to one layer); the bottom layer can never be deleted; an op
naming an unknown layer is dropped unless the frame has exactly one layer (then
it lands there, as untagged ops always did); snapshot catch-up is skipped for
multi-layer rooms because a baked PNG cannot carry layers; and a locally-created
document (draft / gallery / remix / template) adopts the ROOM's frame id, or its
layer messages would resolve to no frame at all.

Read `AGENTS.md` first (env-gated / anonymous-first golden rule, verification
conventions, commit rules), then this. The two reproduction scripts referenced
below are already on disk, untracked, and passing.

---

## 1. The bug, verified

Layers work locally in a room and then silently come apart. Verified with a real
browser against a scratch server (Playwright + Chromium), not by reading code:

1. **A room history replay flattens the artist's own layer stack.** The panel
   keeps showing N layers, but every pixel is on layer 0 and layers 1..N-1 are
   blank. Triggered by join, reload, reconnect, any moderation action, and scene
   paging — not just reloads.
2. **The local autosave then persists the flattened stack**, so the layer split
   is gone from the draft as well (2 layers saved, pixels in one).
3. **A full reload** rebuilds ONE layer ("Canvas") with all the art on it. The
   art survives; the layering does not.
4. **A joiner mid-session gets one layer**, not the artist's stack — there is
   nothing for them to "help on".
5. **A joiner's stroke lands on layer 0 of the layered artist's canvas**, i.e.
   underneath the artist's upper-layer work. Measured: the artist's canvas did
   not change at all when the collaborator drew inside a region the artist had
   filled on layer 2 (ink 18144 → 18144); only hiding the artist's top layer
   revealed the visitor's stroke (2893).
6. **A replay is not a 1:1 redraw.** The artist erased on layer 0 while an upper
   layer covered the hole, so the screen did not change (2893 → 2891). After the
   room rebuilt the drawing the region was 0 — the erase had eaten the upper
   layer's ink too, because both strokes were replayed onto layer 0 in op order.
   Content the artist never touched disappeared. Z-order, hidden layers, layer
   opacity and layer-scoped erases all resolve differently on replay.

Raw evidence: section 10 (appendix) has today's script output, which is the
"before" baseline.

## 2. Root cause map

| # | Where | What |
|---|---|---|
| 1 | `src/App.jsx:3199-3217` (`relayStroke`) | The wire op is `{kind, strokeId, points, settings, frameId?, end?}` — **no layer field**. |
| 2 | `src/App.jsx:3185` | Outside animation rooms only frame 0 is shared, and layer identity never travels at all. |
| 3 | `server.js:3790-3835` (`case 'op'`) | The server relays ops **opaquely** (it only rewrites `settings.symmetry` and validates size/points/frameId), so a `layerId` field would ride through untouched. The server has no layer concept anywhere. |
| 4 | `src/App.jsx:7247-7249` (`case "history"`) | On every history frame the client **clears every layer of every frame**, then replays. |
| 5 | `src/App.jsx:6718-6725` (`frameBaseCtx`), `6799-6813` (`applyRemoteOp`) | Remote and replayed ops commit to `frame.layers[0]` — always. |
| 6 | `src/App.jsx:2375-2409` (`saveDraft`) | The autosave writes the live stack, so a flattened stack becomes the local draft. |
| 7 | `src/App.jsx:4589-4607` (`handleAddLayer`), `4630+` | Layer structure mutations are local-only: nothing is sent. |
| 8 | `ARCHITECTURE.md:69` | "everyone draws onto the same layer" is called *the defining design choice* — this plan changes that sentence. |
| 9 | `ARCHITECTURE.md:222-225` | Already lists "ops carry no layer" as a *known divergence* — as a render-fidelity note. It does not mention the local flattening, the durable draft damage, or the collaboration breakage. |

## 3. What to build

Layer **structure** (per frame: ordered `{id, name, visible, opacity, locked}`)
becomes shared room state, and each op records which layer it was drawn on. Pixels
are still never uploaded: a joiner rebuilds every layer by replaying the room's op
stream into the right canvas. Back-compat must be total — an existing room has no
layer list and no `layerId` on its ops, and must replay exactly as it does today.

**Decisions taken (defaults; proceed unless the user says otherwise):**

1. **Who may change layers** — any member in a private room, host-only in public
   (`kid_safe`) rooms. Mirror the existing `set_wet` / `set_symmetry` permission
   model (`server.js`, and `sendSetWet` in `useMultiplayer.js:286`).
2. **Deleting a layer purges that layer's ops** from the room history (reuse the
   moderation op-removal path at `server.js` `mod_remove`), or a replay would
   resurrect the layer.
3. **Snapshots stay off while a room has more than one layer.** The join-catch-up
   PNG is baked flat and cannot restore layer membership. Extend the existing gate
   (`snapshotDue` / `roomCanSnapshot`, `server.js:1157-1167`, which already
   refuses multi-frame animation rooms). Cost: big multi-layer rooms replay the
   full op stream on join — slower first paint, already covered by the join
   curtain. (Alternative, not chosen: upload one PNG per layer = N× bytes.)
4. **Wet / smudge / goo stay layer-0-only.** `mixMap` mirrors layer 0 only at 8px
   granularity; sampling it for an upper layer would read the wrong pixels. Block
   those brushes when the active layer isn't layer 0 (or, minimally, when a room
   has >1 layer). Layer opacity must stay 1 on layer 0 for the wet path.

**Caps unchanged** (keep the existing client caps and enforce them server-side):
6 layers per frame, 3 in animation rooms (`src/App.jsx:169,174`, `MAX_LAYERS` /
`ANIM_MAX_LAYERS`). Each layer is a full 4000×2500 canvas **per client**, so a
6-layer room is ~240MB of canvas in the browser — this is the main perf risk and
the reason for the caps.

## 4. Wire protocol

Client → server (all echoed to every member in server order, exactly like the
existing `frame_add` / `frame_del` / `frame_move` / `frame_duration` cases):

```
{ type: "layer_add",    frameId, afterLayerId, name? }      -> { type: "layer_add",    frameId, layer, afterLayerId, byUserId }
{ type: "layer_del",    frameId, layerId }                  -> { type: "layer_del",    frameId, layerId, layerIds (purged opIds), byUserId }
{ type: "layer_move",   frameId, layerId, toIndex }         -> { type: "layer_move",   frameId, layerId, toIndex, byUserId }
{ type: "layer_patch",  frameId, layerId, patch }           -> { type: "layer_patch",  frameId, layerId, patch, byUserId }
```

`frameId` omitted = the room's first frame (matches how untagged ops resolve).

Ops gain `layerId` (string, ≤24 chars, like frame ids). Absent = layer 0 (legacy).

The `history` frame (`server.js:1699` `sceneHistoryMsg`, and the join/`resync`
paths) must carry the frame layer lists — `frames` already rides along, so a
per-frame `layers` array is enough — so a joiner can materialise the stack
**before** replaying. `connected` should also advertise the layer caps.

## 5. Implementation tasks (order matters)

**Server (`server.js`)**

1. `sanitizeFrames` (`:1567-1577` → use `function sanitizeFrames(list)`; add
   `layers: sanitizeLayers(f.layers)`); write `sanitizeLayers`: array, ≤ cap,
   `id` string 1-24 chars + unique, `name` ≤ 40 chars, `visible` bool,
   `opacity` clamped 0..1, `locked` bool. Cap: 6 (3 when the room is an animation
   room) — read the cap the same way `frame_add` does for frames.
2. Persistence: `room.frames` is already written in the room JSON
   (`server.js:1360`) and read back through `sanitizeFrames` on load
   (`server.js:1895`), so per-frame layers persist for free **once step 1 lands**.
   Verify `loadRoom` (`:1229`), `persistRoom` (`:1403`), `getRoom` (`:1793`).
3. New WS cases next to the `frame_*` cases (`:4760-4900`): `layer_add`,
   `layer_del`, `layer_move`, `layer_patch`. Permission gate: host-only when
   `room.audience === 'kid_safe'` (same shape as `set_wet`), any member in private
   rooms; block while `room.locked && !isHost`. Echo via `broadcast(...)` +
   `persistRoom(roomId)`, and `invalidateRoomSnapshot(room)` (snapshot is stale).
4. `layer_del` also filters that layer's ops out of `room.history` (mirror
   `mod_remove`), rebuilds `room.frameOpCounts`, and returns the removed opIds so
   clients can drop them.
5. In `case 'op'` (`:3790-3835`): accept and validate `data.op.layerId` (string,
   ≤24, must exist in the target frame's layer list else drop the op — same
   treatment as a bad `frameId`); if the target layer is `locked` and the sender
   isn't a host, drop the op. Also make sure the op cap path and `opFrameId`
   (`:1594`) keep working for untagged ops.
6. Snapshot gate: `snapshotDue` + `roomCanSnapshot` (`:1157-1167`) return false
   when the room's frames have more than one layer in total.
7. Room hop / `fork_private` / `remixSource` / productions: no changes needed —
   they copy frames+ops wholesale, and the layer list rides in the frames.

**Transport (`src/hooks/useMultiplayer.js`)**

8. Add `sendLayerAdd`, `sendLayerDel`, `sendLayerMove`, `sendLayerPatch` next to
   the `frame_*` senders (`:293-307`) and export them from the hook's return
   (`:366`). `sendOp` (`:236`) needs no change (the op is built in App.jsx).

**Client (`src/App.jsx`)** — this is the bulk of the work

9. `relayStroke` (`:3199`): tag the op with the authoring layer id
   (`layersRef.current` active layer, or the frame's active layer for animation).
10. `applyRemoteOp` (`:6799`) + `frameBaseCtx` (`:6722`): resolve the target
    canvas as `frame.layers` matched on `op.layerId`, falling back to layer 0 when
    absent/unknown. Thread the resolved layer through `commitRemoteStroke`
    (`:6730`), the mix-dirty / prefetch invalidation calls (layer 0 only, as now),
    and `touchFrame`.
11. `case "history"` (`:7222-7356`): replace the blanket "clear every layer" with:
    (a) reconcile the frame layer lists from `data.frames[].layers` the same way
    `reconcileFrames` (`:1287-1326`) reconciles frames — keep pixels for surviving
    ids, blank canvases for new ids, drop deleted ids; (b) clear only the layers
    being rebuilt; (c) replay each op to its own layer. The snapshot bake
    (`:7281-7300`) stays layer-0-only and only runs in snapshot-capable (therefore
    single-layer) rooms.
12. New `case "layer_add" | "layer_del" | "layer_move" | "layer_patch"`
    (`:7677` is where `frame_add` lives): apply the server's canonical list, keep
    pixels by id, drop ops the server purged, then `renderDisplay()` +
    `syncLayerState()`.
13. `handleAddLayer` / delete / duplicate / move / rename / visibility / opacity /
    lock (`:4589-4780`): stop mutating locally and instead send the message and
    let the echo apply it (the `frame_*` model — everyone applies in server order).
    Keep the local cap checks so the UI can explain a refusal.
14. Drawing guards: a locked layer can't be drawn on (mirror the existing
    room-locked canvas guard), and wet/mix brushes on layer ≥ 1 are blocked per
    decision 4.
15. Cold-frame hydration (`:4927-4950`, `hydrateFrame`) and the raster queue
    (`src/utils/frameRasters.js:70` `rasterizeOps`): route ops per layer.
16. `replayFrameOnto` (`src/utils/opReplay.js:202`): keep the flat-canvas
    signature for exports (a film IS flat) and add a layered target (layers array
    + `layerId` routing) for hydration. Its call sites: `App.jsx:4938` (hydration →
    layered), `App.jsx:5721` and `:5847` (film export → flat, unchanged),
    `frameRasters.js:72` (proxies/thumbnails → flat composite is fine).
17. Cache/thumbnail/film paths that assume `layers[0]` for the wet mirror
    (`mixMapRef`, `markMixDirty`, `invalidateMixPrefetch`, `:1406-1450`) stay
    layer-0-scoped — they are correct as long as decision 4 holds.
18. Fold layer names/visibility/opacity into the frame proxy/thumbnail composite
    (`compositeLayers` already walks the whole stack, so this is mostly checking
    that thumbnails use the composite, not layer 0).

**Docs & hygiene**

19. Update `ARCHITECTURE.md:69-70` (the "one shared canvas / same layer" statement
    becomes "one shared canvas, shared layer stack, ops record their layer") and
    the known-divergence entry at `:222-225` (it stops being true for
    layer-carrying ops; say what replaces it).
20. If any new durable client store appears (a strokeId→layerId map, a new IDB
    key), it MUST be added to the wipe lists in `src/utils/accountDeletion.js`
    (`AGENTS.md` calls this App-Review load-bearing). Prefer no new client store:
    the draft already stores per-layer pixels and the server owns the layer list.

## 6. Verification (do this — don't hand it to the user)

The two scripts already exist and already fail the right way (they pin today's
behaviour). **Flip their assertions to the intended behaviour** and keep them as
regression tests:

`node scripts/layer-room-reload-verify.mjs` (13 checks)
  - R1-R4b (local layering + draft with pixels in both layers) stay as-is.
  - R6/R7 today: "count unchanged, everything now on ONE layer" → must become:
    after a replay the count is unchanged **and** the art is still split (hide the
    top layer → only the right-hand stroke disappears; hide the bottom → only the
    left).
  - R8 today: "2 layers, only one has pixels" → both layers must have pixels.
  - R9 today: "a full reload comes back FLAT: 1 layer" → the reload must come back
    with 2 layers ("Canvas" + "Layer 2") and the art on the right ones.
  - R11 today: "Restore last draft → 2 layers, every pixel on one" → the split
    must survive the restore.

`node scripts/layer-room-collab-verify.mjs` (8 checks)
  - C1 today: "a joiner gets ONE layer" → the joiner must get the artist's stack
    (same names, same order) with all the art on the right layers.
  - C2/C2b today: "the joiner's stroke is invisible / sits underneath" → the
    joiner's stroke must land on the layer they are drawing on and be visible to
    the artist (hiding that layer hides it on both screens).
  - C4 today asserts ops carry **no** `layerId` → must assert every op carries one.
  - C5 today: "the replay is NOT 1:1 (the erase eats both strokes)" → the region
    must be unchanged by the replay (`2891` before and after).
  - C6 today: "2 layers, everything on one" → the split must hold.

Then, all of:
  - `node --check server.js`
  - `npm run lint` (zero-warning policy)
  - `npm run build` (redirect to a file and read `$?` — piping through `tail`
    hides the exit code)
  - `node scripts/modwatch-verify.mjs` (28 checks) — the moderation hide/restore
    path is exactly what triggers replays here
  - `node scripts/draft-roundtrip-verify.mjs` — the draft is the local recovery path
  - `node scripts/animation-sync-verify.mjs` and `node scripts/filmstrip-verify.mjs`
    — frames × layers is the memory-heavy corner
  - `node scripts/film-timing-verify.mjs` / the export path — `replayFrameOnto`
    signature change
  - `node test/harness/run.mjs` and `node scripts/safety-verify.mjs` — these have
    pre-existing failures on a clean checkout (3/6 and 18/21 as of this writing);
    stash your changes (`git stash push -- server.js src/`), re-run, compare
    counts, then `git stash pop`. Report pre-existing failures as pre-existing.
  - **The anonymous path** (`AGENTS.md` golden rule): a room with PocketBase
    unset must still paint, replay, join and reload. Add a pass to one script, or
    spot-check in the browser, before calling it done.
  - A **two-client manual/live check** in the browser (two contexts): both see the
    same stack, both can draw on the same layer, and a layer added by one appears
    for the other without a reload.

Scratch-server pattern (from `happypaint-feature-verification`): spawn
`server.js` with `PORT=89xx` and a throwaway `DATA_DIR` (`os.tmpdir()`), poll
`/healthz`, never touch port 8787 or the repo-root `DATA_DIR` — 8787 is the local
Docker stack that serves production drawesome.art.

## 7. Risks / gotchas

- **Memory** is the real cost: layers are full-resolution canvases per client, and
  animation rooms multiply frames × layers. Keep the caps, and keep cooling/
  rastering cold frames (a multi-layer frame's cold proxy stays flat).
- **Snapshot behaviour changes** (slower joins for multi-layer rooms). If joins
  feel slow, the follow-up is per-layer snapshot bundles — deliberately not in
  this plan.
- **Moderation**: hidden/removed ops are addressed by opId and unaffected, but a
  layer delete now also removes ops — make sure that path notifies clients
  (the `layer_del` echo carries the purged opIds) and that `resync` still lands.
- **Public rooms**: host-only layer mutations, plus the locked-layer op drop, are
  the anti-grief boundary. Kids' rooms are the audience — do not let any member
  delete someone else's layer in a `kid_safe` room.
- **Wet/mix brushes** must not be allowed to sample a non-layer-0 stack (decision
  4), or colours will smear across the wrong pixels.
- **Don't break the single-layer case**: the overwhelming majority of rooms have
  one layer and no `layerId` on their ops. Legacy ops must land on layer 0 exactly
  as today, and a one-layer room must be byte-identical to before (compare against
  a stashed baseline if a suite moves).

## 8. Commit / branch

Work on `codex/youth-design-refresh` (this is where the current work sits).
`AGENTS.md`: `git add` the specific files (never `-A`), multi-line messages via a
temp `.commitmsg.txt` + `git commit -F`, end messages with the `Co-Authored-By:`
trailer, and **the user pushes** — don't push for them. Suggested split:
(1) server protocol + sanitizers + persistence, (2) client routing/replay +
handlers, (3) verification scripts + doc updates.

## 9. Current working-tree state

- Branch `codex/youth-design-refresh` @ `ac54a7c`; `git diff` is empty (no
  product code touched by this analysis).
- Untracked and new: `scripts/layer-room-reload-verify.mjs`,
  `scripts/layer-room-collab-verify.mjs` (the two suites above).
- Pre-existing untracked: `.audio/`, `docs/SOCIAL_COPY.md`, `docs/SOCIAL_PUSH.md`,
  `output/` — not mine, leave them.
- `dist/` was rebuilt during this analysis (`npm run build`, exit 0). It is
  gitignored and the Docker image builds its own copy, so production was never
  reachable from these tests.

## 10b. What the suites say now

`layer-protocol-verify.mjs` ALL PASS (20) / `layer-room-reload-verify.mjs` ALL PASS
(13) / `layer-room-collab-verify.mjs` 10 of 11 with ONE INTERMITTENT check: "C2 the
joiner's stroke shows up on the artist's canvas right away" sometimes reads the
artist's canvas ~4s after the joiner's stroke without seeing it, then sees it
after the next history replay (the joiner's own canvas always has it, and the
stroke survives every rebuild). It passed on re-run. Treat it as an open lead,
NOT as green: it looks like the artist's LIVE op path dropping or deferring a
single op - candidates are the `historyReplayActiveRef` deferred-message drain
and the remote stroke-dedup path. Chase it first if a collaborator's stroke ever
fails to appear live.

`animation-sync-verify.mjs` 44/45, identical to the stashed baseline (the one
failure, "FINGERS: only the finger-paint brushes show", is pre-existing).
`modwatch-verify` 28/28 / `filmstrip-verify` 13/13 / `film-timing-verify` 26
assertions / `draft-roundtrip-verify` ALL PASS / lint 0 warnings / build OK.

## 10. Appendix## 10. Appendix: the "before" baseline (today's script output)

`node scripts/layer-room-reload-verify.mjs` — ALL PASS (13 checks), i.e. these
pass today *because* the behaviour is broken:

```
PASS  R1 a room opens with exactly one layer
PASS  R2 adding a layer gives a 2-layer stack, new layer on top + active
PASS  R3 both strokes are on screen locally                       (ink 2434 / 2428)
PASS  R4 locally the strokes really do live on separate layers    (hiding bottom: left 0 / right 2428)
PASS  R4b the autosaved draft holds BOTH layers with their own pixels (97px / 97px)
PASS  R5 the room's op stream … ops=12 fields=[kind,strokeId,points,settings,userId,opId]
PASS  R6 after a room history replay the layer COUNT is unchanged
PASS  R7 …but every stroke is now on ONE layer (top-hidden 2434/2428, bottom-hidden 0/0)
PASS  R8 the autosaved draft still has 2 layers, but only one has pixels (194 / 0)
PASS  R9 a full reload comes back FLAT: one layer, everything on it
PASS  R10 the art itself is intact after the reload
PASS  R11 Restore last draft → 2 layers, every pixel on one of them
```

`node scripts/layer-room-collab-verify.mjs` — ALL PASS (8 checks):

```
PASS  C0 the artist's 2-layer stack is intact locally, block of ink on the upper one (U=18144)
PASS  C1 a joiner mid-session gets ONE layer, with all the art on it  (ink(R)=2893)
PASS  C2 the joiner's stroke is INVISIBLE on the artist's canvas      (18144 → 18144)
PASS  C2b hiding the artist's upper layer reveals it underneath        (2893, both-hidden 0)
PASS  C3 the artist's erase under the upper layer changed nothing      (2893 → 2891)
PASS  C4 the room's stream carries no layer on any op                 (ops=32)
PASS  C5 the replay is NOT 1:1: the erase eats both strokes            (2891 → 0)
PASS  C6 after the rebuild the panel lists 2 layers, everything on one
```
