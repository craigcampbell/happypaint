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

**What it is.** A per-room *palette + wetness + single-layer* affordance, not a
rendering fork. Both modes draw with the same brushes and the same op contract,
so toggling it never repaints history. "Realistic" is today's full catalog;
"fun" is a bold, wet, smeary subset (`marker, crayon, paint, watercolor,
watercolor-wet, gouache, glow, spray, smudge, goo, eraser`) with wet mixing
forced on at pen-down, **and it collapses the local layer stack to a single
layer 0** (the layers panel is hidden). That single-layer guarantee is what lets
goo/smudge displacement sample exactly the paint every peer already sees — ops
carry no layer, so a smear on layer ≥ 1 would otherwise read different pixels
than everyone else.

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

## 3. Gooey renderer — "fun" physics  ✅ implemented

The "fun" mode's *feel* upgrade. See `docs/creative-engine-roadmap.md` §1 for
the full design; this is the bounded plan on the current engine.

**Renderer.** New brush id `goo` (private + fun rooms; dropped in `kid_safe`
rooms the way `smudge` is), `noColor: false`. It merges the two mechanisms that
already ship, per dab, into a stroke buffer committed once at pen-up (the v3
smudge pattern, NOT the direct-to-layer legacy path):

1. **Displacement** — sample the *pre-stroke* layer-0 footprint trailing the
   motion (v3 smudge's `makeSmudgeV3Renderer` drag carry: `getSmudgeScratch` /
   `getCarryScratch`, feathered, deposited at pressure-driven strength).
2. **Pigment deposit** — on top of the displacement, stamp a soft blob of the
   brush colour whose pigment bends toward what it crosses via the mix map.

So paint both moves (the smeared under-paint) and lays down its own colour that
picks up what it crosses.

**Adjustable gooeyness.** One slider (`settings.gooiness`, 0..1, captured into
the op at pen-down so replay is deterministic) maps onto the viscosity — the
roadmap's pudding/tempera presets, interpolated:

| gooiness | smear | drag | pickup | dragRate |
|---|---|---|---|---|
| 0.0 (runny) | 0.20 | 0.50 | 0.50 | 0.30 |
| 1.0 (thick) | 0.60 | 0.25 | 0.15 | 0.08 |

(`smear` = displacement re-stamp alpha, `drag` = sample trail fraction, `pickup`
= pigment bend toward under-paint, `dragRate` = carried-colour chase.)

**Room contract.** "fun" mode is where this is safe: the toddler contract —
single layer (the mix map mirrors layer 0 only), opacity locked to 1, wet-on,
smudge+goo allowed. `FINGERS` already enforces this; the room toggle from §1
generalizes it. Displacement is therefore bounded to layer 0, same as smudge,
with the same documented live-overlap divergence (self-heals on the next history
frame).

**Acceptance (all passing).** The `v3-goo` golden group (thick/runny passes over
a red|blue field + a carry stroke onto blank paper, deterministic) pins the
pixels; the lab's `goo` scenario gates pigment-on-blank, rerun determinism, and
the per-dab budget on the real 4000×2500 layer (~0.19 ms/dab software).
