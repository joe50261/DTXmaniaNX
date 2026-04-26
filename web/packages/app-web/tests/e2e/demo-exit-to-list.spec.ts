import { test, expect } from '@playwright/test';

/**
 * Closing the loop on the legacy "list-less demo injection" path.
 *
 * Historically `start-demo` fetched `demo.dtx` and called `launchGame`
 * directly without setting up a `Library` — the chart played, but on
 * exit (Esc → KeyboardInput.onMenu(cancel) → Game.leaveSong →
 * onRestart) `main.ts`'s `showSongSelectForActive(fs)` saw
 * `!library` and silently returned. Result: overlay re-appeared with
 * the status text "Pick another chart or change folder." and no
 * song-select panel — the player had nowhere to go without picking a
 * Songs folder. The demo was a one-way trip.
 *
 * The fix is to route `playDemo` through the same library mechanism
 * the real picker uses — install a one-entry synthetic library
 * containing the demo chart, then `launchGame`. On exit,
 * `showSongSelectForActive` finds the library and shows the panel
 * with the demo entry, so the player can replay or pick another
 * chart from a folder they pick later.
 *
 * This spec pins the closed-loop behaviour: the demo chart appears
 * as a real entry on exit. The pre-fix behaviour (silent no-show)
 * is what we're guarding against regressing back to.
 */
test.describe('bundled demo — exit returns to a real song list', () => {
  test('start demo, press Esc to leave, song-select panel re-appears with the demo entry', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    await page.goto('/');
    await expect(page.locator('#overlay')).toBeVisible();

    await page.locator('#start-demo').click();

    // launchGame hides the overlay once the chart parsed + audio is up.
    await expect(page.locator('#overlay')).toBeHidden({ timeout: 10_000 });

    // hasChart flips true while the chart is loaded — used as the
    // positive signal that the demo really started, before we exit.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __dtxmaniaTest?: { game?: { hasChart: boolean } } })
                .__dtxmaniaTest?.game?.hasChart ?? null,
          ),
        { timeout: 5_000 },
      )
      .toBe(true);

    // Esc routes through KeyboardInput.onMenu(cancel) → Game.leaveSong
    // → onRestart, which is supposed to land us back on the picker.
    await page.keyboard.press('Escape');

    // Overlay re-appears (the desktop-mode branch of onRestart sets
    // display:grid). This already worked pre-fix.
    await expect(page.locator('#overlay')).toBeVisible({ timeout: 5_000 });

    // The actual closed-loop assertion: the song-select panel is
    // shown, and contains the demo chart as a navigable entry. Pre-fix
    // this would fail because `library === null` made
    // `showSongSelectForActive` early-return without calling
    // `Game.showSongSelect`, leaving `songSelectShown === false`.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                window as unknown as {
                  __dtxmaniaTest?: { game?: { songSelectShown: boolean } };
                }
              ).__dtxmaniaTest?.game?.songSelectShown ?? null,
          ),
        { timeout: 5_000 },
      )
      .toBe(true);

    // hasChart should drop back to false — leaveSong clears chart state.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __dtxmaniaTest?: { game?: { hasChart: boolean } } })
                .__dtxmaniaTest?.game?.hasChart ?? null,
          ),
        { timeout: 2_000 },
      )
      .toBe(false);

    expect(errors, `pageerrors: ${errors.join('\n')}`).toEqual([]);
  });
});
