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

  test('toggling the auto-play BD lane persists and drives both DOM and VR panels', async ({
    page,
  }) => {
    // The auto-play grid exists on the desktop DOM config panel and
    // is mirrored on the VR canvas panel (both go through
    // `toggleAutoPlayLane` into `updateConfig`). We exercise the DOM
    // path here — the VR panel's cell onclick is covered by the
    // `toggleAutoPlayLane` unit test + the VR_CONFIG_LAYOUT geometry
    // tests — and pin the persisted localStorage shape so a future
    // refactor that forgets to write config.autoPlay.BD (e.g. by
    // spreading into the wrong object) fails here.
    await page.goto('/');
    await page.locator('#config-btn').click();
    const modal = page.locator('.config-modal');
    await expect(modal).toBeVisible();

    // Each lane cell is a <label> with a checkbox + span carrying the
    // lane abbreviation. Scope to the Auto-play section so we don't
    // accidentally match an unrelated "BD" elsewhere.
    const autoPlayGrid = modal.locator('.config-autoplay-grid');
    await expect(autoPlayGrid).toBeVisible();

    const bdCell = autoPlayGrid.locator('label', { hasText: /^BD$/ });
    const bdCheckbox = bdCell.locator('input[type=checkbox]');
    await expect(bdCheckbox).not.toBeChecked();

    await bdCheckbox.check();
    await expect(bdCheckbox).toBeChecked();

    const storedAfterOn = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as { autoPlay?: Record<string, boolean> }) : null;
    }, STORAGE_KEY);
    expect(storedAfterOn?.autoPlay?.BD).toBe(true);
    // Other lanes untouched — catches a regression where a careless
    // spread wipes sibling fields back to default.
    expect(storedAfterOn?.autoPlay?.LBD).toBe(false);
    expect(storedAfterOn?.autoPlay?.HH).toBe(false);

    // Flip back off and verify the toggle is symmetric (the VR grid
    // relies on `toggleAutoPlayLane` returning false → true → false).
    await bdCheckbox.uncheck();
    const storedAfterOff = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as { autoPlay?: Record<string, boolean> }) : null;
    }, STORAGE_KEY);
    expect(storedAfterOff?.autoPlay?.BD).toBe(false);
  });
});
