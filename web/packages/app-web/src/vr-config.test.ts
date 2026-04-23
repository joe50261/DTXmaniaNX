import { describe, expect, it } from 'vitest';
import {
  roundToStep,
  VR_CONFIG_FOOTER_HINTS,
  VR_CONFIG_LAYOUT,
} from './vr-config.js';

/**
 * `roundToStep` is the float-drift guard that keeps repeated `−` / `+`
 * step-button presses on VR sliders from accumulating IEEE-754 error.
 * Exported from `vr-config.ts` so we can pin the invariant down
 * independently of the panel's rendering path.
 */
describe('roundToStep — slider step snap', () => {
  it('rounds to the nearest multiple of step', () => {
    expect(roundToStep(0.47, 0.05)).toBeCloseTo(0.45, 10);
    expect(roundToStep(0.48, 0.05)).toBeCloseTo(0.5, 10);
    expect(roundToStep(1.23, 0.1)).toBeCloseTo(1.2, 10);
  });

  it('idempotent on values already on the grid', () => {
    expect(roundToStep(0.5, 0.05)).toBe(0.5);
    expect(roundToStep(1.0, 0.1)).toBe(1.0);
  });

  it("0.05 + 0.05 accumulation doesn't drift below 0.10", () => {
    // Unrounded: 0.05 + 0.05 = 0.1 exactly on paper, but as IEEE-754
    // doubles it's 0.10000000000000002. Rounding to the 0.05 grid has
    // to produce 0.1 on the dot or a "BGM volume 0.5" slider drifts to
    // 0.50000000004 after repeated presses.
    const stepped = roundToStep(0.05 + 0.05, 0.05);
    expect(stepped).toBe(0.1);
  });

  it('stays on grid across many accumulated steps (simulates 20×+ taps)', () => {
    let v = 0;
    for (let i = 0; i < 20; i++) v = roundToStep(v + 0.05, 0.05);
    // 20 × 0.05 = 1.0 exact.
    expect(v).toBe(1.0);
  });

  it('handles negative values symmetrically', () => {
    expect(roundToStep(-0.47, 0.05)).toBeCloseTo(-0.45, 10);
    expect(roundToStep(-0.48, 0.05)).toBeCloseTo(-0.5, 10);
  });
});

describe('VR_CONFIG_LAYOUT — footer geometry invariants', () => {
  // The "Back to menu" button and the two hint-text lines all live in
  // the same footer strip. In the previous layout the back button was
  // centered at the bottom and happened to paint over the hint text,
  // which was unreadable in VR. These tests pin the geometry so a
  // careless tweak (resize back button, reposition hints) that would
  // reintroduce the overlap fails in CI.

  const {
    PANEL_W_PX,
    PANEL_H_PX,
    FOOTER_H,
    FOOTER_TOP,
    BACK_BTN_W,
    BACK_BTN_H,
    HINT_LINE_1_Y,
    HINT_LINE_2_Y,
  } = VR_CONFIG_LAYOUT;

  it('footer strip sits at the bottom of the panel', () => {
    expect(FOOTER_TOP + FOOTER_H).toBe(PANEL_H_PX);
    expect(FOOTER_H).toBeGreaterThan(0);
  });

  it('back button fits entirely inside the footer strip', () => {
    const backX = PANEL_W_PX - 40 - BACK_BTN_W;
    const backY = FOOTER_TOP + FOOTER_H / 2 - BACK_BTN_H / 2;
    expect(backY).toBeGreaterThanOrEqual(FOOTER_TOP);
    expect(backY + BACK_BTN_H).toBeLessThanOrEqual(PANEL_H_PX);
    // Right edge has a ≥16 px breathing margin inside the panel.
    expect(backX + BACK_BTN_W).toBeLessThanOrEqual(PANEL_W_PX - 16);
  });

  it('hint lines and the back button share the footer y-band (x-separation is the only thing preventing overlap)', () => {
    // Both hint lines sit inside the back button's vertical range by
    // design — the back button is centered in the footer strip and
    // the hints are painted in the same strip. What keeps them
    // visually separated is the x-axis: hints left-aligned from
    // x=40, back button right-aligned (see the x-separation test
    // below). This test pins the y-overlap as intentional so that a
    // future refactor that tries to "fix" it by stacking them above
    // the button without widening the footer doesn't silently push
    // the button off-panel.
    const backY = FOOTER_TOP + FOOTER_H / 2 - BACK_BTN_H / 2;
    const textTop1 = HINT_LINE_1_Y - 10;
    const textBot1 = HINT_LINE_1_Y + 3;
    const textTop2 = HINT_LINE_2_Y - 10;
    const textBot2 = HINT_LINE_2_Y + 3;
    const hint1Overlaps = textBot1 >= backY && textTop1 <= backY + BACK_BTN_H;
    const hint2Overlaps = textBot2 >= backY && textTop2 <= backY + BACK_BTN_H;
    expect({ hint1Overlaps, hint2Overlaps }).toEqual({
      hint1Overlaps: true,
      hint2Overlaps: true,
    });
  });

  it('back button x is right of the longer hint line so the two never overlap horizontally', () => {
    // Computed from the actual exported hint string rather than a
    // hand-estimated character count — if the wording shortens, the
    // expected right edge shrinks with it and the assertion stays
    // honest. `ui-monospace` 13px renders at ~7.2 px per glyph on
    // both macOS and Chromium (empirically measured); using the
    // longer of the two hints as the worst case.
    const longer =
      VR_CONFIG_FOOTER_HINTS.line1.length >= VR_CONFIG_FOOTER_HINTS.line2.length
        ? VR_CONFIG_FOOTER_HINTS.line1
        : VR_CONFIG_FOOTER_HINTS.line2;
    const MONOSPACE_13PX_EM = 7.2;
    const hintRightEdge = 40 + longer.length * MONOSPACE_13PX_EM;
    const backX = PANEL_W_PX - 40 - BACK_BTN_W;
    expect(backX).toBeGreaterThan(hintRightEdge);
  });
});
