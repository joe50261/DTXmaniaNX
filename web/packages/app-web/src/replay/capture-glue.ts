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
 *  - `HitSource` is hard-coded `'xr-right'` for human input. The input
 *    pipeline merges keyboard + XR events into a generic
 *    `LaneHitEvent` before reaching `handleLaneHit`, so the originating
 *    side is lost. To distinguish hands, tag the event at the input
 *    boundary (`KeyboardInput.onLaneHit` / `XrControllers.onHit`).
 */

import { Recorder, type ChartMeta, type FinalSnapshot, type HitEvent, type PlayerSettings, type PoseSample } from './recorder-model.js';
import { saveReplay } from './storage.js';
import { Judgment, type ScoreSnapshot } from '@dtxmania/dtx-core';
import type { LaneValue } from '@dtxmania/input';
import type { HitProcessedEvent } from '../game.js';
import type { XrPoseSnapshot } from '../xr-controllers.js';

/** Translate a Game `HitProcessedEvent` into the replay schema's
 * `HitEvent`. Three flavours, distinguished by `e.matched`:
 *  - `matched === null` → stray (chipIndex=-1, lagMs=null, judgment=MISS placeholder).
 *  - `matched.deltaMs === null` → auto-detected miss (source='auto', judgment=MISS).
 *  - `matched.deltaMs !== null` → human input matched a chip; source is
 *    'auto' if the lane is on autoplay (defensive — autoplay-lane hits
 *    don't currently reach this path), else 'xr-right' placeholder.
 *
 * `autoPlayLanes` is a snapshot at recording start; live changes
 * mid-run aren't reflected — matches how `Game.autoPlayLanes` is set
 * once per loadAndStart. */
export function buildHitEvent(
  _e: HitProcessedEvent,
  _autoPlayLanes: ReadonlySet<LaneValue>,
): HitEvent {
  throw new Error('buildHitEvent: not implemented');
}

/** Trivial shape transform; pinned in tests so a future change to
 * `XrPoseSnapshot` is forced through this layer. */
export function buildPoseSample(_snap: XrPoseSnapshot, _songTimeMs: number): PoseSample {
  throw new Error('buildPoseSample: not implemented');
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
export function buildFinalSnapshot(_snap: ScoreSnapshot): FinalSnapshot {
  throw new Error('buildFinalSnapshot: not implemented');
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
  _autoPlayLanes: ReadonlySet<LaneValue>,
): ReplayCapture {
  throw new Error('createReplayCapture: not implemented');
}

// Re-export so consumers see the `Recorder` lifecycle if they want
// finer control (e.g. a future "pause recording" hook).
export { Recorder, Judgment };
