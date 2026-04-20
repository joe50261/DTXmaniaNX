/**
 * Resolution of one measure. Matches CDTX.cs `n小節の解像度 = 384`.
 * All tick offsets inside a measure are in the range [0, MEASURE_TICKS).
 */
export const MEASURE_TICKS = 384;

export interface Chip {
  /** Raw channel number as it appears in the DTX file (decimal of the hex pair). */
  channel: number;
  /** 0-based measure index (DTX `#MMM` is zero-padded 3 digits). */
  measure: number;
  /** Tick offset inside the measure, 0..MEASURE_TICKS-1. */
  tick: number;
  /** wavId (1..36^2-1, zz-encoded). Set for sound-producing chips; undefined otherwise. */
  wavId?: number;
  /** BPM table id for BPMChangeExtended (channel 0x08) chips. */
  bpmId?: number;
  /** Direct BPM value for BPMChange (channel 0x03) chips. */
  rawBpm?: number;
  /** Absolute playback time in ms from song start, filled in by the timing pass. */
  playbackTimeMs: number;
}

export interface WavDef {
  /** zz id, 1..(36^2)-1 */
  id: number;
  /** Relative path (resolved against song directory). */
  path: string;
  /** Volume 0..100. Defaults to 100. */
  volume: number;
  /** Pan -100..+100. Defaults to 0. */
  pan: number;
}

export interface Song {
  title: string;
  artist: string;
  genre: string;
  comment: string;

  /** #BPM (main, starting BPM). */
  baseBpm: number;
  /**
   * #BASEBPM, added to every channel-0x03 BPM-change value. Defaults to 0
   * (so channel 0x03 effectively sets absolute BPM 0..255).
   */
  basebpmOffset: number;
  /** #BPMxx values keyed by xx id. */
  bpmTable: Map<number, number>;
  /** #WAVxx definitions. */
  wavTable: Map<number, WavDef>;

  /** #DLEVEL, 0..1000. */
  drumLevel: number;
  panel: string;
  preview: string;
  preimage: string;
  stageFile: string;
  background: string;

  /** All parsed chips, sorted by playbackTimeMs after the timing pass. */
  chips: Chip[];

  /** Total song duration in ms (last chip's time, or last measure end). */
  durationMs: number;
}

export function createEmptySong(): Song {
  return {
    title: '',
    artist: '',
    genre: '',
    comment: '',
    baseBpm: 120,
    basebpmOffset: 0,
    bpmTable: new Map(),
    wavTable: new Map(),
    drumLevel: 0,
    panel: '',
    preview: '',
    preimage: '',
    stageFile: '',
    background: '',
    chips: [],
    durationMs: 0,
  };
}
