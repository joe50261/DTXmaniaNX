import { Lane, type LaneValue } from '@dtxmania/input';

/**
 * Per-lane source rectangles in 7_chips_drums.png.
 *
 * Ported from
 * DTXMania/Code/Stage/07.Performance/DrumsScreen/CActPerfDrumsChipFireD.cs:1071-1072
 * (the `nノーツの左上X座標` / `nノーツの幅` arrays). All chips share atlas y=640
 * and height 64, so we only store the per-lane x and width.
 */
export interface ChipRect {
  lane: LaneValue;
  sx: number;
  sw: number;
}

export const CHIP_ATLAS_Y = 640;
export const CHIP_ATLAS_H = 64;

export const CHIP_ATLAS: readonly ChipRect[] = [
  { lane: Lane.LC, sx: 538, sw: 64 },
  { lane: Lane.HH, sx: 70,  sw: 46 },
  { lane: Lane.SD, sx: 126, sw: 54 },
  { lane: Lane.BD, sx: 0,   sw: 60 },
  { lane: Lane.HT, sx: 190, sw: 46 },
  { lane: Lane.LT, sx: 246, sw: 46 },
  { lane: Lane.FT, sx: 302, sw: 46 },
  { lane: Lane.CY, sx: 358, sw: 60 },
  { lane: Lane.LP, sx: 660, sw: 48 },
  { lane: Lane.RD, sx: 432, sw: 48 },
] as const;

const BY_LANE = new Map<LaneValue, ChipRect>(CHIP_ATLAS.map((r) => [r.lane, r]));

export function chipRect(lane: LaneValue): ChipRect | undefined {
  return BY_LANE.get(lane);
}
