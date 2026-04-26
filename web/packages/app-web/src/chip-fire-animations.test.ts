import { describe, expect, it } from 'vitest';
import { chipFireFrame } from './chip-fire-animations.js';
import { CHIP_FIRE_END_SCALE, CHIP_FIRE_LIFETIME_MS } from './chip-fire-layout.js';

describe('chipFireFrame — lifecycle', () => {
  it('reports expired before the hit and after the lifetime', () => {
    expect(chipFireFrame(50, 100).expired).toBe(true);
    expect(chipFireFrame(100 + CHIP_FIRE_LIFETIME_MS, 100).expired).toBe(true);
    expect(chipFireFrame(100 + CHIP_FIRE_LIFETIME_MS + 50, 100).expired).toBe(true);
  });

  it('returns full alpha + base scale at impact', () => {
    const f = chipFireFrame(100, 100);
    expect(f.expired).toBe(false);
    expect(f.alpha).toBe(1);
    expect(f.scale).toBe(1);
  });

  it('reaches end scale + 0 alpha just before expiry', () => {
    const f = chipFireFrame(CHIP_FIRE_LIFETIME_MS - 0.01, 0);
    expect(f.expired).toBe(false);
    expect(f.scale).toBeCloseTo(CHIP_FIRE_END_SCALE, 3);
    expect(f.alpha).toBeCloseTo(0, 3);
  });

  it('linearly interpolates scale + alpha across the window', () => {
    const half = chipFireFrame(CHIP_FIRE_LIFETIME_MS / 2, 0);
    expect(half.scale).toBeCloseTo(1 + (CHIP_FIRE_END_SCALE - 1) / 2);
    expect(half.alpha).toBeCloseTo(0.5);
  });
});

describe('chipFireFrame — defensive', () => {
  it('treats non-finite delta as expired', () => {
    expect(chipFireFrame(Number.NaN, 0).expired).toBe(true);
  });
});
