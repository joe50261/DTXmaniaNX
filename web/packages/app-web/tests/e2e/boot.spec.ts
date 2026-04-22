import { test, expect, type ConsoleMessage } from '@playwright/test';

test.describe('app boot', () => {
  test('overlay, canvas, and initial status render without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    await page.goto('/');

    await expect(page.locator('#overlay')).toBeVisible();
    await expect(page.locator('#game')).toBeAttached();
    await expect(page.locator('#status')).toHaveText('Pick your Songs folder to begin.');
    await expect(page.locator('#pick-folder')).toBeVisible();
    await expect(page.locator('#start-demo')).toBeVisible();
    await expect(page.locator('#config-btn')).toBeVisible();

    // Let any async boot work settle so late errors surface.
    await page.waitForTimeout(500);

    // File System Access missing on the runner logs a warn (not error) —
    // we only fail on real errors here. Skin-load fallback warns likewise.
    expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
  });

  test('service worker registers and PWA manifest is fetchable', async ({ page }) => {
    await page.goto('/');

    const reg = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return null;
      const r = await navigator.serviceWorker.getRegistration();
      return r ? { scope: r.scope } : null;
    });
    expect(reg).not.toBeNull();

    const manifestHref = await page.locator('link[rel=manifest]').getAttribute('href');
    expect(manifestHref).toBeTruthy();
    const manifestUrl = new URL(manifestHref!, page.url()).toString();
    const res = await page.request.get(manifestUrl);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.name || body.short_name).toBeTruthy();
  });
});
