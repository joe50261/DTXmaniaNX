import { test, expect } from '@playwright/test';

/**
 * Practice-loop hotkeys + UI wiring. Demo chart (public/demo.dtx) is
 * 4 measures at 120 BPM which gives the song loop enough runway for
 * the capture hotkeys to return a meaningful measure index.
 *
 * Goals per spec:
 *   1. `[` / `]` / `\` hotkeys fire and surface the HUD toast (the
 *      `setStatus` → overlay path is hidden during play, so toast is
 *      the ONLY visual feedback — a regression that swallows it is
 *      silent from the player's perspective).
 *   2. The Settings panel's "Range is invalid" amber warning toggles
 *      visibility off config state, so players who misconfigure the
 *      range via hotkey don't get silent-disabled loops.
 */

const STORAGE_KEY = 'dtxmania.config';

test.describe('practice loop — hotkeys + invalid-range warning', () => {
  test('[ captures Loop A, ] captures Loop B, and \\ toggles — all surface the HUD toast', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    await page.goto('/');
    await page.locator('#start-demo').click();
    // launchGame() hides the overlay once the chart is ready; tolerate
    // a cold Chromium warmup.
    await expect(page.locator('#overlay')).toBeHidden({ timeout: 10_000 });

    const toast = page.locator('#hud-toast');

    // Toggle: starts disabled (default config), `\` flips it on → toast
    // "Loop on". A second press → "Loop off". Does not depend on a
    // specific songTime, so it's the safest assertion to run first.
    await page.keyboard.press('\\');
    await expect(toast).toHaveClass(/visible/);
    await expect(toast).toHaveText(/Loop on/);
    await page.keyboard.press('\\');
    await expect(toast).toHaveText(/Loop off/);

    // Capture hotkeys — [ snaps the current songTime to the floor
    // measure, ] to the ceil. Toast text includes the measure index,
    // or the "invalid" form when the resulting window is degenerate
    // (can happen if both captures fire during the lead-in countdown,
    // where songTime is negative and snaps to measure 0 for both).
    await page.keyboard.press('[');
    await expect(toast).toHaveText(/Loop A: measure \d+/);

    await page.keyboard.press(']');
    await expect(toast).toHaveText(/Loop B: measure \d+|invalid/);

    // Toast persists the "Loop *" text for ~1.8 s before the fade-out
    // class is removed. We've already asserted on the text; no need
    // to wait through the fade.
    expect(errors, `pageerrors: ${errors.join('\n')}`).toEqual([]);
  });

  test('Settings panel surfaces amber "Range is invalid" when B ≤ A and hides on Clear', async ({ page }) => {
    await page.goto('/');

    // Force an invalid range via the config blob directly. Drives the
    // same resolveLoopWindow-based visibility check the panel uses on
    // every subscribe tick; proves the warning toggles off stored
    // state, not only the capture hotkey path. Reload to pick up the
    // pre-seed before ConfigPanel reads it.
    await page.evaluate((key) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          practiceLoopEnabled: true,
          practiceLoopStartMeasure: 3,
          practiceLoopEndMeasure: 1,
        }),
      );
    }, STORAGE_KEY);
    await page.reload();

    await page.locator('#config-btn').click();
    const modal = page.locator('.config-modal');
    await expect(modal).toBeVisible();

    const warn = modal.locator('.config-note-warn');
    await expect(warn).toBeVisible();
    await expect(warn).toContainText(/invalid/i);

    // Clear wipes start + end and disables the loop; the warning's
    // resolveLoopWindow-equivalent check (end !== null && end <= start)
    // is now false, so the warning must hide.
    await modal.locator('button', { hasText: 'Clear A/B' }).click();
    await expect(warn).toBeHidden();
  });
});
