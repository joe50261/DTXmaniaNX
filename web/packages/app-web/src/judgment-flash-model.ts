import type { JudgmentKind } from '@dtxmania/dtx-core';
import type { LaneValue } from '@dtxmania/input';

/**
 * One judgment "pop" (PERFECT / GREAT / GOOD / POOR / MISS) anchored to
 * a single lane. Produced by `game.ts` on every hit/miss and consumed by
 * `renderer.ts`'s `drawJudgmentFlashes`.
 *
 * Lives in a pure model module (no view/`three` imports) because it is a
 * data shape shared across the producer (Game) and consumer (Renderer);
 * see web/CLAUDE.md "Pure model modules for shared logic".
 */
export interface JudgmentFlash {
  text: string;
  /** Raw judgment kind, used to look up the sprite in JUDGE_ROWS. */
  judgment?: JudgmentKind;
  color: string;
  lane: LaneValue;
  spawnedMs: number;
  /** Hit-time delta in ms. Negative = player pressed early (FAST),
   * positive = late (SLOW). `undefined` for MISS (no user press). */
  deltaMs?: number;
}

/** How long (song-ms) a judgment pop stays on screen before it is pruned
 *  and stops painting. Mirrors the renderer's fade life so the store and
 *  the draw agree on when a flash is dead. */
export const JUDGMENT_FLASH_LIFE_MS = 400;

/**
 * Add `flash` to the per-lane flash set, replacing any flash already on
 * the same lane.
 *
 * DTXMania keeps judgment state per lane
 * (`CActPerfCommonJudgementString.st状態[nLane]`) and simply restarts
 * that lane's animation counter on a fresh hit, so a chord across lanes
 * shows one judgment pop per lane at the same time. The single-slot model
 * this replaces could only ever hold the last lane hit in a frame, which
 * is why simultaneous note hits appeared to show only one judgment.
 *
 * Pure (returns a new array) so it is trivially unit-testable and callers
 * can reassign without worrying about aliasing the array that the last
 * rendered frame captured.
 */
export function upsertLaneFlash(
  flashes: readonly JudgmentFlash[],
  flash: JudgmentFlash,
): JudgmentFlash[] {
  const next = flashes.filter((f) => f.lane !== flash.lane);
  next.push(flash);
  return next;
}

/** Drop flashes whose age has passed the on-screen life so the set stays
 *  bounded (also naturally capped at one-per-lane by `upsertLaneFlash`). */
export function pruneJudgmentFlashes(
  flashes: readonly JudgmentFlash[],
  nowMs: number,
  lifeMs: number = JUDGMENT_FLASH_LIFE_MS,
): JudgmentFlash[] {
  return flashes.filter((f) => nowMs - f.spawnedMs < lifeMs);
}
