import { test, expect } from '@playwright/test';

test.describe('bundled demo play path', () => {
  test('click #start-demo hides overlay and leaves canvas in play', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    await page.goto('/');
    await expect(page.locator('#overlay')).toBeVisible();

    await page.locator('#start-demo').click();

    // launchGame() sets overlay.style.display = 'none' once the chart
    // has parsed and audio graph is primed. Demo ships without WAVs so
    // no "Loading samples…" stage — transition is typically sub-second,
    // but allow generous time for a cold Chromium warmup.
    await expect(page.locator('#overlay')).toBeHidden({ timeout: 10_000 });

    // Canvas stays mounted throughout game play. It's WebGL-backed so we
    // don't try to assert on pixels — just that the element remains.
    await expect(page.locator('#game')).toBeAttached();

    // Press a few drum keys — these should be absorbed by the input
    // routing without raising. Snare, Bass, HiHat per the help text.
    await page.keyboard.press('KeyS');
    await page.keyboard.press('Space');
    await page.keyboard.press('KeyH');

    // Escape returns to menu per the in-app hint.
    await page.keyboard.press('Escape');

    expect(errors, `pageerrors: ${errors.join('\n')}`).toEqual([]);
  });
});
