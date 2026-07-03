/**
 * Pure timeline / mixing decisions for the replay → video render path.
 *
 * The offline render (replay/render.ts + replay/render-audio-offline.ts)
 * runs FASTER THAN REAL TIME, so wall-clock `performance.now()` is NOT a
 * usable animation clock there — the only monotone axis is the chart's own
 * `songTimeMs`. The view modules (`renderer.ts`, `xr-controllers.ts`) were
 * written for live play where `performance.now()` ≈ song time, so the
 * render path has to feed them song-time values instead. The non-obvious
 * decisions that follow from that are extracted here so they can be unit
 * tested without a WebGL/canvas context (see `web/CLAUDE.md` → "Test the
 * model, not the view").
 */

import type { HitEvent, PoseSample } from './recorder-model.js';

/**
 * Did the auto-play engine fire this hit (as opposed to a human/controller
 * strike)? Genuinely auto-fired chips are captured with `source: 'auto'`
 * AND a `null` lag (there is no input-to-chip delta). A human strike that
 * happens to land on an auto-play lane is also tagged `'auto'` defensively
 * but keeps a numeric lag, so the null-lag check is what isolates a real
 * auto-fire. See `replay/capture-glue.ts`.
 */
export function isAutoFiredHit(hit: Pick<HitEvent, 'source' | 'lagMs'>): boolean {
  return hit.source === 'auto' && hit.lagMs === null;
}

/**
 * Per-hit playback gain multiplier for the offline mix, mirroring the live
 * game: auto-fired chips play at full volume (`Game.autoFireLanes` passes
 * 1.0) while manual strikes are attenuated to 0.7 (`Game.handleLaneHit`).
 * The chip's own `wavTable` volume is applied on top of this by the caller.
 * Without this split, auto-play / demo replays render every drum 30 %
 * quieter than they sounded live.
 */
export function hitPlaybackVolumeMult(hit: Pick<HitEvent, 'source' | 'lagMs'>): number {
  return isAutoFiredHit(hit) ? 1 : 0.7;
}

/**
 * Clamp a render-frame song time to the recorded pose range so the ghost
 * hands / head proxy hold their final sample through the result-screen tail
 * instead of vanishing. Pose capture stops ~500 ms after the chart ends
 * (`SONG_END_TAIL_MS`), but the video render keeps going for a 6 s tail; an
 * unclamped query past the last sample makes `lerpPoseSample` return null,
 * which hides the avatar for those ~5.5 s. An empty pose stream (desktop
 * capture) is returned unchanged. Times before the first sample are left
 * alone — the avatar is correctly absent before play begins.
 */
export function clampToPoseRange(songTimeMs: number, poses: readonly PoseSample[]): number {
  if (poses.length === 0) return songTimeMs;
  const last = poses[poses.length - 1]!.songTimeMs;
  return songTimeMs > last ? last : songTimeMs;
}

/**
 * Stamp the song-relative time of the playing → finished transition exactly
 * ONCE and hold it thereafter. The result-screen fade derives its age from
 * this value; in the offline render the song time is the only monotone
 * clock. The original bug re-stamped `finishedAtMs` with `performance.now()`
 * on every finished frame, which pinned the fade age to ~0 so the RESULTS
 * overlay (rank, score, counts, badge) rendered at ~0 % opacity for the
 * whole tail — invisible. Passing `prev` back in each frame keeps the first
 * stamp stable.
 */
export function stampFinishedAtSongMs(
  prev: number | null,
  songTimeMs: number,
  finished: boolean,
): number | null {
  if (prev !== null) return prev;
  return finished ? songTimeMs : null;
}
