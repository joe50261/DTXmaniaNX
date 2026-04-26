import { describe, expect, it } from 'vitest';
import {
  ALL_FADE_MODES,
  fadeAlpha,
  fadeAsset,
  FADE_CANVAS_H,
  FADE_CANVAS_W,
  FADE_DURATION_MS,
  isFadeDone,
  isFadeOutMode,
  tileGridSize,
} from './stage-fade-layout.js';

describe('stage-fade — mode metadata', () => {
  it('picks the right asset per mode', () => {
    expect(fadeAsset('fade-in-black')).toBe('Tile black 64x64.png');
    expect(fadeAsset('fade-out-black')).toBe('Tile black 64x64.png');
    expect(fadeAsset('fade-in-white')).toBe('Tile white 64x64.png');
    expect(fadeAsset('fade-out-white')).toBe('Tile white 64x64.png');
  });

  it('isFadeOutMode discriminates correctly', () => {
    expect(isFadeOutMode('fade-in-black')).toBe(false);
    expect(isFadeOutMode('fade-out-black')).toBe(true);
    expect(isFadeOutMode('fade-in-white')).toBe(false);
    expect(isFadeOutMode('fade-out-white')).toBe(true);
  });

  it('ALL_FADE_MODES enumerates every fade mode', () => {
    expect(ALL_FADE_MODES.length).toBe(4);
  });
});

describe('fadeAlpha — direction', () => {
  it('fade-in starts at 1 and ends at 0', () => {
    expect(fadeAlpha(0, 'fade-in-black')).toBe(1);
    expect(fadeAlpha(FADE_DURATION_MS, 'fade-in-black')).toBe(0);
    expect(fadeAlpha(FADE_DURATION_MS / 2, 'fade-in-black')).toBeCloseTo(0.5);
  });

  it('fade-out starts at 0 and ends at 1', () => {
    expect(fadeAlpha(0, 'fade-out-black')).toBe(0);
    expect(fadeAlpha(FADE_DURATION_MS, 'fade-out-black')).toBe(1);
    expect(fadeAlpha(FADE_DURATION_MS / 2, 'fade-out-black')).toBeCloseTo(0.5);
  });

  it('clamps for non-finite / past-end values', () => {
    expect(fadeAlpha(-100, 'fade-in-black')).toBe(1);
    expect(fadeAlpha(Number.NaN, 'fade-out-white')).toBe(0);
    expect(fadeAlpha(FADE_DURATION_MS + 1000, 'fade-out-white')).toBe(1);
  });
});

describe('isFadeDone', () => {
  it('flips at the duration boundary', () => {
    expect(isFadeDone(FADE_DURATION_MS - 1)).toBe(false);
    expect(isFadeDone(FADE_DURATION_MS)).toBe(true);
    expect(isFadeDone(FADE_DURATION_MS + 1)).toBe(true);
  });

  it('rejects non-finite', () => {
    expect(isFadeDone(Number.NaN)).toBe(false);
  });
});

describe('tileGridSize', () => {
  it('rounds up so the bottom-right corner is fully covered', () => {
    const grid = tileGridSize(FADE_CANVAS_W, FADE_CANVAS_H);
    expect(grid.cols).toBe(20);  // 1280 / 64
    expect(grid.rows).toBe(12);  // 720 / 64 = 11.25 → 12
  });

  it('handles non-multiple dimensions correctly', () => {
    const grid = tileGridSize(100, 100);
    expect(grid.cols).toBe(2);
    expect(grid.rows).toBe(2);
  });
});
