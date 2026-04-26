/**
 * Chip-fire layout — per-lane asset map + sprite geometry. Pure
 * data; no THREE / DOM. Source of truth: `chip-fire-design.md`
 * (mirroring `CActPerfDrumsChipFireD.cs` lines 391-436).
 */

import { Lane, type LaneValue } from '@dtxmania/input';

/** Source PNG dimensions. Each asset is a single-frame 128×128
 *  sprite — no atlas slicing. */
export const CHIP_FIRE_SPRITE_W = 128;
export const CHIP_FIRE_SPRITE_H = 128;

/** Total burst lifetime — 70 frames × 3 ms in C#. */
export const CHIP_FIRE_LIFETIME_MS = 210;

/** Scale multiplier the sprite reaches at end-of-life. The base
 *  scale is 1.0; the sprite grows linearly to this value. */
export const CHIP_FIRE_END_SCALE = 1.4;

/** Per-lane fire filename. RD and LBD share CY/BD respectively
 *  because the bundled skin omits dedicated assets — see
 *  `chip-fire-design.md`. */
export const CHIP_FIRE_ASSET: Record<LaneValue, string> = {
  [Lane.LC]: 'ScreenPlayDrums chip fire_LC.png',
  [Lane.HH]: 'ScreenPlayDrums chip fire_HH.png',
  [Lane.HHO]: 'ScreenPlayDrums chip fire_HH.png',
  [Lane.LP]: 'ScreenPlayDrums chip fire_LP.png',
  [Lane.SD]: 'ScreenPlayDrums chip fire_SD.png',
  [Lane.HT]: 'ScreenPlayDrums chip fire_HT.png',
  [Lane.BD]: 'ScreenPlayDrums chip fire_BD.png',
  [Lane.LBD]: 'ScreenPlayDrums chip fire_BD.png',
  [Lane.LT]: 'ScreenPlayDrums chip fire_LT.png',
  [Lane.FT]: 'ScreenPlayDrums chip fire_FT.png',
  [Lane.CY]: 'ScreenPlayDrums chip fire_CY.png',
  // Bundled skin has no chip fire_RD.png → reuse CY's asset.
  [Lane.RD]: 'ScreenPlayDrums chip fire_CY.png',
};

/** Unique fetch list — duplicates collapsed. */
export const CHIP_FIRE_FILES: readonly string[] = Array.from(
  new Set(Object.values(CHIP_FIRE_ASSET))
);

/** Resolve filename for a lane. Returns null on unknown values. */
export function chipFireAsset(lane: LaneValue): string | null {
  return CHIP_FIRE_ASSET[lane] ?? null;
}
