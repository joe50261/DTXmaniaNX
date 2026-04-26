import { test, expect, type Page } from '@playwright/test';
import {
  installIwerRuntime,
  pulseButton,
  pulseTrigger,
  releaseStick,
  setStickAxes,
} from './iwer-helper';

/**
 * Mid-VR song change without removing the headset:
 *
 *   pick song A → play → press LEFT face button (panic quit) →
 *   `Game.leaveSong` → `onRestart` → `showSongSelectForActive` →
 *   panel re-appears in VR mode → move focus → pick song B → new
 *   chart loads with a DIFFERENT `currentChartPath`.
 *
 * Three intertwined regression hazards this pins:
 *
 *   1. The LEFT-X / LEFT-Y face button (`gamepad.buttons[4]`/`[5]`)
 *      Schmitt-edge wiring in `game.ts:tick` — a regression that
 *      stopped polling those slots, swapped them with the right
 *      hand's A/B (loop capture), or read by id instead of slot
 *      would silently break the only in-VR way to leave a chart.
 *
 *   2. `leaveSong → onRestart → showSongSelectForActive` lands the
 *      panel back in VR mode rather than desktop mode (the
 *      `setDesktopMode(!inXR)` decision in main.ts) — without this
 *      branch the player would see the desktop-styled wheel inside
 *      the headset, which only renders correctly through the HUD
 *      texture if VR mode was kept.
 *
 *   3. The state-reset path in `Game.loadAndStart` actually clears
 *      the prior chart's `currentChartPath` — a regression that
 *      kept it cached would leave Game thinking the OLD song was
 *      still loaded after the picker's onPick fired, which trips
 *      `hasChart` checks in main.ts (e.g. `if (library &&
 *      !game.hasChart) showSongSelectForActive()` would no-op).
 *
 * `xr-controllers.test.ts` covers the gamepad handedness lookup
 * with a fake renderer; `vr-lifecycle.test.ts` covers the state
 * reset; nothing else exercises the full leave-then-pick chain
 * inside a real immersive session.
 */

interface FakeLibrarySpec {
  songs: Array<{
    title: string;
    artist?: string;
    charts: Array<{ slot: number; label: string; level?: number }>;
  }>;
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
      hasChart: boolean;
      songSelectShown: boolean;
      songSelectFocusedTitle: string | null;
      currentChartPath: string | null;
    };
  };
};

async function readHookField<K extends keyof NonNullable<NonNullable<HookShape['__dtxmaniaTest']>['game']>>(
  page: Page,
  field: K,
): Promise<NonNullable<HookShape['__dtxmaniaTest']>['game'][K] | null> {
  return page.evaluate(
    (k) => (window as unknown as HookShape).__dtxmaniaTest?.game?.[k] ?? null,
    field,
  ) as Promise<NonNullable<HookShape['__dtxmaniaTest']>['game'][K] | null>;
}

async function pollFlag(
  page: Page,
  flag: 'inXR' | 'hasChart' | 'songSelectShown',
  expected: boolean,
  timeoutMs = 5_000,
): Promise<void> {
  await expect.poll(() => readHookField(page, flag), { timeout: timeoutMs }).toBe(expected);
}

test.describe('mid-VR song change — leave + re-pick without removing the headset', () => {
  test('pick Alpha, LEFT-x face button quits to picker, advance focus, pick Bravo — chartPath changes', async ({
    context,
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));

    await installIwerRuntime(context);
    await page.goto('/');

    await installFakeLibrary(page, {
      songs: [
        { title: 'Alpha', charts: [{ slot: 1, label: 'REG', level: 300 }] },
        { title: 'Bravo', charts: [{ slot: 1, label: 'REG', level: 400 }] },
      ],
    });
    await expect(page.locator('#enter-xr')).toBeVisible();
    await page.locator('#enter-xr').click();
    await pollFlag(page, 'inXR', true);
    await pollFlag(page, 'songSelectShown', true);
    await pollFlag(page, 'hasChart', false);

    // Initial focus lands on the synthetic Random row. Push the left
    // stick down once → focus → 'Alpha'. (Reuses the Schmitt-trigger
    // path covered by vr-stick-nav.spec.ts; a regression there would
    // surface here too as a "couldn't reach Alpha" failure.)
    expect(await readHookField(page, 'songSelectFocusedTitle')).toMatch(/Random/);
    await setStickAxes(page, 'left', 0, 1);
    await expect.poll(() => readHookField(page, 'songSelectFocusedTitle'), {
      timeout: 2_000,
    }).toBe('Alpha');
    await releaseStick(page, 'left');
    await page.waitForTimeout(50);

    // Pick Alpha. Trigger pulse falls back to `activateFocused` since
    // the controller isn't aimed at the panel — that's the cheaper
    // path covered by vr-controller-hit; we're using it here for
    // brevity, not to re-cover that regression.
    await pulseTrigger(page, 'right');
    await pollFlag(page, 'hasChart', true, 10_000);
    expect(await readHookField(page, 'currentChartPath')).toBe('Alpha.dtx');

    // ── Mid-VR quit: LEFT-x face button (button[4]) → leaveSong ──
    // The handler's `active` gate requires `status === 'playing' &&
    // inXR` — `hasChart=true` above proves the chart actually loaded
    // and ticked into 'playing' (loadAndStart sets it after the audio
    // graph is primed), so the press will be honoured.
    await pulseButton(page, 'left', 'x-button');

    // After leaveSong: hasChart drops because `Game.leaveSong` ran
    // emptyChartState; main.ts's onRestart re-shows the panel via
    // `showSongSelectForActive` (which on master also runs even
    // when `inXR` is true — the panel just stays in VR mode rather
    // than the desktop overlay re-appearing).
    await pollFlag(page, 'hasChart', false);
    await pollFlag(page, 'songSelectShown', true);
    expect(await readHookField(page, 'inXR')).toBe(true);

    // Move focus to Bravo. Initial focus on re-show resumes from the
    // last selection (persistedFocusIdx logic) — that's still Alpha
    // here, so one stick push lands on Bravo.
    expect(await readHookField(page, 'songSelectFocusedTitle')).toBe('Alpha');
    await setStickAxes(page, 'left', 0, 1);
    await expect.poll(() => readHookField(page, 'songSelectFocusedTitle'), {
      timeout: 2_000,
    }).toBe('Bravo');
    await releaseStick(page, 'left');
    await page.waitForTimeout(50);

    // Pick Bravo. The KEY assertion is that `currentChartPath`
    // changed from 'Alpha.dtx' to 'Bravo.dtx' — `hasChart` flipping
    // true again proves a chart loaded but says nothing about
    // identity, so a stale-state regression that re-loaded Alpha
    // would still pass that one.
    await pulseTrigger(page, 'right');
    await pollFlag(page, 'hasChart', true, 10_000);
    expect(await readHookField(page, 'currentChartPath')).toBe('Bravo.dtx');

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });
});
