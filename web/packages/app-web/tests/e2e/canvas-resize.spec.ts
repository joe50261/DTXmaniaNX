import { test, expect, type Page } from '@playwright/test';

/**
 * Regression pins for the game-canvas resize behaviour (#game gets an
 * explicit viewport-driven CSS size in index.html):
 *
 *  1. Shrinking the window HEIGHT must scale the canvas down — the old
 *     attribute-driven layout ignored height entirely (percentage
 *     max-height doesn't resolve inside the auto-sized grid row), so a
 *     short window cut the judgment line and pads off below the fold.
 *  2. Growing the window back must restore the full canvas — the old
 *     layout ratcheted: Renderer.handleResize rewrites the canvas
 *     width/height attributes (its intrinsic size) to match the WebGL
 *     backbuffer, so once shrunk it could never grow back.
 *  3. The aspect ratio stays 16:9 so the fixed 1280×720 ortho scene
 *     never renders stretched.
 */

function gameMetrics(page: Page): Promise<{ w: number; h: number; attrW: number; attrH: number }> {
  return page.evaluate(() => {
    const c = document.getElementById('game') as HTMLCanvasElement;
    const r = c.getBoundingClientRect();
    return { w: r.width, h: r.height, attrW: c.width, attrH: c.height };
  });
}

test.describe('game canvas resize', () => {
  test('height shrink scales the canvas; growing back restores it (no ratchet)', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('#overlay')).toBeVisible();
    await page.locator('#start-demo').click();
    await expect(page.locator('#overlay')).toBeHidden({ timeout: 10_000 });

    // 1. Height-only shrink: canvas must fit the 500px-tall viewport.
    await page.setViewportSize({ width: 1280, height: 500 });
    await expect
      .poll(async () => (await gameMetrics(page)).h, { timeout: 3_000 })
      .toBeLessThanOrEqual(500);
    const shrunk = await gameMetrics(page);
    expect(shrunk.w / shrunk.h).toBeCloseTo(16 / 9, 2);

    // 2. Grow back: full native size returns.
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect
      .poll(async () => (await gameMetrics(page)).h, { timeout: 3_000 })
      .toBeGreaterThan(700);
    const restored = await gameMetrics(page);
    expect(Math.round(restored.w)).toBe(1280);
    expect(Math.round(restored.h)).toBe(720);

    // 3. The WebGL backbuffer follows layout (rAF-deferred resize;
    //    headless dpr=1 so attributes equal CSS pixels).
    await expect
      .poll(async () => (await gameMetrics(page)).attrH, { timeout: 3_000 })
      .toBe(720);
    expect((await gameMetrics(page)).attrW).toBe(1280);
  });
});
