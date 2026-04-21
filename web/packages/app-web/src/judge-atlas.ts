import { Judgment, type JudgmentKind } from '@dtxmania/dtx-core';

/**
 * Per-judgment source rectangles in `ScreenPlay judge strings 1.png`.
 *
 * Ported from DTXMania/Code/Stage/07.Performance/CActPerfCommonJudgementString.cs:86-94.
 * Sprite size is 128 × 42 for all judgments. DTXMania has three theme
 * variants (1 / 2 / 3.png); we only ship the first — POOR / MISS reuse
 * the first image's bottom slot tinted red at paint time.
 */
export const JUDGE_SPRITE_W = 128;
export const JUDGE_SPRITE_H = 42;

export const JUDGE_ROWS: Record<JudgmentKind, { sy: number; tint?: string }> = {
  [Judgment.PERFECT]: { sy: 0 },
  [Judgment.GREAT]:   { sy: 43 },
  [Judgment.GOOD]:    { sy: 86 },
  // POOR / MISS: reuse a sprite + a tint so single-atlas ship still reads.
  [Judgment.POOR]:    { sy: 86,  tint: '#a855f7' },
  [Judgment.MISS]:    { sy: 86,  tint: '#ef4444' },
};
