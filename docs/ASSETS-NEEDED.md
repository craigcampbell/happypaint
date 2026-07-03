# Drawesome — Asset Production Inventory

Everything visual/audio we need generated, with specs, so any item can be produced
independently and dropped in. Master rule: **SVG for anything UI, OGG+M4A pairs for
audio, PNG only for textures/photos.** Keep source files (AI/PSD/Figma) somewhere safe.

Drop points (create if missing):
- `public/brand/` — logos, favicons, OG images
- `public/icons/` — the SVG icon set (one file per icon, see naming below)
- `public/sfx/` — sound effects (`.ogg` + `.m4a` per sound)
- `public/textures/` — paper/canvas/paint textures (existing: `linen.png`, `canvas.png`)

---

## 1. Brand / Logos  🔴 highest priority (you said you have ideas)

| Asset | File | Format | Notes |
|---|---|---|---|
| Wordmark | `brand/drawesome-wordmark.svg` | SVG, single color + full color variants | Playful but not babyish — must work for teens/young pros too. Should sit comfortably next to "a Toon Boom alternative" and next to a kid's fridge drawing. |
| Glyph / app mark | `brand/drawesome-mark.svg` | SVG, works at 16px | The 🎨 emoji stands in today (SiteNav brand button). Needs to read at favicon size. |
| Favicon set | `brand/favicon-16.png`, `-32`, `-180` (apple-touch), `favicon.svg` | PNG + SVG | Replaces `vite.svg` (still the favicon today — embarrassing). |
| OG / share card | `brand/og-default.png` | PNG 1200×630 | Shown when links are shared to Discord/iMessage. One default + later per-room variants. |
| Loading splash | `brand/splash.svg` | SVG | Optional: paint-blob animation frame for slow loads. |

**Logo direction notes:** dark/light variants; must survive 1-color (chat embeds, watermarks).
A small `drawesome.art` watermark version for exported PNGs/GIFs/MP4s (bottom-right, ~28px tall).

## 2. UI Icon Set — style spec

One style for everything: **24×24 grid, 2px stroke, rounded caps/joins, slightly chunky,
filled variants for active states.** Naming: `icons/<name>.svg`, kebab-case. Every icon
must read at 20px on iPad. Current UI uses emoji everywhere (🎨 📤 😀 🖼️ etc.) — fine
for personality, but the tool chrome needs real icons for a consistent look.

### 2a. Core studio (replaces emoji in tool chrome)
`brush`, `eraser`, `smudge`, `fill`, `shapes`, `text`, `hand-pan`, `zoom-in`, `zoom-out`,
`undo`, `redo`, `layers`, `color-wheel`, `size-dot` (3 weights), `opacity-checker`,
`gallery`, `save`, `share`, `chat`, `report-flag`, `settings-gear`, `home`, `rooms-door`,
`lock`, `unlock`, `mute`, `kick`, `crown-host`, `sheet-coloring`, `camera-export`.

### 2b. Animation suite (new — film-strip UI)
| Icon | Name | Notes |
|---|---|---|
| Film frame | `frame.svg` | Single cel with sprocket notches |
| Add frame | `frame-add.svg` | Cel + plus |
| Duplicate frame | `frame-duplicate.svg` | Two stacked cels |
| Delete frame | `frame-delete.svg` | |
| Onion skin | `onion-skin.svg` | Literally a little onion 🧅 — kids will remember it |
| Eye open | `eye-open.svg` | Per-frame/track visibility ON |
| Eye closed | `eye-closed.svg` | Visibility OFF |
| Play | `play.svg` | Chunky triangle |
| Pause | `pause.svg` | |
| Stop | `stop.svg` | |
| Loop | `loop.svg` | |
| Playhead | `playhead.svg` | The scrub handle — skeuomorphic, grabbable |
| FPS/speed | `speed-gauge.svg` | |
| Track: art | `track-art.svg` | Paintbrush strip |
| Track: background | `track-bg.svg` | Mountain/backdrop |
| Track: effects | `track-fx.svg` | Sparkle |
| Track: storyboard | `track-story.svg` | Pencil thumbnail panels |
| Track: audio | `track-audio.svg` | Waveform |
| Ghost opacity | `ghost.svg` | Friendly ghost for onion-skin strength slider |

### 2c. Vector tools (private/pro rooms)
`pen-bezier`, `node-select`, `shape-rect`, `shape-ellipse`, `shape-polygon`,
`path-stroke`, `path-fill`, `boolean-union`, `send-back`, `bring-front`.

### 2d. Toddler room
`finger-paint` (hand with paint), `smudge-stick`, `paint-blob`, `wash-hands` (clear),
`big-dot-sizes` (extra-chunky 3-size icon), `sparkle-clean`.

## 3. Sound Effects — Toddler Finger-Paint Room  🔊

Format: **OGG Vorbis + M4A fallback, 44.1kHz, mono ok, ≤ 3s each (loops seamless),
normalized ≈ −16 LUFS, NO harsh transients** (toddlers + iPad speakers). Names final:

| Sound | File | Trigger | Feel |
|---|---|---|---|
| Gooey smear (loop) | `sfx/goo-smear-loop.ogg` | Finger drag, pitch/volume follows speed | Wet, thick, satisfying — like pudding |
| Paint squish | `sfx/goo-squish-1.ogg` … `-3.ogg` | Finger down (round-robin 3 variants) | Soft splat |
| Slorp mix | `sfx/goo-mix.ogg` | Two colors visibly mixing | Sticky swirl |
| Splat | `sfx/goo-splat.ogg` | Big fast dab | Cartoonish, not startling |
| Bubble pop | `sfx/goo-pop-1.ogg` … `-3.ogg` | UI touches (color pick, size change) | Tiny, cute |
| Squeegee clean | `sfx/goo-squeegee.ogg` | Clear canvas | Wipe-clean whoosh |
| Handprint stamp | `sfx/goo-stamp.ogg` | Handprint/stamp tool | Thump + squish |
| Happy chime | `sfx/goo-done.ogg` | Save/share | Soft xylophone, 2 notes |

Also: a **global mute toggle is a hard requirement** (parents), and sounds default OFF
in multiplayer rooms (only the toddler room defaults ON, local-only — never networked).

## 4. Toddler Room Visuals

| Asset | File | Format | Notes |
|---|---|---|---|
| Finger-paint grain | `textures/fingerpaint-grain.png` | PNG 512² tileable, grayscale | Multiplied into gooey strokes for streaky pull marks |
| Smudge-stick tip | `textures/smudge-tip.png` | PNG 256² grayscale alpha | Dab tip for the smudge stick |
| Paper: butcher roll | `textures/butcher-paper.png` | PNG 1024² tileable | The toddler room canvas background |
| Blobby UI frame | `brand/toddler-frame.svg` | SVG 9-slice | Round squishy borders for the toddler UI chrome |
| Chunky color blobs | `icons/blob-red.svg` etc. (8-10 colors) | SVG | The toddler palette is big paint blobs, not swatches |

## 5. Film-Strip Skeuomorphic Chrome

| Asset | File | Format | Notes |
|---|---|---|---|
| Strip texture | `textures/filmstrip.svg` | SVG 9-slice | Dark strip + sprocket holes top/bottom; frames sit in the middle. Must tile horizontally, scrolls under a fixed playhead. |
| Cel border | `textures/cel-border.svg` | SVG | Slight rounded acetate edge + highlight for each frame thumbnail |
| Playhead handle | part of `icons/playhead.svg` | SVG | Fat, thumb-friendly (44px touch target) |
| Storyboard paper | `textures/storyboard-paper.png` | PNG tileable | Header row look for the storyboard track |

CSS will do most of the skeuomorphism (gradients/shadows); these assets carry the character.

## 6. Extra Paper / Canvas Textures

Existing: `linen.png`, `canvas.png`. Wanted: `cel-acetate` (near-white, slight sheen),
`storyboard-grid`, `newsprint`, `black-paper` (for neon brushes). PNG 1024² tileable.

## 7. Brush Tip / Grain Library (for gooey pack + future imports)

8–12 grayscale PNG 256² alpha tips: `tip-flat-bristle`, `tip-round-soft`, `tip-fan`,
`tip-sponge`, `tip-fingertip`, `tip-palm-edge`, `grain-heavy-tooth`, `grain-splatter`.
These feed the stamped-dab engine directly and double as the test fixtures for the
Photoshop/Procreate import work.

## 8. Membership / Marketing Art (later, needs pricing final)

Hero image per tier card, "animation studio" hero for the landing page, empty-state
illustrations (empty gallery, empty film strip, no rooms open). Specs TBD after tier
names lock.

---

### Production order that unblocks the most work
1. **Icon set 2b (animation)** — the film-strip MVP ships with these
2. **Logos + favicon** — replaces vite.svg everywhere, needed for any marketing
3. **Toddler SFX + textures** — gates the toddler room build
4. Core studio icons (2a) — swap-in, no code dependency
5. Everything else as features land
