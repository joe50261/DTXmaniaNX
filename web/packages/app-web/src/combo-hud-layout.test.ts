import { describe, expect, it } from 'vitest';
import {
  COMBO_DIGIT_CAP,
  COMBO_DIGIT_COLS,
  COMBO_DIGIT_H,
  COMBO_DIGIT_W,
  COMBO_LABEL_ATLAS_Y,
  comboDigitAtlasX,
  comboDigitAtlasY,
  comboDigits,
  dangerAlpha,
  DANGER_MAX_ALPHA,
  DANGER_THRESHOLD,
  isComboOverflow,
} from './combo-hud-layout.js';

describe('comboDigitAtlas — pinned to ScreenPlayDrums combo.png', () => {
  it('matches the C# CActPerfCommonCombo constants', () => {
    expect(COMBO_DIGIT_W).toBe(120);
    expect(COMBO_DIGIT_H).toBe(160);
    expect(COMBO_DIGIT_COLS).toBe(5);
    expect(COMBO_LABEL_ATLAS_Y).toBe(320);
  });

  it('places digits 0-4 in row 0, 5-9 in row 1', () => {
    expect(comboDigitAtlasX(0)).toBe(0);
    expect(comboDigitAtlasX(4)).toBe(4 * 120);
    expect(comboDigitAtlasX(5)).toBe(0);
    expect(comboDigitAtlasX(9)).toBe(4 * 120);

    expect(comboDigitAtlasY(0)).toBe(0);
    expect(comboDigitAtlasY(4)).toBe(0);
    expect(comboDigitAtlasY(5)).toBe(160);
    expect(comboDigitAtlasY(9)).toBe(160);
  });

  it('throws on out-of-range digits', () => {
    expect(() => comboDigitAtlasX(-1)).toThrow();
    expect(() => comboDigitAtlasX(10)).toThrow();
    expect(() => comboDigitAtlasX(1.5)).toThrow();
  });
});

describe('comboDigits', () => {
  it('returns ones-first array', () => {
    expect(comboDigits(125)).toEqual([5, 2, 1]);
    expect(comboDigits(7)).toEqual([7]);
    expect(comboDigits(40)).toEqual([0, 4]);
  });

  it('caps at 4 digits / 999', () => {
    expect(comboDigits(9999)).toEqual([9, 9, 9]);
    expect(comboDigits(1000)).toEqual([9, 9, 9]);
    expect(comboDigits(1234)).toEqual([9, 9, 9]);
    expect(comboDigits(999)).toEqual([9, 9, 9]);
  });

  it('returns empty for 0 / negative / NaN (canvas skips paint)', () => {
    expect(comboDigits(0)).toEqual([]);
    expect(comboDigits(-5)).toEqual([]);
    expect(comboDigits(Number.NaN)).toEqual([]);
  });

  it('floors fractional combos', () => {
    expect(comboDigits(12.7)).toEqual([2, 1]);
  });

  it('never returns more than COMBO_DIGIT_CAP entries', () => {
    expect(comboDigits(99999).length).toBeLessThanOrEqual(COMBO_DIGIT_CAP);
  });
});

describe('isComboOverflow', () => {
  it('true when above 999, false otherwise', () => {
    expect(isComboOverflow(0)).toBe(false);
    expect(isComboOverflow(999)).toBe(false);
    expect(isComboOverflow(1000)).toBe(true);
    expect(isComboOverflow(Number.POSITIVE_INFINITY)).toBe(false); // not finite
  });
});

describe('dangerAlpha', () => {
  it('returns 0 above the threshold', () => {
    expect(dangerAlpha(DANGER_THRESHOLD + 0.01, 0)).toBe(0);
    expect(dangerAlpha(1, 0)).toBe(0);
  });

  it('returns a positive pulse when below threshold', () => {
    const a1 = dangerAlpha(0.1, 0);
    expect(a1).toBeGreaterThan(0);
    expect(a1).toBeLessThanOrEqual(DANGER_MAX_ALPHA);
  });

  it('clamps to DANGER_MAX_ALPHA at gauge=0', () => {
    let max = 0;
    for (let t = 0; t < 1000; t += 25) {
      max = Math.max(max, dangerAlpha(0, t));
    }
    expect(max).toBeLessThanOrEqual(DANGER_MAX_ALPHA);
  });

  it('returns 0 for non-finite gauge', () => {
    expect(dangerAlpha(Number.NaN, 0)).toBe(0);
  });
});
