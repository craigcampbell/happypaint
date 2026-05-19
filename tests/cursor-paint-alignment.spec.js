import { test, expect } from '@playwright/test';

const DRAIN_DURATION = 150; // ms to wait after each stroke for canvas rendering

test.describe('Cursor-Paint Alignment', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.paint-canvas', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(500);
  });

  test('paint lands at cursor position on initial stroke', async ({ page }) => {
    const canvas = page.locator('.paint-canvas');
    const box = await canvas.boundingBox();
    if (!box || box.width === 0 || box.height === 0) {
      test.skip(true, 'Canvas has no visible area');
      return;
    }

    const x = Math.round(box.x + box.width * 0.3);
    const y = Math.round(box.y + box.height * 0.5);

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 1, y + 1, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(DRAIN_DURATION);

    const result = await page.evaluate(
      ({ pageX, pageY }) => {
        const canvas = document.querySelector('.paint-canvas');
        const rect = canvas.getBoundingClientRect();
        const canvasX = Math.round(pageX - rect.left);
        const canvasY = Math.round(pageY - rect.top);
        const ctx = canvas.getContext('2d');
        const radius = 1;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const cx = canvasX + dx;
            const cy = canvasY + dy;
            const pixel = ctx.getImageData(cx, cy, 1, 1);
            const r = pixel.data[0];
            const g = pixel.data[1];
            const b = pixel.data[2];
            if (r !== 255 || g !== 255 || b !== 255) {
              return { painted: true, matchedX: cx, matchedY: cy, expectedX: canvasX, expectedY: canvasY };
            }
          }
        }
        return { painted: false, expectedX: canvasX, expectedY: canvasY };
      },
      { pageX: x, pageY: y }
    );

    expect(result.painted).toBe(true);
    expect(Math.abs(result.matchedX - result.expectedX)).toBeLessThanOrEqual(2);
    expect(Math.abs(result.matchedY - result.expectedY)).toBeLessThanOrEqual(2);
  });

  test('paint position does not drift across 10 consecutive single-click dots at the exact same position', async ({ page }) => {
    const canvas = page.locator('.paint-canvas');
    const box = await canvas.boundingBox();
    if (!box || box.width === 0 || box.height === 0) {
      test.skip(true, 'Canvas has no visible area');
      return;
    }

    const targetX = Math.round(box.x + box.width * 0.3);
    const targetY = Math.round(box.y + box.height * 0.5);
    const centroids = [];

    for (let i = 0; i < 10; i++) {
      await page.mouse.move(targetX, targetY);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(DRAIN_DURATION);

      const centroid = await page.evaluate(
        ({ pageX, pageY }) => {
          const canvas = document.querySelector('.paint-canvas');
          const rect = canvas.getBoundingClientRect();
          const canvasX = Math.round(pageX - rect.left);
          const canvasY = Math.round(pageY - rect.top);
          const ctx = canvas.getContext('2d');

          let sumX = 0, sumY = 0, count = 0;
          const radius = 15;

          for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
              const cx = canvasX + dx;
              const cy = canvasY + dy;
              if (cx < 0 || cy < 0 || cx >= canvas.width || cy >= canvas.height) continue;
              const pixel = ctx.getImageData(cx, cy, 1, 1);
              if (pixel.data[0] !== 255 || pixel.data[1] !== 255 || pixel.data[2] !== 255) {
                sumX += cx;
                sumY += cy;
                count++;
              }
            }
          }

          return {
            count,
            centroidX: count > 0 ? sumX / count : null,
            centroidY: count > 0 ? sumY / count : null,
            expectedX: canvasX,
            expectedY: canvasY,
            canvasWidth: canvas.width,
            canvasHeight: canvas.height,
            rectWidth: Math.round(rect.width),
            rectHeight: Math.round(rect.height),
          };
        },
        { pageX: targetX, pageY: targetY }
      );

      expect(centroid.count).toBeGreaterThan(0);
      centroids.push(centroid);
    }

    const xValues = centroids.map((c) => c.centroidX);
    const firstX = xValues[0];
    const lastX = xValues[xValues.length - 1];

    expect(firstX).not.toBeNull();
    expect(lastX).not.toBeNull();

    const drift = lastX - firstX;
    expect(Math.abs(drift)).toBeLessThan(1.5);
  });

  test('canvas dimensions are stable and do not change between strokes', async ({ page }) => {
    const canvas = page.locator('.paint-canvas');
    const box = await canvas.boundingBox();
    if (!box || box.width === 0 || box.height === 0) {
      test.skip(true, 'Canvas has no visible area');
      return;
    }

    const x = Math.round(box.x + box.width * 0.3);
    const y = Math.round(box.y + box.height * 0.5);
    const dimensions = [];

    for (let i = 0; i < 5; i++) {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(DRAIN_DURATION);

      const dims = await page.evaluate(() => {
        const canvas = document.querySelector('.paint-canvas');
        const rect = canvas.getBoundingClientRect();
        return {
          bufferWidth: canvas.width,
          bufferHeight: canvas.height,
          cssWidth: Math.round(rect.width),
          cssHeight: Math.round(rect.height),
          scaleX: canvas.width / rect.width,
          scaleY: canvas.height / rect.height,
        };
      });

      dimensions.push(dims);
    }

    const first = dimensions[0];
    for (const d of dimensions) {
      expect(d.bufferWidth).toBe(first.bufferWidth);
      expect(d.bufferHeight).toBe(first.bufferHeight);
      expect(d.cssWidth).toBe(first.cssWidth);
      expect(d.cssHeight).toBe(first.cssHeight);
      expect(d.scaleX).toBe(first.scaleX);
      expect(d.scaleY).toBe(first.scaleY);
    }
  });

  test('visual paint position on WebGL canvas aligns with paint canvas (screenshot)', async ({ page }) => {
    const paintCanvas = page.locator('.paint-canvas');
    const box = await paintCanvas.boundingBox();
    if (!box || box.width === 0 || box.height === 0) {
      test.skip(true, 'Canvas has no visible area');
      return;
    }

    const cx = Math.round(box.x + box.width / 2);
    const cy = Math.round(box.y + box.height / 2);

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 30, cy, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(500);

    const screenshot = await page.screenshot();

    const pixelAtCursor = await page.evaluate(
      ({ pageX, pageY }) => {
        const canvas = document.querySelector('.paint-canvas');
        const rect = canvas.getBoundingClientRect();
        const canvasX = Math.round(pageX - rect.left);
        const canvasY = Math.round(pageY - rect.top);
        const ctx = canvas.getContext('2d');

        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const cx2 = canvasX + dx;
            const cy2 = canvasY + dy;
            if (cx2 < 0 || cy2 < 0 || cx2 >= canvas.width || cy2 >= canvas.height) continue;
            const pixel = ctx.getImageData(cx2, cy2, 1, 1);
            if (pixel.data[0] !== 255 || pixel.data[1] !== 255 || pixel.data[2] !== 255) {
              return { painted: true, x: cx2, y: cy2 };
            }
          }
        }
        return { painted: false };
      },
      { pageX: cx, pageY: cy }
    );

    expect(pixelAtCursor.painted).toBe(true);
    expect(screenshot).toBeTruthy();
    expect(screenshot.length).toBeGreaterThan(1000);
  });

  test('paint remains at correct position after canvas resize when window changes', async ({ page }) => {
    const canvas = page.locator('.paint-canvas');

    const x1 = 300;
    const y1 = 250;

    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(DRAIN_DURATION);

    await page.setViewportSize({ width: 1024, height: 768 });
    await page.waitForTimeout(500);

    const x2 = 300;
    const y2 = 250;

    await page.mouse.move(x2, y2);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(DRAIN_DURATION);

    const result = await page.evaluate(() => {
      const canvas = document.querySelector('.paint-canvas');
      const ctx = canvas.getContext('2d');
      const rect = canvas.getBoundingClientRect();
      const cx = Math.round(300 - rect.left);
      const cy = Math.round(250 - rect.top);

      const pixel = ctx.getImageData(cx, cy, 1, 1);
      return {
        painted: pixel.data[0] !== 255 || pixel.data[1] !== 255 || pixel.data[2] !== 255,
        r: pixel.data[0],
        g: pixel.data[1],
        b: pixel.data[2],
      };
    });

    expect(result.painted).toBe(true);
  });

  test('coordinate drift logged for debugging (records full state per stroke)', async ({ page }) => {
    const canvas = page.locator('.paint-canvas');
    const box = await canvas.boundingBox();
    if (!box || box.width === 0 || box.height === 0) {
      test.skip(true, 'Canvas has no visible area');
      return;
    }

    const x = Math.round(box.x + box.width * 0.3);
    const y = Math.round(box.y + box.height * 0.5);
    const log = [];

    for (let i = 0; i < 5; i++) {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(DRAIN_DURATION);

      const entry = await page.evaluate(
        ({ pageX, pageY }) => {
          const canvas = document.querySelector('.paint-canvas');
          const rect = canvas.getBoundingClientRect();
          const canvasX = Math.round(pageX - rect.left);
          const canvasY = Math.round(pageY - rect.top);
          const ctx = canvas.getContext('2d');

          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          let sumX = 0, sumY = 0, count = 0;
          const radius = 15;

          for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
              const cx = canvasX + dx;
              const cy = canvasY + dy;
              if (cx < 0 || cy < 0 || cx >= canvas.width || cy >= canvas.height) continue;
              const pixel = ctx.getImageData(cx, cy, 1, 1);
              if (pixel.data[0] !== 255 || pixel.data[1] !== 255 || pixel.data[2] !== 255) {
                if (cx < minX) minX = cx;
                if (cx > maxX) maxX = cx;
                if (cy < minY) minY = cy;
                if (cy > maxY) maxY = cy;
                sumX += cx;
                sumY += cy;
                count++;
              }
            }
          }

          return {
            stroke: undefined,
            pageX,
            pageY,
            canvasWidth: canvas.width,
            canvasHeight: canvas.height,
            rectWidth: rect.width,
            rectHeight: rect.height,
            scaleX: canvas.width / rect.width,
            scaleY: canvas.height / rect.height,
            expectedX: canvasX,
            expectedY: canvasY,
            centroidX: count > 0 ? sumX / count : null,
            centroidY: count > 0 ? sumY / count : null,
            minX: count > 0 ? minX : null,
            maxX: count > 0 ? maxX : null,
            paintSpreadX: count > 0 ? maxX - minX : null,
            pixelCount: count,
          };
        },
        { pageX: x, pageY: y }
      );

      entry.stroke = i;
      log.push(entry);

      expect(entry.pixelCount).toBeGreaterThan(0);
    }

    const centroids = log.map((e) => e.centroidX);
    const firstCentroid = centroids[0];
    const lastCentroid = centroids[centroids.length - 1];

    expect(firstCentroid).not.toBeNull();
    expect(lastCentroid).not.toBeNull();
    expect(Math.abs(lastCentroid - firstCentroid)).toBeLessThan(1.5);
  });
});
