/**
 * Pure model for replay recording.
 *
 * The replay subsystem is a sidecar: it observes input + judgment events
 * emitted by `Game` (via existing callback boundaries) and serialises
 * them to a `Replay` envelope. This file owns ONLY the data shapes and
 * the in-memory buffering API. No view, no Three.js, no IndexedDB —
 * those live in their own modules so this one stays cheap to unit-test
 * and the dependency-cruiser `pure-model-no-view-imports` rule passes.
 *
 * Two streams are recorded:
 *   1. Hit stream — one entry per resolved input event (matched chip or
 *      stray). Already classified; replay re-paints, doesn't re-judge.
 *   2. Pose stream — controller + headset poses sampled at the caller's
 *      cadence (typically every render frame). Drives ghost hands on
 *      playback.
 *
 * Design notes (tradeoffs):
 *  - Time axis is `songTimeMs` (offset from song start), NOT
 *    `performance.now()`. This makes a replay independent of when it
 *    was recorded — looping, pausing, or pre-roll on the live play
 *    side never leaks into the file.
 *  - Caller controls pose cadence; the model never resamples or
 *    interpolates. A replay viewer that wants 90 Hz from a 30 Hz
 *    capture must lerp itself.
 *  - Hits store an already-classified `judgment`. Trade: a future
 *    judgment-rule change won't retroactively update old replays. We
 *    accept this so replay stays a sidecar (no need for a deterministic
 *    play-core extraction). If determinism is needed later, capture
 *    raw inputs in a parallel stream and recompute.
 *  - lagMs is `number | null`; null = stray (no matched chip). NaN
 *    avoided so JSON round-trips losslessly.
 */

import type { JudgmentKind } from '@dtxmania/dtx-core';
import type { LaneValue } from '@dtxmania/input';

export const REPLAY_FORMAT_VERSION = 1;

/** Where the input came from. Used by the viewer to decide whether to
 * draw a ghost hand (xr-*) or a key flash (keyboard) and by analytics
 * to slice replays by source. */
export type HitSource =
  | 'keyboard'
  | 'xr-left'
  | 'xr-right'
  | 'midi'
  | 'gamepad'
  | 'auto';

export interface ChartMeta {
  /** Stable identifier of the chart this replay binds to. The viewer
   * refuses to play a replay against a different chart. Production
   * caller can use a hash of the .dtx contents; tests pass any string. */
  chartHash: string;
  /** Display only — surface in replay browser UI. */
  title?: string;
  /** Display only. */
  artist?: string;
  /** Chart duration in ms. Pre-allocated by the viewer for scrub UI;
   * not used for correctness. */
  durationMs: number;
}

export interface HitEvent {
  /** ms from song start (0 = chart start). */
  songTimeMs: number;
  lane: LaneValue;
  source: HitSource;
  /** Index into `Song.chips` matched by hit detection; -1 = stray. */
  chipIndex: number;
  /** ms offset from the matched chip's playbackTimeMs. Positive = late.
   * `null` for strays. */
  lagMs: number | null;
  /** Caller already classified this. Model is opinion-free. */
  judgment: JudgmentKind;
}

/** Position + orientation. Coordinates are play-space metres /
 * unit-quaternion. The viewer is responsible for any frame-of-reference
 * conversion (e.g. applying VR seat-height calibration). */
export interface Pose {
  /** [x, y, z] metres. */
  pos: readonly [number, number, number];
  /** [x, y, z, w] quaternion. */
  quat: readonly [number, number, number, number];
}

export interface PoseSample {
  songTimeMs: number;
  /** null = HMD pose unavailable at this frame (e.g., desktop play). */
  head: Pose | null;
  /** null = left controller not tracked. */
  left: Pose | null;
  /** null = right controller not tracked. */
  right: Pose | null;
}

export interface FinalSnapshot {
  /** 0..1, mirrors `ScoreTracker` final value. */
  finalScoreNorm: number;
  comboMax: number;
  fullCombo: boolean;
  /** Counts per judgment for the result panel + replay browser. */
  counts: Readonly<Record<JudgmentKind, number>>;
}

export interface Replay {
  formatVersion: typeof REPLAY_FORMAT_VERSION;
  meta: ChartMeta;
  /** Wall-clock at recording start (`Date.now()`). Display only —
   * never used for correctness. */
  startedAt: number;
  hits: readonly HitEvent[];
  poses: readonly PoseSample[];
  final: FinalSnapshot;
}

/**
 * In-memory recorder. One instance per recording. Lifecycle:
 *
 *   const r = new Recorder();
 *   r.start({ chartHash, title, artist, durationMs });
 *   // ... per-hit:  r.recordHit({ songTimeMs, lane, ... })
 *   // ... per-frame: r.recordPose({ songTimeMs, head, left, right })
 *   const replay = r.finish({ finalScoreNorm, comboMax, ... });
 *
 * Calling recordHit/recordPose while idle is a silent no-op — the live
 * play path shouldn't have to guard every emission with an
 * `if (recording)` check. Calling start() while already recording
 * resets the buffers (treated as starting fresh).
 */
export class Recorder {
  isRecording(): boolean {
    throw new Error('Recorder.isRecording: not implemented');
  }

  hitCount(): number {
    throw new Error('Recorder.hitCount: not implemented');
  }

  poseCount(): number {
    throw new Error('Recorder.poseCount: not implemented');
  }

  start(_meta: ChartMeta): void {
    throw new Error('Recorder.start: not implemented');
  }

  recordHit(_e: HitEvent): void {
    throw new Error('Recorder.recordHit: not implemented');
  }

  recordPose(_s: PoseSample): void {
    throw new Error('Recorder.recordPose: not implemented');
  }

  finish(_final: FinalSnapshot): Replay {
    throw new Error('Recorder.finish: not implemented');
  }
}

/** Stable JSON encoding. `lagMs: null` is preserved as null, so a
 * round-trip never produces NaN. Field order is not guaranteed by
 * `JSON.stringify`, so do not rely on byte-exact output for hashing —
 * normalise first if you need that. */
export function serializeReplay(_r: Replay): string {
  throw new Error('serializeReplay: not implemented');
}

/** Parse a `Replay` from a JSON string. Returns null on:
 *  - invalid JSON,
 *  - missing/wrong `formatVersion`,
 *  - structurally broken envelope (missing meta/hits/poses/final).
 *
 * Field-level validation (sane lane numbers, finite floats) is the
 * viewer's job — this only protects against catastrophic shape
 * mismatches so a corrupted file can't crash the loader. */
export function deserializeReplay(_s: string): Replay | null {
  throw new Error('deserializeReplay: not implemented');
}

/** Convenience: does this replay match the chart the user is currently
 * looking at? Used by the replay browser to gate the "Play replay"
 * button. */
export function replayMatchesChart(r: Replay, chartHash: string): boolean {
  return r.meta.chartHash === chartHash;
}
