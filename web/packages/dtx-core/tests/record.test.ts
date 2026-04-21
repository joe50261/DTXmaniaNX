import { describe, it, expect } from 'vitest';
import { mergeChartRecord } from '../src/scoring/record.js';
import { Judgment, type JudgmentKind } from '../src/scoring/judgment.js';
import type { ScoreSnapshot } from '../src/scoring/score.js';

/** Build a minimal snapshot inline — the full tracker path is tested
 * elsewhere; we just need something mergeChartRecord can read. */
function snap(over: Partial<ScoreSnapshot>): ScoreSnapshot {
  const counts: Record<JudgmentKind, number> = {
    [Judgment.PERFECT]: 0,
    [Judgment.GREAT]: 0,
    [Judgment.GOOD]: 0,
    [Judgment.POOR]: 0,
    [Judgment.MISS]: 0,
  };
  return {
    totalNotes: 100,
    counts: { ...counts, ...(over.counts ?? {}) },
    combo: over.combo ?? 0,
    maxCombo: over.maxCombo ?? 0,
    score: over.score ?? 0,
    autoCount: over.autoCount ?? 0,
  };
}

describe('mergeChartRecord', () => {
  it('first play produces a record with plays=1', () => {
    const rec = mergeChartRecord(
      'Songs/a.dtx',
      null,
      snap({ score: 500_000, maxCombo: 80, counts: { [Judgment.PERFECT]: 80 } as Record<JudgmentKind, number> })
    );
    expect(rec.chartPath).toBe('Songs/a.dtx');
    expect(rec.plays).toBe(1);
    expect(rec.bestScore).toBe(500_000);
    expect(rec.lastPlayedMs).toBeGreaterThan(0);
  });

  it('score / achievement / rank take max across plays', () => {
    const first = mergeChartRecord('x.dtx', null, snap({ score: 400_000, counts: { [Judgment.PERFECT]: 60 } as Record<JudgmentKind, number>, maxCombo: 60 }));
    const second = mergeChartRecord('x.dtx', first, snap({ score: 700_000, counts: { [Judgment.PERFECT]: 90 } as Record<JudgmentKind, number>, maxCombo: 90 }));
    expect(second.bestScore).toBe(700_000);
    expect(second.plays).toBe(2);
    // Going backwards doesn't erase the best.
    const third = mergeChartRecord('x.dtx', second, snap({ score: 100_000, counts: { [Judgment.PERFECT]: 20 } as Record<JudgmentKind, number>, maxCombo: 20 }));
    expect(third.bestScore).toBe(700_000);
    expect(third.plays).toBe(3);
  });

  it('full-combo flag is sticky — once true, stays true', () => {
    const pristine = mergeChartRecord(
      'x.dtx',
      null,
      snap({ counts: { [Judgment.PERFECT]: 80, [Judgment.GREAT]: 20 } as Record<JudgmentKind, number>, maxCombo: 100 })
    );
    expect(pristine.fullCombo).toBe(true);
    // Play again and drop combo; flag should persist.
    const after = mergeChartRecord(
      'x.dtx',
      pristine,
      snap({ counts: { [Judgment.PERFECT]: 50, [Judgment.MISS]: 50 } as Record<JudgmentKind, number>, maxCombo: 40 })
    );
    expect(after.fullCombo).toBe(true);
  });

  it('excellent flag is sticky and implies full-combo on that play', () => {
    const perfect = mergeChartRecord(
      'x.dtx',
      null,
      snap({ counts: { [Judgment.PERFECT]: 100 } as Record<JudgmentKind, number>, maxCombo: 100 })
    );
    expect(perfect.excellent).toBe(true);
    expect(perfect.fullCombo).toBe(true);
    const worse = mergeChartRecord(
      'x.dtx',
      perfect,
      snap({ counts: { [Judgment.PERFECT]: 90, [Judgment.GREAT]: 10 } as Record<JudgmentKind, number>, maxCombo: 100 })
    );
    expect(worse.excellent).toBe(true);
  });

  it('rank only moves up, never down', () => {
    const B = mergeChartRecord(
      'x.dtx',
      null,
      snap({ counts: { [Judgment.PERFECT]: 70, [Judgment.GREAT]: 20, [Judgment.MISS]: 10 } as Record<JudgmentKind, number>, maxCombo: 70 })
    );
    const rankB = B.bestRank;
    const E = mergeChartRecord(
      'x.dtx',
      B,
      snap({ counts: { [Judgment.MISS]: 100 } as Record<JudgmentKind, number>, maxCombo: 0 })
    );
    expect(E.bestRank).toBe(rankB);
  });
});
