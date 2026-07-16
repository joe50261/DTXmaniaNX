import { test, expect, type Page } from '@playwright/test';

// Wide CJK title in the style that exposed the HUD overlap bug — long
// enough that, unclipped, it would run from x=20 well past the first
// lane (x=263) and under the lane labels.
const LONG_TITLE =
  '【ヴァイオレット・エヴァーガーデンOP主題歌】TRUEとオーイシマサヨシが「Sincerely」をコラボ歌唱してみた';

/** Serve the bundled demo chart with its #TITLE swapped for LONG_TITLE. */
async function routeLongTitleDemo(page: Page): Promise<void> {
  await page.route('**/demo.dtx', async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace(/^#TITLE .*$/m, `#TITLE ${LONG_TITLE}`);
    await route.fulfill({ response: res, body });
  });
}

/** Count of pixels with non-zero alpha in a HUD-canvas region, read
 * through the `__dtxmaniaTest` hook (the HUD canvas is offscreen — no
 * DOM node, no screenshot reaches it). Returns -1 before the hook /
 * game exist. */
function countPaintedHudPixels(
  page: Page,
  region: { x: number; y: number; w: number; h: number }
): Promise<number> {
  return page.evaluate((r) => {
    const hook = (
      window as unknown as {
        __dtxmaniaTest?: {
          readHudPixels?: (x: number, y: number, w: number, h: number) => number[] | null;
        };
      }
    ).__dtxmaniaTest;
    const px = hook?.readHudPixels?.(r.x, r.y, r.w, r.h);
    if (!px) return -1;
    let painted = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i]! > 0) painted++;
    return painted;
  }, region);
}

// The header band on the 1280×720 HUD canvas: title baseline y=26,
// meta baseline y=44 → glyphs live inside y∈[14,48). The text column
// is x∈[20, 251) (HUD_HEADER_X + HUD_HEADER_MAX_W). The gap band
// starts 2px right of the column (anti-aliasing slop) and ends where
// the first lane begins (LC at x=263).
const HEADER_COLUMN = { x: 20, y: 14, w: 231, h: 34 };
const GAP_BAND = { x: 253, y: 14, w: 10, h: 34 };

// The app's service worker fetches demo.dtx itself, and Playwright
// routes never see service-worker-initiated requests — without this,
// routeLongTitleDemo silently serves the stock short title and the
// clipping assertions test nothing.
test.use({ serviceWorkers: 'block' });

test.describe('in-play HUD header + console hygiene', () => {
  test('resize bursts raise no ResizeObserver loop errors; xr support is logged at most once', async ({
    page,
  }) => {
    const consoleLines: string[] = [];
    const errors: string[] = [];
    page.on('console', (m) => consoleLines.push(m.text()));
    page.on('pageerror', (err) => errors.push(err.message));

    await routeLongTitleDemo(page);
    await page.goto('/');
    await expect(page.locator('#overlay')).toBeVisible();
    await page.locator('#start-demo').click();
    await expect(page.locator('#overlay')).toBeHidden({ timeout: 10_000 });

    // Header clipping: wait until the in-play header has actually
    // painted glyphs into the left column, then require the gap band
    // between the column and the LC lane to be untouched. Unclipped,
    // LONG_TITLE runs from x=20 straight through the band and under
    // the lane labels — the bug this spec pins.
    await expect
      .poll(() => countPaintedHudPixels(page, HEADER_COLUMN), { timeout: 10_000 })
      .toBeGreaterThan(50);
    expect(await countPaintedHudPixels(page, GAP_BAND)).toBe(0);

    // Burst of window resizes. Before the frame-coalesced resize path,
    // each backbuffer setSize inside the ResizeObserver callback
    // re-triggered the observer in the same cycle and the browser
    // reported "ResizeObserver loop completed with undelivered
    // notifications" through window.onerror.
    for (const [w, h] of [
      [900, 600],
      [1100, 650],
      [800, 500],
      [1280, 720],
    ] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(300);

    const roErrors = [...consoleLines, ...errors].filter((t) =>
      t.includes('ResizeObserver loop')
    );
    expect(roErrors, `ResizeObserver errors: ${roErrors.join('\n')}`).toEqual([]);

    // Exit to menu and start again — refreshXrButton runs on each of these
    // transitions. The memoized support probe must answer from cache: at
    // most one isSessionSupported log (headless Chromium with WebXR) or one
    // boot-time "navigator.xr absent" line (without), never one per refresh.
    await page.keyboard.press('Escape');
    await expect(page.locator('#overlay')).toBeVisible();
    await page.locator('#start-demo').click();
    await expect(page.locator('#overlay')).toBeHidden({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    const absentLogs = consoleLines.filter((t) => t.includes('navigator.xr absent'));
    expect(absentLogs.length, `absent logs:\n${absentLogs.join('\n')}`).toBeLessThanOrEqual(1);
    const supportLogs = consoleLines.filter((t) =>
      t.includes('isSessionSupported(immersive-vr) =')
    );
    expect(
      supportLogs.length,
      `isSessionSupported logs:\n${supportLogs.join('\n')}`
    ).toBeLessThanOrEqual(1);

    expect(errors, `pageerrors: ${errors.join('\n')}`).toEqual([]);
  });
});
