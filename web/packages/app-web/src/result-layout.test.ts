import { describe, expect, it } from 'vitest';
import {
  BANNER_X,
  BANNER_Y,
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

  it('large digit strip matches CActResultParameterPanel table', () => {
    expect(LARGE_DIGIT_W).toBe(28);
    expect(LARGE_DIGIT_COUNT).toBe(11);
    // Spot-check the per-glyph atlas X for digits and the colon.
    expect(digitAtlasX('0')).toBe(0);
    expect(digitAtlasX('5')).toBe(140);
    expect(digitAtlasX('9')).toBe(252);
    expect(digitAtlasX(':')).toBe(280);
  });

  it('digitAtlasX returns null for non-digit characters', () => {
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
