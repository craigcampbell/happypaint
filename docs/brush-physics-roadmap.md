# Brush Physics Roadmap — Stage 6 (room brush mode, tilt-mop, gooey)

Status: spec + partial implementation. Builds on **Stage 5** (`tilt` / `splay` /
`charge` / `diffuse` dab fields in `src/utils/brushes.js`).

The invariants do not change: every op must render byte-identical on the local
studio, remote peers, spectators and history replay **forever**, so new physics
is always *additive* — a new dab field that defaults to 0/off, or a new brush
id routed explicitly — never an edit to how an already-persisted op renders. No
wall-clock, no readbacks / `ctx.filter` / allocation on the per-dab hot path.
`scripts/brush-lab.mjs --golden` and the timing tables are the acceptance gate.

## 1. Room brush mode — "realistic" vs "fun"  ✅ implemented

**What it is.** A per-room *palette + wetness* affordance, not a rendering fork.
Both modes draw with the same brushes and the same op contract, so toggling it
never repaints history. "Realistic" is today's full catalog; "fun" is a bold,
wet, smeary subset (`marker, crayon, paint, watercolor, watercolor-wet, gouache,
glow, spray, smudge, eraser`) with wet mixing forced on at pen-down.

**How the switch works — and why it's safe on/off.** It is the exact `set_wet` /
`wetCanvas` design the room already uses:

1. Server persists a room field `brushMode: "realistic" | "fun"` (default
   realistic). The featured `FINGERS` toddler room is pinned to "fun".
2. A `set_brush_mode` WS message (host-only in public rooms, any member in
   private — the same power model as `set_wet`) flips it, broadcasts
   `brush_mode_state`, and persists.
3. Every client flips its brush picker atomically on `brush_mode_state`; the
   mode also rides the `connected` handshake so late joiners/reconnects sync.
4. "Fun" stamps `settings.wet = true` **into each op at pen-down** (like the wet
   toggle does today). The mode itself is NOT in the op — so a stroke painted in
   "fun" replays identically after the room flips back to "realistic".

That last point is the answer to "how do we switch it once it's on/off": the
mode is a room-level UI/palette state, and each stroke captures only the
*consequences* that matter for rendering (its wetness, its brush id) at the
moment it starts — exactly the wetCanvas pattern, so there is no repaint, no
half-finished-stroke flop, and no history hazard.

## 2. Tilt-mop asymmetry (`pool`)  ✅ implemented

**Realism.** A leaned round watercolour mop deposits pigment asymmetrically:
paint pools on the downhill side of the lean and the dab drags slightly wider
along it. New dab field `pool` (wash shapes only, 0 = off — every pre-Stage-6
wash op renders unchanged):

- a pen point carries `tx`/`ty` (already on the wire since Stage 3) → lean
  magnitude + azimuth;
- the dab's scatter and bloom are biased toward the lean azimuth (the "pools
  downhill" read) and the stamp swells a touch along it;
- a tilt-less point (touch, mouse, old op) → lean 0 → the pre-Stage-6 dab.

`watercolor`/`watercolor-wet` ship `pool` in their authoring dabs; the tilted
watercolor stroke in the `v3-physics` golden group pins it.

## 3. Gooey renderer — "fun" physics  📝 spec (implement next)

The "fun" mode's *feel* upgrade. See `docs/creative-engine-roadmap.md` §1 for
the full design; this is the bounded plan on the current engine.

**Renderer.** New brush id `goo` (private + fun rooms; dropped in `kid_safe`
rooms the way `smudge` is), `noColor: false`. It merges the two mechanisms that
already ship, per dab, into a stroke buffer committed once at pen-up (the v3
smudge pattern, NOT the direct-to-layer legacy path):

1. **Displacement** — sample the *pre-stroke* layer-0 footprint trailing the
   motion (v3 smudge's `makeSmudgeV3Renderer` drag carry: `getSmudgeScratch` /
   `getCarryScratch`, feathered, deposited at pressure-driven strength).
2. **Pigment deposit** — on top of the displacement, stamp the brush colour
   wet-tinted by the mix-map pickup (the existing km/wet path).

So paint both moves (the smeared under-paint) and lays down its own colour that
picks up what it crosses — the finger-paint pudding/tempera presets from the
roadmap become dab params (`smear`, `drag`, `pickup`, `dragRate`).

**Room contract.** "fun" mode is where this is safe: the toddler contract —
single layer (the mix map mirrors layer 0 only), opacity locked to 1 (no
uniform-opacity buffered commit), wet-on, smudge+goo allowed. `FINGERS` already
enforces this; the room toggle from §1 generalizes it to any room that picks
"fun". Displacement is therefore bounded to layer 0, same as smudge, with the
same documented live-overlap divergence (self-heals on the next history frame).

**Acceptance.** Mirror the smudge lab gates: a `goo` golden group (tilt-less,
deterministic), a lab scenario checking feather (no hard edge), carry-thins-out
past a field edge, rerun + batch determinism, and the per-dab budget on the real
4000×2500 layer. Ship only after those pass.
