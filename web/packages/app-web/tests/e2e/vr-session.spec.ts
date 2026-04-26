import { test, expect, type Page } from '@playwright/test';
import { installIwerRuntime } from './iwer-helper';

/**
 * VR session lifecycle — entering and exiting an immersive-vr session
 * via real `navigator.xr` (iwer). Focuses on the wiring between:
 *
 *   click #enter-xr ➜ main.ts enter-handler ➜ `game.enterXR` ➜
 *   `renderer.enterXR` ➜ `navigator.xr.requestSession` ➜
 *   `webgl.xr.setSession(session)` ➜ onSessionStarted ➜ overlay hidden,
 *   status updated, and the symmetric teardown when `session.end()` is
 *   called.
 *
 * The individual pieces (pose resolution, lifecycle state machine,
 * controller slot identity) live in unit tests under
 * `xr-controllers.test.ts` / `vr-lifecycle.test.ts`. This spec pins the
 * plumbing that only fails under a real WebXR runtime — things like
 * three.js's `setSession` awaiting a framebuffer, the `'end'` event
 * listener on the XRSession actually firing, and the desktop overlay
 * state being restored without the user having to reload.
 */

type DtxmaniaTestHookShape = {
  __dtxmaniaTest?: {
    game?: {
      inXR: boolean;
      display: {
        webgl: {
          xr: { getSession(): { end(): Promise<void> } | null };
        };
      };
    };
    refreshXrButton?: () => void;
  };
};

/** Poll `game.inXR` until the expected value (the renderer's XR flag
 * updates asynchronously after three.js acks `setSession`). */
async function expectInXR(page: Page, expected: boolean): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as DtxmaniaTestHookShape).__dtxmaniaTest?.game?.inXR ?? null,
        ),
      { timeout: 5_000 },
    )
    .toBe(expected);
}

test.describe('VR session — enter, cleanly reach the immersive state, exit', () => {
  test('click Enter VR ➜ overlay hidden + inXR true; end session ➜ overlay restored + inXR false', async ({
    context,
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));

    await installIwerRuntime(context);
    await page.goto('/');
    await expect(page.locator('#overlay')).toBeVisible();

    // refreshXrButton isn't called at boot, so surface the button
    // before trying to click it. Boot log confirms activeGame is
    // eligible (`eligible = Boolean(library || activeGame)` and the
    // eagerly-constructed Game satisfies the latter).
    await page.evaluate(() =>
      (
        window as unknown as {
          __dtxmaniaTest: { refreshXrButton: () => void };
        }
      ).__dtxmaniaTest.refreshXrButton(),
    );
    await expect(page.locator('#enter-xr')).toBeVisible();

    await page.locator('#enter-xr').click();

    // Success criteria for "we're in VR": overlay hides (main.ts's
    // enterPromise.then sets display:none), status updates, and
    // game.inXR flips. All three must land — a partial (overlay
    // hidden but inXR false) would indicate three.js took the session
    // but renderer.xrSession didn't get wired back.
    await expect(page.locator('#overlay')).toBeHidden({ timeout: 10_000 });
    await expect(page.locator('#status')).toHaveText('In VR — use controllers to play.');
    await expectInXR(page, true);

    // End the session from outside (no controller to press Exit
    // without a menu). Matches what `onExit` does in main.ts's
    // showSongSelectForActive. iwer dispatches the 'end' event to the
    // XRSession, renderer's listener restores playfield state, and
    // main.ts's onEnded handler re-shows the overlay.
    await page.evaluate(async () => {
      const session = (
        window as unknown as DtxmaniaTestHookShape
      ).__dtxmaniaTest?.game?.display.webgl.xr.getSession();
      if (!session) throw new Error('no active XR session to end');
      await session.end();
    });

    await expect(page.locator('#overlay')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#status')).toHaveText('Exited VR.');
    await expectInXR(page, false);

    // Any residual failure mode we haven't caught would surface here
    // — e.g. a stale requestAnimationFrame handle running against a
    // torn-down XRFrame would throw a pageerror.
    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });
});
