/**
 * Playfield animations — pure helpers for the lane-flush overlay.
 *
 * Mirrors `CActPerfDrumsLaneFlushD.OnUpdateAndDraw` (lines 395-422)
 * but reformulated against `lastPadHitMs[lane]` (the renderer
 * already tracks this) instead of the C# per-lane progress
 * counters. No THREE / DOM imports.
 */

import {
  LANE_FLUSH_FRAME_COUNT,
  LANE_FLUSH_FRAME_PERIOD_MS,
  LANE_FLUSH_LIFETIME_MS,
  LANE_FLUSH_TRAVEL_PX,
} from './playfield-layout.js';

export interface LaneFlushFrame {
  /** True when the streak is no longer visible (past lifetime). */
  expired: boolean;
  /** 0..1 progress through the streak's lifetime. */
  progress: number;
  /** y of the streak's top edge in canvas px. Streak rides up off
   *  the bottom of the playfield as `progress` grows. Returned
   *  relative to the canvas top (0 = top edge). */
  y: number;
  /** 0..1 alpha for the draw call. Linear fade-out matched to the
   *  C# `nTransparency = num8` term. */
  alpha: number;
  /** 0..LANE_FLUSH_FRAME_COUNT-1 — which animation frame to sample
   *  from the source PNG. */
  frame: number;
}

/**
 * Resolve the lane-flush draw state at `nowMs`, given the timestamp
 * of the most recent hit in this lane. Returns `expired: true` if
 * the streak is no longer visible (the canvas should skip the draw
 * call entirely). The caller is expected to early-out on `expired`
 * for performance.
 *
 * The streak starts at the bottom of the playfield (y near canvas
 * height) and rides up until it leaves the top edge. Alpha decays
 * linearly so the streak fades as it climbs.
 */
export function laneFlushFrame(
  nowMs: number,
  lastHitMs: number,
  canvasHeight: number
): LaneFlushFrame {
  const t = nowMs - lastHitMs;
  if (!Number.isFinite(t) || t < 0 || t >= LANE_FLUSH_LIFETIME_MS) {
    return { expired: true, progress: 1, y: 0, alpha: 0, frame: 0 };
  }
  const progress = t / LANE_FLUSH_LIFETIME_MS;
  const y = canvasHeight - progress * LANE_FLUSH_TRAVEL_PX;
  const alpha = 1 - progress;
  const frame = flushFrameIndex(t);
  return { expired: false, progress, y, alpha, frame };
}

/** Pure helper for the cycling animation frame index. Public so
 *  tests can pin the cycle math without spinning up a canvas. */
export function flushFrameIndex(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 0;
  const tick = Math.floor(elapsedMs / LANE_FLUSH_FRAME_PERIOD_MS);
  return ((tick % LANE_FLUSH_FRAME_COUNT) + LANE_FLUSH_FRAME_COUNT) % LANE_FLUSH_FRAME_COUNT;
}
