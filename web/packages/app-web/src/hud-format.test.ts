import { describe, expect, it } from 'vitest';
import { buildMetaLine, formatBpm } from './hud-format.js';

describe('formatBpm', () => {
  it('keeps integers bare', () => {
    expect(formatBpm(186)).toBe('186');
    expect(formatBpm(120)).toBe('120');
  });

  it('keeps up to three authored decimals', () => {
    expect(formatBpm(144.012)).toBe('144.012');
    expect(formatBpm(99.5)).toBe('99.5');
  });

  it('collapses parseFloat noise to three decimals', () => {
    expect(formatBpm(133.33333333333331)).toBe('133.333');
    expect(formatBpm(240.50550000000001)).toBe('240.506');
  });

  it('drops trailing zeros after rounding', () => {
    expect(formatBpm(180.0004)).toBe('180');
    expect(formatBpm(150.2500001)).toBe('150.25');
  });
});

describe('buildMetaLine', () => {
  it('composes the header meta line', () => {
    expect(buildMetaLine(144.012, 1184)).toBe('BPM 144.012 / Notes 1184');
    expect(buildMetaLine(133.33333333333331, 27)).toBe('BPM 133.333 / Notes 27');
  });
});
