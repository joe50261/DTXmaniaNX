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
  /** Number of chips consumed by auto-play (e.g. auto-kick). Excluded from
   * both the 1,000,000-scale score and the rank formula, matching DTXmania
   * (CScoreIni.cs:1571 — `nAuto = nTotal - (P+Gr+Gd+Po+Mi)`). */
  autoCount: number;
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
  private autoCount = 0;

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

  /**
   * Record an auto-played chip (e.g. a BD chip fired by auto-kick). Does
   * not advance combo, add to any judgment count, or contribute weight — it
   * just removes the chip from the score / rank denominator so the player
   * isn't penalised for notes they didn't play. Mirrors DTXmania's
   * EJudgement.Auto path (CStagePerfCommonScreen.cs:1509-1546).
   */
  recordAuto(): void {
    this.autoCount += 1;
  }

  snapshot(): ScoreSnapshot {
    const effective = Math.max(0, this.totalNotes - this.autoCount);
    const score = effective === 0
      ? 0
      : Math.round((this.weightSum / effective) * 1_000_000);
    return {
      totalNotes: this.totalNotes,
      counts: { ...this.counts },
      combo: this.combo,
      maxCombo: this.maxCombo,
      score,
      autoCount: this.autoCount,
    };
  }
}

/**
 * Letter grade awarded on the result screen. Order mirrors DTXMania's
 * ERANK enum (SS is best, E is worst). Autoplay-only SS is not reachable
 * today — we don't have an autoplay mode.
 */
export type Rank = 'SS' | 'S' | 'A' | 'B' | 'C' | 'D' | 'E';

/**
 * DTXMania's achievement rate (0..100), ported from
 * CScoreIni.tCalculateRank (CScoreIni.cs:1565-1612). Formula:
 *
 *   rate = 100*P/T * 0.85 + 100*Gr/T * 0.35 + 100*maxCombo/T * 0.15
 *
 * where T = totalNotes (autoplay-excluded; we have no autoplay). The
 * rate is independent of the 0..1,000,000 display score.
 */
export function computeAchievementRate(snap: ScoreSnapshot): number {
  // Mirrors CScoreIni.cs:1571 — auto-played chips are subtracted from the
  // denominator so auto-play doesn't dilute nor inflate the rate.
  const effective = snap.totalNotes - snap.autoCount;
  if (effective <= 0) return 0;
  const p = (snap.counts.PERFECT / effective) * 100;
  const g = (snap.counts.GREAT / effective) * 100;
  const c = (snap.maxCombo / effective) * 100;
  return p * 0.85 + g * 0.35 + c * 0.15;
}

/**
 * Rank from achievement rate. Thresholds match CScoreIni.cs:1587-1611.
 * totalNotes=0 collapses to 'E' to mirror CActResultRank.cs:140's
 * rankE fallback for empty charts.
 */
export function computeRank(rate: number, totalNotes: number): Rank {
  if (totalNotes === 0) return 'E';
  if (rate >= 95) return 'SS';
  if (rate >= 80) return 'S';
  if (rate >= 73) return 'A';
  if (rate >= 63) return 'B';
  if (rate >= 53) return 'C';
  if (rate >= 45) return 'D';
  return 'E';
}

/** All chips hit without POOR or MISS. Good counts as still-comboing in DTXMania. */
export function isFullCombo(snap: ScoreSnapshot): boolean {
  return (
    snap.totalNotes > 0 &&
    snap.counts.POOR === 0 &&
    snap.counts.MISS === 0
  );
}

/** Every chip PERFECT. Supersedes full-combo on the result banner. */
export function isExcellent(snap: ScoreSnapshot): boolean {
  return snap.totalNotes > 0 && snap.counts.PERFECT === snap.totalNotes;
}
