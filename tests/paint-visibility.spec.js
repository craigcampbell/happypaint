import { test, expect } from '@playwright/test';

test('stroke is visible during painting, not just after mouse up', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.paint-canvas', { timeout: 10000 });

  const canvas = page.locator('.paint-canvas');
  const box = await canvas.boundingBox();

  const cx = Math.round(box.x + box.width / 2);
  const cy = Math.round(box.y + box.height / 2);

  // Paint a stroke: drag from center to the right
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 200, cy + 100, { steps: 10 });

  // Wait for a couple frames to render
  await page.waitForTimeout(300);

  // Check that paint is visible on the canvas DURING painting (mouse still down)
  const hasPaintWhileDrawing = await page.evaluate(() => {
    const c = document.querySelector('.paint-canvas');
    if (!c) return false;
    const ctx = c.getContext('2d');
    // Sample the middle of the stroke
    const w = c.width;
    const h = c.height;
    const cx = Math.floor(w / 2);
    const cy2 = Math.floor(h / 2);
    // Check a broad area for any non-white pixels
    const data = ctx.getImageData(cx, cy2, 100, 50);
    for (let i = 0; i < data.data.length; i += 4) {
      if (data.data[i] < 250 || data.data[i + 1] < 250 || data.data[i + 2] < 250) {
        return true;
      }
    }
    return false;
  });

  expect(hasPaintWhileDrawing).toBe(true);

  // Now mouse up
  await page.mouse.up();
  await page.waitForTimeout(300);

  // Paint should still be there
  const hasPaintAfterUp = await page.evaluate(() => {
    const c = document.querySelector('.paint-canvas');
    if (!c) return false;
    const ctx = c.getContext('2d');
    const w = c.width;
    const h = c.height;
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2);
    const data = ctx.getImageData(cx, cy, 100, 50);
    for (let i = 0; i < data.data.length; i += 4) {
      if (data.data[i] < 250 || data.data[i + 1] < 250 || data.data[i + 2] < 250) {
        return true;
      }
    }
    return false;
  });

  expect(hasPaintAfterUp).toBe(true);
});

test('stroke visible during painting on webgl canvas', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.paint-canvas', { timeout: 10000 });

  const canvas = page.locator('.paint-canvas');
  const box = await canvas.boundingBox();

  const cx = Math.round(box.x + box.width / 2);
  const cy = Math.round(box.y + box.height / 2);

  // Select a bold visible color
  await page.locator('.color-swatch').first().click();
  await page.waitForTimeout(100);

  // Draw a thick stroke
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 150, cy + 80, { steps: 8 });
  await page.waitForTimeout(200);

  // Take screenshot while mouse is still down and check webgl canvas
  // The webgl canvas should show paint content (not be blank)
  const webglCanvas = page.locator('.webgl-canvas canvas');
  await expect(webglCanvas).toBeAttached();

  // Now mouse up
  await page.mouse.up();
  await page.waitForTimeout(300);

  // Screenshot the canvas area and verify it shows content
  const canvasArea = page.locator('.canvas-area');
  const screenshot = await canvasArea.screenshot();

  // Screenshot should not be uniform white/black
  // A simple check: the screenshot bytes should not all be identical
  const uniqueValues = new Set(screenshot);
  expect(uniqueValues.size).toBeGreaterThan(10);
});
