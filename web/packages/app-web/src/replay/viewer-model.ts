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
 *    binds to the chart by `chartPath`, so the chart is the source of
 *    truth for "how long is this song".
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
  replay: Replay,
  cutoffSongTimeMs: number,
  totalNotes: number,
): ScoreSnapshot {
  const tracker = new ScoreTracker(totalNotes);
  for (const h of replay.hits) {
    if (h.chipIndex === -1) continue;
    if (h.songTimeMs > cutoffSongTimeMs) continue;
    tracker.record(h.judgment);
  }
  return tracker.snapshot();
}

/** All hit-pad flashes still visible at `currentSongTimeMs`, given
 *  `lifeMs` (defaults to `HIT_FLASH_LIFE_MS`). Includes strays — they
 *  are a visual event in live play. Output order matches recorded order. */
export function replayActiveHitFlashes(
  replay: Replay,
  currentSongTimeMs: number,
  lifeMs: number = HIT_FLASH_LIFE_MS,
): ActiveHitFlash[] {
  const out: ActiveHitFlash[] = [];
  for (const h of replay.hits) {
    if (h.songTimeMs > currentSongTimeMs) continue;
    if (currentSongTimeMs - h.songTimeMs > lifeMs) continue;
    out.push({ lane: h.lane, spawnedMs: h.songTimeMs });
  }
  return out;
}

/** The most recent matched-chip hit at or before `currentSongTimeMs`, if
 *  still within `lifeMs` (defaults to `JUDGMENT_FLASH_LIFE_MS`).
 *  Strays are skipped — live play doesn't paint a judgment flash for
 *  strays, just the pad flash. Returns null when no eligible hit. */
export function replayActiveJudgmentFlash(
  replay: Replay,
  currentSongTimeMs: number,
  lifeMs: number = JUDGMENT_FLASH_LIFE_MS,
): ActiveJudgmentFlash | null {
  let latest: HitEvent | null = null;
  for (const h of replay.hits) {
    if (h.chipIndex === -1) continue;
    if (h.songTimeMs > currentSongTimeMs) continue;
    if (currentSongTimeMs - h.songTimeMs > lifeMs) continue;
    if (latest === null || h.songTimeMs >= latest.songTimeMs) {
      latest = h;
    }
  }
  if (latest === null) return null;
  return {
    lane: latest.lane,
    judgment: latest.judgment,
    spawnedMs: latest.songTimeMs,
    deltaMs: latest.lagMs,
  };
}

/** Hits whose `songTimeMs` falls in `(fromMs, toMs]` — exclusive low,
 *  inclusive high. The intended use is incremental per-tick audio
 *  scheduling: the view layer remembers last tick's `songTimeMs` and
 *  pulls the new range each frame. Includes strays so the viewer can
 *  fire the stray-fallback sample. Output order matches recorded order. */
export function replayHitsInRange(
  replay: Replay,
  fromMs: number,
  toMs: number,
): HitEvent[] {
  const out: HitEvent[] = [];
  for (const h of replay.hits) {
    if (h.songTimeMs > fromMs && h.songTimeMs <= toMs) {
      out.push(h);
    }
  }
  return out;
}

/** `'playing'` until `currentSongTimeMs >= replay.meta.durationMs`, then
 *  `'finished'`. Equivalent to Game's status flip. */
export function replayStatus(
  replay: Replay,
  currentSongTimeMs: number,
): 'playing' | 'finished' {
  return currentSongTimeMs >= replay.meta.durationMs ? 'finished' : 'playing';
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
  poses: readonly PoseSample[],
  currentSongTimeMs: number,
): InterpolatedPose | null {
  if (poses.length === 0) return null;
  const first = poses[0]!;
  const last = poses[poses.length - 1]!;
  if (currentSongTimeMs < first.songTimeMs) return null;
  if (currentSongTimeMs > last.songTimeMs) return null;

  // Find bracket: a (latest sample <= t) and b (earliest sample >= t).
  let a: PoseSample = first;
  let b: PoseSample = last;
  for (let i = 0; i < poses.length; i++) {
    const s = poses[i]!;
    if (s.songTimeMs <= currentSongTimeMs) a = s;
    if (s.songTimeMs >= currentSongTimeMs) {
      b = s;
      break;
    }
  }

  const span = b.songTimeMs - a.songTimeMs;
  const t = span === 0 ? 0 : (currentSongTimeMs - a.songTimeMs) / span;

  const lerpField = (pa: Pose | null, pb: Pose | null): Pose | null => {
    if (pa === null || pb === null) return null;
    const px = pa.pos[0] + (pb.pos[0] - pa.pos[0]) * t;
    const py = pa.pos[1] + (pb.pos[1] - pa.pos[1]) * t;
    const pz = pa.pos[2] + (pb.pos[2] - pa.pos[2]) * t;
    let qx = pa.quat[0] + (pb.quat[0] - pa.quat[0]) * t;
    let qy = pa.quat[1] + (pb.quat[1] - pa.quat[1]) * t;
    let qz = pa.quat[2] + (pb.quat[2] - pa.quat[2]) * t;
    let qw = pa.quat[3] + (pb.quat[3] - pa.quat[3]) * t;
    const len = Math.hypot(qx, qy, qz, qw);
    if (len > 0) {
      qx /= len;
      qy /= len;
      qz /= len;
      qw /= len;
    }
    return { pos: [px, py, pz], quat: [qx, qy, qz, qw] };
  };

  return {
    head: lerpField(a.head, b.head),
    left: lerpField(a.left, b.left),
    right: lerpField(a.right, b.right),
  };
}

// Re-export the ScoreTracker only as a hint that this module's snapshot
// shape comes from there — no need for view code to import dtx-core
// scoring directly when it already pulls from this model.
export { ScoreTracker };
