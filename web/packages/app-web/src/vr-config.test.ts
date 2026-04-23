import { describe, expect, it } from 'vitest';
import { roundToStep } from './vr-config.js';

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
