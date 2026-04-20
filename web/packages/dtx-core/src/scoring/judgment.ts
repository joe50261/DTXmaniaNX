/**
 * Judgment windows in milliseconds (absolute delta between hit time and
 * target chip time). Ported from STHitRanges.cs:43-49 default values.
 *
 * A hit qualifies for the tightest window it fits; anything beyond POOR is MISS.
 */
export const HIT_RANGES_MS = {
  PERFECT: 34,
  GREAT: 67,
  GOOD: 84,
  POOR: 117,
} as const;

export const Judgment = {
  PERFECT: 'PERFECT',
  GREAT: 'GREAT',
  GOOD: 'GOOD',
  POOR: 'POOR',
  MISS: 'MISS',
} as const;

export type JudgmentKind = (typeof Judgment)[keyof typeof Judgment];

export function classifyDeltaMs(deltaMs: number): JudgmentKind {
  const d = Math.abs(deltaMs);
  if (d <= HIT_RANGES_MS.PERFECT) return Judgment.PERFECT;
  if (d <= HIT_RANGES_MS.GREAT) return Judgment.GREAT;
  if (d <= HIT_RANGES_MS.GOOD) return Judgment.GOOD;
  if (d <= HIT_RANGES_MS.POOR) return Judgment.POOR;
  return Judgment.MISS;
}
