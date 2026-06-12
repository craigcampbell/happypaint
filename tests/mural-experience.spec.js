import { test, expect, devices } from '@playwright/test';

test.describe('Mural Jam experience', () => {
  test('loads a named mural from the URL', async ({ page }) => {
    await page.goto('/?mural=rainbow-wall');
    await page.waitForSelector('.mural-hud', { timeout: 10000 });

    await expect(page.locator('.mural-hud')).toContainText('rainbow-wall');
    await expect(page.locator('.connection-status')).toContainText('Live in rainbow-wall');
    await expect(page.locator('.prompt-strip')).toBeVisible();
  });

  test('mural API exposes room capacity and saved mark metadata', async ({ request }) => {
    const response = await request.get('http://localhost:3001/api/murals/playwright-wall');
    expect(response.ok()).toBeTruthy();

    const mural = await response.json();
    expect(mural.id).toBe('playwright-wall');
    expect(mural.maxArtists).toBeGreaterThan(1);
    expect(mural.strokeCount).toBeGreaterThanOrEqual(0);
  });

  test('mobile keeps the mural HUD and bottom tool tray usable', async ({ browser }) => {
    const context = await browser.newContext({
      ...devices['Pixel 5'],
      hasTouch: true,
    });
    const page = await context.newPage();

    await page.goto('/?mural=phone-wall');
    await page.waitForSelector('.toolbar-panel', { timeout: 10000 });

    await expect(page.locator('.mural-hud')).toBeVisible();
    await expect(page.locator('.toolbar-panel')).toBeVisible();
    await expect(page.locator('.save-mural-btn')).toBeVisible();

    await context.close();
  });
});
