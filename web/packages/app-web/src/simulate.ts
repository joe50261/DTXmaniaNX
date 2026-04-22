import type { ScoreSnapshot, Song } from '@dtxmania/dtx-core';
import { Judgment, ScoreTracker } from '@dtxmania/dtx-core';
import type { LaneValue } from '@dtxmania/input';
import { applyAutoFire, type AutoFireCandidate } from './autofire.js';
import { channelToLane } from './lane-layout.js';
import { detectMisses, matchLaneHit, type MatchCandidate } from './matcher.js';

/**
 * A pre-planned keystroke at a specific song time. Test harnesses
 * build an array of these to drive a chart headlessly — no renderer,
 * no audio, no input device required.
 */
export interface ScriptedHit {
  lane: LaneValue;
  /** Press time in song ms (same timebase as chip.playbackTimeMs). */
  timeMs: number;
}

export interface SimulateOptions {
  autoLanes?: Set<LaneValue>;
  scripted?: readonly ScriptedHit[];
  /** Player-calibrated latency offset in ms. Passed through to
   * matchLaneHit, same as Game pulls from loadAudioOffsetMs(). */
  offsetMs?: number;
  /** Simulated tick period (ms). Default 16 ≈ 60 fps. Smaller = more
   * precise miss-window timing at the cost of CPU. */
  tickStepMs?: number;
}

/**
 * Drive a chart through to completion without a renderer or audio
 * engine. Reproduces the pure-state parts of Game.tick / handleLaneHit:
 *
 *   1. Build playables by filtering song.chips through channelToLane
 *      (matches what Game.loadAndStart does).
 *   2. For each tick:
 *        - Fire scripted keystrokes whose timeMs has landed.
 *        - Run applyAutoFire for any auto-lanes.
 *        - Run detectMisses for anyone whose POOR window expired.
 *   3. Return the final ScoreTracker snapshot.
 *
 * Stray-hit audio, hit-flashes, gauge, judgment flashes — all the UI
 * side effects — are left out because they don't affect scoring. If a
 * test needs them, raise the signal via additional return fields.
 */
export function simulatePlaythrough(song: Song, options: SimulateOptions = {}): ScoreSnapshot {
  const autoLanes = options.autoLanes ?? new Set<LaneValue>();
  const scripted = options.scripted ?? [];
  const offsetMs = options.offsetMs ?? 0;
  const tickStepMs = options.tickStepMs ?? 16;

  // Combined candidate array — PlayableChip's shape is a superset of
  // both MatchCandidate and AutoFireCandidate, so one array feeds both
  // helpers without copies.
  const playables: (MatchCandidate & AutoFireCandidate)[] = [];
  for (const chip of song.chips) {
    const lane = channelToLane(chip.channel);
    if (!lane) continue;
    playables.push({ chip, laneValue: lane.lane, hit: false, missed: false });
  }
  const tracker = new ScoreTracker(playables.length);

  // Scripts processed in time order so a pending index advances
  // monotonically — O(n) total across the whole run.
  const scripts = [...scripted].sort((a, b) => a.timeMs - b.timeMs);
  let scriptIdx = 0;

  const endTime = song.durationMs + 500;
  for (let songTime = 0; songTime <= endTime; songTime += tickStepMs) {
    // 1. Scripted keystrokes. Press time is the script's own timeMs so
    // the delta math matches what a real press at that moment would
    // produce; songTime is just the tick the delivery landed on.
    while (scriptIdx < scripts.length && scripts[scriptIdx]!.timeMs <= songTime) {
      const ks = scripts[scriptIdx]!;
      const m = matchLaneHit(playables, ks.lane, ks.timeMs, offsetMs);
      if (m !== null) tracker.record(m.judgment);
      scriptIdx++;
    }
    // 2. Auto-fire.
    const autoEvents = applyAutoFire(playables, autoLanes, songTime);
    for (let i = 0; i < autoEvents.length; i++) tracker.recordAuto();
    // 3. Miss detection.
    const missEvents = detectMisses(playables, songTime);
    for (let i = 0; i < missEvents.length; i++) tracker.record(Judgment.MISS);
  }

  return tracker.snapshot();
}

/**
 * Helper: build a perfect-timing script for all chips of the given
 * lanes. Useful as "scripted player plays everything perfectly on
 * selected lanes, nothing on others".
 */
export function perfectScriptFor(song: Song, lanes: Set<LaneValue>): ScriptedHit[] {
  const out: ScriptedHit[] = [];
  for (const chip of song.chips) {
    const lane = channelToLane(chip.channel);
    if (!lane) continue;
    if (!lanes.has(lane.lane)) continue;
    out.push({ lane: lane.lane, timeMs: chip.playbackTimeMs });
  }
  return out;
}
