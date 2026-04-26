import { test, expect, type Page } from '@playwright/test';
import { installIwerRuntime, releaseStick, setStickAxes } from './iwer-helper';

/**
 * Left-stick Y axis advances the song-select focus across multiple
 * XR frames. The pure model (`song-select-input.ts:stepStickAxis`)
 * exhaustively covers the Schmitt-trigger latching with vitest, but
 * the real-XR-frame pump that connects iwer's `updateAxes` to
 * `inputSource.gamepad.axes[3]` to `SongSelectCanvas.tick` only
 * lives end-to-end inside an immersive session — a regression that
 * (say) stopped reading axes per frame, or read from `axes[0]/[1]`
 * instead of `axes[2]/[3]`, would silently break in-VR navigation
 * and the unit tests couldn't notice.
 *
 * Each push-release pair fires exactly ONE focus move (the stick is
 * deliberately edge-triggered, no autofire — see PR #19's UX rationale
 * in song-select-input.ts:STICK_THRESHOLD comment). Three cycles of
 * push-down → release walk three rows down the wheel; we assert the
 * focused row title changes after each cycle.
 */

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

type HookShape = {
  __dtxmaniaTest?: {
    game?: { inXR: boolean; songSelectShown: boolean; songSelectFocusedTitle: string | null };
  };
};

async function focusedTitle(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      (window as unknown as HookShape).__dtxmaniaTest?.game?.songSelectFocusedTitle ?? null,
  );
}

async function pollFlag(
  page: Page,
  flag: 'inXR' | 'songSelectShown',
  expected: boolean,
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (k: 'inXR' | 'songSelectShown') =>
            (window as unknown as HookShape).__dtxmaniaTest?.game?.[k] ?? null,
          flag,
        ),
      { timeout: 5_000 },
    )
    .toBe(expected);
}

test.describe('VR thumbstick — Y axis steps focus across real XR frames', () => {
  test('three push-release cycles on left stick advance the focused row by three', async ({
    context,
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));

    await installIwerRuntime(context);
    await page.goto('/');

    // 5+ songs so the focus has somewhere to move; titles deliberately
    // alphabetic so the title-sort order is predictable (Alpha < Bravo
    // < Charlie < Delta < Echo).
    await installFakeLibrary(page, {
      songs: [
        { title: 'Alpha', charts: [{ slot: 1, label: 'REG', level: 300 }] },
        { title: 'Bravo', charts: [{ slot: 1, label: 'REG', level: 350 }] },
        { title: 'Charlie', charts: [{ slot: 1, label: 'REG', level: 400 }] },
        { title: 'Delta', charts: [{ slot: 1, label: 'REG', level: 450 }] },
        { title: 'Echo', charts: [{ slot: 1, label: 'REG', level: 500 }] },
      ],
    });
    await expect(page.locator('#enter-xr')).toBeVisible();
    await page.locator('#enter-xr').click();
    await pollFlag(page, 'inXR', true);
    await pollFlag(page, 'songSelectShown', true);

    // Initial focus: row 0 is the synthetic Random row; the wheel
    // doesn't auto-skip it on show(). Pin the starting state so a
    // future change (e.g. focus defaults to first song) fails this
    // assertion explicitly rather than silently shifting the count.
    const initialTitle = await focusedTitle(page);
    expect(initialTitle).toMatch(/Random/);

    // Cycle 1: push left stick fully down, wait for the tick to see
    // it, then release. `expect.poll` lets us tolerate however many
    // XR frames iwer takes to pump the value through.
    await setStickAxes(page, 'left', 0, 1);
    await expect.poll(() => focusedTitle(page), { timeout: 2_000 }).toBe('Alpha');
    await releaseStick(page, 'left');
    // Brief pause so the 0-axis read latches y back to the neutral
    // band before the next push — without this the second push
    // could see the same fired edge get suppressed by the latch.
    await page.waitForTimeout(50);

    // Cycle 2: another push moves to Bravo.
    await setStickAxes(page, 'left', 0, 1);
    await expect.poll(() => focusedTitle(page), { timeout: 2_000 }).toBe('Bravo');
    await releaseStick(page, 'left');
    await page.waitForTimeout(50);

    // Cycle 3: Charlie. Three cycles is enough to prove "fires once
    // per push" without writing a long chain — if the Schmitt
    // trigger ever regressed to autofire, the first push alone
    // would skip past Bravo to Echo and the polled-Bravo assertion
    // above would fail.
    await setStickAxes(page, 'left', 0, 1);
    await expect.poll(() => focusedTitle(page), { timeout: 2_000 }).toBe('Charlie');
    await releaseStick(page, 'left');

    // Reverse direction: a push UP (negative y) now walks back. Pin
    // the symmetry — a sign-flip in cycleFocus or the axis-read
    // polarity would break only one direction.
    await setStickAxes(page, 'left', 0, -1);
    await expect.poll(() => focusedTitle(page), { timeout: 2_000 }).toBe('Bravo');
    await releaseStick(page, 'left');

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });
});
