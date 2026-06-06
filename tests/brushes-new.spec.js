import { test, expect } from '@playwright/test';

test.describe('Happy Paint - New Brushes', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.paint-canvas', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(500);
  });

  test('blur brush option exists and is selectable', async ({ page }) => {
    await page.waitForSelector('.brush-select', { timeout: 10000 });
    const brushSelect = page.locator('.brush-select').nth(1);
    await brushSelect.selectOption('blur');
    await expect(brushSelect).toHaveValue('blur');
  });

  test('blur brush paints without crashing', async ({ page }) => {
    await page.locator('.brush-select').nth(1).selectOption('blur');
    await page.waitForTimeout(200);
    const canvasArea = page.locator('.canvas-area');
    const box = await canvasArea.boundingBox();
    if (!box || box.width === 0) {
      test.skip(true, 'Canvas area has no size');
      return;
    }
    const cx = Math.round(box.x + box.width / 2);
    const cy = Math.round(box.y + box.height / 2);

    // Paint a stroke with blur
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 100, cy + 50, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(500);

    // Should not crash — webgl canvas still visible
    await expect(page.locator('.webgl-canvas')).toBeVisible();
  });

  test('smudge brush option exists and is selectable', async ({ page }) => {
    await page.waitForSelector('.brush-select', { timeout: 10000 });
    const brushSelect = page.locator('.brush-select').nth(1);
    await brushSelect.selectOption('smudge');
    await expect(brushSelect).toHaveValue('smudge');
  });

  test('smudge brush paints on canvas with pre-existing paint', async ({ page }) => {
    // First, draw with round brush to put paint on canvas
    const canvasArea = page.locator('.canvas-area');
    const box = await canvasArea.boundingBox();
    if (!box || box.width === 0) {
      test.skip(true, 'Canvas area has no size');
      return;
    }
    const cx = Math.round(box.x + box.width * 0.3);
    const cy = Math.round(box.y + box.height * 0.5);

    // Draw something first
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy + 40, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // Now switch to smudge and smudge over it
    await page.locator('.brush-select').nth(1).selectOption('smudge');
    await page.waitForTimeout(200);

    await page.mouse.move(cx + 40, cy + 20);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy + 60, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(500);

    await expect(page.locator('.webgl-canvas')).toBeVisible();
  });

  test('wet brush option exists and is selectable', async ({ page }) => {
    await page.waitForSelector('.brush-select', { timeout: 10000 });
    const brushSelect = page.locator('.brush-select').nth(1);
    await brushSelect.selectOption('wetBrush');
    await expect(brushSelect).toHaveValue('wetBrush');
  });

  test('wet brush paints without crashing', async ({ page }) => {
    await page.locator('.brush-select').nth(1).selectOption('wetBrush');
    await page.waitForTimeout(200);
    const canvasArea = page.locator('.canvas-area');
    const box = await canvasArea.boundingBox();
    if (!box || box.width === 0) {
      test.skip(true, 'Canvas area has no size');
      return;
    }
    const cx = Math.round(box.x + box.width / 2);
    const cy = Math.round(box.y + box.height / 2);

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy + 30, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(500);

    await expect(page.locator('.webgl-canvas')).toBeVisible();
  });

  test('wet brush with watercolor shows variation slider', async ({ page }) => {
    await page.locator('.brush-select').nth(1).selectOption('wetBrush');
    await page.waitForTimeout(200);

    // Switch to watercolor paint type
    const paintTypeSelect = page.locator('.paint-type-select');
    if (await paintTypeSelect.isVisible()) {
      await paintTypeSelect.selectOption('watercolor');
      await page.waitForTimeout(200);
    }

    // Variation slider should be visible for wet brush
    const densityLabel = page.locator('.toolbar-section').filter({ hasText: 'Density' });
    await expect(densityLabel).toBeVisible();
  });

  test('sponge brush option exists and is selectable', async ({ page }) => {
    await page.waitForSelector('.brush-select', { timeout: 10000 });
    const brushSelect = page.locator('.brush-select').nth(1);
    await brushSelect.selectOption('sponge');
    await expect(brushSelect).toHaveValue('sponge');
  });

  test('sponge brush paints without crashing', async ({ page }) => {
    await page.locator('.brush-select').nth(1).selectOption('sponge');
    await page.waitForTimeout(200);
    const canvasArea = page.locator('.canvas-area');
    const box = await canvasArea.boundingBox();
    if (!box || box.width === 0) {
      test.skip(true, 'Canvas area has no size');
      return;
    }
    const cx = Math.round(box.x + box.width / 2);
    const cy = Math.round(box.y + box.height / 2);

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 50, cy + 25, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(500);

    await expect(page.locator('.webgl-canvas')).toBeVisible();
  });

  test('palette knife option exists and is selectable', async ({ page }) => {
    await page.waitForSelector('.brush-select', { timeout: 10000 });
    const brushSelect = page.locator('.brush-select').nth(1);
    await brushSelect.selectOption('paletteKnife');
    await expect(brushSelect).toHaveValue('paletteKnife');
  });

  test('palette knife paints without crashing', async ({ page }) => {
    const canvasArea = page.locator('.canvas-area');
    const box = await canvasArea.boundingBox();
    if (!box || box.width === 0) {
      test.skip(true, 'Canvas area has no size');
      return;
    }
    const cx = Math.round(box.x + box.width / 2);
    const cy = Math.round(box.y + box.height / 2);

    // Draw something first so the knife has paint to smear
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 70, cy + 35, { steps: 7 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // Now palette knife
    await page.locator('.brush-select').nth(1).selectOption('paletteKnife');
    await page.waitForTimeout(200);

    await page.mouse.move(cx + 35, cy + 15);
    await page.mouse.down();
    await page.mouse.move(cx + 100, cy + 50, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(500);

    await expect(page.locator('.webgl-canvas')).toBeVisible();
  });

  test('all new brush options appear in selector', async ({ page }) => {
    await page.waitForSelector('.brush-select', { timeout: 10000 });
    const brushSelect = page.locator('.brush-select').nth(1);
    const options = await brushSelect.locator('option').allTextContents();

    // New brushes should appear
    expect(options.some(o => o.includes('Blur'))).toBe(true);
    expect(options.some(o => o.includes('Smudge'))).toBe(true);
    expect(options.some(o => o.includes('Wet Brush'))).toBe(true);
    expect(options.some(o => o.includes('Sponge'))).toBe(true);
    expect(options.some(o => o.includes('Palette Knife'))).toBe(true);
  });
});
