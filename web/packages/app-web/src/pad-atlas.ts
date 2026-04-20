import { Lane, type LaneValue } from '@dtxmania/input';

/**
 * Per-lane source rectangles in the 7_pads.png atlas, ported from
 * DTXMania/Code/Stage/07.Performance/DrumsScreen/CActPerfDrumsPad.cs:22-91.
 *
 * The atlas is a 4x3 grid of 96×96 pad sprites. Coordinates are in atlas
 * pixels (origin top-left); each entry's width / height is always 96.
 */
export interface PadRect {
  lane: LaneValue;
  /** atlas x in pixels */
  sx: number;
  /** atlas y in pixels */
  sy: number;
}

export const PAD_SIZE = 96;

export const PAD_ATLAS: readonly PadRect[] = [
  { lane: Lane.LC, sx: 0,   sy: 0   },
  { lane: Lane.HH, sx: 96,  sy: 0   },
  { lane: Lane.CY, sx: 192, sy: 0   },
  { lane: Lane.RD, sx: 288, sy: 0   },
  { lane: Lane.SD, sx: 0,   sy: 96  },
  { lane: Lane.HT, sx: 96,  sy: 96  },
  { lane: Lane.LT, sx: 192, sy: 96  },
  { lane: Lane.FT, sx: 288, sy: 96  },
  { lane: Lane.BD, sx: 0,   sy: 192 },
  { lane: Lane.LP, sx: 96,  sy: 192 },
] as const;

const BY_LANE = new Map<LaneValue, PadRect>(PAD_ATLAS.map((r) => [r.lane, r]));

export function padRect(lane: LaneValue): PadRect | undefined {
  return BY_LANE.get(lane);
}
