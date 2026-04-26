/**
 * Pure derivation layer for the replay viewer.
 *
 * The viewer (a separate `*-canvas` / view module — not yet built) drives
 * the existing `Renderer` + drum-kit + grips by feeding it a `RenderState`
 * derived from a `Replay` snapshot at the current `songTimeMs`. This module
 * holds the deterministic, framework-free derivers so view code stays thin
 * and tests don't need a renderer / Three.js / DOM.
 *
 * Design notes (tradeoffs):
 *  - The viewer reuses live-play scoring (`ScoreTracker` from `@dtxmania/dtx-core`)
 *    rather than reimplementing combo / counts / achievement maths. A score
 *    snapshot at any cutoff is just "scrub a fresh tracker through the matched
 *    hits in order". This keeps the live-play HUD and the replay HUD
 *    bit-identical for a given hit stream.
 *  - Strays (`chipIndex === -1`) are kept in the hit stream because they're
 *    a *visual* event the viewer must paint to match what the player saw.
 *    Score functions filter them; flash / audio functions include them.
 *    This mirrors `Game.handleLaneHit`'s split between `playStrayHit`
 *    (visual + audio) and the matched-chip path (visual + audio + tracker).
 *  - Pose interpolation uses component-wise lerp + renormalise on the
 *    quaternion, not true slerp. At a 60 Hz capture cadence adjacent samples
 *    are < 16 ms apart so the angle delta is tiny; the difference is
 *    visually indistinguishable. Avoiding slerp keeps this file framework-
 *    free (no `three`).
 *  - `durationMs` for the playing → finished flip lives on `replay.meta`
 *    (the chart's duration), not on the replay envelope itself. The replay
 *    binds to the chart by hash, so the chart is the source of truth for
 *    "how long is this song".
 *
 * Out of scope here:
 *  - Building a full `RenderState` (depends on the chart object, the
 *    Renderer's atlas types, etc. — done by the view layer).
 *  - Driving Three.js grip transforms (view layer).
 *  - Audio scheduling itself — this layer only enumerates which hits fall
 *    inside an arbitrary time range; the view layer feeds AudioEngine.
 */

import { ScoreTracker, type JudgmentKind, type ScoreSnapshot } from '@dtxmania/dtx-core';
import type { LaneValue } from '@dtxmania/input';
import type { HitEvent, Pose, PoseSample, Replay } from './recorder-model.js';

/** Lifetime of a hit-pad flash on the HUD, in ms. Mirrors the live
 *  Renderer's flash decay so a replay paints identically. */
export const HIT_FLASH_LIFE_MS = 200;

/** Lifetime of the central judgment-text flash, in ms. */
export const JUDGMENT_FLASH_LIFE_MS = 600;

export interface ActiveHitFlash {
  lane: LaneValue;
  spawnedMs: number;
}

export interface ActiveJudgmentFlash {
  lane: LaneValue;
  judgment: JudgmentKind;
  spawnedMs: number;
  /** ms offset from chip's playbackTimeMs. Null only for strays, but
   * `replayActiveJudgmentFlash` filters strays so non-null in practice;
   * typed as `number | null` to match `HitEvent.lagMs`. */
  deltaMs: number | null;
}

export interface InterpolatedPose {
  head: Pose | null;
  left: Pose | null;
  right: Pose | null;
}

/** Replay every matched-chip hit at or before `cutoffSongTimeMs` through
 *  a fresh `ScoreTracker` and return the snapshot. Strays
 *  (`chipIndex === -1`) are excluded — they don't go through the tracker
 *  in live play either.
 *
 *  `totalNotes` is the chart's playable-chip count; the caller knows the
 *  chart, this module doesn't. */
export function replayScoreSnapshotAt(
  _replay: Replay,
  _cutoffSongTimeMs: number,
  _totalNotes: number,
): ScoreSnapshot {
  throw new Error('replayScoreSnapshotAt: not implemented');
}

/** All hit-pad flashes still visible at `currentSongTimeMs`, given
 *  `lifeMs` (defaults to `HIT_FLASH_LIFE_MS`). Includes strays — they
 *  are a visual event in live play. Output order matches recorded order. */
export function replayActiveHitFlashes(
  _replay: Replay,
  _currentSongTimeMs: number,
  _lifeMs?: number,
): ActiveHitFlash[] {
  throw new Error('replayActiveHitFlashes: not implemented');
}

/** The most recent matched-chip hit at or before `currentSongTimeMs`, if
 *  still within `lifeMs` (defaults to `JUDGMENT_FLASH_LIFE_MS`).
 *  Strays are skipped — live play doesn't paint a judgment flash for
 *  strays, just the pad flash. Returns null when no eligible hit. */
export function replayActiveJudgmentFlash(
  _replay: Replay,
  _currentSongTimeMs: number,
  _lifeMs?: number,
): ActiveJudgmentFlash | null {
  throw new Error('replayActiveJudgmentFlash: not implemented');
}

/** Hits whose `songTimeMs` falls in `(fromMs, toMs]` — exclusive low,
 *  inclusive high. The intended use is incremental per-tick audio
 *  scheduling: the view layer remembers last tick's `songTimeMs` and
 *  pulls the new range each frame. Includes strays so the viewer can
 *  fire the stray-fallback sample. Output order matches recorded order. */
export function replayHitsInRange(
  _replay: Replay,
  _fromMs: number,
  _toMs: number,
): HitEvent[] {
  throw new Error('replayHitsInRange: not implemented');
}

/** `'playing'` until `currentSongTimeMs >= replay.meta.durationMs`, then
 *  `'finished'`. Equivalent to Game's status flip. */
export function replayStatus(
  _replay: Replay,
  _currentSongTimeMs: number,
): 'playing' | 'finished' {
  throw new Error('replayStatus: not implemented');
}

/** Component-wise lerp on position + lerp+renormalise on quaternion,
 *  between the two `PoseSample`s bracketing `currentSongTimeMs`.
 *
 *  Returns null when the time is out-of-range:
 *   - empty buffer
 *   - before first sample
 *   - after last sample
 *  (No extrapolation. Caller decides what to do.)
 *
 *  Per-field null handling: if either bracket sample has null for that
 *  field (head/left/right), the output field is null — half-known
 *  bracket isn't interpolated to avoid half-truth poses. */
export function lerpPoseSample(
  _poses: readonly PoseSample[],
  _currentSongTimeMs: number,
): InterpolatedPose | null {
  throw new Error('lerpPoseSample: not implemented');
}

// Re-export the ScoreTracker only as a hint that this module's snapshot
// shape comes from there — no need for view code to import dtx-core
// scoring directly when it already pulls from this model.
export { ScoreTracker };
