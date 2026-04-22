import type { Chip } from '@dtxmania/dtx-core';
import type { LaneValue } from '@dtxmania/input';

/**
 * Structural view of a playable chip — just the fields the auto-fire
 * decision needs. Matches PlayableChip shape (game.ts) so the caller
 * passes its own records straight through, but kept independent so
 * tests can hand-roll minimal inputs.
 *
 * `hit` / `missed` are mutated on fire so repeat calls within the
 * same tick don't re-fire the same chip.
 */
export interface AutoFireCandidate {
  chip: Chip;
  laneValue: LaneValue;
  hit: boolean;
  missed: boolean;
}

export interface AutoFireEvent {
  /** Index into the input array — lets the caller look back up its
   * real record for side-effects (audio, visuals). */
  idx: number;
  lane: LaneValue;
  chip: Chip;
}

/**
 * Decide which chips to auto-fire this tick. Mirrors DTXmania's
 * CStagePerfDrumsScreen.cs:3394-3429 UsePerfectGhost loop:
 *
 *   - the candidate's lane is in `autoLanes`, AND
 *   - the chip hasn't already been hit or missed, AND
 *   - its playback time has arrived.
 *
 * Side effects: flips `hit = true` on each fired candidate so a
 * second call this frame is a no-op. No tracker / audio / visual
 * touches — caller handles those.
 *
 * Empty `autoLanes` is an early-exit so the per-tick cost is zero
 * for the common case (no auto-play configured).
 */
export function applyAutoFire(
  candidates: readonly AutoFireCandidate[],
  autoLanes: ReadonlySet<LaneValue>,
  songTimeMs: number,
): AutoFireEvent[] {
  const events: AutoFireEvent[] = [];
  if (autoLanes.size === 0) return events;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (c.hit || c.missed) continue;
    if (!autoLanes.has(c.laneValue)) continue;
    if (songTimeMs < c.chip.playbackTimeMs) continue;
    c.hit = true;
    events.push({ idx: i, lane: c.laneValue, chip: c.chip });
  }
  return events;
}
