import type { Chip } from '@dtxmania/dtx-core';
import { classifyDeltaMs, HIT_RANGES_MS, type JudgmentKind } from '@dtxmania/dtx-core';
import type { LaneValue } from '@dtxmania/input';

/**
 * Structural view of a playable chip — matches PlayableChip's fields
 * the matcher reads, so callers can pass their own records directly.
 */
export interface MatchCandidate {
  chip: Chip;
  laneValue: LaneValue;
  hit: boolean;
  missed: boolean;
}

export interface LaneMatch {
  /** Index into `candidates` of the best-matching chip. */
  idx: number;
  /** Signed delta in ms. Negative = player was early (FAST);
   * positive = late (SLOW). */
  deltaMs: number;
  judgment: JudgmentKind;
}

/**
 * Find the nearest unhit chip on `lane` within the POOR window and
 * classify the resulting delta. Returns `null` if no chip is close
 * enough ("stray hit" path on the caller side).
 *
 * Mirrors DTXmania's CActPerfDrumsCombo-style matching: scans every
 * outstanding chip on the visual lane (so HHO shares a lane with HH,
 * and LBD shares a lane with BD — channelToLane in the caller has
 * already projected). Picks the closest-in-time candidate rather than
 * strictly-earliest, because a player's press at time T should match
 * whichever target is temporally nearest T.
 *
 * Pure apart from `candidate.hit = true` on the match, so a repeat
 * call in the same frame with the same arguments finds `null`. This
 * matches handleLaneHit's latching behaviour.
 */
export function matchLaneHit(
  candidates: readonly MatchCandidate[],
  lane: LaneValue,
  songTimeMs: number,
  offsetMs: number,
): LaneMatch | null {
  let bestIdx = -1;
  let bestDelta = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (c.hit || c.missed) continue;
    if (c.laneValue !== lane) continue;
    const delta = songTimeMs - c.chip.playbackTimeMs - offsetMs;
    if (Math.abs(delta) > HIT_RANGES_MS.POOR) continue;
    if (Math.abs(delta) < Math.abs(bestDelta)) {
      bestDelta = delta;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  candidates[bestIdx]!.hit = true;
  return {
    idx: bestIdx,
    deltaMs: bestDelta,
    judgment: classifyDeltaMs(bestDelta),
  };
}

export interface MissEvent {
  idx: number;
  lane: LaneValue;
  chip: Chip;
}

/**
 * Flag any chip whose POOR window has passed and wasn't hit. Mutates
 * `candidate.missed = true` on each so a repeat call the same frame
 * doesn't re-fire the miss. Caller handles the tracker / gauge /
 * flash side effects.
 */
export function detectMisses(
  candidates: readonly MatchCandidate[],
  songTimeMs: number,
): MissEvent[] {
  const misses: MissEvent[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (c.hit || c.missed) continue;
    if (songTimeMs - c.chip.playbackTimeMs <= HIT_RANGES_MS.POOR) continue;
    c.missed = true;
    misses.push({ idx: i, lane: c.laneValue, chip: c.chip });
  }
  return misses;
}
