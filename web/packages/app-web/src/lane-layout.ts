import { Lane, type LaneValue } from '@dtxmania/input';
import type { DrumVoice } from '@dtxmania/audio-engine';

export interface LaneSpec {
  lane: LaneValue;
  label: string;
  x: number;
  width: number;
  color: string;
  voice: DrumVoice;
}

// Lane x coordinates ported from CActPerfDrumsPad.cs:22-91 (DTXMania Type A).
// Per-lane widths are variable (LC + BD + CY are visibly wider than the
// HH / LP / tom columns) — matches DTXmania's chip atlas spacing and
// gives the playfield its recognisable lane pattern. Widths picked to
// fit between adjacent lane.x values with a small gap; tweaking only
// the width column avoids re-doing all hit-detection geometry.
export const LANE_LAYOUT: readonly LaneSpec[] = [
  { lane: Lane.LC, label: 'LC', x: 263, width: 66, color: '#e74c3c', voice: 'crash' },
  { lane: Lane.HH, label: 'HH', x: 336, width: 46, color: '#f1c40f', voice: 'hihat' },
  { lane: Lane.LP, label: 'LP', x: 388, width: 48, color: '#9b59b6', voice: 'kick' },
  { lane: Lane.SD, label: 'SD', x: 446, width: 54, color: '#ecf0f1', voice: 'snare' },
  { lane: Lane.HT, label: 'HT', x: 510, width: 46, color: '#3498db', voice: 'tom-hi' },
  { lane: Lane.BD, label: 'BD', x: 565, width: 50, color: '#2ecc71', voice: 'kick' },
  { lane: Lane.LT, label: 'LT', x: 622, width: 46, color: '#1abc9c', voice: 'tom-lo' },
  { lane: Lane.FT, label: 'FT', x: 672, width: 46, color: '#e67e22', voice: 'tom-floor' },
  { lane: Lane.CY, label: 'CY', x: 735, width: 50, color: '#ff6b9d', voice: 'crash' },
  { lane: Lane.RD, label: 'RD', x: 791, width: 48, color: '#7ed6df', voice: 'ride' },
] as const;

const BY_LANE = new Map<LaneValue, LaneSpec>(LANE_LAYOUT.map((s) => [s.lane, s]));

export function laneSpec(lane: LaneValue): LaneSpec | undefined {
  return BY_LANE.get(lane);
}

/**
 * Maps a DTX channel number to the LaneSpec we display for it.
 * Some channels (HHO, LBD) share a visual lane with another (HH, BD).
 */
export function channelToLane(channel: number): LaneSpec | undefined {
  switch (channel) {
    case 0x11: return BY_LANE.get(Lane.HH);
    case 0x18: return BY_LANE.get(Lane.HH);      // HiHat open shares HH lane visually
    case 0x12: return BY_LANE.get(Lane.SD);
    case 0x13: return BY_LANE.get(Lane.BD);
    case 0x1c: return BY_LANE.get(Lane.BD);      // Left BD shares BD lane visually
    case 0x14: return BY_LANE.get(Lane.HT);
    case 0x15: return BY_LANE.get(Lane.LT);
    case 0x17: return BY_LANE.get(Lane.FT);
    case 0x16: return BY_LANE.get(Lane.CY);
    case 0x19: return BY_LANE.get(Lane.RD);
    case 0x1a: return BY_LANE.get(Lane.LC);
    case 0x1b: return BY_LANE.get(Lane.LP);
    default: return undefined;
  }
}

/** Voice used for the auto-played BGM trigger chips (channel 0x01). Silent by default in MVP. */
export const BGM_VOICE: DrumVoice | null = null;
