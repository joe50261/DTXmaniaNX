import { describe, expect, it } from 'vitest';
import {
  BANNER_X,
  BANNER_Y,
  digitAtlas,
  digitAtlasX,
  JUDGE_NUMBER_RIGHT_X,
  JUDGE_LABEL_X,
  JUDGE_ROW_COUNT,
  JUDGE_TOP_Y,
  judgeRowY,
  LARGE_DIGIT_COUNT,
  LARGE_DIGIT_W,
  RANK_X,
  RESULT_CANVAS_H,
  RESULT_CANVAS_W,
} from './result-layout.js';

describe('result-layout — pinned constants match the C# reference', () => {
  it('rank anchor + banner offset reproduce the C# resolved values', () => {
    expect(RANK_X).toBe(480);
    expect(BANNER_X).toBe(315);
    expect(BANNER_Y).toBe(100);
  });

  it('large digit strip matches CActResultParameterPanel st特大文字位置 table', () => {
    // Normal-mode glyph cell — 18×24 in a 5×2 grid (with '.' / '%').
    // First-pass code had 28×24 in a 1×11 strip, which sampled empty
    // space on digits 5-9 and overlapping cells on 0-4 (visible as
    // garbled "12%" / "01.%" overlay on the first preview).
    expect(LARGE_DIGIT_W).toBe(18);
    expect(LARGE_DIGIT_COUNT).toBe(12); // 0..9 + '.' + '%'
    // Row 0: digits 0..4 at y=0.
    expect(digitAtlasX('0')).toBe(0);
    expect(digitAtlasX('4')).toBe(72);
    // Row 1: digits 5..9 at y=24.
    expect(digitAtlasX('5')).toBe(0);
    expect(digitAtlasX('9')).toBe(72);
    // Punctuation slots.
    expect(digitAtlasX('.')).toBe(90);
    expect(digitAtlasX('%')).toBe(90);
  });

  it('digitAtlas returns the (sx, sy) tuple for each canonical char', () => {
    // Pinned to CActResultParameterPanel st特大文字位置 lines 116-165.
    expect(digitAtlas('0')).toEqual({ sx: 0,  sy: 0  });
    expect(digitAtlas('5')).toEqual({ sx: 0,  sy: 24 });
    expect(digitAtlas('9')).toEqual({ sx: 72, sy: 24 });
    expect(digitAtlas('.')).toEqual({ sx: 90, sy: 24 });
    expect(digitAtlas('%')).toEqual({ sx: 90, sy: 0  });
    expect(digitAtlas('a')).toBe(null);
    expect(digitAtlas('')).toBe(null);
  });

  it('digitAtlasX (back-compat) still returns null for unknown chars', () => {
    expect(digitAtlasX('a')).toBe(null);
    expect(digitAtlasX('-')).toBe(null);
    expect(digitAtlasX('')).toBe(null);
    expect(digitAtlasX('12')).toBe(null); // length > 1
  });
});

describe('result-layout — judgement row mapping', () => {
  it('places each judgement row 40 px below the previous', () => {
    expect(judgeRowY(0)).toBe(JUDGE_TOP_Y);
    expect(judgeRowY(1)).toBe(JUDGE_TOP_Y + 40);
    expect(judgeRowY(JUDGE_ROW_COUNT - 1)).toBe(JUDGE_TOP_Y + 4 * 40);
  });

  it('throws for out-of-range indices', () => {
    expect(() => judgeRowY(-1)).toThrow();
    expect(() => judgeRowY(JUDGE_ROW_COUNT)).toThrow();
  });
});

describe('result-layout — geometric invariants', () => {
  it('keeps the metrics column inside the canvas', () => {
    expect(JUDGE_LABEL_X).toBeGreaterThanOrEqual(0);
    expect(JUDGE_NUMBER_RIGHT_X).toBeLessThanOrEqual(RESULT_CANVAS_W);
    expect(judgeRowY(JUDGE_ROW_COUNT - 1)).toBeLessThan(RESULT_CANVAS_H);
  });

  it('keeps the rank glyph anchor inside the canvas (top half)', () => {
    expect(RANK_X).toBeGreaterThan(0);
    expect(RANK_X).toBeLessThan(RESULT_CANVAS_W);
  });
});
