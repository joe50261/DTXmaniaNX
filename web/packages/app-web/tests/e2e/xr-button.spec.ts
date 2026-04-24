import { test, expect } from '@playwright/test';

/**
 * `#enter-xr` button visibility in non-XR vs stubbed-XR Chromium.
 *
 * `refreshXrButton` (main.ts) has three observable branches that vitest
 * can't cover authentically — they all pivot on the real `navigator.xr`
 * shape:
 *
 *   A. `navigator.xr` absent → button hidden. This is headless Chromium's
 *      default (Playwright's Linux runner ships no WebXR Device API).
 *   B. `navigator.xr.isSessionSupported('immersive-vr')` resolves `true`
 *      → button `display:inline-block`. What we see on Quest Browser.
 *   C. The same call throws or resolves `false` → button hidden. Covered
 *      implicitly by (A) since the runner never returns true.
 *
 * We deliberately don't test the click handler → `enterXR` path here:
 * Chromium can't mint an XR session without a headset regardless of
 * stubs, so the interesting edge is visibility only. The click wiring
 * itself is reachable via `game.enterXR` unit tests in vr-lifecycle.
 */

test.describe('#enter-xr visibility', () => {
  test('hidden when navigator.xr is absent, visible when stubbed supported', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#overlay')).toBeVisible();

    const xrBtn = page.locator('#enter-xr');
    // At boot the HTML attribute `style="display:none"` wins — no
    // library has triggered `refreshXrButton` yet. Explicitly invoke
    // it so we're asserting against the live branch rather than the
    // static inline style.
    await page.evaluate(() => {
      const hook = (window as unknown as {
        __dtxmaniaTest?: { refreshXrButton?: () => void };
      }).__dtxmaniaTest;
      if (!hook?.refreshXrButton) throw new Error('refreshXrButton hook missing');
      hook.refreshXrButton();
    });
    // Headless Chromium on the Playwright runner has no navigator.xr,
    // so the branch-A guard hides the button.
    await expect(xrBtn).toBeHidden();

    // Install a stub xr that reports `immersive-vr` as supported.
    // `configurable: true` so the defineProperty shadows anything the
    // browser may put on navigator's prototype; required for the
    // branch-B path where the device layer exists.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'xr', {
        configurable: true,
        value: {
          isSessionSupported: (mode: string) => Promise.resolve(mode === 'immersive-vr'),
          // refreshXrButton only touches isSessionSupported, but a
          // minimal requestSession stub makes it harder for future
          // changes to silently call something undefined on this
          // object and have the test pass by accident.
          requestSession: () => Promise.reject(new Error('stub: no real XR in tests')),
        },
      });
    });
    await page.evaluate(() =>
      (
        window as unknown as { __dtxmaniaTest: { refreshXrButton: () => void } }
      ).__dtxmaniaTest.refreshXrButton(),
    );

    // isSessionSupported resolves on the microtask queue; Playwright's
    // `toBeVisible` retries until the style flips (or times out). If
    // the eligibility gate (`library || activeGame`) regresses to
    // `library`-only, this assertion catches it because no library is
    // loaded in this test — only the eagerly-built `activeGame` keeps
    // the button eligible.
    await expect(xrBtn).toBeVisible();
  });
});
