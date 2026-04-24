import { test, expect, type Page } from '@playwright/test';
import { installIwerRuntime } from './iwer-helper';

/**
 * Controller input reaches the in-VR menu's tick loop and fires a
 * song-pick via the "no ray hit ⇒ activateFocused" branch.
 *
 * Why this is worth the effort:
 *
 *   - `xr-controllers.test.ts` covers hit-test geometry with a fake
 *     renderer, but NOT the real XRSession input-source wiring.
 *     Iwer gives us a spec-compliant `XRInputSource[]` pumped every
 *     frame, so the `inputSources[i].gamepad.buttons[0].pressed` edge
 *     detection in `vr-menu.ts:tick` runs the real path.
 *   - A regression that (say) stopped copying iwer's gamepad state
 *     into `inputSources`, or froze the edge-detection on the first
 *     frame, would silently break every in-VR click and the unit
 *     tests couldn't notice.
 *
 * We don't test pad-stick-hit geometry here — that requires scripting
 * sub-second position deltas timed against a real `requestAnimationFrame`
 * and is a level of flakiness not worth the coverage in this pass.
 * The controller-button + VR-menu path exercises the same
 * `session.inputSources` pipeline, which is the regression that
 * matters.
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
    game?: { inXR: boolean; vrMenuShown: boolean; hasChart: boolean };
    refreshXrButton?: () => void;
  };
  __iwerDevice?: {
    controllers: Record<
      'left' | 'right',
      | {
          updateButtonValue(id: string, v: number): void;
          setButtonValueImmediate(id: string, v: number): void;
        }
      | undefined
    >;
  };
};

async function pollFlag(
  page: Page,
  flag: 'inXR' | 'vrMenuShown' | 'hasChart',
  expected: boolean,
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (k: 'inXR' | 'vrMenuShown' | 'hasChart') =>
            (window as unknown as HookShape).__dtxmaniaTest?.game?.[k] ?? null,
          flag,
        ),
      { timeout: 5_000 },
    )
    .toBe(expected);
}

test.describe('controller trigger — drives VR menu via real XRSession inputSources', () => {
  test('right trigger pulse while VR menu is up ➜ focused song commits (game.hasChart=true)', async ({
    context,
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));

    await installIwerRuntime(context);
    await page.goto('/');
    await installFakeLibrary(page, {
      songs: [
        { title: 'River', charts: [{ slot: 1, label: 'REG', level: 300 }] },
        { title: 'Tribe', charts: [{ slot: 1, label: 'REG', level: 400 }] },
      ],
    });
    await expect(page.locator('#enter-xr')).toBeVisible();
    await page.locator('#enter-xr').click();
    await pollFlag(page, 'inXR', true);
    await pollFlag(page, 'vrMenuShown', true);
    // Chart hasn't been loaded yet — the menu is up, waiting for a pick.
    await pollFlag(page, 'hasChart', false);

    // Pulse the right trigger. Iwer's `updateButtonValue` queues the
    // change until the next XRFrame; `setButtonValueImmediate` is the
    // one that lands on the gamepad state synchronously. We release
    // to 0 first (trigger edge-detection in vr-menu compares
    // `pressed` vs `wasPressed` — starting from 0 makes the
    // 0→1 transition deterministic), wait a frame, then press to 1.
    await page.evaluate(async () => {
      const device = (window as unknown as HookShape).__iwerDevice;
      const right = device?.controllers.right;
      if (!right) throw new Error('no right controller on emulated device');
      right.setButtonValueImmediate('trigger', 0);
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      right.setButtonValueImmediate('trigger', 1);
    });

    // VrMenu.tick runs once per XR frame; the trigger edge fires
    // activateFocused → onPick → launchGame. loadAndStart sets
    // game.song before the await resolves, so hasChart flips true as
    // soon as the parse completes. launchGame also calls
    // `game.hideVrMenu()` before loadAndStart → vrMenuShown goes
    // false too. Either is a sufficient positive signal; we assert
    // on hasChart because it's the direct evidence that the
    // `onPick` callback landed in the game layer.
    await pollFlag(page, 'hasChart', true);

    // Release the trigger so we don't accidentally re-fire on a
    // second frame (VrMenu.wasPressed latches until release anyway,
    // but being explicit keeps this spec's state clean if more
    // assertions get added later).
    await page.evaluate(() => {
      const right = (window as unknown as HookShape).__iwerDevice?.controllers.right;
      right?.setButtonValueImmediate('trigger', 0);
    });

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });
});
