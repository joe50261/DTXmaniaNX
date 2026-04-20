/**
 * DTX channel codes. Values match the decimal equivalents of the two-character
 * hex channel codes used in `#MMMCC:...` data lines (e.g. "11" hex = 17 dec = HiHatClose).
 *
 * Ported from DTXMania/Code/Score,Song/EChannel.cs. Only the channels that v1
 * actually handles are named; everything else is left as a numeric literal if
 * encountered by the parser.
 */
export const Channel = {
  Invalid: -1,
  Nil: 0,

  // Control channels
  BGM: 1,
  BarLength: 2,
  BPMChange: 3,
  BPMChangeExtended: 8,

  // Drum lanes (0x11..0x1C)
  HiHatClose: 0x11,
  Snare: 0x12,
  BassDrum: 0x13,
  HighTom: 0x14,
  LowTom: 0x15,
  Cymbal: 0x16,
  FloorTom: 0x17,
  HiHatOpen: 0x18,
  RideCymbal: 0x19,
  LeftCymbal: 0x1a,
  LeftPedal: 0x1b,
  LeftBassDrum: 0x1c,

  // Visual-only channels v1 tolerates but does not render
  BarLine: 0x50,
  BeatLine: 0x51,
  Movie: 0x54,
} as const;

export type ChannelValue = (typeof Channel)[keyof typeof Channel];

const DRUM_LANES: ReadonlySet<number> = new Set([
  Channel.HiHatClose,
  Channel.Snare,
  Channel.BassDrum,
  Channel.HighTom,
  Channel.LowTom,
  Channel.Cymbal,
  Channel.FloorTom,
  Channel.HiHatOpen,
  Channel.RideCymbal,
  Channel.LeftCymbal,
  Channel.LeftPedal,
  Channel.LeftBassDrum,
]);

export function isDrumLane(channel: number): boolean {
  return DRUM_LANES.has(channel);
}

export function isBpmChange(channel: number): boolean {
  return channel === Channel.BPMChange || channel === Channel.BPMChangeExtended;
}
