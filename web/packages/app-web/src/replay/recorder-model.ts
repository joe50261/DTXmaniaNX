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
 *  - `startedAt` is ISO 8601 (not Date.now ms). The byte cost is
 *    negligible against the rest of the envelope and a stricter
 *    parser can refuse malformed timestamps before they reach UI.
 *  - Loop sessions are NOT recorded as replays — by contract, only
 *    runs that count toward score-results are play. The recorder
 *    integration layer enforces this by simply not calling `start()`
 *    when a loop window is active. So no `loopWindow` field here.
 */

import type { JudgmentKind } from '@dtxmania/dtx-core';
import type { LaneValue } from '@dtxmania/input';

export const REPLAY_FORMAT_VERSION = 1;

/** Where a hit came from, in the only granularity the viewer actually
 * cares about: which (virtual) hand struck the pad, or whether the
 * lane was auto-played.
 *
 * Non-XR inputs (keyboard, MIDI, gamepad) collapse to whichever side
 * the lane's primary hand is on — visually they all render as a pad
 * flash with no ghost hand, so finer distinctions buy nothing. The
 * recorder integration layer applies the lane-handedness lookup. */
export type HitSource = 'xr-left' | 'xr-right' | 'auto';

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

/** Per-run player configuration that affects how the chart was
 * experienced. Without these, replaying the same chart can render or
 * judge differently from how the original session played out.
 *
 * Why these and not other settings:
 *  - `audioOffsetMs`: shifts every hit's lag systematically; a 0 ms
 *    replay viewer would mis-show a +25 ms calibrated player's hits
 *    as 25 ms early. Must be captured.
 *  - `autoPlayLanes`: which lanes were on auto-fire at the moment
 *    of capture. The hit stream still tags `source: 'auto'` per hit,
 *    but recording the lane set up-front lets the viewer label the
 *    replay (e.g. "demo run, all lanes auto") without having to
 *    scan every hit.
 *
 * Other settings (skin, kit preset, scroll speed) are deliberately
 * NOT captured for v1 — they affect presentation, not the simulation
 * of what was struck and when. If a future viewer feature needs
 * them, bump `formatVersion`. */
export interface PlayerSettings {
  audioOffsetMs: number;
  /** Lanes the player had on auto-play at the start of the run. */
  autoPlayLanes: readonly LaneValue[];
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
  player: PlayerSettings;
  /** Wall-clock at recording start, ISO 8601 with millisecond
   * precision (e.g. `"2025-01-02T03:04:05.678Z"`). Display only —
   * never used for correctness. ISO over epoch-ms so the file can
   * be eyeballed in a debugger / issue attachment without converting. */
  startedAt: string;
  hits: readonly HitEvent[];
  poses: readonly PoseSample[];
  final: FinalSnapshot;
}

/**
 * In-memory recorder. One instance per recording. Lifecycle:
 *
 *   const r = new Recorder();
 *   r.start({ chartHash, title, artist, durationMs },
 *           { audioOffsetMs, autoPlayLanes });
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
  private state:
    | { kind: 'idle' }
    | {
        kind: 'recording';
        meta: ChartMeta;
        player: PlayerSettings;
        startedAt: string;
        hits: HitEvent[];
        poses: PoseSample[];
      } = { kind: 'idle' };

  isRecording(): boolean {
    return this.state.kind === 'recording';
  }

  hitCount(): number {
    return this.state.kind === 'recording' ? this.state.hits.length : 0;
  }

  poseCount(): number {
    return this.state.kind === 'recording' ? this.state.poses.length : 0;
  }

  start(meta: ChartMeta, player: PlayerSettings): void {
    this.state = {
      kind: 'recording',
      meta,
      player,
      startedAt: new Date(Date.now()).toISOString(),
      hits: [],
      poses: [],
    };
  }

  recordHit(e: HitEvent): void {
    if (this.state.kind !== 'recording') return;
    this.state.hits.push(e);
  }

  recordPose(s: PoseSample): void {
    if (this.state.kind !== 'recording') return;
    this.state.poses.push(s);
  }

  finish(final: FinalSnapshot): Replay {
    if (this.state.kind !== 'recording') {
      throw new Error('Recorder.finish: called while idle');
    }
    const replay: Replay = {
      formatVersion: REPLAY_FORMAT_VERSION,
      meta: this.state.meta,
      player: this.state.player,
      startedAt: this.state.startedAt,
      hits: this.state.hits,
      poses: this.state.poses,
      final,
    };
    this.state = { kind: 'idle' };
    return replay;
  }
}

/** Stable JSON encoding. `lagMs: null` is preserved as null, so a
 * round-trip never produces NaN. Field order is not guaranteed by
 * `JSON.stringify`, so do not rely on byte-exact output for hashing —
 * normalise first if you need that. */
export function serializeReplay(r: Replay): string {
  return JSON.stringify(r);
}

/** Parse a `Replay` from a JSON string. Returns null on:
 *  - invalid JSON,
 *  - missing/wrong `formatVersion`,
 *  - structurally broken envelope (missing meta/player/hits/poses/final/startedAt).
 *
 * Field-level validation (sane lane numbers, finite floats) is the
 * viewer's job — this only protects against catastrophic shape
 * mismatches so a corrupted file can't crash the loader. */
export function deserializeReplay(s: string): Replay | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (o.formatVersion !== REPLAY_FORMAT_VERSION) return null;
  if (typeof o.startedAt !== 'string') return null;
  if (o.meta === null || typeof o.meta !== 'object') return null;
  if (o.player === null || typeof o.player !== 'object') return null;
  if (!Array.isArray(o.hits)) return null;
  if (!Array.isArray(o.poses)) return null;
  if (o.final === null || typeof o.final !== 'object') return null;
  return o as unknown as Replay;
}

/** Convenience: does this replay match the chart the user is currently
 * looking at? Used by the replay browser to gate the "Play replay"
 * button. */
export function replayMatchesChart(r: Replay, chartHash: string): boolean {
  return r.meta.chartHash === chartHash;
}
