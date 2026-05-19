# Happy Paint Test Suite

## Quick Start

```bash
# Run all tests (headless Chromium)
npx playwright test

# Run a specific test file
npx playwright test tests/cursor-paint-alignment.spec.js

# Run with UI viewer
npx playwright test --ui

# Debug a failing test
npx playwright test --debug tests/cursor-paint-alignment.spec.js

# View last HTML report
npx playwright show-report
```

## Dev Server

The Playwright config auto-starts `npm run dev` on port 5173 before tests run. If the server is already running, it reuses the existing instance — no manual setup needed.

## Test Files

### `tests/app.spec.js` — General App Tests

Smoke tests for the app shell and UI controls:

| Test | Description |
|------|-------------|
| `loads the app` | App mounts, `.app-title` shows "Happy Paint" |
| `shows toolbar` | `.toolbar-panel` is visible |
| `canvas is visible and interactive` | Canvas exists, accepts mouse down/move/up |
| `brush selector works` | Dropdown visible, can select "spray" |
| `color selector shows presets` | 17 color swatches visible (16 presets + 1 custom) |
| `size slider is visible` | Brush size slider exists |
| `clear button is visible` | `.clear-btn` exists |
| `chat panel can be opened` | Click chat button, panel appears |
| `user list is visible` | `.user-list-btn` exists |
| `works on iPad viewport` | App renders correctly at iPad (gen 7) dimensions |
| `connection status shows` | `.connection-status` element is visible |
| `texture selector works` | `.toolbar-select` is visible |

### `tests/cursor-paint-alignment.spec.js` — Cursor-Paint Alignment Tests

Tests that verify the paint lands where the cursor is, and that position does not
drift across multiple strokes. This addresses a bug where paint appeared to shift
further left on each successive stroke.

| Test | Description |
|------|-------------|
| `paint lands at cursor position on initial stroke` | Single dot: verifies pixel at cursor position is painted (not white) |
| `paint position does not drift across 10 consecutive single-click dots at the exact same position` | Draws 10 single-click dots at same page coordinates, checks centroid doesn't drift more than 1.5px across all 10 |
| `canvas dimensions are stable and do not change between strokes` | Verifies buffer width/height and CSS width/height remain identical across 5 strokes |
| `visual paint position on WebGL canvas aligns with paint canvas (screenshot)` | Draws a horizontal line, takes screenshot, verifies paint lands at expected canvas coordinates |
| `paint remains at correct position after canvas resize when window changes` | Draws dot before and after viewport resize, verifies paint at same page coordinates still exists |
| `coordinate drift logged for debugging (records full state per stroke)` | Captures exact buffer dimensions, CSS rect, scale factors, centroid, and pixel spread per stroke — fails if drift > 1.5px |

#### Why These Tests Exist

The coordinate pipeline is:

1. Page coordinates (`clientX`, `clientY` from mouse event)
2. Canvas-local coordinates via `getBoundingClientRect()` (`cx = clientX - rect.left`)
3. Canvas buffer coordinates (internal `canvas.width` x `canvas.height` pixels)

A mismatch at any stage causes the paint to land off-target. The CSS sets
`.paint-canvas { width: 100%; height: 100% }` while `canvas.width` is set to
`Math.floor(containerRect.width)`. If these diverge (browser rounding, ResizeObserver
timing), coordinates shift.

The "drift further left each stroke" symptom suggests either:
- Canvas internal size narrowing on each resize (content re-renders at smaller resolution)
- `getBoundingClientRect()` returning a progressively different value
- Layout shift between strokes altering the canvas position

#### How Tests Verify Alignment

Each test:
1. Simulates mouse events at known page coordinates
2. Uses `page.evaluate()` to access `.paint-canvas` context directly
3. Reads pixel data with `getImageData()` at the expected canvas-internal coordinates
4. Computes the centroid of all non-white painted pixels
5. Asserts the centroid is within 2-3px of the expected position

The search radius is adaptive (based on brush size) to account for brush stroke
width variability while still catching systemic drift.

---

## Known Issues Fixed

### Canvas buffer size mismatch (root cause of cursor-paint offset)

**Symptom**: Paint shifted left progressively on each successive click/stroke.

**Root cause** in `src/App.jsx`: The toolbar is `position: fixed` (out of flow), but the initial `canvasDimensions` estimate subtracted 280px:

```js
// BEFORE (bug — toolbar is fixed, doesn't take layout space)
width: Math.max(400, window.innerWidth - 280)

// AFTER (fix — toolbar overlays, canvas fills full viewport)
width: Math.max(400, window.innerWidth)
```

This caused the canvas buffer to be ~280px narrower than its CSS-rendered size. `getBoundingClientRect()` returned CSS size, but `ctx` coordinates were in buffer space — creating a persistent scaling mismatch. The async `toDataURL()` → `img.onload` restore pattern in the resize handler was replaced with synchronous offscreen canvas copy to eliminate a race condition where `onload` could overwrite newly-painted strokes.

**Files changed**:
- `src/App.jsx:49-51` — Fixed initial `canvasDimensions` estimate (removed `-280`)
- `src/App.jsx:90-100` — Replaced async `toDataURL()`/`Image` restore with synchronous `drawImage` from offscreen canvas

---

## Future Test Ideas

### Regression Prevention

- [ ] **Canvas resize during painting**: Simulate window resize mid-stroke, verify paint stays aligned
- [ ] **Toolbar toggle during painting**: Open/close toolbar while drawing, check no coordinate shift
- [ ] **Zoom/DPI scenarios**: Test at 125%, 150%, 200% device pixel ratios
- [ ] **Touch coordinate mapping**: Same alignment tests but with `page.touchscreen` instead of mouse
- [ ] **WebSocket remote strokes**: Receive a stroke from server, verify it renders at correct position

### Performance & Stress

- [ ] **Rapid strokes**: 100 consecutive strokes, verify no cumulative drift
- [ ] **Large brush sizes**: Test alignment at brush sizes 20, 40, 80, 120
- [ ] **Memory stability**: Monitor canvas pixel buffer size doesn't inflate across strokes

### Brush-Specific Alignment

- [ ] **Palette knife smear**: Verify smear sampling region aligns with cursor
- [ ] **Eraser**: Verify erased region aligns with cursor (reciprocal of paint test)
- [ ] **Line tool**: Two-click line starts and ends at click positions
- [ ] **Spray / Airbrush**: Centroid of particle distribution aligns with cursor

### Visual Regression

- [ ] **Screenshot diff per brush type**: Reference screenshots of each brush stroke
- [ ] **Impasto 3D lighting correctness**: Screenshot with impasto on/off, diff for height map artifacts

### Cross-Browser

- [ ] **Firefox**: Same alignment tests on Firefox
- [ ] **Safari**: Same alignment tests on WebKit
- [ ] **Mobile Chrome**: Touch events on mobile viewport

---

## Conventions for AI Agents

When writing tests for Happy Paint:

1. **Canvas access**: The `.paint-canvas` has `opacity: 0` — to visually debug set `style.opacity = '1'` in `page.evaluate()`. For pixel verification, use `canvas.getContext('2d').getImageData()` inside `page.evaluate()`.

2. **Coordinate mapping**: Always convert page coordinates to canvas-internal coordinates via `canvas.getBoundingClientRect()` inside `page.evaluate()` to avoid stale references.

3. **Color detection**: The canvas background is white (`#ffffff`). Non-white pixels indicate paint. Check `r !== 255 || g !== 255 || b !== 255`.

4. **Wait for paint**: After mouse events, add `await page.waitForTimeout(50-100)` to let React state updates and canvas rendering complete before reading pixels.

5. **Test isolation**: Each test starts with a fresh page. Canvas content is NOT preserved between tests. The dev server is shared — keep state local.

6. **File naming**: `tests/<feature>.spec.js`. Use `test.describe` blocks for grouping. Follow the existing pattern of `test.beforeEach` for common setup.

7. **Running**: Use `npx playwright test` from the project root. The config auto-starts the Vite dev server.

8. **Reference files**:
   - `src/hooks/useDrawing.js` — 2D canvas stroke rendering, coordinate transforms
   - `src/hooks/usePaintEngine.js` — Three.js WebGL impasto engine
   - `src/App.jsx` — Canvas sizing, ResizeObserver, stroke lifecycle
   - `playwright.config.js` — Test configuration
