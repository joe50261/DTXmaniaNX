import { test, expect, type Page } from '@playwright/test';
import { installIwerRuntime } from './iwer-helper';

/**
 * In-VR song picker appears on session start when a library is
 * already loaded, and the panel's `onPick` / `onExit` callbacks land
 * on real Game state.
 *
 * Specifically pins `main.ts`'s `enterPromise.then` branch:
 *
 *     if (library && !game.hasChart) showSongSelectForActive();
 *
 * which is the only path that makes the song-select panel appear
 * without the user picking a song first on desktop. Breaking it
 * leaves a player entering VR to an empty scene with no way to pick
 * a chart without taking off the headset — a UX regression
 * `vr-lifecycle.test.ts` can't catch because it stubs out the XR
 * session surface.
 *
 * Also asserts the teardown symmetry: programmatic `session.end()`
 * runs the `onEnded` handler chain that hides the panel AND restores
 * the desktop overlay.
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
    game?: {
      inXR: boolean;
      songSelectShown: boolean;
      display: { webgl: { xr: { getSession(): { end(): Promise<void> } | null } } };
    };
    refreshXrButton?: () => void;
  };
};

/** Poll `inXR` / `songSelectShown` — the renderer's XR flag and the
 * panel's `shown` both update on the frame AFTER three.js acks
 * setSession, so polling is needed rather than a one-shot read. */
async function pollFlag(
  page: Page,
  flag: 'inXR' | 'songSelectShown',
  expected: boolean,
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((k: 'inXR' | 'songSelectShown') => {
          const game = (window as unknown as HookShape).__dtxmaniaTest?.game;
          return game?.[k] ?? null;
        }, flag),
      { timeout: 5_000 },
    )
    .toBe(expected);
}

test.describe('in-VR song picker — appears on session start when a library is loaded', () => {
  test('enter VR with library ➜ panel shown; end session ➜ panel hidden + overlay restored', async ({
    context,
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));

    await installIwerRuntime(context);
    await page.goto('/');
    await expect(page.locator('#overlay')).toBeVisible();

    // Library is the gate for the "auto-show menu" branch. installFakeLibrary
    // also forces refreshXrButton, so #enter-xr becomes visible without
    // a separate call.
    await installFakeLibrary(page, {
      songs: [
        { title: 'River', charts: [{ slot: 1, label: 'REG', level: 300 }] },
        { title: 'Tribe', charts: [{ slot: 1, label: 'REG', level: 400 }] },
      ],
    });
    await expect(page.locator('#enter-xr')).toBeVisible();

    await page.locator('#enter-xr').click();

    // Song-select panel showing is the whole point of this spec.
    // Also verify inXR flipped — a bug that kept the renderer on
    // desktop but "showed" the panel object could deceive the
    // `songSelectShown` flag without it actually being visible in VR.
    await expect(page.locator('#overlay')).toBeHidden({ timeout: 10_000 });
    await pollFlag(page, 'inXR', true);
    await pollFlag(page, 'songSelectShown', true);

    // Teardown: ending the session from outside (simulating the Exit
    // button's `session.end()` call) must bring the desktop overlay
    // back. A regression that forgot to re-show the overlay would
    // leave the player stuck on a black page after taking off the
    // headset.
    //
    // Note: `songSelectShown` is NOT asserted to flip false here.
    // main.ts's `enterPromise` `onEnded` calls `showSongSelectForActive()`
    // again when `library && !game.hasChart`, which switches the panel
    // from VR mode to desktop mode (still shown) rather than hiding it
    // — so the player keeps the picker without having to re-enter VR.
    // The positive check below pins that new behaviour explicitly.
    await page.evaluate(async () => {
      const s = (window as unknown as HookShape).__dtxmaniaTest?.game?.display.webgl.xr.getSession();
      if (!s) throw new Error('no session to end');
      await s.end();
    });

    await expect(page.locator('#overlay')).toBeVisible({ timeout: 5_000 });
    await pollFlag(page, 'inXR', false);
    // Panel stays shown — re-mounted in desktop mode for continued picking.
    await pollFlag(page, 'songSelectShown', true);

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });
});
