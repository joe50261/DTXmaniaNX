/**
 * Replay capture glue.
 *
 * This module is the subscriber side of the sidecar pattern: it
 * observes Game's emit-only callbacks (`onHitProcessed`, `onTickPose`,
 * and the existing `onChartFinished`), translates each event into the
 * replay schema, and persists via `storage.saveReplay`.
 *
 * Game does not import this module. Removing the entire `replay/`
 * folder leaves Game's callbacks unbound, which is a no-op.
 *
 * Wiring (host = main.ts):
 *
 *   const capture = createReplayCapture(autoPlayLanes);
 *   await game.loadAndStart(text, {
 *     ...,
 *     onHitProcessed: capture.onHit,
 *     onTickPose: capture.onPose,
 *     onChartFinished: async (path, snap, didLoop) => {
 *       // existing best-of update first
 *       await persistBestOf(...);
 *       // replay: discard practice runs, save real runs
 *       if (didLoop) capture.discard();
 *       else await capture.finish(snap);
 *     },
 *   });
 *   capture.start({ chartPath, ... }, { audioOffsetMs, autoPlayLanes });
 *
 * Known gaps (documented; addressed in a follow-up slice):
 *  - Auto-fired chips (lanes in `autoPlayLanes`) DON'T emit through
 *    `onHitProcessed` today — Game's `autoFireLanes` calls
 *    `tracker.recordAuto()` directly without going through
 *    `handleLaneHit`. Replays of autoplay-on charts will show those
 *    chips as falling past the judge line without any visual /
 *    score event. Fix is a 1-line emit in `autoFireLanes`.
 */

import { Recorder, type ChartMeta, type FinalSnapshot, type HitEvent, type PlayerSettings, type PoseSample } from './recorder-model.js';
import { saveReplay } from './storage.js';
import { Judgment, type ScoreSnapshot } from '@dtxmania/dtx-core';
import type { LaneValue } from '@dtxmania/input';
import type { HitProcessedEvent } from '../game.js';
import type { XrPoseSnapshot } from '../xr-controllers.js';

/** Translate a Game `HitProcessedEvent` into the replay schema's
 * `HitEvent`. Source priority:
 *  - lane on autoplay → `'auto'` (defensive — autoplay-lane hits
 *    rarely reach `handleLaneHit`, but if they do the run wasn't
 *    "human input on that lane").
 *  - `matched.deltaMs === null` (auto-detected miss) → `'auto'`.
 *  - `e.hand === 'left'` → `'xr-left'`.
 *  - `e.hand === 'right'` → `'xr-right'`.
 *  - hand `undefined` (keyboard / MIDI / gamepad) → `'xr-right'`
 *    placeholder; visually a pad flash with no ghost hand, so any
 *    side label is benign here.
 *
 * `autoPlayLanes` is a snapshot at recording start; live changes
 * mid-run aren't reflected — matches how `Game.autoPlayLanes` is set
 * once per loadAndStart. */
export function buildHitEvent(
  e: HitProcessedEvent,
  autoPlayLanes: ReadonlySet<LaneValue>,
): HitEvent {
  // Hand mapping for human input; keyboard / MIDI / gamepad (hand=undefined)
  // collapses to xr-right since the viewer only paints a pad flash.
  const handSource: 'xr-left' | 'xr-right' =
    e.hand === 'left' ? 'xr-left' : 'xr-right';

  if (e.matched === null) {
    // Stray: real human pad strike with no chip in window. Viewer still
    // paints a flash on the striking hand, so source mirrors hand mapping.
    return {
      songTimeMs: e.songTimeMs,
      lane: e.lane,
      source: autoPlayLanes.has(e.lane) ? 'auto' : handSource,
      chipIndex: -1,
      lagMs: null,
      judgment: Judgment.MISS,
    };
  }

  // Auto-detected miss: chip's POOR window expired without input. Per
  // game.ts contract, deltaMs is null exactly for this case.
  if (e.matched.deltaMs === null) {
    return {
      songTimeMs: e.songTimeMs,
      lane: e.lane,
      source: 'auto',
      chipIndex: e.matched.idx,
      lagMs: null,
      judgment: e.matched.judgment,
    };
  }

  // Matched human input — autoPlay-lane wins as a defensive label.
  return {
    songTimeMs: e.songTimeMs,
    lane: e.lane,
    source: autoPlayLanes.has(e.lane) ? 'auto' : handSource,
    chipIndex: e.matched.idx,
    lagMs: e.matched.deltaMs,
    judgment: e.matched.judgment,
  };
}

/** Trivial shape transform; pinned in tests so a future change to
 * `XrPoseSnapshot` is forced through this layer. */
export function buildPoseSample(snap: XrPoseSnapshot, songTimeMs: number): PoseSample {
  return {
    songTimeMs,
    head: snap.head,
    left: snap.left,
    right: snap.right,
  };
}

/** Project the live-play `ScoreSnapshot` (from
 * `Game.tracker.snapshot()`) into the replay's `FinalSnapshot`.
 *
 * - `finalScoreNorm`: ScoreTracker's `score` is on the 0..1_000_000
 *   scale; we normalise to 0..1.
 * - `fullCombo`: mirrors `isFullCombo` from `dtx-core/scoring`
 *   (POOR === 0 && MISS === 0 && totalNotes > 0). Inlined to avoid
 *   importing for one-line semantics.
 * - `counts`: shallow-copied so a mutation on the snapshot doesn't
 *   leak through. */
export function buildFinalSnapshot(snap: ScoreSnapshot): FinalSnapshot {
  return {
    finalScoreNorm: snap.score / 1_000_000,
    comboMax: snap.maxCombo,
    fullCombo:
      snap.totalNotes > 0 && snap.counts.POOR === 0 && snap.counts.MISS === 0,
    counts: { ...snap.counts },
  };
}

/** A wired replay-capture session. Methods are bound so they can be
 * passed straight to Game's callback slots:
 *
 *   game.loadAndStart(text, { onHitProcessed: capture.onHit, ... });
 */
export interface ReplayCapture {
  /** Begin recording; clears any previous state. */
  start(meta: ChartMeta, player: PlayerSettings): void;
  /** Stop without persisting. Used for loop / leaveSong runs. */
  discard(): void;
  /** Stop and persist via `saveReplay`. Returns the new row id. */
  finish(snap: ScoreSnapshot): Promise<string>;
  /** Hook into `Game.onHitProcessed`. */
  onHit: (e: HitProcessedEvent) => void;
  /** Hook into `Game.onTickPose`. */
  onPose: (snap: XrPoseSnapshot, songTimeMs: number) => void;
}

/** Build a capture session. The autoPlayLanes set is captured by
 * reference at construction; mutating it after wiring will affect
 * subsequent hit translations (matches how `Game.autoPlayLanes`
 * works). */
export function createReplayCapture(
  autoPlayLanes: ReadonlySet<LaneValue>,
): ReplayCapture {
  let recorder: Recorder | null = null;

  return {
    start(meta: ChartMeta, player: PlayerSettings): void {
      recorder = new Recorder();
      recorder.start(meta, player);
    },
    discard(): void {
      // Drop the in-flight recording entirely; never persist.
      recorder = null;
    },
    async finish(snap: ScoreSnapshot): Promise<string> {
      if (recorder === null) {
        throw new Error('ReplayCapture.finish: called without an active recording');
      }
      const replay = recorder.finish(buildFinalSnapshot(snap));
      recorder = null;
      return saveReplay(replay);
    },
    onHit(e: HitProcessedEvent): void {
      if (recorder === null || !recorder.isRecording()) return;
      recorder.recordHit(buildHitEvent(e, autoPlayLanes));
    },
    onPose(snap: XrPoseSnapshot, songTimeMs: number): void {
      if (recorder === null || !recorder.isRecording()) return;
      recorder.recordPose(buildPoseSample(snap, songTimeMs));
    },
  };
}

// Re-export so consumers see the `Recorder` lifecycle if they want
// finer control (e.g. a future "pause recording" hook).
export { Recorder, Judgment };
