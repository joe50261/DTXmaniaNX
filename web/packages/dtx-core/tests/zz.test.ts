import { describe, it, expect } from 'vitest';
import { decodeZz } from '../src/parser/zz.js';

describe('decodeZz', () => {
  it('decodes 00 as 0', () => {
    expect(decodeZz('00')).toBe(0);
  });
  it('decodes 01 as 1', () => {
    expect(decodeZz('01')).toBe(1);
  });
  it('decodes 0A as 10', () => {
    expect(decodeZz('0A')).toBe(10);
  });
  it('decodes 10 as 36', () => {
    expect(decodeZz('10')).toBe(36);
  });
  it('decodes ZZ as 36*36 - 1 = 1295', () => {
    expect(decodeZz('ZZ')).toBe(35 * 36 + 35);
  });
  it('tolerates lowercase', () => {
    expect(decodeZz('ab')).toBe(decodeZz('AB'));
  });
  it('throws on non-base36', () => {
    expect(() => decodeZz('!!')).toThrow();
  });
  it('throws on wrong length', () => {
    expect(() => decodeZz('0')).toThrow();
    expect(() => decodeZz('000')).toThrow();
  });
});
