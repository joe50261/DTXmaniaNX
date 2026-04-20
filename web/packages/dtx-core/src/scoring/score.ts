import { Judgment, type JudgmentKind } from './judgment.js';

/**
 * Simplified score state tracker for v1.
 *
 * The final formula is intended to match DTXMania's 1,000,000-point scale
 * (CStagePerfCommonScreen.cs:1675-1827), but the precise combo-based
 * multiplier is deferred until we can A/B against the C# reference.
 *
 * v1 scoring:
 *   base_weight = { PERFECT: 1.0, GREAT: 0.7, GOOD: 0.5, POOR: 0.2, MISS: 0 }
 *   score = (sum of weights / totalNotes) * 1_000_000
 *
 * Combo breaks on POOR/MISS. Max combo is tracked separately.
 */
export interface ScoreSnapshot {
  totalNotes: number;
  counts: Record<JudgmentKind, number>;
  combo: number;
  maxCombo: number;
  score: number;
}

const WEIGHTS: Record<JudgmentKind, number> = {
  [Judgment.PERFECT]: 1.0,
  [Judgment.GREAT]: 0.7,
  [Judgment.GOOD]: 0.5,
  [Judgment.POOR]: 0.2,
  [Judgment.MISS]: 0,
};

export class ScoreTracker {
  private counts: Record<JudgmentKind, number> = {
    [Judgment.PERFECT]: 0,
    [Judgment.GREAT]: 0,
    [Judgment.GOOD]: 0,
    [Judgment.POOR]: 0,
    [Judgment.MISS]: 0,
  };
  private weightSum = 0;
  private combo = 0;
  private maxCombo = 0;

  constructor(private readonly totalNotes: number) {
    if (totalNotes < 0) throw new Error('totalNotes must be non-negative');
  }

  record(j: JudgmentKind): void {
    this.counts[j] += 1;
    this.weightSum += WEIGHTS[j];
    if (j === Judgment.PERFECT || j === Judgment.GREAT || j === Judgment.GOOD) {
      this.combo += 1;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    } else {
      this.combo = 0;
    }
  }

  snapshot(): ScoreSnapshot {
    const score = this.totalNotes === 0
      ? 0
      : Math.round((this.weightSum / this.totalNotes) * 1_000_000);
    return {
      totalNotes: this.totalNotes,
      counts: { ...this.counts },
      combo: this.combo,
      maxCombo: this.maxCombo,
      score,
    };
  }
}
