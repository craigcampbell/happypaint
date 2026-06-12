import { test, expect } from '@playwright/test';

const BG = { r: 255, g: 255, b: 255 };

const DRAWABLE_BRUSHES = [
  { value: 'round', label: 'round', minPixels: 700, maxMs: 2200 },
  { value: 'square', label: 'square', minPixels: 700, maxMs: 2200 },
  { value: 'pen', label: 'pen', minPixels: 700, maxMs: 2200 },
  { value: 'pencil', label: 'pencil', minPixels: 40, maxMs: 2200, textured: true },
  { value: 'spray', label: 'spray', minPixels: 90, maxMs: 2600, textured: true },
  { value: 'airbrush', label: 'airbrush', minPixels: 180, maxMs: 2600, soft: true },
  { value: 'wetBrush', label: 'wet brush', minPixels: 220, maxMs: 2400, soft: true },
  { value: 'sponge', label: 'sponge', minPixels: 120, maxMs: 2600, textured: true },
  { value: 'paletteKnife', label: 'palette knife', minPixels: 280, maxMs: 2600, textured: true, needsBase: true },
  { value: 'smudge', label: 'smudge', minPixels: 120, maxMs: 2600, needsBase: true },
  { value: 'blur', label: 'blur', minPixels: 120, maxMs: 3400, needsBase: true, soft: true },
];

async function screenToCanvasPoint(page, screenX, screenY) {
  return page.evaluate(({ screenX, screenY }) => {
    const canvas = document.querySelector('.paint-canvas');
    const rect = canvas.getBoundingClientRect();
    const relX = screenX - rect.left;
    const relY = screenY - rect.top;
    const viewport = window.__HP_VIEWPORT__ || { x: 3000, y: 2000, zoom: 0.5 };
    const maxDim = Math.max(rect.width, rect.height);
    const scale = maxDim / (viewport.zoom * rect.height);
    return {
      x: Math.round(viewport.x + (relX - rect.width / 2) * scale),
      y: Math.round(viewport.y + (relY - rect.height / 2) * scale),
    };
  }, { screenX, screenY });
}

async function setupBlankMural(page, name) {
  await page.goto(`/?mural=${name}`);
  await page.waitForSelector('.paint-canvas', { state: 'attached', timeout: 15000 });
  await page.locator('.clear-btn').click();
  await page.waitForTimeout(350);
}

async function selectBrush(page, value) {
  await page.locator('.brush-select').nth(1).selectOption(value);
  await page.waitForTimeout(120);
}

async function drawStroke(page, box, offsetY = 0) {
  const cx = Math.round(box.x + box.width / 2);
  const cy = Math.round(box.y + box.height / 2 + offsetY);
  const elapsed = await page.evaluate(({ cx, cy }) => {
    const canvas = document.querySelector('.paint-canvas');
    const points = [
      [cx - 90, cy - 35],
      [cx - 70, cy - 16],
      [cx - 45, cy + 10],
      [cx - 8, cy + 2],
      [cx + 45, cy - 10],
      [cx + 72, cy + 14],
      [cx + 100, cy + 38],
    ];

    const dispatch = (type, x, y) => {
      canvas.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: type === 'mouseup' ? 0 : 1,
      }));
    };

    const started = performance.now();
    dispatch('mousedown', points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) {
      dispatch('mousemove', points[i][0], points[i][1]);
    }
    dispatch('mouseup', points[points.length - 1][0], points[points.length - 1][1]);
    return performance.now() - started;
  }, { cx, cy });
  await page.waitForTimeout(260);
  return elapsed;
}

async function drawBasePaint(page, box) {
  await selectBrush(page, 'round');
  await page.locator('.size-slider').first().fill('28');
  await drawStroke(page, box, -36);
}

async function getCanvasMetrics(page) {
  return page.evaluate((bg) => {
    const canvas = document.querySelector('.paint-canvas');
    const ctx = canvas.getContext('2d');
    const width = 700;
    const height = 420;
    const startX = Math.floor(canvas.width / 2 - width / 2);
    const startY = Math.floor(canvas.height / 2 - height / 2);
    const image = ctx.getImageData(startX, startY, width, height).data;
    let changed = 0;
    let faint = 0;
    let strong = 0;
    let sumDelta = 0;
    let sumSqDelta = 0;
    const colors = new Set();

    for (let i = 0; i < image.length; i += 4) {
      const dr = image[i] - bg.r;
      const dg = image[i + 1] - bg.g;
      const db = image[i + 2] - bg.b;
      const delta = Math.sqrt(dr * dr + dg * dg + db * db);
      if (delta > 14) {
        changed++;
        sumDelta += delta;
        sumSqDelta += delta * delta;
        colors.add(`${image[i] >> 3},${image[i + 1] >> 3},${image[i + 2] >> 3}`);
        if (delta < 90) faint++;
        if (delta > 150) strong++;
      }
    }

    const mean = changed ? sumDelta / changed : 0;
    const variance = changed ? sumSqDelta / changed - mean * mean : 0;
    return {
      changed,
      faint,
      strong,
      uniqueBuckets: colors.size,
      deltaStdDev: Math.sqrt(Math.max(0, variance)),
    };
  }, BG);
}

async function getCenterWebglPixel(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.webgl-canvas canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
    if (!gl) return null;
    const pixel = new Uint8Array(4);
    gl.readPixels(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return Array.from(pixel);
  });
}

test.describe('Brush performance and artistic audit', () => {
  test.describe.configure({ mode: 'serial' });

  for (const brush of DRAWABLE_BRUSHES) {
    test(`${brush.label} is practical and has a distinct mark`, async ({ page }) => {
      await setupBlankMural(page, `brush-audit-${brush.value}`);
      const canvas = page.locator('.paint-canvas');
      const box = await canvas.boundingBox();
      test.skip(!box || box.width === 0, 'Canvas has no size');

      if (brush.needsBase) {
        await drawBasePaint(page, box);
      }

      await selectBrush(page, brush.value);
      if (brush.value === 'blur') {
        await page.locator('.size-slider').first().fill('26');
      }

      const elapsedMs = await drawStroke(page, box, 12);
      const metrics = await getCanvasMetrics(page);

      expect(elapsedMs, `${brush.label} stroke should feel responsive`).toBeLessThan(brush.maxMs);
      expect(metrics.changed, `${brush.label} should leave visible affected pixels`).toBeGreaterThan(brush.minPixels);

      if (brush.textured) {
        expect(metrics.uniqueBuckets, `${brush.label} should have painterly texture/color variation`).toBeGreaterThan(3);
        expect(metrics.deltaStdDev, `${brush.label} should not look like a flat MS Paint line`).toBeGreaterThan(4);
      }

      if (brush.soft) {
        expect(metrics.faint, `${brush.label} should have a soft translucent edge`).toBeGreaterThan(20);
      }
    });
  }

  test('paint types produce distinguishable painterly marks', async ({ page }) => {
    const types = [
      { value: 'watercolor', brush: 'wetBrush', minFaint: 60, description: 'watercolor should read soft and washy' },
      { value: 'acrylic', brush: 'round', minStrong: 120, description: 'acrylic should read more opaque' },
      { value: 'oil', brush: 'paletteKnife', minBuckets: 4, description: 'oil should read textured with knife ridges' },
    ];

    for (const type of types) {
      await setupBlankMural(page, `paint-type-audit-${type.value}`);
      const box = await page.locator('.paint-canvas').boundingBox();
      test.skip(!box || box.width === 0, 'Canvas has no size');

      if (type.brush === 'paletteKnife') {
        await drawBasePaint(page, box);
      }

      await page.locator('.paint-type-select').selectOption(type.value);
      await selectBrush(page, type.brush);
      await drawStroke(page, box, 0);
      const metrics = await getCanvasMetrics(page);

      if (type.minFaint) {
        expect(metrics.faint, type.description).toBeGreaterThan(type.minFaint);
      }
      if (type.minStrong) {
        expect(metrics.strong, type.description).toBeGreaterThan(type.minStrong);
      }
      if (type.minBuckets) {
        expect(metrics.uniqueBuckets, type.description).toBeGreaterThan(type.minBuckets);
      }
    }
  });

  test('clear mural resets paint and WebGL surface without leftover artifacts', async ({ page }) => {
    await setupBlankMural(page, 'clear-regression-audit');
    const box = await page.locator('.paint-canvas').boundingBox();
    test.skip(!box || box.width === 0, 'Canvas has no size');

    await page.locator('.paint-type-select').selectOption('oil');
    await selectBrush(page, 'paletteKnife');
    await drawStroke(page, box, 0);
    await page.locator('.clear-btn').click();
    await page.waitForTimeout(500);

    const metrics = await getCanvasMetrics(page);
    expect(metrics.changed).toBe(0);

    const webglCanvas = page.locator('.webgl-canvas canvas');
    await expect(webglCanvas).toBeVisible();
    const centerPixel = await getCenterWebglPixel(page);
    expect(centerPixel[0]).toBeGreaterThan(245);
    expect(centerPixel[1]).toBeGreaterThan(245);
    expect(centerPixel[2]).toBeGreaterThan(245);
  });

  test('line tool completes a visible straight stroke on second click', async ({ page }) => {
    await setupBlankMural(page, 'line-tool-regression');
    const box = await page.locator('.paint-canvas').boundingBox();
    test.skip(!box || box.width === 0, 'Canvas has no size');

    await selectBrush(page, 'line');
    const start = { x: Math.round(box.x + box.width / 2 - 90), y: Math.round(box.y + box.height / 2 - 40) };
    const end = { x: Math.round(box.x + box.width / 2 + 120), y: Math.round(box.y + box.height / 2 + 70) };

    await page.mouse.click(start.x, start.y);
    await page.mouse.click(end.x, end.y);
    await page.waitForTimeout(350);

    const canvasStart = await screenToCanvasPoint(page, start.x, start.y);
    const canvasEnd = await screenToCanvasPoint(page, end.x, end.y);
    const linePixels = await page.evaluate(({ canvasStart, canvasEnd, bg }) => {
      const canvas = document.querySelector('.paint-canvas');
      const ctx = canvas.getContext('2d');
      let hits = 0;
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        const x = Math.round(canvasStart.x + (canvasEnd.x - canvasStart.x) * t);
        const y = Math.round(canvasStart.y + (canvasEnd.y - canvasStart.y) * t);
        const data = ctx.getImageData(x - 3, y - 3, 7, 7).data;
        for (let j = 0; j < data.length; j += 4) {
          const changed = Math.abs(data[j] - bg.r) + Math.abs(data[j + 1] - bg.g) + Math.abs(data[j + 2] - bg.b);
          if (changed > 40) {
            hits++;
            break;
          }
        }
      }
      return hits;
    }, { canvasStart, canvasEnd, bg: BG });

    expect(linePixels).toBeGreaterThan(16);
  });
});
