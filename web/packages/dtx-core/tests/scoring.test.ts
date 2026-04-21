import { describe, it, expect } from 'vitest';
import { classifyDeltaMs, HIT_RANGES_MS, Judgment } from '../src/scoring/judgment.js';
import {
  ScoreTracker,
  computeAchievementRate,
  computeRank,
  isFullCombo,
  isExcellent,
  type ScoreSnapshot,
} from '../src/scoring/score.js';

function snap(partial: Partial<ScoreSnapshot> & { totalNotes: number }): ScoreSnapshot {
  return {
    totalNotes: partial.totalNotes,
    counts: {
      PERFECT: 0,
      GREAT: 0,
      GOOD: 0,
      POOR: 0,
      MISS: 0,
      ...(partial.counts ?? {}),
    },
    combo: partial.combo ?? 0,
    maxCombo: partial.maxCombo ?? 0,
    score: partial.score ?? 0,
  };
}

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

describe('computeAchievementRate', () => {
  it('all-perfect + full combo caps out at 100', () => {
    const rate = computeAchievementRate(
      snap({ totalNotes: 100, counts: { PERFECT: 100 } as never, maxCombo: 100 })
    );
    // 100*0.85 + 0 + 100*0.15 = 100
    expect(rate).toBeCloseTo(100, 10);
  });

  it('zero total notes returns 0, no divide-by-zero', () => {
    expect(computeAchievementRate(snap({ totalNotes: 0 }))).toBe(0);
  });

  it('mixed run: P=50,Gr=30,good=10,poor=5,miss=5,maxCombo=95 of 100', () => {
    const rate = computeAchievementRate(
      snap({
        totalNotes: 100,
        counts: { PERFECT: 50, GREAT: 30, GOOD: 10, POOR: 5, MISS: 5 } as never,
        maxCombo: 95,
      })
    );
    // 50*0.85 + 30*0.35 + 95*0.15 = 42.5 + 10.5 + 14.25 = 67.25
    expect(rate).toBeCloseTo(67.25, 4);
  });
});

describe('computeRank', () => {
  it('DTXMania thresholds at exact boundaries (inclusive)', () => {
    // CScoreIni.cs:1587-1611
    expect(computeRank(95, 100)).toBe('SS');
    expect(computeRank(94.999, 100)).toBe('S');
    expect(computeRank(80, 100)).toBe('S');
    expect(computeRank(79.999, 100)).toBe('A');
    expect(computeRank(73, 100)).toBe('A');
    expect(computeRank(72.999, 100)).toBe('B');
    expect(computeRank(63, 100)).toBe('B');
    expect(computeRank(62.999, 100)).toBe('C');
    expect(computeRank(53, 100)).toBe('C');
    expect(computeRank(52.999, 100)).toBe('D');
    expect(computeRank(45, 100)).toBe('D');
    expect(computeRank(44.999, 100)).toBe('E');
    expect(computeRank(0, 100)).toBe('E');
  });

  it('empty chart collapses to E regardless of rate', () => {
    expect(computeRank(100, 0)).toBe('E');
    expect(computeRank(0, 0)).toBe('E');
  });
});

describe('isFullCombo / isExcellent', () => {
  it('full combo: no POOR, no MISS, at least one note', () => {
    expect(
      isFullCombo(
        snap({ totalNotes: 10, counts: { PERFECT: 5, GREAT: 3, GOOD: 2 } as never })
      )
    ).toBe(true);
    expect(
      isFullCombo(
        snap({ totalNotes: 10, counts: { PERFECT: 9, POOR: 1 } as never })
      )
    ).toBe(false);
    expect(
      isFullCombo(
        snap({ totalNotes: 10, counts: { PERFECT: 9, MISS: 1 } as never })
      )
    ).toBe(false);
    expect(isFullCombo(snap({ totalNotes: 0 }))).toBe(false);
  });

  it('excellent requires every note PERFECT', () => {
    expect(
      isExcellent(
        snap({ totalNotes: 10, counts: { PERFECT: 10 } as never })
      )
    ).toBe(true);
    expect(
      isExcellent(
        snap({ totalNotes: 10, counts: { PERFECT: 9, GREAT: 1 } as never })
      )
    ).toBe(false);
    expect(isExcellent(snap({ totalNotes: 0 }))).toBe(false);
  });
});
