import { describe, it, expect } from 'vitest';
import { classifyDeltaMs, HIT_RANGES_MS, Judgment } from '../src/scoring/judgment.js';
import { ScoreTracker } from '../src/scoring/score.js';

describe('classifyDeltaMs', () => {
  it('classifies exact hit as PERFECT', () => {
    expect(classifyDeltaMs(0)).toBe(Judgment.PERFECT);
  });
  it('edge of PERFECT is PERFECT, +1ms over is GREAT', () => {
    expect(classifyDeltaMs(HIT_RANGES_MS.PERFECT)).toBe(Judgment.PERFECT);
    expect(classifyDeltaMs(HIT_RANGES_MS.PERFECT + 1)).toBe(Judgment.GREAT);
  });
  it('treats negative and positive deltas symmetrically', () => {
    expect(classifyDeltaMs(-50)).toBe(classifyDeltaMs(50));
  });
  it('beyond POOR is MISS', () => {
    expect(classifyDeltaMs(HIT_RANGES_MS.POOR + 1)).toBe(Judgment.MISS);
    expect(classifyDeltaMs(500)).toBe(Judgment.MISS);
  });
});

describe('ScoreTracker', () => {
  it('all perfect gives 1,000,000', () => {
    const t = new ScoreTracker(10);
    for (let i = 0; i < 10; i++) t.record(Judgment.PERFECT);
    const s = t.snapshot();
    expect(s.score).toBe(1_000_000);
    expect(s.maxCombo).toBe(10);
  });

  it('combo breaks on MISS and POOR', () => {
    const t = new ScoreTracker(5);
    t.record(Judgment.PERFECT);
    t.record(Judgment.GREAT);
    t.record(Judgment.MISS);
    t.record(Judgment.PERFECT);
    t.record(Judgment.POOR);
    const s = t.snapshot();
    expect(s.maxCombo).toBe(2);
    expect(s.combo).toBe(0);
    expect(s.counts[Judgment.PERFECT]).toBe(2);
    expect(s.counts[Judgment.GREAT]).toBe(1);
    expect(s.counts[Judgment.POOR]).toBe(1);
    expect(s.counts[Judgment.MISS]).toBe(1);
  });

  it('empty song returns 0 score without dividing by 0', () => {
    const t = new ScoreTracker(0);
    expect(t.snapshot().score).toBe(0);
  });

  it('weighted score: 5 greats out of 10 notes ~= 350_000', () => {
    const t = new ScoreTracker(10);
    for (let i = 0; i < 5; i++) t.record(Judgment.GREAT);
    for (let i = 0; i < 5; i++) t.record(Judgment.MISS);
    expect(t.snapshot().score).toBe(350_000);
  });
});
