import { test, expect } from '@playwright/test';

const STORAGE_KEY = 'dtxmania.config';

test.describe('config panel', () => {
  test('opening the panel, moving BGM volume, persists to localStorage', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#overlay')).toBeVisible();

    await page.locator('#config-btn').click();

    const modal = page.locator('.config-modal');
    await expect(modal).toBeVisible();

    // The form is built dynamically — rows are .config-row-slider with a
    // .config-label. BGM volume row has label "BGM volume".
    const bgmRow = modal.locator('.config-row-slider', { hasText: 'BGM volume' });
    const bgmInput = bgmRow.locator('input[type=range]');
    await expect(bgmInput).toBeVisible();

    // Set volume via the HTMLInputElement API then dispatch 'input' so
    // updateConfig fires — same path as a real drag.
    await bgmInput.evaluate((el: HTMLInputElement) => {
      el.value = '0.25';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // config.ts writes the whole blob to localStorage on every update.
    const stored = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as { volumeBgm?: number }) : null;
    }, STORAGE_KEY);

    expect(stored).not.toBeNull();
    expect(stored!.volumeBgm).toBeCloseTo(0.25, 2);

    // Close via ✕ — backdrop hides.
    await modal.locator('.config-close').click();
    await expect(page.locator('#config-backdrop')).toBeHidden();
  });
});
