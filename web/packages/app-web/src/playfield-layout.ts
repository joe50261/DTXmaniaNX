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

// --- 7_Paret.png lane chrome (kick footprint pattern) ----------------

/**
 * `7_Paret.png` is the canonical *permanent* lane background. It
 * contains a repeating footprint pattern in the BD / LP slices —
 * the foot-pedal lanes get a stamped-footprint motif that's drawn
 * every frame regardless of hit state. Other slices are vertical
 * separator bars + lane tinting.
 *
 * Source asset: `7_Paret.png` (558 × 720). Per-lane slices pinned
 * to `CActPerfDrumsLaneFlushD.cs:189-298` (Type A layout — the
 * web port locks to Type A for now).
 *
 * The slices are drawn at the C# destination X for the canonical
 * 1280×720 grid; web port re-anchors each slice to the lane
 * centre from `lane-layout.ts` so the footprint pattern lines up
 * with the chip stream regardless of lane-position drift.
 */
export interface ParetSlice {
  /** Source rect in `7_Paret.png`. */
  sx: number;
  sw: number;
  /** Source y / h are always 0 / 720 — the slice is full-height. */
}

/** Per-lane slice metadata. The keys are LaneValue numerics so the
 *  paint loop can index by `spec.lane` directly. */
export const PARET_LANE_SLICE: Partial<Record<LaneValue, ParetSlice>> = {
  [Lane.LC]: { sx: 0,   sw: 72 },  // left bar / LC
  [Lane.HH]: { sx: 72,  sw: 49 },  // HH
  [Lane.HHO]: { sx: 72, sw: 49 },  // HHO shares HH visual
  [Lane.LP]: { sx: 121, sw: 51 },  // left pedal — *footprint pattern*
  [Lane.SD]: { sx: 172, sw: 57 },  // snare
  [Lane.HT]: { sx: 229, sw: 49 },  // hi-tom
  [Lane.BD]: { sx: 278, sw: 69 },  // bass drum — *footprint pattern*
  [Lane.LBD]: { sx: 278, sw: 69 }, // LBD shares BD slice
  [Lane.LT]: { sx: 347, sw: 49 },  // low tom
  [Lane.FT]: { sx: 396, sw: 54 },  // floor tom
  [Lane.CY]: { sx: 450, sw: 70 },  // crash
  [Lane.RD]: { sx: 520, sw: 38 },  // ride
};

/** Source asset height (full lane chrome covers the playfield). */
export const PARET_SRC_H = 720;

/** Source filename — included in STAGE7_ALLOWLIST in vite.config.ts. */
export const PARET_ASSET = '7_Paret.png';
