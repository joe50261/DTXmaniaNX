import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test, expect } from '@playwright/test';

/**
 * `#enter-xr` button visibility across two environments:
 *   1. Vanilla Chromium (Playwright's runner) — has the WebXR surface
 *      but no XR device, so `isSessionSupported('immersive-vr')`
 *      resolves `false` and the button stays hidden.
 *   2. Chromium with Meta's `iwer` (Immersive Web Emulation Runtime)
 *      bootstrapping a Quest 3 device — `isSessionSupported` resolves
 *      `true` and the button becomes visible.
 *
 * Why iwer over a hand-rolled `Object.defineProperty(navigator, 'xr',
 * {...})` stub:
 *   - A manual `isSessionSupported ➜ true` stub silently lies if
 *     `refreshXrButton` grows a new probe (e.g. feature-detection on
 *     `navigator.xr.requestSession` input features). Iwer serves the
 *     full XRSystem spec surface, so the test fails for the right
 *     reason when the code evolves.
 *   - CLAUDE.md flags WebXR as the class of regression that belongs in
 *     Playwright + Chrome's WebXR Device Emulator. Iwer is the
 *     programmatic equivalent — injectable via `addInitScript`, no
 *     manual DevUI clicks required.
 *
 * We assert visibility only — not the click ➜ session ➜ overlay-hidden
 * path. `game.enterXR` hands the session off to three.js's XRManager
 * which would need a real WebGL render loop, controller poses, and a
 * synthetic environment module to not throw; the model-level pieces
 * (`resolveHapticSource`, `emptyChartState`, XR lifecycle) are already
 * covered by `xr-controllers.test.ts` and `vr-lifecycle.test.ts`.
 */

// Iwer ships a UMD bundle under `build/iwer.min.js` that self-assigns to
// `window.IWER`. Resolved via createRequire so ESM test contexts pick up
// the same path the Node bundler would — works regardless of whether pnpm
// hoists the package to the root node_modules or leaves it in .pnpm.
const require_ = createRequire(import.meta.url);
const IWER_BUNDLE_PATH = require_.resolve('iwer/build/iwer.min.js');

async function readIwerBundle(): Promise<string> {
  return readFile(IWER_BUNDLE_PATH, 'utf8');
}

test.describe('#enter-xr visibility', () => {
  test('hidden on vanilla Chromium (no headset ⇒ isSessionSupported resolves false)', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('#overlay')).toBeVisible();

    // Playwright's headless Chromium ships the WebXR surface on
    // `navigator.xr` but with no backing device, so
    // `isSessionSupported('immersive-vr')` resolves `false`. That's the
    // desktop-with-no-headset branch of refreshXrButton (set the button
    // display to `none` after the promise settles). Boot state is
    // governed by index.html's inline `style="display:none"` —
    // refreshXrButton isn't called at module init, so we trigger it
    // explicitly and then assert against the live async branch.
    await page.evaluate(() => {
      const hook = (window as unknown as {
        __dtxmaniaTest?: { refreshXrButton?: () => void };
      }).__dtxmaniaTest;
      if (!hook?.refreshXrButton) throw new Error('refreshXrButton hook missing');
      hook.refreshXrButton();
    });

    await expect(page.locator('#enter-xr')).toBeHidden();
  });

  test('visible when iwer emulates a Meta Quest 3 XRSystem', async ({ context, page }) => {
    const iwerBundle = await readIwerBundle();

    // Inject the iwer runtime and bootstrap a Quest 3-shaped device
    // BEFORE any page script evaluates. `addInitScript` runs per new
    // document, so this applies to the upcoming `goto('/')`.
    //
    // We use two separate scripts rather than concatenating so any
    // syntax issue in our installer surfaces with a clear stack
    // (instead of pretending iwer itself threw).
    await context.addInitScript(iwerBundle);
    await context.addInitScript(() => {
      // Iwer's UMD exposes `window.IWER` with XRDevice + headset presets.
      // Constructing with `metaQuest3` installs an `immersive-vr`-capable
      // session surface; `installRuntime` patches `navigator.xr` onto
      // the window the test page shares.
      const iwer = (
        window as unknown as {
          IWER: {
            XRDevice: new (cfg: unknown) => { installRuntime: () => void };
            metaQuest3: unknown;
          };
        }
      ).IWER;
      new iwer.XRDevice(iwer.metaQuest3).installRuntime();
    });

    await page.goto('/');
    await expect(page.locator('#overlay')).toBeVisible();

    // Sanity: iwer actually landed on `navigator.xr`. A zero-length
    // runtime (bundle fetch failure, UMD self-assign suppressed) would
    // turn the button visibility into a silent false negative.
    const xrSupported = await page.evaluate(async () => {
      if (!navigator.xr) return 'missing';
      return navigator.xr.isSessionSupported('immersive-vr');
    });
    expect(xrSupported).toBe(true);

    await page.evaluate(() =>
      (
        window as unknown as { __dtxmaniaTest: { refreshXrButton: () => void } }
      ).__dtxmaniaTest.refreshXrButton(),
    );

    // `refreshXrButton` resolves isSessionSupported on the microtask
    // queue and flips the style afterwards; `toBeVisible` retries. If
    // the eligibility gate (`library || activeGame`) regresses to
    // `library`-only, this fails — no library loaded here, only the
    // eagerly-built `activeGame` keeps the button eligible.
    await expect(page.locator('#enter-xr')).toBeVisible();
  });
});
