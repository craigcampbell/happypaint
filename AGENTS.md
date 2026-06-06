# Happy Paint — AI Agent Testing Guide

## Quick Start

```bash
# Run everything
npm run build && npx vitest run && npx playwright test

# Unit tests only (fast, no browser)
npx vitest run

# E2E tests only (requires browser)
npx playwright test

# Single test file
npx vitest run tests/unit/colorMixer.test.js
npx playwright test tests/brushes-new.spec.js
```

## Test Architecture

| Layer | Tool | Directory | Speed | What It Tests |
|-------|------|-----------|-------|---------------|
| Unit | vitest | `tests/unit/` | <1s | Pure functions, data, logic |
| E2E | Playwright | `tests/` | ~30s | Browser rendering, WebSocket, canvas |

## Unit Tests (`npx vitest run`)

**Config:** `vitest.config.js` — node environment, globals enabled, includes `tests/unit/**/*.test.js` only.

### Files and What They Cover

#### `tests/unit/colorMixer.test.js` (20 tests)
Tests every exported function in `src/utils/colorMixer.js`:

| Function | Tests | Key Behaviors Verified |
|----------|-------|----------------------|
| `hexToRgb` | 8 | Hash/no-hash, uppercase, invalid input, black/white |
| `rgbToHex` | 5 | Padding, clamping 0-255, rounding fractions |
| `mixPigments` | 11 | Identity (opacity 0), full replacement (opacity 1), subtractive darkening, determinism, valid hex output |
| `kubelkaMunkBlend` | 5 | Pigment darkening, opacity control, valid range output |
| `samplePigment` | 4 | Pixel extraction, bounds checking, multi-pixel |
| `writePigment` | 3 | Write semantics, bounds safety, multi-pixel indexing |
| Real-world scenarios | 3 | Yellow+cyan, layering buildup, black mixing |

**Critical invariant:** `clamp()` in `colorMixer.js` must clamp to 0-255, not 0-1. This was a production bug fixed during testing. Any change to clamp behavior will break these tests.

#### `tests/unit/paintTypes.test.js` (9 tests)
Tests `src/utils/paintTypes.js`:

| Coverage | Tests |
|----------|-------|
| PAINT_TYPES | All 4 types defined, unique values |
| PAINT_PROPERTIES | Every type has all 12 required fields |
| Numeric ranges | wetness, spread, impasto, glossiness, granulation, blendFactor, defaultOpacity all in [0,1] |
| opacityRange | Valid 2-element array with min ≤ max |
| defaultOpacity | Falls within its type's opacityRange |
| Semantic invariants | Oil has highest impasto, watercolor has highest wetness, watercolor.edgeDarkening is true |
| Labels | All types have non-empty label and description strings |

#### `tests/unit/constants.test.js` (22 tests)
Tests `src/utils/constants.js`:

| Coverage | Tests |
|----------|-------|
| BRUSH_TYPES | All 17 types defined, unique values |
| Canvas dims | VIRTUAL > display, exact values (6000×4000) |
| Zoom config | MIN < PAINT_MIN < MAX, ZOOM_PER_SCROLL > 0 |
| Defaults | Size > 0, variation/opacity in [0,1], valid hex color |
| TEXTURES | All 3 textures defined |

#### `tests/unit/server.test.js` (33 tests)
Tests server logic in isolation (no WebSocket needed):

| Coverage | Tests |
|----------|-------|
| `generateUserId()` | Format (`user_` prefix), length, uniqueness (100x) |
| `generateUserName()` | Returns from pool, non-empty |
| `generateUserColor()` | Returns from pool, valid hex |
| `RoomManager.getRoom()` | Auto-create, same instance on re-get |
| `RoomManager.addUser()` | Single, multiple |
| `RoomManager.removeUser()` | Removal, empty-room cleanup, non-existent no-throw |
| `RoomManager.addToHistory()` | Growth, truncation to maxHistory (500), keeps recent |
| `RoomManager.getHistory()` | Empty for unknown rooms |
| `RoomManager.getTotalUserCount()` | Cross-room aggregation |
| `RoomManager.getRoomCount()` | Active room count |
| Room isolation | Different rooms have independent user sets |
| `analyzeStroke()` | Too-few-points → unknown, vertical → 'l', circular → letter, horizontal → 'e', S-curve → greeting/letter |
| `shouldTriggerLLM()` | Null/empty → false, vertical+wide → true, flat → false, small → false |

## Playwright E2E Tests (`npx playwright test`)

**Config:** `playwright.config.js` — Chromium only, auto-starts `npm run dev` (Vite + server on port 5173), base URL `http://localhost:5173`.

### Existing Spec Files

| File | Tests | Coverage |
|------|-------|----------|
| `tests/app.spec.js` | 28 | Core render, toolbar, canvas, brush select, color swatches, clear, user list, zoom, minimap, chat brush, meme brush, mobile/iPad |
| `tests/cursor-paint-alignment.spec.js` | 6 | Paint lands at cursor, position drift across 10 clicks, canvas stability, screenshot alignment, resize robustness, debug logging |
| `tests/paint-visibility.spec.js` | 2 | Paint visible during drawing (not just after mouseup), WebGL canvas shows content |
| `tests/zoom-controls.spec.js` | 1 | Minimap zoom buttons, hover reveal, zoom in/out changes indicator |
| `tests/brushes-new.spec.js` | 14 | Blur, smudge, wet brush, sponge, palette knife — all selectable, paint without crash, smudge needs pre-existing paint, watercolor shows density slider |
| `tests/paint-types.spec.js` | 9 | All 4 paint types selectable, paint indicator updates, Show 3D Strokes checkbox visibility per type, opacity defaults per type, switching mid-paint doesn't crash |

### Running E2E Tests

```bash
# All E2E tests
npx playwright test

# Specific file
npx playwright test tests/brushes-new.spec.js

# With UI mode (interactive)
npx playwright test --ui

# With headed browser (see what's happening)
npx playwright test --headed

# Debug mode (step through)
npx playwright test --debug

# Single test by name
npx playwright test -g "blur brush paints without crashing"
```

## Test Pipeline for AI Agents

When making changes, run in this order:

```bash
# Step 1: Verify build compiles (catches import/syntax errors)
npm run build

# Step 2: Run unit tests (catches logic errors, <1 second)
npx vitest run

# Step 3: Run E2E tests (catches rendering/behavior issues, ~30 seconds)
npx playwright test

# Step 4: If any fail, fix and repeat from step 1
```

### CI Command

```bash
npm run build && npx vitest run && npx playwright test
```

## Adding New Tests

### Unit Tests

Create `tests/unit/<feature>.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { myFunction } from '../../src/utils/myModule';

describe('myFunction', () => {
  it('does the thing', () => {
    expect(myFunction(input)).toBe(expectedOutput);
  });
});
```

Rules:
- Import from `../../src/` path
- Test pure functions only (no DOM, no React hooks, no canvas API)
- If you need canvas (`getImageData`, `putImageData`), write a Playwright E2E test instead
- All vitest tests run in Node environment — no browser APIs available

### E2E Tests

Create `tests/<feature>.spec.js`:

```js
import { test, expect } from '@playwright/test';

test('description', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.some-element', { timeout: 10000 });
  // interact and assert
});
```

Rules:
- Always wait for `.paint-canvas` to be attached before interacting
- Use `test.skip(true, 'reason')` if canvas bounding box has zero size
- Add `await page.waitForTimeout(N)` after paint operations to allow rendering
- Target CSS classes for selectors (`.toolbar-panel`, `.webgl-canvas`, etc.)

## Key Files Under Test

| Source | Tests |
|--------|-------|
| `src/utils/colorMixer.js` | `tests/unit/colorMixer.test.js` |
| `src/utils/paintTypes.js` | `tests/unit/paintTypes.test.js` |
| `src/utils/constants.js` | `tests/unit/constants.test.js` |
| `server.js` | `tests/unit/server.test.js` |
| `src/App.jsx` | All Playwright specs |
| `src/hooks/useDrawing.js` | `tests/brushes-new.spec.js`, `tests/cursor-paint-alignment.spec.js` |
| `src/hooks/usePaintEngine.js` | `tests/paint-visibility.spec.js` |
| `src/components/*` | `tests/app.spec.js` |

## Known Sensitivities

1. **`clamp()` in `colorMixer.js`** — Must clamp to 0-255. Do not change to 0-1 without updating `cmyToRgb` to output normalized values.
2. **`sampleUnderlyingColor()` in `useDrawing.js`** — Uses `getImageData` which is slow on 6000×4000 canvas. Never call per-point in hot loops.
3. **Paint canvas CSS** — Has `opacity: 0` in `App.css`. `getImageData` still works on the backing store, but visual tests must use WebGL canvas screenshots.
4. **Port 3001** — Server uses this. Kill stale processes before running tests: `lsof -ti:3001 | xargs kill`
5. **E2E test timeout** — Default 60s. Some canvas interactions need extra time; use `await page.waitForTimeout()` after paint operations.
