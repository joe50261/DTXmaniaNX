import { test, expect } from '@playwright/test';

test.describe('bundled demo play path', () => {
  test('click #start-demo hides overlay and leaves canvas in play', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    // Catch any skin-asset 404 (typo / casing / generator-vs-consumer
    // filename mismatch). The renderer tolerates missing skin pieces by
    // falling back to plain 2D drawing — see skin.ts — so a 404 is
    // otherwise silent at runtime, exactly the regression an automated
    // check is good at. Driving demo play exercises loadSkin()'s
    // Stage-7 fetches (7_background.png, 7_pads.png, 7_chips_drums.png,
    // ScreenPlayDrums pads flush.png, ScreenPlay judge strings 1.png,
    // 7_Gauge.png, 7_gauge_bar.png) plus anything song-select-canvas
    // touches if the player goes there before play.
    const skinFailures: string[] = [];
    page.on('response', (r) => {
      const url = r.url();
      if (url.includes('/skin/') && r.status() >= 400) {
        skinFailures.push(`${r.status()} ${url}`);
      }
    });

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

    // Let any in-flight skin fetches resolve before we assert. loadSkin()
    // is async and can complete after the keyboard input — without the
    // settle pause we'd race the listener.
    await page.waitForLoadState('networkidle');

    expect(errors, `pageerrors: ${errors.join('\n')}`).toEqual([]);
    expect(skinFailures, `skin asset 404s: ${skinFailures.join(', ')}`).toEqual([]);
  });
});
