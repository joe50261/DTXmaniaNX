import { test, expect } from '@playwright/test';

/**
 * End-to-end coverage for the "leftover state from the previous chart"
 * fix in `game.ts`:`loadAndStart` → `emptyChartState`.
 *
 * The bug in its VR form: picking a song from the in-VR menu while the
 * RESULTS screen from the previous play was still mounted left the
 * last chart's chips + score overlay painting into the VR panel
 * texture throughout the new chart's sample-preload window. The
 * desktop path exercises the same `loadAndStart` entry point — if the
 * state reset there is incomplete, a replay from the menu will render
 * a dirty first frame.
 *
 * We can't assert on canvas pixels directly (WebGL + offscreen HUD
 * canvas), but we CAN verify the observable DOM contract:
 *   - Start demo → overlay hides, #game stays mounted.
 *   - Esc back to menu → overlay re-appears.
 *   - Start demo again → overlay hides without throwing; no
 *     pageerror / console error during the transition.
 * A regression in the reset path (e.g. finishedReturnHandled left
 * true) would surface as a pageerror from the tick() loop hitting
 * stale state, or as the overlay failing to hide because launchGame
 * threw out of loadAndStart.
 */
test.describe('demo replay path — no residual state between runs', () => {
  test('start demo, return to menu, start again without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto('/');
    await expect(page.locator('#overlay')).toBeVisible();

    // First demo run.
    await page.locator('#start-demo').click();
    await expect(page.locator('#overlay')).toBeHidden({ timeout: 10_000 });
    await expect(page.locator('#game')).toBeAttached();

    // Bail out back to the picker (Esc routes through Game.leaveSong
    // which clears song/status; same cleanup path as VR squeeze-cancel).
    await page.keyboard.press('Escape');
    await expect(page.locator('#overlay')).toBeVisible({ timeout: 5_000 });

    // Second demo run — this is the replay. We can't re-click
    // #start-demo: the first run installed a synthetic single-entry
    // library (so the demo-exit path lands on a real picker rather
    // than an empty overlay), and the demo button is disabled while
    // any library is loaded — see `demo-exit-to-list.spec.ts` for
    // the rationale. The expected replay path is the same one a
    // player uses to re-pick from their real library: arrow down
    // past the synthetic Random row to the Bundled demo entry, then
    // Enter to launch.
    //
    // If loadAndStart's state-reset regressed (song/status/
    // hitFlashes not wiped), tick()'s `if (!this.song) return;`
    // would never fire during the preload and the render would
    // throw on stale fields; or the previous run's
    // finishedReturnHandled would make onRestart double-fire and
    // recurse. Either way the overlay would not hide cleanly here.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('#overlay')).toBeHidden({ timeout: 10_000 });
    await expect(page.locator('#game')).toBeAttached();

    // Let a few render frames tick so any latent stale-state crash
    // in tick() surfaces as a pageerror. Using rAF instead of a
    // wall-clock timeout keeps the test deterministic across slow
    // CI machines.
    await page.evaluate(async () => {
      for (let i = 0; i < 10; i++) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
    });

    expect(errors, `errors during replay: ${errors.join('\n')}`).toEqual([]);
  });
});
