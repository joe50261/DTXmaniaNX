import { test, expect, type Page } from '@playwright/test';

/**
 * Song-wheel keyboard flow end-to-end. The wheel's pure model
 * (`song-wheel-model.test.ts`) already exhaustively covers
 * `cycleFocus`, `cycleDifficultySlot`, `pickChartForSlot`, etc., so this
 * spec is deliberately thin — it only pins the regressions Chromium is
 * needed to surface:
 *
 *   1. `window.addEventListener('keydown', …)` actually reaches
 *      `SongWheel.handleKey` (the listener is attached during module init
 *      before any user gesture, so jsdom-based tests happily pass even if
 *      the wire-up silently breaks).
 *   2. The model result renders into the real DOM: `.wheel-focus` hops,
 *      `.chart-btn.selected` follows difficulty cycles.
 *   3. Enter on the focused row drives the full `startChart` →
 *      `launchGame` path to `#overlay` being hidden (mocked fs, real
 *      Game + Renderer). The model test stubs `onStart`; this spec
 *      catches a regression that fires `onStart` but crashes inside
 *      `loadAndStart` (stale state, bad skin wiring, missing await).
 *
 * Relies on `window.__dtxmaniaTest.installFakeLibrary` to seed a 3-song
 * tree with two difficulty slots each. Without this hook the desktop
 * overlay has no wheel content (no Songs folder picked), and we'd have
 * to drive the whole File System Access picker in an e2e — not worth
 * the complexity for what is a thin integration check.
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

test.describe('song wheel — keyboard navigation + difficulty + Enter-to-launch', () => {
  test('↑↓ moves focus, ←→ cycles difficulty, Enter launches chart and hides overlay', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    await page.goto('/');
    await expect(page.locator('#overlay')).toBeVisible();

    // Each song has REGULAR (slot 1) + MASTER (slot 3). Two slots is
    // the minimum for a meaningful ← → cycle and matches DTXmania's
    // common "REG + MAS" rip layout.
    await installFakeLibrary(page, {
      songs: [
        {
          title: 'Alpha',
          artist: 'Tester',
          charts: [
            { slot: 1, label: 'REGULAR', level: 300 },
            { slot: 3, label: 'MASTER', level: 700 },
          ],
        },
        {
          title: 'Bravo',
          artist: 'Tester',
          charts: [
            { slot: 1, label: 'REGULAR', level: 400 },
            { slot: 3, label: 'MASTER', level: 800 },
          ],
        },
        {
          title: 'Charlie',
          artist: 'Tester',
          charts: [
            { slot: 1, label: 'REGULAR', level: 500 },
            { slot: 3, label: 'MASTER', level: 900 },
          ],
        },
      ],
    });

    // After setRoot the focusIdx defaults to 0, which for a root box is
    // the synthetic Random row — not a real song. Step down once to
    // land on the first song so the subsequent ↑↓ / ←→ assertions
    // apply to a node that actually has a title + chart buttons.
    const focusedTitle = page.locator('.wheel-row.wheel-focus .wheel-title');
    await expect(focusedTitle).toHaveText(/Random/);

    await page.keyboard.press('ArrowDown');
    await expect(focusedTitle).toHaveText('Alpha');

    // ↓ advances, ↑ reverts — assert both directions to catch a delta-
    // sign flip in handleKey.
    await page.keyboard.press('ArrowDown');
    await expect(focusedTitle).toHaveText('Bravo');
    await page.keyboard.press('ArrowUp');
    await expect(focusedTitle).toHaveText('Alpha');

    // Difficulty cycle. preferredSlot starts at 4; Alpha has slots
    // [1, 3] so pickChartForSlot falls back to the highest (MASTER).
    // Pressing ← wraps to the lower slot (REGULAR), and → returns to
    // MASTER — the `.selected` class on chart-btn is the model's
    // observable projection.
    const chartButtons = page.locator('.wheel-focus .chart-btn');
    await expect(chartButtons).toHaveCount(2);
    const masterBtn = chartButtons.filter({ hasText: 'MASTER' });
    const regularBtn = chartButtons.filter({ hasText: 'REGULAR' });
    await expect(masterBtn).toHaveClass(/selected/);
    await expect(regularBtn).not.toHaveClass(/selected/);

    await page.keyboard.press('ArrowLeft');
    await expect(regularBtn).toHaveClass(/selected/);
    await expect(masterBtn).not.toHaveClass(/selected/);

    await page.keyboard.press('ArrowRight');
    await expect(masterBtn).toHaveClass(/selected/);

    // Enter commits the focused chart. `startChart` awaits
    // `library.backend.readText` (stubbed to the bundled demo.dtx),
    // then `launchGame` → `Game.loadAndStart` → overlay hidden.
    // This is the end-to-end assertion that couldn't live in vitest —
    // the whole renderer + audio graph + skin wiring has to boot
    // without throwing for the overlay transition to land.
    await page.keyboard.press('Enter');
    await expect(page.locator('#overlay')).toBeHidden({ timeout: 10_000 });
    await expect(page.locator('#game')).toBeAttached();

    expect(errors, `pageerrors: ${errors.join('\n')}`).toEqual([]);
  });
});
