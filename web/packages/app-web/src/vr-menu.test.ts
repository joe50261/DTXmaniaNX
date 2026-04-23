import { describe, expect, it } from 'vitest';
import { VR_MENU_FOOTER } from './vr-menu.js';

/**
 * Geometry invariants for the in-VR song-picker footer strip.
 *
 * The regression this file pins down: in the previous layout the
 * Settings / Calibrate utility buttons and the control-hint text
 * ("Stick: ↕ browse · ↔ difficulty · Trigger: play / enter · Squeeze:
 * back") were placed at the same y, so the button rectangles painted
 * over the hint text and it was unreadable in VR. The new layout moves
 * the hint ABOVE the button row — these tests fail fast if a future
 * tweak collapses them back onto the same baseline.
 *
 * We don't spin up a canvas here because the check is purely
 * geometric; the paint code itself is exercised by the Playwright e2e
 * pass (boot.spec.ts keeps the canvas mounted).
 */
describe('VR_MENU_FOOTER — song-picker footer geometry', () => {
  const {
    PANEL_W_PX,
    PANEL_H_PX,
    EXIT_W,
    EXIT_H,
    UTIL_BTN_W,
    UTIL_BTN_H,
    EXIT_Y,
    UTIL_BTN_Y,
  } = VR_MENU_FOOTER;

  it('Exit VR button fits inside the panel with margin', () => {
    expect(EXIT_Y).toBeGreaterThan(0);
    expect(EXIT_Y + EXIT_H).toBeLessThanOrEqual(PANEL_H_PX);
    expect(EXIT_W).toBeGreaterThan(0);
    // 16 px bottom margin so the button doesn't touch the panel edge.
    expect(PANEL_H_PX - (EXIT_Y + EXIT_H)).toBeGreaterThanOrEqual(12);
  });

  it('Utility row shares a baseline band with Exit VR (single control strip)', () => {
    // Both buttons centre on the same visual line. Their y-ranges must
    // overlap so the bottom strip reads as one row rather than two.
    const exitBand: [number, number] = [EXIT_Y, EXIT_Y + EXIT_H];
    const utilBand: [number, number] = [UTIL_BTN_Y, UTIL_BTN_Y + UTIL_BTN_H];
    const overlap = !(utilBand[1] < exitBand[0] || utilBand[0] > exitBand[1]);
    expect(overlap).toBe(true);
  });

  it('hint text baseline sits above the button row (no visual overlap)', () => {
    const hintY = VR_MENU_FOOTER.hintBaselineY();
    // 13-px text: baseline y means glyph bottom ≈ y + 3, top ≈ y - 10.
    // The button row starts at min(EXIT_Y, UTIL_BTN_Y) — the text's
    // bottom edge must land strictly above that.
    const buttonTop = Math.min(EXIT_Y, UTIL_BTN_Y);
    const textBottom = hintY + 3;
    expect(textBottom).toBeLessThan(buttonTop);
  });

  it('hint text stays inside the panel (no clipping below the panel edge)', () => {
    const hintY = VR_MENU_FOOTER.hintBaselineY();
    expect(hintY).toBeGreaterThan(0);
    expect(hintY).toBeLessThan(PANEL_H_PX);
  });

  it('utility buttons do not extend past the right edge where Exit VR sits', () => {
    // Two utility buttons (Settings + Calibrate) sit on the left with
    // a 16-px gap. Together they must end before the Exit VR button's
    // left edge so they don't collide horizontally.
    const utilLeftEnd = 40 + UTIL_BTN_W + 16 + UTIL_BTN_W; // Calibrate's right edge
    const exitLeftEdge = PANEL_W_PX - 40 - EXIT_W;
    expect(utilLeftEnd).toBeLessThan(exitLeftEdge);
  });
});
