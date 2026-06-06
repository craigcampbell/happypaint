import { test, expect } from '@playwright/test';

test.describe('Happy Paint - Paint Types', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.paint-canvas', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(500);
  });

  test('paint type selector is visible with all options', async ({ page }) => {
    const paintTypeSelect = page.locator('.paint-type-select');
    await expect(paintTypeSelect).toBeVisible();

    const options = await paintTypeSelect.locator('option').allTextContents();
    expect(options.some(o => o.includes('Standard'))).toBe(true);
    expect(options.some(o => o.includes('Watercolor'))).toBe(true);
    expect(options.some(o => o.includes('Acrylic'))).toBe(true);
    expect(options.some(o => o.includes('Oil'))).toBe(true);
  });

  test('switching to Standard paint type works', async ({ page }) => {
    const paintTypeSelect = page.locator('.paint-type-select');
    await paintTypeSelect.selectOption('none');
    await expect(paintTypeSelect).toHaveValue('none');

    // Paint and verify no crash
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
    await page.mouse.move(cx + 30, cy + 15, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    await expect(page.locator('.webgl-canvas')).toBeVisible();
  });

  test('switching to Watercolor paint type works', async ({ page }) => {
    const paintTypeSelect = page.locator('.paint-type-select');
    await paintTypeSelect.selectOption('watercolor');
    await expect(paintTypeSelect).toHaveValue('watercolor');

    // Paint indicator should show
    await expect(page.locator('.paint-type-indicator')).toContainText('Watercolor');
  });

  test('switching to Acrylic paint type works', async ({ page }) => {
    const paintTypeSelect = page.locator('.paint-type-select');
    await paintTypeSelect.selectOption('acrylic');
    await expect(paintTypeSelect).toHaveValue('acrylic');

    await expect(page.locator('.paint-type-indicator')).toContainText('Acrylic');
  });

  test('switching to Oil paint type works', async ({ page }) => {
    const paintTypeSelect = page.locator('.paint-type-select');
    await paintTypeSelect.selectOption('oil');
    await expect(paintTypeSelect).toHaveValue('oil');

    await expect(page.locator('.paint-type-indicator')).toContainText('Oil');
  });

  test('3D strokes checkbox appears for non-Standard paint types', async ({ page }) => {
    const paintTypeSelect = page.locator('.paint-type-select');

    // Standard should hide the 3D checkbox
    await paintTypeSelect.selectOption('none');
    await page.waitForTimeout(200);
    const checkboxStandard = page.locator('.checkbox-label').filter({ hasText: 'Show 3D Strokes' });
    await expect(checkboxStandard).toHaveCount(0);

    // Oil should show it
    await paintTypeSelect.selectOption('oil');
    await page.waitForTimeout(200);
    const checkboxOil = page.locator('.checkbox-label').filter({ hasText: 'Show 3D Strokes' });
    await expect(checkboxOil).toBeVisible();
  });

  test('switching paint type updates default opacity', async ({ page }) => {
    const opacitySlider = page.locator('.size-slider').nth(1); // Opacity slider
    const paintTypeSelect = page.locator('.paint-type-select');

    // Watercolor should have lower default opacity
    await paintTypeSelect.selectOption('watercolor');
    await page.waitForTimeout(200);
    const watercolorOpacity = await opacitySlider.inputValue();
    expect(Number(watercolorOpacity)).toBeLessThanOrEqual(70);

    // Acrylic should have higher opacity
    await paintTypeSelect.selectOption('acrylic');
    await page.waitForTimeout(200);
    const acrylicOpacity = await opacitySlider.inputValue();
    expect(Number(acrylicOpacity)).toBeGreaterThanOrEqual(70);
  });

  test('changing paint type while painting does not crash', async ({ page }) => {
    const canvasArea = page.locator('.canvas-area');
    const box = await canvasArea.boundingBox();
    if (!box || box.width === 0) {
      test.skip(true, 'Canvas area has no size');
      return;
    }
    const cx = Math.round(box.x + box.width / 2);
    const cy = Math.round(box.y + box.height / 2);

    // Start painting
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 40, cy + 20, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // Switch paint type and paint again
    await page.locator('.paint-type-select').selectOption('oil');
    await page.waitForTimeout(200);

    await page.mouse.move(cx + 40, cy + 20);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy + 40, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    await expect(page.locator('.webgl-canvas')).toBeVisible();
  });

  test('opacity slider range respects paint type limits', async ({ page }) => {
    const paintTypeSelect = page.locator('.paint-type-select');

    // The opacity slider should always be visible and functional
    await paintTypeSelect.selectOption('watercolor');
    await page.waitForTimeout(200);
    const opacitySlider = page.locator('.size-slider').nth(1);
    await expect(opacitySlider).toBeVisible();

    const value = await opacitySlider.inputValue();
    expect(Number(value)).toBeGreaterThanOrEqual(5);
    expect(Number(value)).toBeLessThanOrEqual(100);
  });
});
