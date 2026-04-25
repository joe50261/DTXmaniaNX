import { describe, it, expect } from 'vitest';
import {
  COMMENT_SCROLL_GAP_PX,
  COMMENT_SCROLL_PX_PER_SEC,
  PREIMAGE_FADE_MIN_ALPHA,
  PREIMAGE_FADE_MS,
  WHEEL_SCROLL_MS,
  easeOutCubic,
  lerp,
  newCommentScrollState,
  newPreimageFadeState,
  newWheelScrollState,
  preimageOpacity,
  restartCommentScroll,
  restartPreimageFade,
  startWheelScroll,
  tickCommentScroll,
  tickPreimageFade,
  tickWheelScroll,
  wheelScrollProgress,
} from './song-select-animations.js';

describe('easeOutCubic', () => {
  it('clamps below zero and above one', () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });
  it('passes through 0 and 1', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });
  it('decelerates — covers most ground in the first half', () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.7);
  });
});

describe('lerp', () => {
  it('endpoints', () => {
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
  });
  it('midpoint', () => {
    expect(lerp(10, 20, 0.5)).toBe(15);
  });
});

describe('wheel scroll', () => {
  it('starts idle and reports progress = 1', () => {
    const s = newWheelScrollState();
    expect(s.dir).toBe(0);
    expect(wheelScrollProgress(s)).toBe(1);
  });

  it('startWheelScroll(0) is a no-op and clears any prior state', () => {
    const stale = startWheelScroll(newWheelScrollState(), 1);
    const cleared = startWheelScroll(stale, 0);
    expect(cleared.dir).toBe(0);
    expect(cleared.remainingMs).toBe(0);
  });

  it('startWheelScroll(±1) gives a full WHEEL_SCROLL_MS budget', () => {
    const up = startWheelScroll(newWheelScrollState(), -1);
    expect(up.dir).toBe(-1);
    expect(up.remainingMs).toBe(WHEEL_SCROLL_MS);
    const down = startWheelScroll(newWheelScrollState(), 1);
    expect(down.dir).toBe(1);
    expect(down.remainingMs).toBe(WHEEL_SCROLL_MS);
  });

  it('progresses from 0 toward 1 with cubic-out shape', () => {
    let s = startWheelScroll(newWheelScrollState(), 1);
    expect(wheelScrollProgress(s)).toBeCloseTo(0, 5);
    s = tickWheelScroll(s, WHEEL_SCROLL_MS / 2);
    expect(wheelScrollProgress(s)).toBeGreaterThan(0.7);
    s = tickWheelScroll(s, WHEEL_SCROLL_MS / 2);
    expect(wheelScrollProgress(s)).toBe(1);
    expect(s.dir).toBe(0);
    expect(s.remainingMs).toBe(0);
  });

  it('tickWheelScroll on idle state stays idle', () => {
    const s = newWheelScrollState();
    const next = tickWheelScroll(s, 100);
    expect(next).toEqual(s);
  });
});

describe('preimage fade', () => {
  it('starts at the floor opacity', () => {
    const s = newPreimageFadeState();
    expect(preimageOpacity(s)).toBeCloseTo(PREIMAGE_FADE_MIN_ALPHA, 5);
  });

  it('reaches 1.0 at PREIMAGE_FADE_MS', () => {
    let s = newPreimageFadeState();
    s = tickPreimageFade(s, PREIMAGE_FADE_MS);
    expect(preimageOpacity(s)).toBe(1);
  });

  it('clamps elapsed at PREIMAGE_FADE_MS', () => {
    let s = newPreimageFadeState();
    s = tickPreimageFade(s, PREIMAGE_FADE_MS * 5);
    expect(s.elapsedMs).toBe(PREIMAGE_FADE_MS);
    expect(preimageOpacity(s)).toBe(1);
  });

  it('restartPreimageFade resets to floor', () => {
    let s = newPreimageFadeState();
    s = tickPreimageFade(s, PREIMAGE_FADE_MS);
    s = restartPreimageFade();
    expect(preimageOpacity(s)).toBeCloseTo(PREIMAGE_FADE_MIN_ALPHA, 5);
  });
});

describe('comment scroll', () => {
  it('holds offset at 0 when text fits', () => {
    let s = newCommentScrollState();
    s = tickCommentScroll(s, 1000, 100, 750);
    expect(s.offsetPx).toBe(0);
  });

  it('resets a non-zero offset to 0 when the text becomes shorter', () => {
    const stale = { offsetPx: 200 };
    const next = tickCommentScroll(stale, 16, 100, 750);
    expect(next.offsetPx).toBe(0);
  });

  it('advances at the configured rate when text overflows', () => {
    const start = newCommentScrollState();
    const next = tickCommentScroll(start, 1000, 2000, 750);
    expect(next.offsetPx).toBeCloseTo(COMMENT_SCROLL_PX_PER_SEC, 5);
  });

  it('wraps after one full period (textWidth + gap)', () => {
    const textWidth = 2000;
    const period = textWidth + COMMENT_SCROLL_GAP_PX;
    let s: { offsetPx: number } = { offsetPx: period - 1 };
    s = tickCommentScroll(s, 16, textWidth, 750);
    expect(s.offsetPx).toBeLessThan(period);
    expect(s.offsetPx).toBeGreaterThanOrEqual(0);
  });

  it('restartCommentScroll resets to 0', () => {
    expect(restartCommentScroll().offsetPx).toBe(0);
  });
});
