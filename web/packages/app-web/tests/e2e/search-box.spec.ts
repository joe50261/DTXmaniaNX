import { test, expect, type Page } from '@playwright/test';

/**
 * Search box: `/` opens, typing filters the wheel, Esc clears + closes.
 * Three independently-regressable parts, all wired together in
 * `main.ts:117-143`:
 *
 *   - `/` keydown listener on window (guards against active INPUT /
 *     TEXTAREA + overlay visibility) toggles `.visible` on `#search-box`,
 *     focuses it, and calls `songWheel.detachKeyboard()` so arrow keys
 *     move the caret instead of the wheel.
 *   - `input` listener forwards the query into `songWheel.setSearchQuery`,
 *     which rebuilds the display entries with `buildDisplayEntries({ searchQuery })`.
 *   - `Escape` in the search box clears the query + `.visible` class
 *     + calls `songWheel.attachKeyboard()` so the player can keep browsing.
 *     The `blur` handler re-attaches as a belt-and-braces second path.
 *
 * The pure filter logic lives in `song-wheel-model.ts` and is covered
 * exhaustively by unit tests; this e2e exists specifically because
 * listener-wiring bugs (wrong event target, double-prevented default,
 * detach/attach imbalance) are invisible to jsdom and only bite in real
 * Chromium — where the window-level `/` listener and the input-local
 * `keydown` listener have to cooperate.
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

test.describe('search box — open / filter / Esc', () => {
  test('`/` opens, typing filters the wheel, Esc clears + closes + re-attaches wheel keys', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('#overlay')).toBeVisible();

    // Titles deliberately use only letters whose `KeyboardEvent.code`
    // ISN'T claimed by the drum-lane keymap (input/keyboard.ts ➜
    // DEFAULT_KEY_MAP binds KeyA/KeyS/KeyD/KeyH/KeyP/…). That listener
    // lives on `window` and calls preventDefault on any match, even
    // while an INPUT is focused — typing "alpha" into the search box
    // would drop the a/p/h chars. The chosen letters (C, L, I, M, B, R,
    // V, E, T) are all unbound.
    await installFakeLibrary(page, {
      songs: [
        { title: 'River', charts: [{ slot: 1, label: 'REG', level: 300 }] },
        { title: 'Tribe', charts: [{ slot: 1, label: 'REG', level: 400 }] },
        { title: 'Climb', charts: [{ slot: 1, label: 'REG', level: 500 }] },
      ],
    });

    const searchBox = page.locator('#search-box');
    // Starts hidden — `display:none` via CSS, `.visible` toggled by
    // main.ts. Plain `toBeHidden` is happy with either.
    await expect(searchBox).toBeHidden();

    // `/` is only consumed while the overlay is visible AND focus is
    // not on an INPUT/TEXTAREA — both conditions hold at initial boot.
    await page.keyboard.press('/');
    await expect(searchBox).toHaveClass(/visible/);
    await expect(searchBox).toBeFocused();

    // Typing drives the `input` listener → setSearchQuery → rebuildEntries.
    // pressSequentially mirrors a real per-keystroke cadence so the
    // `input` event fires once per character, the same path a player hits.
    await searchBox.pressSequentially('cli');
    // Sanity: the input has accepted all 3 chars. If the drum keymap
    // starts claiming any of C/L/I in the future, this assertion fails
    // loudly instead of the filter test producing a confusing subset.
    await expect(searchBox).toHaveValue('cli');

    // After filtering, only Climb should appear among wheel rows.
    // `.wheel-title` is rendered for every row including off-center;
    // we assert by the set of visible text so whichever row is focused
    // doesn't matter.
    const wheelTitles = page.locator('#song-wheel .wheel-title');
    const titles = await wheelTitles.allTextContents();
    expect(titles).toContain('Climb');
    expect(titles).not.toContain('River');
    expect(titles).not.toContain('Tribe');

    // Esc must: clear the input value, hide the box, and hand keyboard
    // control back to the wheel. We verify the first two via DOM state
    // and the third by pressing ArrowDown afterwards — if the wheel's
    // listener weren't re-attached, the focused title wouldn't change.
    await page.keyboard.press('Escape');
    await expect(searchBox).not.toHaveClass(/visible/);
    await expect(searchBox).toHaveValue('');

    // With the query cleared, the wheel rebuilds to all 3 songs and
    // focus lands on the first real entry (title-sort order:
    // Climb < River < Tribe, with the synthetic Random occupying
    // index 0 and Climb the first non-synthetic entry).
    const focusedTitle = page.locator('.wheel-row.wheel-focus .wheel-title');
    await expect(focusedTitle).toHaveText('Climb');

    // ArrowDown proves the keyboard is reattached — blur + closeSearch
    // both call `songWheel.attachKeyboard()`; if neither ran, the wheel
    // would be deaf to the keypress.
    await page.keyboard.press('ArrowDown');
    await expect(focusedTitle).toHaveText('River');
  });
});
