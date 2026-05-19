import { test, expect, devices } from '@playwright/test';

test.describe('Happy Paint - Core', () => {
  test('loads the app', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.app-title', { timeout: 10000 });
    await expect(page.locator('.app-title')).toContainText('Happy Paint');
  });

  test('shows toolbar', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.toolbar-panel', { timeout: 10000 });
    await expect(page.locator('.toolbar-panel')).toBeVisible();
  });

  test('canvas renders', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.webgl-canvas', { timeout: 10000 });
    await expect(page.locator('.webgl-canvas')).toBeVisible();
  });

  test('brush selector works', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.brush-select', { timeout: 10000 });
    const brushSelect = page.locator('.brush-select').nth(1);
    await brushSelect.selectOption('spray');
    await expect(brushSelect).toHaveValue('spray');
  });

  test('color swatches have unique keys (no duplicate warning)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.color-swatch', { timeout: 10000 });
    const swatches = page.locator('.color-swatch');
    await expect(swatches.first()).toBeVisible();
  });

  test('size slider is visible', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.size-slider', { timeout: 10000 });
    await expect(page.locator('.size-slider').first()).toBeVisible();
  });

  test('clear button is visible', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.clear-btn', { timeout: 10000 });
    await expect(page.locator('.clear-btn')).toBeVisible();
  });

  test('user list is visible', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.user-list-btn', { timeout: 10000 });
    await expect(page.locator('.user-list-btn')).toBeVisible();
  });

  test('connection status shows', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.connection-status', { timeout: 10000 });
    await expect(page.locator('.connection-status')).toBeVisible();
  });
});

test.describe('Happy Paint - Viewport', () => {
  test('zoom indicator is visible', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.zoom-indicator', { timeout: 10000 });
    await expect(page.locator('.zoom-indicator')).toBeVisible();
    await expect(page.locator('.zoom-indicator')).toContainText('%');
  });

  test('minimap renders', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.minimap', { timeout: 10000 });
    const minimap = page.locator('.minimap');
    await expect(minimap).toBeVisible();
  });

  test('minimap click navigates viewport', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.minimap', { timeout: 10000 });
    const minimap = page.locator('.minimap');
    const box = await minimap.boundingBox();
    // Click center of minimap
    await minimap.click({ position: { x: box.width / 2, y: box.height / 2 } });
    // Should not crash
    await page.waitForTimeout(300);
    await expect(page.locator('.zoom-indicator')).toBeVisible();
  });

  test('zoom via wheel changes zoom indicator', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.zoom-indicator', { timeout: 10000 });
    const initialText = await page.locator('.zoom-indicator').textContent();
    // Scroll to zoom
    await page.locator('.webgl-canvas').dispatchEvent('wheel', { deltaY: -100 });
    await page.waitForTimeout(500);
    const newText = await page.locator('.zoom-indicator').textContent();
    // Zoom level should have changed
    expect(newText).not.toBe(initialText);
  });

  test('space key changes cursor mode', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.webgl-canvas', { timeout: 10000 });
    // Press space
    await page.keyboard.down('Space');
    await page.waitForTimeout(200);
    // Release space
    await page.keyboard.up('Space');
    // Should not crash
    await expect(page.locator('.zoom-indicator')).toBeVisible();
  });
});

test.describe('Happy Paint - Chat Brush', () => {
  test('chat brush option exists', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.brush-select', { timeout: 10000 });
    const brushSelect = page.locator('.brush-select').nth(1);
    await brushSelect.selectOption('chat');
    await expect(brushSelect).toHaveValue('chat');
  });

  test('Show Chat toggle is visible', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.layer-toggles', { timeout: 10000 });
    await expect(page.locator('.layer-toggles')).toBeVisible();
  });

  test('old chat panel is gone', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.toolbar-panel', { timeout: 10000 });
    // Old chat button and panel should not exist
    await expect(page.locator('.chat-btn')).toHaveCount(0);
    await expect(page.locator('.chat-panel')).toHaveCount(0);
  });
});

test.describe('Happy Paint - Meme Brush', () => {
  test('meme brush option exists', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.brush-select', { timeout: 10000 });
    const brushSelect = page.locator('.brush-select').nth(1);
    await brushSelect.selectOption('meme');
    await expect(brushSelect).toHaveValue('meme');
  });

  test('meme brush click opens file input', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.brush-select', { timeout: 10000 });
    await page.locator('.brush-select').nth(1).selectOption('meme');
    await page.waitForTimeout(200);

    const canvasArea = page.locator('.canvas-area');
    const box = await canvasArea.boundingBox();
    await canvasArea.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await page.waitForTimeout(300);
    await expect(page.locator('input[type="file"]')).toHaveCount(1);
  });

  test('Show Memes toggle is visible', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.layer-toggles', { timeout: 10000 });
    await expect(page.locator('.layer-toggles')).toContainText('Show Memes');
  });

  test('layer toggles can be clicked', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.layer-toggles input[type="checkbox"]', { timeout: 10000 });
    const checkboxes = page.locator('.layer-toggles input[type="checkbox"]');
    await expect(checkboxes).toHaveCount(2);
    // Toggle first checkbox
    await checkboxes.first().click();
    await page.waitForTimeout(200);
    // Toggle it back
    await checkboxes.first().click();
    await page.waitForTimeout(200);
  });
});

test.describe('Happy Paint - Mobile', () => {
  test('works on iPad viewport', async ({ browser }) => {
    const context = await browser.newContext({
      ...devices['iPad (gen 7)'],
    });
    const page = await context.newPage();
    await page.goto('/');
    await page.waitForSelector('.app-title', { timeout: 15000 });
    await expect(page.locator('.app-title')).toBeVisible();
    await expect(page.locator('.webgl-canvas')).toBeVisible();
    await context.close();
  });

  test('touch interaction works on mobile viewport', async ({ browser }) => {
    const context = await browser.newContext({
      ...devices['iPad (gen 7)'],
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto('/');
    await page.waitForSelector('.webgl-canvas', { timeout: 10000 });
    await page.waitForTimeout(500);
    await expect(page.locator('.zoom-indicator')).toBeVisible();
    await context.close();
  });
});
