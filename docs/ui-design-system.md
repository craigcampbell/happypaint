# UI / Design System Strategy

**Status:** decision doc — 2026-07
**Question answered:** "How would it be to switch over to full shadcn components? And how hard would it be for me to make custom icons?"
**Ground truth:** src/App.css is one 5,266-line global stylesheet (507 class selectors) + a 67-line src/index.css reset. Zero styling dependencies — no Tailwind, no PostCSS, no Radix, no CSS-in-JS. 604 hard-coded hex literals (184 distinct values), 4 `var()` usages total. All HUD JSX lives in the 6,899-line src/App.jsx.

---

## 1. Verdict: do NOT do a full shadcn/ui conversion

Short answer: it would be a multi-week rewrite with high regression risk in the touch layout, for zero benefit to the part of the app that matters most (the studio HUD). Recommend against. Here's why, concretely:

### 1.1 Tailwind preflight vs. the global button rule
shadcn requires Tailwind, and Tailwind's preflight resets `button` to completely unstyled. This app styles **all 288 raw `<button>` elements through one global rule** (App.css:59-100). The moment preflight loads globally, every button in the app goes naked at once. There is no gradual migration path with preflight on — it forces a big-bang cutover where every one of those 288 buttons becomes a shadcn `<Button>` in the same PR, or the UI ships broken.

### 1.2 Radix overlays vs. the pointer-captured canvas
shadcn's Dialog/Sheet/Popover are Radix under the hood, and Radix applies body scroll-lock and focus traps when overlays open. The studio canvas depends on pointer capture (App.jsx:5653-5658), `touch-action: none`, and gesture `preventDefault` in main.jsx. A Radix Dialog toggling body styles forces style/layout recalc on the layer holding two full-size canvases — a direct jank vector, and **drawing performance is the one rule we never trade away**. The current hand-rolled fixed-div overlays cost nothing at open/close. This is not a theoretical concern; it is the reason studio modals must stay bespoke regardless of what happens elsewhere.

### 1.3 The mobile layout is held together by specificity we'd lose
The phone/iPad layout (our primary audience) depends on **20 `!important` declarations** inside a `(max-width:1024px), (pointer:coarse)` media query duplicated ~10 times (App.css:1016, 3202, 3379, 3975, 4082, 4185, 4239, 4323, 4513, 4903). Utility-class refactors silently lose these specificity battles. The touch layout took four separate tuning passes (tasks #6/#7/#21/#53) to get right; a className rewrite re-litigates all of it.

### 1.4 The z-index ladder is implicit
Overlay stacking is a hand-tuned ladder (24/30/45/55/60/65/70/100) that exists nowhere but in scattered CSS. Radix portals mount at body-end and will fight the fixed quickbar (z-70) and FAB (z-45). Any portal-based component system needs that ladder documented and tokenized *first* (see §2a).

### 1.5 Bundle cost for nothing
shadcn's pinned Radix deps add ~30-60 KB gz to a bundle that already ships tfjs + nsfwjs for the NSFW watcher. And shadcn has **no primitives for anything the studio actually is**: tool rails, a translateY bottom-sheet drawer over a pointer-captured canvas, floating quickbars, a film strip. We'd pay the cost and still hand-roll the hard parts.

### 1.6 Honest effort estimate
Full conversion = rewriting ~507 CSS classes across 881 className sites and 288 buttons, in a single-file app where the animation film-strip work is landing concurrently. Realistically **3-5 weeks of focused work with a big-bang cutover risk**, and the deliverable is "the same UI, more fragile on touch, slightly heavier." Don't.

---

## 2. Recommended path

Three moves, in order. (a) and (b) are commitments; (c) is optional.

### 2a. Design-token pass (cheap, safe, do first)
Extract the 184 distinct hex values into ~25-30 `:root` custom properties in App.css. Mechanical find/replace in one file, zero runtime cost, zero canvas risk — and it immediately unblocks theming (toddler room, premium tiers, dark mode beyond the `.night` paper trick).

Suggested token set (names + values from the codebase audit):

```css
:root {
  /* Ink & surfaces */
  --ink: #1f2a33;              /* primary text */
  --ink-soft: #5b6b7a;         /* secondary text */
  --surface: #ffffff;
  --surface-raised: #f4f7f9;
  --surface-sunken: #e9eef3;

  /* Borders */
  --border: #cdd7e0;           /* the workhorse */
  --border-strong: #c3cdd7;

  /* Brand & actions */
  --primary: #174c4d;          /* deep teal — brand */
  --action: #2d6cdf;           /* action blue */
  --danger: #dc2626;
  --danger-deep: #b91c1c;
  --warn: #f59e0b;             /* amber family */
  --warn-deep: #b45309;

  /* Radii */
  --radius-sm: 8px;
  --radius-md: 16px;
  --radius-lg: 18px;
  --radius-pill: 999px;

  /* Z-index ladder (currently implicit — write it down) */
  --z-rail: 24;
  --z-sheet: 30;
  --z-fab: 45;
  --z-zoom: 55;
  --z-overlay: 60;
  --z-modal: 65;
  --z-quickbar: 70;
  --z-top: 100;

  /* Shadows (the 2-3 repeated ones) */
  --shadow-card: 0 2px 8px rgba(31, 42, 51, 0.08);
  --shadow-float: 0 8px 24px rgba(31, 42, 51, 0.16);
}
```

Exact hue consolidation happens during the pass (many of the 184 values are near-duplicates that collapse into one token). Rule of thumb: if a hex appears ≥3 times or is a state variant of one that does, it becomes a token; one-off decorative values can stay inline.

Note: Inter is declared in CSS but never actually loaded. If we ever self-host it, do it **before** any component work — it changes every text measurement, and the buttons are font-weight-800-dependent.

### 2b. Extract the studio HUD out of App.jsx (the prerequisite for everything)
App.jsx contains both the draw loop and all HUD JSX. Any styling change today collides head-on with the animation film-strip work in the same file. Extract into components, keeping StudioApp as the single owner of state (the FrameStrip pattern — pure presentational, props + callbacks — is the established template):

- **Topbar** (desktop top chrome)
- **MpBar** (multiplayer presence/status bar)
- **MobileQuickbar** (the fixed z-70 mobile toolbar + FAB cluster)
- **ToolRail** sections (the 320px right rail, section by section)
- **ConfirmDialog** — currently copy-pasted 7+ times inline; extract once
- **StudioModal** wrapper (the `modal-backdrop` + `studio-modal` pattern)

This is a pure JSX move — no styling changes, no behavior changes — and it's what makes the token pass, the icon swap, and the film-strip UI able to proceed in parallel without merge hell.

### 2c. OPTIONAL: incremental shadcn, fenced to site pages only
If shadcn is still appealing after (a) and (b), adopt it **only** on the marketing/account/admin surfaces: SiteNav, HomePage, SignupPage, Faq, About, Privacy, RoomFinderPage, LiveAdmin, AccountPanel. These are normal document-flow pages where Radix behaves fine and polished forms/tables actually pay off.

Containment rules (non-negotiable):
1. **Preflight is scoped, never global.** Tailwind v4: import utilities only, with preflight scoped under a `.site` wrapper class. The studio's global `button` rule must never see a reset.
2. **No Radix overlay components inside `/studio` or `/join` routes. Ever.** Studio modals stay the fixed-div pattern (optionally hardened with a small `useFocusTrap` hook — that's a 30-line utility, not a dependency).
3. Verify the Tailwind v4 `@tailwindcss/vite` plugin against our Vite 8 setup before committing — Vite 8 is new enough that "should work" needs a spike, not an assumption.

If containment ever feels like a fight, the fallback is fine: the site pages stay bespoke too, styled with the same tokens from (a).

---

## 3. Custom icon system

Direct answer to "how hard would it be to make custom icons": **not hard, and it's the highest-leverage visual upgrade available.** The current chrome is ~85 distinct emoji/text glyphs, which render differently per OS (Segoe UI Emoji vs Apple Color Emoji), sometimes fall back to monochrome where FE0F is missing (🖼 App.jsx:5413, 🗑 App.jsx:5867, 👁 LayerPanel.jsx:53), and can't inherit `currentColor` — so active/disabled tinting on quickbar and rail chips is impossible today.

Production art specs (grid, naming, file locations, the full asset list including the animation-suite icons) already live in **docs/ASSETS-NEEDED.md §2** — this section defines the *code* side.

### 3.1 The `<Icon />` wrapper spec
One component, inline SVG (no sprite sheet, no icon font):

```jsx
<Icon name="brush" size={20} />
// renders:
// <svg viewBox="0 0 24 24" width={size} height={size}
//      fill="none" stroke="currentColor" strokeWidth="2.25"
//      strokeLinecap="round" strokeLinejoin="round"
//      aria-hidden="true">…paths…</svg>
```

- `viewBox="0 0 24 24"`, sizes 16 / 20 / 24 / 32
- `stroke="currentColor"`, `fill="none"` — icons tint free via CSS color, which is the whole point (active/disabled/danger states come along for the ride)
- `stroke-width` 2.25 with rounded caps/joins — matches the chunky font-weight-800 aesthetic (ASSETS-NEEDED.md says "2px, slightly chunky"; 2.25 at 24px is the same visual weight once rendered at 20px)
- `aria-hidden="true"` by default; the parent button carries the accessible label
- Paths live in a plain `{ name: <path data> }` map; filled variants for active states register as `name-filled`

### 3.2 The ~45-icon core chrome set
brush, fill-bucket, rect, ellipse, line, text, marker, crayon, pencil, paint, oil, watercolor, gouache, ink, spray, eraser, smudge, glow, undo, redo, clear/broom, image, save, gallery, share, export, home, rooms/door, bell, lock, unlock, star/host, droplet/wet, sun/dry, chat, vote, globe, warning, hand/pan, zoom-in, zoom-out, close, chevron-down, trash, eye, layer-up, layer-down, frame-prev, frame-next, plus, refresh, key, sign-out, user, target, check.

(The animation-suite set — frame, onion-skin, playhead, track icons — is specced separately in ASSETS-NEEDED.md §2b and rides in with the film-strip work.)

### 3.3 Swap points: data-driven vs. hardcoded
Two very different migration costs:

- **Data-driven (trivial):** the brush, texture, tool, and sheet catalogs each carry an `icon:` string field. Changing those from emoji to icon names converts the entire tool rail, brush picker, and sheet browser in one pass — the render site changes once, the data changes mechanically.
- **Hardcoded JSX (~40 sites):** emoji sprinkled directly in App.jsx JSX (topbar buttons, quickbar, modals, layer panel, etc.). These get swept during the HUD extraction in §2b — extracting Topbar/MobileQuickbar/etc. touches those exact lines anyway, so the icon swap piggybacks on that refactor instead of being its own error-prone grep mission.

### 3.4 What STAYS emoji (important)
- **Reaction emoji** (App.jsx:5704) — user-facing expressive content
- **Sheet-category emoji** (animals 🐰, vehicles 🚗, …) — content taxonomy, kids navigate by them
- **Marketing-copy emoji** on site pages — tone

Rule: **SVG for chrome, emoji for content.** An emoji a user *sends* or *picks as a thing* is content; an emoji standing in for a verb or a tool is chrome and gets an icon.

Cheap immediate fix regardless of timeline: normalize the missing FE0F variation selectors (App.jsx:5413, 5867) now so the current emoji at least render in color everywhere.

---

## 4. Sequencing

1. **Token pass (§2a)** — one file, one PR, mechanical. Lands before anything else so every later change is written against tokens, not hexes.
2. **HUD extraction (§2b)** — the load-bearing refactor. Must land **before** the animation film-strip UI grows inside App.jsx, because the film strip lives in the same shell (canvas-stage / tool-rail / quickbar) that we're extracting. Doing extraction first means the film-strip branch builds against small stable component files instead of racing styling changes through a 6,899-line file. This ordering is what keeps the two workstreams from generating continuous merge conflicts.
3. **Icon system (§3)** — wrapper + catalog `icon:` fields first (cheap win across the whole rail), then the ~40 hardcoded sites as each HUD component is extracted. Art production per ASSETS-NEEDED.md priorities.
4. **(Maybe) site-page shadcn (§2c)** — last, optional, fenced. Nothing upstream depends on it, so it can be dropped entirely with no cost to 1-3.

Why this order protects the film-strip work: steps 1 and 3 never touch JSX structure the animation branch cares about (tokens are CSS-only; catalog icons are data). Step 2 is the only structural change, and it's *deliberately front-loaded* so the film strip is built on top of it rather than merged across it. Step 4 doesn't touch the studio at all.

**Non-negotiable throughout:** nothing in this plan runs on the pointer path. Tokens are resolved at style time, inline SVGs are static DOM, and no overlay library ever mounts over the canvas. If a styling choice ever costs a frame during a stroke, the styling choice loses.
