import { test, expect } from '@playwright/test';

test('minimap has zoom controls', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.minimap-container', { timeout: 10000 });

  const container = page.locator('.minimap-container');
  await expect(container).toBeVisible();

  // Zoom buttons should exist in DOM
  const zoomBtns = page.locator('.minimap-zoom-btn');
  expect(await zoomBtns.count()).toBe(2);

  // Check button labels
  await expect(zoomBtns.nth(0)).toContainText('+');
  await expect(zoomBtns.nth(1)).toContainText('−');

  // Zoom controls start hidden (opacity 0) and appear on hover
  const controls = page.locator('.minimap-zoom-controls');
  let opacity = await controls.evaluate(el => window.getComputedStyle(el).opacity);
  // Should be 0 when not hovered
  expect(parseFloat(opacity)).toBe(0);

  // Hover over minimap
  await container.hover();
  await page.waitForTimeout(200);

  opacity = await controls.evaluate(el => window.getComputedStyle(el).opacity);
  // Should be 1 when hovered
  expect(parseFloat(opacity)).toBe(1);

  // Clicking + should zoom in
  const initialZoom = await page.locator('.zoom-indicator').textContent();
  await zoomBtns.nth(0).click();
  await page.waitForTimeout(300);
  const afterZoomIn = await page.locator('.zoom-indicator').textContent();
  expect(afterZoomIn).not.toBe(initialZoom);
  expect(parseInt(afterZoomIn)).toBeGreaterThan(parseInt(initialZoom));

  // Clicking − should zoom out
  await zoomBtns.nth(1).click();
  await page.waitForTimeout(300);
  const afterZoomOut = await page.locator('.zoom-indicator').textContent();
  expect(parseInt(afterZoomOut)).toBeLessThan(parseInt(afterZoomIn));
});
