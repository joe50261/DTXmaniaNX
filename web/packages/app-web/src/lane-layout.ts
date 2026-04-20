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

/** Fixed left-to-right lane layout for MVP. Coordinates are in the 1280×720 canvas. */
export const LANE_LAYOUT: readonly LaneSpec[] = [
  { lane: Lane.LC,  label: 'LC',  x:  180, width: 70, color: '#e74c3c', voice: 'crash' },
  { lane: Lane.HH,  label: 'HH',  x:  255, width: 70, color: '#f1c40f', voice: 'hihat' },
  { lane: Lane.LP,  label: 'LP',  x:  330, width: 60, color: '#9b59b6', voice: 'kick' },
  { lane: Lane.SD,  label: 'SD',  x:  395, width: 90, color: '#ecf0f1', voice: 'snare' },
  { lane: Lane.HT,  label: 'HT',  x:  490, width: 80, color: '#3498db', voice: 'tom-hi' },
  { lane: Lane.BD,  label: 'BD',  x:  575, width: 90, color: '#2ecc71', voice: 'kick' },
  { lane: Lane.LT,  label: 'LT',  x:  670, width: 80, color: '#1abc9c', voice: 'tom-lo' },
  { lane: Lane.FT,  label: 'FT',  x:  755, width: 85, color: '#e67e22', voice: 'tom-floor' },
  { lane: Lane.CY,  label: 'CY',  x:  845, width: 90, color: '#ff6b9d', voice: 'crash' },
  { lane: Lane.RD,  label: 'RD',  x:  940, width: 80, color: '#7ed6df', voice: 'ride' },
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
