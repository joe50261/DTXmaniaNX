import { describe, expect, it } from 'vitest';
import { linearFadeIn, linearFadeOut, padBounceOffset } from './renderer-math.js';

/**
 * Regression-silent math: if any of these curves drift, the game still
 * renders and nothing throws — the player just sees a bounce that's
 * too sluggish, or a flash that lingers half a frame too long, or a
 * progress bar past 100%. Pin every numeric contract.
 */

describe('linearFadeOut — opacity / alpha ramp down', () => {
  it('returns 1 at age 0 (peak opacity)', () => {
    expect(linearFadeOut(0, 200)).toBe(1);
  });

  it('returns 0 at age === life (fully faded)', () => {
    expect(linearFadeOut(200, 200)).toBe(0);
  });

  it('returns 0.5 at the midpoint', () => {
    expect(linearFadeOut(100, 200)).toBeCloseTo(0.5, 10);
  });

  it('clamps negative ages to 1 (defensive: caller should filter but don\'t trust it)', () => {
    expect(linearFadeOut(-50, 200)).toBe(1);
  });

  it('clamps ages past life to 0 (same defence for stale flashes)', () => {
    expect(linearFadeOut(500, 200)).toBe(0);
  });

  it('returns 0 for zero-or-negative life to avoid divide-by-zero', () => {
    expect(linearFadeOut(50, 0)).toBe(0);
    expect(linearFadeOut(50, -10)).toBe(0);
  });

  it('is monotonically non-increasing over its domain', () => {
    const life = 400;
    let prev = linearFadeOut(0, life);
    for (let age = 10; age <= life; age += 10) {
      const cur = linearFadeOut(age, life);
      expect(cur).toBeLessThanOrEqual(prev);
      prev = cur;
    }
  });
});

describe('linearFadeIn — progress / float-up ramp', () => {
  it('returns 0 at age 0', () => {
    expect(linearFadeIn(0, 400)).toBe(0);
  });

  it('returns 1 at age === life', () => {
    expect(linearFadeIn(400, 400)).toBe(1);
  });

  it('returns 0.5 at the midpoint', () => {
    expect(linearFadeIn(200, 400)).toBeCloseTo(0.5, 10);
  });

  it('clamps negative ages to 0', () => {
    expect(linearFadeIn(-100, 400)).toBe(0);
  });

  it('clamps ages past life to 1 (progress bar must never exceed 100%)', () => {
    // This is the specific regression around the song-progress bar —
    // a tick past the song end used to draw past the right edge before
    // the clamp was added. Pin it.
    expect(linearFadeIn(10_000, 400)).toBe(1);
  });

  it('total==0: age>0 returns 1 (song-length unknown → treat as "finished" for UI)', () => {
    // Mirrors the pre-extract inline code: progress bar showed 0 when
    // songLengthMs was 0, but the extracted primitive returns 1 for a
    // non-zero age. Callers that don't want that (drawHUD has a
    // songLengthMs > 0 guard upstream now replaced by the helper) can
    // pre-check; inside the helper the contract is "you gave me total
    // 0 and a positive age, treat it as complete". Pin the behaviour
    // so a caller refactor doesn't accidentally start returning 0.
    expect(linearFadeIn(100, 0)).toBe(1);
    expect(linearFadeIn(0, 0)).toBe(0);
  });

  it('is monotonically non-decreasing over its domain', () => {
    const life = 400;
    let prev = linearFadeIn(0, life);
    for (let age = 10; age <= life; age += 10) {
      const cur = linearFadeIn(age, life);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it('is the mirror of linearFadeOut: fadeIn + fadeOut = 1 over the domain', () => {
    const life = 500;
    for (let age = 0; age <= life; age += 25) {
      expect(linearFadeIn(age, life) + linearFadeOut(age, life)).toBeCloseTo(1, 10);
    }
  });
});

describe('padBounceOffset — pad-head hit bounce', () => {
  const DUR = 120;
  const AMT = 0.04; // 4 cm dip

  it('returns 0 at t=0 (pad at rest)', () => {
    expect(padBounceOffset(0, DUR, AMT)).toBe(0);
  });

  it('returns 0 at t=1 (fully recovered to rest)', () => {
    expect(padBounceOffset(DUR, DUR, AMT)).toBe(0);
  });

  it('reaches the full -amount minimum exactly at the 35% split point', () => {
    // The down/up split encodes the "real drum" feel. If this constant
    // drifts, the bounce reads sluggish or twitchy. The minimum must
    // land exactly at t=0.35.
    const bottom = padBounceOffset(DUR * 0.35, DUR, AMT);
    expect(bottom).toBeCloseTo(-AMT, 10);
  });

  it('is negative (dip down) throughout 0 < t < 1', () => {
    for (const t of [0.1, 0.2, 0.35, 0.5, 0.75, 0.9]) {
      const y = padBounceOffset(DUR * t, DUR, AMT);
      expect(y).toBeLessThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(-AMT);
    }
  });

  it('down phase (0 → 0.35) decreases monotonically to the floor', () => {
    let prev = padBounceOffset(0, DUR, AMT);
    for (let t = 0.05; t <= 0.35; t += 0.05) {
      const cur = padBounceOffset(DUR * t, DUR, AMT);
      expect(cur).toBeLessThanOrEqual(prev);
      prev = cur;
    }
  });

  it('recovery phase (0.35 → 1) increases monotonically back to 0', () => {
    let prev = padBounceOffset(DUR * 0.35, DUR, AMT);
    for (let t = 0.4; t <= 1; t += 0.05) {
      const cur = padBounceOffset(DUR * t, DUR, AMT);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it('clamps age > duration to 0 — pads must never punch up above rest', () => {
    // Without the Math.min(0, ...) clamp, an age past duration would
    // overshoot into positive territory. That would drive the pad
    // through the render layer above it. Defence in depth.
    expect(padBounceOffset(10_000, DUR, AMT)).toBe(0);
  });

  it('clamps age < 0 to 0 (rest position)', () => {
    expect(padBounceOffset(-50, DUR, AMT)).toBe(0);
  });

  it('scales linearly with amount — doubling amount doubles the dip', () => {
    const a = padBounceOffset(DUR * 0.35, DUR, 0.04);
    const b = padBounceOffset(DUR * 0.35, DUR, 0.08);
    expect(b).toBeCloseTo(a * 2, 10);
  });

  it('down phase is faster than recovery (asymmetric curve)', () => {
    // Sanity on the 35/65 split. Reach -amount/2 during the down
    // phase at t ≈ 0.175; reach -amount/2 during recovery at
    // t ≈ 0.35 + 0.325 = 0.675. The down phase takes 17.5% of the
    // duration to reach halfway; recovery takes 32.5% → recovery is
    // ~1.86x slower.
    const halfDown = padBounceOffset(DUR * 0.175, DUR, AMT);
    const halfUp = padBounceOffset(DUR * 0.675, DUR, AMT);
    expect(halfDown).toBeCloseTo(-AMT / 2, 5);
    expect(halfUp).toBeCloseTo(-AMT / 2, 5);
  });
});
