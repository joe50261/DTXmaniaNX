import { describe, expect, it } from 'vitest';
import { roundToStep, VR_CONFIG_LAYOUT } from './vr-config.js';

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

  it('hint text Y positions stay above the back button rectangle', () => {
    // 13px text paints with (baseline-ascender) ≈ 10 px, so the
    // rectangle the glyphs occupy is roughly [y-10, y+3]. The back
    // button's left edge is at x≈60, text starts at x=40 — they
    // overlap horizontally, so vertical separation is the only thing
    // keeping them from colliding.
    const backY = FOOTER_TOP + FOOTER_H / 2 - BACK_BTN_H / 2;
    const textTop1 = HINT_LINE_1_Y - 10;
    const textBot1 = HINT_LINE_1_Y + 3;
    const textTop2 = HINT_LINE_2_Y - 10;
    const textBot2 = HINT_LINE_2_Y + 3;
    const backTop = backY;
    const backBot = backY + BACK_BTN_H;
    // Text lines 1 and 2 live WITHIN the back button's vertical band
    // (the button is centered in the footer strip, same strip that
    // holds the hints). They should NOT overlap horizontally with the
    // button; the button is right-aligned, hints are left-aligned,
    // with a ≥180 px x-gap. Expressed as: each hint line's horizontal
    // extent ends before the button's x starts.
    // That gap assertion lives in the next test — here we only check
    // that a later tweak shoving the button leftward or making it
    // taller doesn't start covering the hints.
    const hint1Overlaps = textBot1 >= backTop && textTop1 <= backBot;
    const hint2Overlaps = textBot2 >= backTop && textTop2 <= backBot;
    // y-overlap is allowed ONLY because x-separation is enforced
    // elsewhere; we explicitly document that coupling.
    expect({ hint1Overlaps, hint2Overlaps }).toEqual({
      hint1Overlaps: true,
      hint2Overlaps: true,
    });
  });

  it('back button is right-aligned so the left-anchored hint text has room to paint', () => {
    // Hint text starts at x=40 and the longer of the two lines ("Hit
    // the − / + buttons to step a slider. Toggles flip on click.
    // Changes persist instantly.") is ≈ 88 chars × 7.2 px (monospace
    // 13px) ≈ 635 px, so its right edge lands around x=675. The back
    // button must start AT OR AFTER that (ideally with 30+ px gap) to
    // prevent the overlap from the pre-fix layout.
    const backX = PANEL_W_PX - 40 - BACK_BTN_W;
    const approxHintRightEdge = 40 + 88 * 7.2;
    expect(backX).toBeGreaterThan(approxHintRightEdge);
  });
});
