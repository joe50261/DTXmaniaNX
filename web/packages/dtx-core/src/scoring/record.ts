import type { JudgmentKind } from './judgment.js';
import type { Rank, ScoreSnapshot } from './score.js';
import { computeAchievementRate, computeRank, isExcellent, isFullCombo } from './score.js';

/**
 * Persistent best-of record for a single chart. Stored per `chartPath`
 * (the scanner's relative path) because that's the one stable ID
 * between scans — `SongEntry.title` can change across re-rips and
 * `ChartEntry` itself is recreated each scan.
 *
 * `bestScore` / `bestRank` / `bestAchievement` are running maxima.
 * `fullCombo` / `excellent` are sticky flags (once true, stay true
 * across worse plays). `plays` and `lastPlayedMs` are always bumped.
 * Per-judgment counts aren't persisted yet — if we start showing
 * detailed per-chart stats later (fastest play, best perfect %),
 * those'd get added alongside rather than replacing the simple
 * record shape.
 */
export interface ChartRecord {
  chartPath: string;
  bestScore: number;
  bestRank: Rank;
  /** DTXmania achievement rate (0..100). Persisted alongside the rank
   * so the UI can show both without recomputing — achievement can
   * differ meaningfully for two plays at the same rank. */
  bestAchievement: number;
  fullCombo: boolean;
  excellent: boolean;
  plays: number;
  lastPlayedMs: number;
}

const RANK_ORDER: Record<Rank, number> = {
  SS: 6,
  S: 5,
  A: 4,
  B: 3,
  C: 2,
  D: 1,
  E: 0,
};

/**
 * Merge a just-finished play's snapshot into the previous record for
 * the same chart. `prev` may be null (first play).
 *
 * Returns the updated record. Always bumps `plays` and `lastPlayedMs`;
 * score / rank / achievement take the max; medals are OR-sticky so a
 * single future full-combo play is enough to light the lamp forever.
 */
export function mergeChartRecord(
  chartPath: string,
  prev: ChartRecord | null,
  snap: ScoreSnapshot
): ChartRecord {
  const rate = computeAchievementRate(snap);
  const rank = computeRank(rate, snap.totalNotes);
  const fc = isFullCombo(snap);
  const ex = isExcellent(snap);

  if (!prev) {
    return {
      chartPath,
      bestScore: snap.score,
      bestRank: rank,
      bestAchievement: rate,
      fullCombo: fc,
      excellent: ex,
      plays: 1,
      lastPlayedMs: Date.now(),
    };
  }

  const bestScore = Math.max(prev.bestScore, snap.score);
  const bestAchievement = Math.max(prev.bestAchievement, rate);
  const bestRank =
    RANK_ORDER[rank] > RANK_ORDER[prev.bestRank] ? rank : prev.bestRank;
  return {
    chartPath,
    bestScore,
    bestRank,
    bestAchievement,
    fullCombo: prev.fullCombo || fc,
    excellent: prev.excellent || ex,
    plays: prev.plays + 1,
    lastPlayedMs: Date.now(),
  };
}

/** Utility for tests / UI — just to make the count-access pattern
 * explicit. Returns 0 for missing keys. */
export function recordJudgmentCount(rec: ChartRecord | null, _j: JudgmentKind): number {
  // Per-judgment persistence was deliberately omitted from the v1
  // record shape; call sites that need this in the future should
  // update mergeChartRecord + bump the IDB schema version.
  if (!rec) return 0;
  return 0;
}
