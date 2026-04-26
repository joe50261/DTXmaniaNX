import { describe, expect, it } from 'vitest';
import {
  rankAnimationDone,
  rankClip,
  rankReveal,
  RANK_REVEAL_DURATION_MS,
  RANK_REVEAL_GROWTH_MS,
  RANK_REVEAL_HOLD_MS,
} from './result-animations.js';

describe('rankReveal', () => {
  it('stays hidden through the hold window', () => {
    expect(rankReveal(0)).toEqual({ hidden: true, progress: 0 });
    expect(rankReveal(RANK_REVEAL_HOLD_MS - 1)).toEqual({ hidden: true, progress: 0 });
  });

  it('starts revealing at the hold boundary', () => {
    const r = rankReveal(RANK_REVEAL_HOLD_MS);
    expect(r.hidden).toBe(false);
    expect(r.progress).toBe(0);
  });

  it('reaches half-way at the midpoint of the growth window', () => {
    const mid = RANK_REVEAL_HOLD_MS + RANK_REVEAL_GROWTH_MS / 2;
    const r = rankReveal(mid);
    expect(r.hidden).toBe(false);
    expect(r.progress).toBeCloseTo(0.5);
  });

  it('clamps to progress=1 at and past the end', () => {
    expect(rankReveal(RANK_REVEAL_DURATION_MS).progress).toBe(1);
    expect(rankReveal(RANK_REVEAL_DURATION_MS + 1000).progress).toBe(1);
  });

  it('treats non-finite elapsedMs as still hidden', () => {
    expect(rankReveal(Number.NaN).hidden).toBe(true);
    expect(rankReveal(-1).hidden).toBe(true);
  });
});

describe('rankClip', () => {
  it('shifts a 200-px sprite fully off-screen at progress=0', () => {
    const c = rankClip(50, 200, 0);
    expect(c.drawY).toBe(50 + 200);
    expect(c.clipH).toBe(0);
  });

  it('places sprite flush at baseY at progress=1', () => {
    const c = rankClip(50, 200, 1);
    expect(c.drawY).toBe(50);
    expect(c.clipH).toBe(200);
  });

  it('linearly interpolates between the two', () => {
    const c = rankClip(0, 100, 0.4);
    expect(c.drawY).toBeCloseTo(60);
    expect(c.clipH).toBeCloseTo(40);
  });

  it('clamps progress out-of-range without throwing', () => {
    expect(rankClip(0, 100, -1).clipH).toBe(0);
    expect(rankClip(0, 100, 5).clipH).toBe(100);
  });
});

describe('rankAnimationDone', () => {
  it('flips true once elapsed reaches the duration', () => {
    expect(rankAnimationDone(RANK_REVEAL_DURATION_MS - 1)).toBe(false);
    expect(rankAnimationDone(RANK_REVEAL_DURATION_MS)).toBe(true);
    expect(rankAnimationDone(RANK_REVEAL_DURATION_MS + 1)).toBe(true);
  });

  it('rejects non-finite elapsed values', () => {
    expect(rankAnimationDone(Number.NaN)).toBe(false);
  });
});
