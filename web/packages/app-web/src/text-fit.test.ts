import { describe, expect, it } from 'vitest';
import { fitTextEnd } from './text-fit.js';

/** 10px per code point — CJK and latin alike, keeps expectations easy. */
const measure10 = (s: string): number => Array.from(s).length * 10;

describe('fitTextEnd', () => {
  it('returns the text unchanged when it fits exactly', () => {
    expect(fitTextEnd('abcde', 50, measure10)).toBe('abcde');
  });

  it('returns the text unchanged when there is spare room', () => {
    expect(fitTextEnd('abc', 500, measure10)).toBe('abc');
  });

  it('trims the tail and appends an ellipsis when too wide', () => {
    // 8 chars = 80px into 50px: 4 prefix chars + ellipsis = 50px.
    expect(fitTextEnd('abcdefgh', 50, measure10)).toBe('abcd…');
  });

  it('never returns a string wider than maxWidth, and keeps the maximal prefix', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    const chars = Array.from(text);
    for (let w = 0; w <= 200; w += 7) {
      const out = fitTextEnd(text, w, measure10);
      expect(measure10(out)).toBeLessThanOrEqual(w);
      // Maximality: a truncation must not over-truncate — keeping one
      // more code point (still ellipsized) has to overflow w.
      if (out !== text && out !== '') {
        const prefixLen = Array.from(out).length - 1; // drop the ellipsis
        if (prefixLen < chars.length - 1) {
          const oneMore = chars.slice(0, prefixLen + 1).join('') + '…';
          expect(measure10(oneMore)).toBeGreaterThan(w);
        }
      }
    }
  });

  it('returns empty string when even the ellipsis cannot fit', () => {
    expect(fitTextEnd('abc', 5, measure10)).toBe('');
    expect(fitTextEnd('abc', 0, measure10)).toBe('');
  });

  it('returns just the ellipsis when only the ellipsis fits', () => {
    expect(fitTextEnd('abc', 10, measure10)).toBe('…');
  });

  it('handles the empty string', () => {
    expect(fitTextEnd('', 50, measure10)).toBe('');
  });

  it('trims on code points so surrogate pairs are never split', () => {
    // Each emoji is one code point (10px) but two UTF-16 units; a
    // .slice()-based trim at 25px would cut mid-pair.
    const text = '😀😀😀😀';
    const out = fitTextEnd(text, 25, measure10);
    expect(out).toBe('😀…');
    // Round-trip through code points must not produce a lone surrogate.
    expect(Array.from(out).join('')).toBe(out);
  });

  it('handles variable-width measurers (non-monospace)', () => {
    // 'W' = 20px, everything else (incl. the ellipsis) 5px. The unique
    // maximal fit for 40px is 'aaW…' (35px) — 'aaWW…' is 55px. An
    // over-truncating implementation (e.g. bare '…') must fail here.
    const measure = (s: string): number =>
      Array.from(s).reduce((acc, ch) => acc + (ch === 'W' ? 20 : 5), 0);
    expect(fitTextEnd('aaWWaa', 40, measure)).toBe('aaW…');
  });
});
