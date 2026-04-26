/**
 * Playfield layout — lane-flush asset map + sprite geometry.
 *
 * Pure data, no THREE / DOM / view imports. Source of truth:
 * `playfield-design.md` (mirroring `CActPerfDrumsLaneFlushD.cs`).
 */

import { Lane, type LaneValue } from '@dtxmania/input';

/** Sprite cell width (px) for a single lane-flush frame in the
 *  ScreenPlayDrums lane-flush PNGs. */
export const LANE_FLUSH_FRAME_W = 42;

/** Sprite height (px) — full lane height in the source asset. */
export const LANE_FLUSH_FRAME_H = 128;

/** Number of horizontal animation frames inside each PNG. */
export const LANE_FLUSH_FRAME_COUNT = 3;

/** Lifetime of a single lane-flush after a hit, in ms. The streak
 *  travels from the bottom of the playfield to the top inside this
 *  window; the alpha fades to 0 at the same time. */
export const LANE_FLUSH_LIFETIME_MS = 500;

/** Frame cycle period — animation frames advance every N ms.
 *  At ~60 fps this is one frame per render tick. */
export const LANE_FLUSH_FRAME_PERIOD_MS = 16;

/** Total y-distance the streak travels during its lifetime,
 *  matched to the C# `(counter × 740 / 100)` term. */
export const LANE_FLUSH_TRAVEL_PX = 740;

/** Per-lane forward asset filenames. Pinned to
 *  `CActPerfDrumsLaneFlushD.cs` lines 63-72. */
export const LANE_FLUSH_ASSET_FORWARD: Record<LaneValue, string> = {
  [Lane.LC]: 'ScreenPlayDrums lane flush leftcymbal.png',
  [Lane.HH]: 'ScreenPlayDrums lane flush hihat.png',
  // HHO shares the HH visual lane (per `channelToLane` in
  // lane-layout.ts), so it shares the asset too.
  [Lane.HHO]: 'ScreenPlayDrums lane flush hihat.png',
  [Lane.LP]: 'ScreenPlayDrums lane flush leftpedal.png',
  [Lane.SD]: 'ScreenPlayDrums lane flush snare.png',
  [Lane.HT]: 'ScreenPlayDrums lane flush hitom.png',
  [Lane.BD]: 'ScreenPlayDrums lane flush bass.png',
  [Lane.LT]: 'ScreenPlayDrums lane flush lowtom.png',
  [Lane.FT]: 'ScreenPlayDrums lane flush floortom.png',
  [Lane.CY]: 'ScreenPlayDrums lane flush cymbal.png',
  // C# CActPerfDrumsLaneFlushD references `ridecymbal.png` but the
  // bundled skin only ships `cymbal.png`. Falling back to cymbal so
  // the RD lane still gets a visual flush rather than a 404.
  [Lane.RD]: 'ScreenPlayDrums lane flush cymbal.png',
  // LBD shares the BD asset for visual continuity (the web port
  // displays LBD chips in the BD lane already — see lane-layout.ts).
  [Lane.LBD]: 'ScreenPlayDrums lane flush bass.png',
};

/** Convenience: the unique set of forward-flush filenames the loader
 *  has to fetch. LBD/BD share, so the actual fetch list is 10. */
export const LANE_FLUSH_FORWARD_FILES: readonly string[] =
  Array.from(new Set(Object.values(LANE_FLUSH_ASSET_FORWARD)));

/** Resolve the asset filename for a lane. Returns null if the
 *  passed value isn't a known LaneValue (defensive — so callers
 *  don't have to narrow). */
export function laneFlushAsset(lane: LaneValue): string | null {
  return LANE_FLUSH_ASSET_FORWARD[lane] ?? null;
}
