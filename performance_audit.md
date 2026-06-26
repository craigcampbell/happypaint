# Happy Paint — Drawing Performance & Bug Audit

Audit date: 2026-06-15 · Scope: drawing hot path across **all platforms** (web `src/`, mobile `mobile/` = iOS + Android).

Method: full read-through of every drawing-path file on each platform plus targeted code verification of the two highest-severity claims (web silent-autosave-loss and mobile per-stroke full serialization were both confirmed against the live source). No files were modified.

Reference constants:
- **Web** canvas = 1600×1200 = 1.92M px → 7.68 MB RGBA backing store per canvas. Default 4 layers. `MAX_HISTORY = 18`. Up to 8 frames.
- **Mobile** = Skia stroke-list renderer. Every committed mark is a React-managed Skia node. Projects persist to one AsyncStorage key.

Severity scale: **Critical** (data loss / crash / unusable on target devices) · **High** (severe jank or freeze in normal use) · **Medium** (degraded UX, edge-case bugs) · **Low** (polish / rare).

---

## Severity summary

| ID | Platform | Title | Category | Severity |
|----|----------|-------|----------|----------|
| W1 | Web | Full multi-layer recomposite on every pointer move | perf | **Critical** |
| W2 | Web | Onion-skin recomposites neighbor frames from scratch each move | perf | **Critical** |
| W3 | Web | Autosave PNG→localStorage overflows quota; failure swallowed, "Autosaved" shown | perf/data-loss | **Critical** |
| M1 | Mobile | Whole project JSON-serialized to AsyncStorage on every stroke (no debounce) | perf/memory | **Critical** |
| M2 | Mobile | Every committed stroke is a permanent JS-managed Skia node; unbounded growth | perf | **Critical** |
| W4 | Web | History clones full layer stack per stroke (~30 MB/entry, up to ~550 MB) | memory | **High** |
| W5 | Web | Display update not rAF-coalesced (compounds W1) | perf | **High** |
| W6 | Web | No devicePixelRatio handling — blurry canvas on all HiDPI/tablets | compat/UX | **High** |
| W7 | Web | GIF encode is synchronous O(px×palette) on main thread — tab freeze | perf | **High** |
| M3 | Mobile | Live stroke repaints entire committed scene each rAF | perf | **High** |
| M4 | Mobile | Unbounded spray-dot accumulation + full path rebuild per frame | perf/memory | **High** |
| M5 | Mobile | Huge serialized payload; Android CursorWindow (~2MB) wipes gallery silently | memory/compat | **High** |
| M6 | Mobile | Export `exporting` flag race + UI-thread GIF encode freeze | correctness/perf | **High** |
| W8 | Web | GIF `ByteBuffer` is a boxed `number[]` with per-byte push | perf/memory | Medium |
| W9 | Web | All frame thumbnails regenerated on any frame structural change | perf | Medium |
| W10 | Web | Flood fill copies full 1600×1200 ImageData + 1.92 MB visited array per click | perf | Medium |
| W11 | Web | Shape preview clears full overlay every move, not rAF-coalesced | perf | Medium |
| W12 | Web | `onPointerLeave={finishStroke}` ends stroke mid-drag (capture footgun) | bug/UX | Medium |
| W13 | Web | Opacity slider recomposites + clones state per tick; non-undoable | perf/UX | Medium |
| M7 | Mobile | Stale `latestProject` snapshot can drop rapid sequential commits | bug | Medium |
| M8 | Mobile | `makeId` (Date.now+random) collision risk in clone/duplicate loops | bug | Medium |
| M9 | Mobile | Eraser paints opaque paper color — broken on transparent/sticker/GIF export | correctness | Medium |
| M10 | Mobile | PanResponder drops fast points; no palm/multitouch rejection | perf/UX | Medium |
| M11 | Mobile | Skia surfaces/images not disposed during export (native OOM risk) | memory | Medium |
| M12 | Mobile | Hardcoded `readPixels` colorType/alphaType literals (4/3) — brittle/color-swap | compat | Medium |
| M13 | Mobile | `useImage`/`matchFont` per item, no cache; Android font fallback | perf/compat | Medium |
| M14 | Mobile | Whole studio re-renders on each live-stroke state update | perf | Medium |
| W14 | Web | No palm rejection / pen prioritization | compat/UX | Low |
| W15 | Web | Object URL revoked synchronously after click; anchor not in DOM | bug/compat | Low |
| W16 | Web | `crypto.randomUUID` unguarded in gallery save (throws on plain HTTP) | compat | Low |
| W17 | Web | Playback `setTimeout` loop drifts / background-throttled | UX | Low |
| M15 | Mobile | Sticker-apply effect stale closure / fires before layout sizing | bug | Low/Med |
| M16 | Mobile | GIF disposal=2 + transparency flicker; delay clamp mismatch (20ms vs 40ms) | correctness | Low |
| M17 | Mobile | Preview-snapshot failure path triggers redundant full save | perf | Low |

---

## Critical findings (fix first)

### W1 — Full multi-layer recomposite on every pointer move
**Location:** `src/App.jsx` `renderDisplay` (~L295-318) called from `drawBrushFromEvent`; `compositeLayers` in `src/utils/layers.js` (~L84-97).
Every `pointermove` clears the 1600×1200 display canvas and `drawImage`s **all** layers onto it. With 4 layers that's `clear + 4 blits ≈ 9.6M px` per move event; at 60–120 coalesced events/sec that's hundreds of M px/sec just to show one brush dab, even though the stroke dirtied a tiny region.
**Fix:** Cache a static "below active" and "above active" composite at stroke-start; per-move blit only `below + activeLayer + above` (3 blits regardless of N) or track a dirty rect. Recomposite the full stack only on stroke-end / structural change.

### W2 — Onion skin recomposites neighbor frames from scratch each move
**Location:** `src/App.jsx` `renderDisplay` (~L302-313); `compositeFrameToCanvas` in `src/utils/frames.js` (~L60-66).
When onion skin is on with ≥2 frames, each move allocates two fresh 1600×1200 canvases and composites entire neighbor layer stacks into them — multiplying W1 by neighbor stacks, plus heavy GC churn from throwaway canvases.
**Fix:** Precompute neighbor onion composites once into cached canvases on stroke-start / frame-switch / onion-toggle; blit the cached versions during the stroke.

### W3 — Autosave overflows localStorage and silently loses data while reporting success
**Location:** `src/App.jsx` `saveDraft` (~L425-455), `writeJson` (~L81-87). **Verified in source.**
`saveDraft` PNG-encodes every layer to a base64 dataURL (each 1600×1200 layer is commonly 1–4 MB) and `JSON.stringify`s them into one localStorage key on a 2.4s timer. Multiple layers easily exceed the ~5 MB quota. `writeJson`'s `catch {}` swallows `QuotaExceededError`, then `saveDraft` unconditionally sets `dirtyRef.current = false` and `setStatus("Autosaved")` — so the draft is stale/unsaved while the user is told it's safe. The PNG encode also blocks the main thread mid-draw every 2.4s.
**Fix:** Detect quota failure, keep `dirtyRef` true, surface a real "couldn't autosave (too large)" status. Move encoding to `OffscreenCanvas`/worker and persist to IndexedDB (larger quota, blob storage, no base64 inflation). Debounce on stroke-end.

### M1 — Whole project serialized to AsyncStorage on every committed stroke
**Location:** `mobile/App.tsx` `persistProject` (~L149-157) wired as `onProjectChange`; `mobile/src/storage.ts` `saveProjects` (~L103-105). **Verified in source.**
Each finished stroke calls `onProjectChange` → `persistProject` → `saveProjects` → `JSON.stringify(allProjects)`. No debounce (the 420ms debounce only covers the PNG preview). As a drawing grows, every stroke re-serializes the entire gallery — O(n²) bytes written per session, rising main-thread stalls per stroke.
**Fix:** Debounce the write (1–2s trailing) and store each project in its own file (expo-file-system) or its own AsyncStorage key; keep only light metadata in the shared key.

### M2 — Every committed stroke is a permanent JS-managed Skia node
**Location:** `mobile/src/components/StudioScreen.tsx` `StrokeNode` (~L227-334), render loop (~L1630-1648).
Each stroke mounts 1–3 `<Path>` nodes; the "paint" brush also mounts up to 24 `<Circle>` nodes per stroke. A 200-stroke painting ≈ 200 paths + up to 4,800 circles, all permanently mounted and re-walked by Skia on every repaint. Memoization prevents React re-render but not Skia repaint cost.
**Fix:** Flatten committed strokes per layer into a cached `Skia.Picture` / offscreen `SkImage` rendered as one node; keep only the live stroke as live nodes. Drop or fold the 24-circle "paint" decoration.

---

## High findings

### W4 — History clones the full layer stack per stroke
`src/App.jsx` `pushHistory` (~L320-329) → `snapshotLayers` (`src/utils/layers.js` ~L56-68) clones every layer to a fresh 1600×1200 canvas. One undo entry with 4 layers = ~30.7 MB; `MAX_HISTORY = 18` → up to ~553 MB resident on a single frame — an OOM risk on mobile Safari. **Fix:** snapshot only the active layer for brush/fill/shape ops; full-stack snapshot only on structural ops; consider delta-of-dirty-rect.

### W5 — Display update not rAF-coalesced
`drawBrushFromEvent` (~L681-705) calls `renderDisplay()` once per move *handler* with no `requestAnimationFrame` gate, so redundant composites happen when move events outpace paints. **Fix:** schedule `renderDisplay` via a single pending rAF flag.

### W6 — No devicePixelRatio handling
Init at `src/App.jsx` (~L1454-1467) sizes canvases to a fixed 1600×1200 backing store stretched by CSS; rendering resolution is decoupled from screen density. Diagonal lines/text look soft on every Retina/tablet/phone — i.e. the entire target audience. **Fix:** render the *display* canvas at `cssWidth × devicePixelRatio` and scale the fixed-res layers into it (coordinate mapping already normalizes via rect).

### W7 — Synchronous GIF encode freezes the tab
`src/utils/gif.js` `nearestColorIndex`/`mapFrame` (~L149-187), `encodeGif` (~L304-380), called synchronously from `exportGif`. Frames are downscaled to 320×240 (good), but nearest-color is a linear scan of up to 255 colors/pixel → ~157M ops for an 8-frame gradient loop, all on the main thread. **Fix:** move `encodeGif` to a Web Worker (transfer ImageData); use an octree/LUT for nearest-color.

### M3 — Live stroke repaints the entire committed scene each rAF
`StudioScreen.tsx` live render (~L1642-1645) is a sibling of all committed nodes in one `<Canvas>`. Each `setLiveStroke` repaints live + every committed node. **Fix:** isolate the in-progress stroke in a dedicated overlay `<Canvas>` / Skia reactive value so committed content (cached per M2) isn't repainted per frame.

### M4 — Unbounded spray dots + full path rebuild per frame
`makeSprayDots` (~L166-177), accumulation (~L724-730), `makeSprayPath` (~L212-220). A long spray stroke can accumulate 10k–50k dots; because `setLiveStroke` makes a new stroke object each rAF, `makeSprayPath` rebuilds the entire path every frame (O(n²) over the stroke), then all dots serialize to storage. **Fix:** cap dots per stroke; append only new dots; rasterize spray to a cached image on commit.

### M5 — Serialized payload blows the Android CursorWindow and wipes the gallery
`types.ts` stores every `{x,y,size}` point and `{x,y,radius}` spray dot; persisted via M1 into one AsyncStorage row. A detailed/multi-frame project exceeds the ~2 MB Android SQLite `CursorWindow` limit; `loadProjects` then throws and the `catch` returns `[]` (`storage.ts` ~L98-100) — **all projects silently disappear**. **Fix:** per-project files; quantize coordinates; surface read errors instead of returning `[]`.

### M6 — Export flag race + UI-thread GIF freeze
`captureTransparent` (~L1258-1269), `snapshotFrameImage` (~L1328-1341), `exportGif` (~L1347-1443). A single shared `exporting`/`exportFrameId` state with no mutual exclusion means overlapping export/preview captures grab the wrong scene (paper visible / wrong frame); the two-rAF wait is a heuristic that can yield blank exports on slow devices; and the full encode runs synchronously on the JS thread holding all frames' RGBA + base64 at once. **Fix:** add an in-flight export guard; run the encoder off-thread / chunked; free per-frame buffers as you go.

---

## Medium findings (condensed)

- **W8** `src/utils/gif.js` `ByteBuffer` (~L21-51) is a boxed `number[]` with per-byte `.push` then `Uint8Array.from` — large transient allocation. Use a growable `Uint8Array`.
- **W9** `src/App.jsx` `syncFrameState` (~L229-239) regenerates *all* frame thumbnails (composite + PNG encode) on any frame structural change. Regenerate only affected frames.
- **W10** `src/utils/fill.js` (~L32-129) copies full 1600×1200 ImageData + allocates a 1.92 MB visited array per click; fill is per-layer only (won't respect boundaries on other layers). Restrict to a bounding box; document single-layer behavior.
- **W11** `src/App.jsx` `continueStroke` (~L836-850) clears the full overlay each move for shape preview. Clear previous bbox only / rAF-coalesce.
- **W12** `src/App.jsx` (~L1606) `onPointerLeave={finishStroke}` combined with `setPointerCapture` prematurely ends strokes when leaving the canvas on some engines. Drop `onPointerLeave`; rely on capture + `pointerup`/`pointercancel`.
- **W13** `src/App.jsx` `handleOpacityChange` (~L1040-1052) recomposites + clones state per slider tick, marks dirty, and is non-undoable. rAF-throttle; snapshot once on drag-start.
- **M7** `StudioScreen.tsx` `latestProject` (~L557-565) is a render snapshot; rapid sequential commits (or sticker-apply during a stroke commit) can build on stale state and drop an item. Use a ref/functional updater for "latest committed project".
- **M8** `makeId` (`StudioScreen.tsx` ~L149, also `App.tsx`/`storage.ts`/`paintSpace.ts`) uses `Date.now()+Math.random()`; in synchronous clone/duplicate loops `Date.now()` is constant → collision → duplicate React keys → corruption. Use a counter or `expo-crypto` UUID.
- **M9** `StrokeNode` eraser (~L268-282) paints opaque `paperBackground` instead of erasing; on transparent/sticker/GIF export (`showBackground=false`) eraser marks become solid paper-colored blobs, and on upper layers they cover lower content. Use Skia `blendMode="clear"`/`dstOut` inside a layer group.
- **M10** PanResponder (~L881-929) is JS-thread and drops points on fast strokes (linear interpolation flattens curves); a second touch/palm feeds the same active stroke. Migrate to `react-native-gesture-handler`; ignore `touches.length > 1`.
- **M11** `exportGif` (~L1404-1419) creates `Skia.Surface.MakeOffscreen` / `Skia.Image` (incl. a full sprite-sheet surface) never `.dispose()`d — native memory spike/OOM on heavy export. Dispose explicitly; stream frames.
- **M12** `exportGif` (~L1373-1378) hardcodes `colorType: 4`, `alphaType: 3`. Import `ColorType.RGBA_8888`/`AlphaType.Unpremul`; literals risk color-swap or fallback on other Skia builds.
- **M13** `ImageItemNode` `useImage` per item (~L432-448) and `matchFont` per `TextNode` (~L454-458) — N stickers = N concurrent decodes, no cache; Android `matchFont` may silently fall back. Cache/limit images; verify Android font.
- **M14** Each `setLiveStroke` (~60/s) re-renders the whole `StudioScreen` body (toolbars, layer list, frame strip). Move the live stroke into an isolated child component.

---

## Low findings (condensed)

- **W14** No palm rejection / pen prioritization (`src/App.jsx` pointer handlers). Prefer `pointerType==="pen"`; ignore large-contact touches.
- **W15** `downloadBlob` (~L128-135) revokes the object URL synchronously after `.click()` and never appends the anchor — breaks downloads on some browsers. Defer revoke; append/remove anchor.
- **W16** `saveToGallery` (~L540) uses `crypto.randomUUID()` unguarded — throws on plain HTTP (non-secure context). Reuse the guarded helper from `paintSpace.js`.
- **W17** `startPlayback` (~L1084-1102) uses `setTimeout` which drifts and is throttled in background tabs. Use rAF + timestamp accumulator for accurate loop timing.
- **M15** `pendingSticker` apply effect (~L1197-1223, deps `[pendingSticker]`) can fire before `onLayout` sets real `canvasSize`, sizing the sticker against `MIN_CANVAS_WIDTH`. Gate on a laid-out flag.
- **M16** GIF disposal=2 + transparent background (`gif.ts` ~L304/346) can ghost between frames; exported min delay 20ms vs preview 40ms means previewed timing ≠ exported timing. Align clamps; consider disposal=1.
- **M17** `savePreview` catch (~L637-647) calls `onProjectChange` again on snapshot failure → redundant full save. Skip the redundant save and retry preview later.

---

## Cross-cutting themes

1. **The composite/repaint hot path dominates both platforms** (W1/W2/W5 on web; M2/M3/M4 on mobile). Both redraw the entire scene per pointer event instead of compositing static content once and drawing only the live stroke over it. This is the root cause of stroke latency on the target tablets/phones and should be the first fix on each platform.
2. **Persistence is unsafe at scale and silently loses data** (W3 on web; M1/M5 on mobile). Both can lose a child's artwork with no error shown — the worst possible failure for this audience. High priority alongside perf.
3. **Export (GIF) freezes the UI on both platforms** (W7/W8; M6/M11) because encoding runs on the main/JS thread. Move encoding off-thread and add an in-flight guard.
4. **Eraser semantics are wrong on a layered model** (M9 confirmed on mobile; web uses `destination-out` correctly per the web audit) — fix before layers + transparent export ship to users.

## Suggested fix order

1. W3 + M1/M5 (data-loss) — protect artwork first.
2. W1/W2 + M2/M3/M4 (draw hot path) — make drawing smooth.
3. W4 (history memory) — prevent OOM.
4. W7 + M6/M11 (export freeze) — make GIF export usable.
5. W6 (HiDPI blur), M9 (eraser export), W12 (pointerleave) — visible correctness.
6. Remaining Medium, then Low.
