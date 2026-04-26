import { test, expect, type Page } from '@playwright/test';

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
 * Two scenarios cover the loop and the guard:
 *   1. Start demo from boot (no library) → Esc → song-select with
 *      the demo entry visible. Pre-fix this asserted false.
 *   2. With a real library already loaded, the demo button is
 *      disabled — clicking it must NOT clobber the picked library
 *      (review-found bug: `playDemo` previously replaced `library`
 *      unconditionally, leaving the player on a one-entry list
 *      after Esc with no path back to their picked folder).
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

  test('with a real library loaded, the demo button is disabled and cannot clobber it', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    await page.goto('/');
    await expect(page.locator('#overlay')).toBeVisible();

    // Boot state: no library yet, demo button is enabled (the only
    // way into the app on first launch).
    const demoBtn = page.locator('#start-demo');
    await expect(demoBtn).toBeEnabled();

    // Install a synthetic library — same hook the in-VR specs use.
    // This is the "player picked a folder" state from main.ts's POV
    // (commitLibrary's path that would normally run after the
    // FileSystem Access picker resolves).
    await installFakeLibrary(page, {
      songs: [
        { title: 'Picked Song A', charts: [{ slot: 1, label: 'REG', level: 300 }] },
        { title: 'Picked Song B', charts: [{ slot: 1, label: 'REG', level: 400 }] },
      ],
    });

    // Demo button must now be disabled — the guard against playDemo
    // clobbering the picked library with the synthetic demo root.
    // Pre-fix `playDemo()` ran unconditionally on click and replaced
    // `library`, so after Esc the player landed on a one-entry list
    // (just the demo) with no path back to "Picked Song A/B" without
    // re-clicking Pick folder.
    await expect(demoBtn).toBeDisabled();

    // Belt-and-braces: even if a future change accidentally re-
    // enables the button, force-click via JS should be a no-op
    // because `disabled` blocks the click handler. We verify by
    // checking the library titles are still the picked ones, not
    // the bundled demo's "Bundled demo".
    await page.evaluate(() => {
      const btn = document.getElementById('start-demo') as HTMLButtonElement | null;
      btn?.click();
    });
    // Give any pending async runs a chance to settle.
    await page.waitForTimeout(100);

    // The hook surfaces library state via a quick title probe — we
    // ride the song-select model through the existing shown getter
    // chain. After the (suppressed) demo click, focus + entries are
    // still the picked-library shape.
    const focusedAfter = await page.evaluate(
      () =>
        (
          window as unknown as {
            __dtxmaniaTest?: { game?: { songSelectFocusedTitle: string | null } };
          }
        ).__dtxmaniaTest?.game?.songSelectFocusedTitle ?? null,
    );
    // installFakeLibrary doesn't auto-show the panel, so
    // songSelectFocusedTitle may be null (no entries painted yet).
    // Either way it must NOT be the demo's "Bundled demo" entry —
    // a clobber would have made setRoot rebuild with that title.
    expect(focusedAfter).not.toBe('Bundled demo');

    expect(errors, `pageerrors: ${errors.join('\n')}`).toEqual([]);
  });
});

interface FakeLibrarySpec {
  songs: Array<{ title: string; charts: Array<{ slot: number; label: string; level?: number }> }>;
}

async function installFakeLibrary(page: Page, spec: FakeLibrarySpec): Promise<void> {
  await page.evaluate(async (s) => {
    const hook = (window as unknown as {
      __dtxmaniaTest?: { installFakeLibrary?: (spec: unknown) => Promise<void> };
    }).__dtxmaniaTest;
    if (!hook?.installFakeLibrary) throw new Error('installFakeLibrary hook missing');
    await hook.installFakeLibrary(s);
  }, spec);
}
