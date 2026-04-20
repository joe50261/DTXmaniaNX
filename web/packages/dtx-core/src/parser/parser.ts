import { Channel, isBpmChange } from '../model/channel.js';
import { MEASURE_TICKS, createEmptySong, type Chip, type Song, type WavDef } from '../model/chip.js';
import { decodeZz } from './zz.js';

/**
 * DTX text-file parser.
 *
 * The DTX format (DTXMania's own) is a superset/variant of BMS. Lines either
 * declare metadata (`#TITLE Foo`), declare indexed resources (`#WAV0A file.wav`,
 * `#BPM03 145`), or embed chip data for one measure + channel
 * (`#001_11: 01000200` = measure 0, channel 0x11, eight half-sixteenth slots).
 *
 * Ported from CDTX.cs:4789-6569, scoped down to DTX + drums v1.
 */

export interface ParseOptions {
  /** If true, channels this parser does not recognize are silently dropped. Default true. */
  ignoreUnknownChannels?: boolean;
}

const DEFAULT_OPTIONS: Required<ParseOptions> = {
  ignoreUnknownChannels: true,
};

/** Regex for `#MMMCC:DATA` chip lines. MMM=3 digits 0-9, CC=2 hex chars. */
const CHIP_LINE = /^#(\d{3})([0-9A-Fa-f]{2}):?\s*([^;]*?)(?:;.*)?$/;

/** Regex for metadata/resource commands, e.g. `#TITLE value` or `#WAV0A path`. */
const COMMAND_LINE = /^#([A-Za-z_][A-Za-z0-9_]*?)(?:\s+|:\s*)(.*?)(?:\s*;.*)?$/;

export function parseDtx(text: string, options: ParseOptions = {}): Song {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const song = createEmptySong();

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = stripBOM(rawLine).trim();
    if (line.length === 0 || !line.startsWith('#')) continue;

    const chipMatch = CHIP_LINE.exec(line);
    if (chipMatch) {
      const payload = (chipMatch[3] ?? '').replace(/\s+/g, '');
      if (/^[0-9A-Za-z]*$/.test(payload)) {
        ingestChipLine(song, chipMatch, opts);
        continue;
      }
    }

    const cmdMatch = COMMAND_LINE.exec(line);
    if (cmdMatch) {
      ingestCommand(song, cmdMatch[1]!.toUpperCase(), cmdMatch[2] ?? '');
    }
  }

  return song;
}

function stripBOM(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function ingestChipLine(song: Song, match: RegExpExecArray, opts: Required<ParseOptions>): void {
  const measure = parseInt(match[1]!, 10);
  const channel = parseInt(match[2]!, 16);
  const data = (match[3] ?? '').replace(/\s+/g, '');
  if (data.length === 0 || data.length % 2 !== 0) return;

  const knownChannel = isKnownChannel(channel);
  if (!knownChannel && opts.ignoreUnknownChannels) return;

  const slots = data.length / 2;
  const tickStep = MEASURE_TICKS / slots;

  // Channel 0x03 (direct BPM change) is parsed as 2-digit *hex* (0..255).
  // Every other channel is parsed as 2-digit base-36 (zz id 0..1295).
  // See CDTX.cs:6856-6865.
  const parsePair = channel === Channel.BPMChange ? parseHexPair : decodeZz;

  for (let i = 0; i < slots; i++) {
    const pair = data.slice(i * 2, i * 2 + 2);
    if (pair === '00') continue;
    const value = parsePair(pair);

    const chip: Chip = {
      channel,
      measure,
      tick: Math.round(i * tickStep),
      playbackTimeMs: 0,
    };

    if (channel === Channel.BPMChangeExtended) {
      chip.bpmId = value;
    } else if (channel === Channel.BPMChange) {
      chip.rawBpm = value;
    } else {
      chip.wavId = value;
    }

    song.chips.push(chip);
  }
}

function parseHexPair(pair: string): number {
  const n = parseInt(pair, 16);
  if (!Number.isFinite(n)) {
    throw new Error(`invalid hex pair: ${JSON.stringify(pair)}`);
  }
  return n;
}

const KNOWN_CHANNELS: ReadonlySet<number> = new Set<number>([
  Channel.BGM,
  Channel.BarLength,
  Channel.BPMChange,
  Channel.BPMChangeExtended,
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
  Channel.BarLine,
  Channel.BeatLine,
]);

function isKnownChannel(channel: number): boolean {
  return KNOWN_CHANNELS.has(channel);
}

function ingestCommand(song: Song, name: string, value: string): void {
  const trimmed = value.trim();

  switch (name) {
    case 'TITLE': song.title = trimmed; return;
    case 'ARTIST': song.artist = trimmed; return;
    case 'GENRE': song.genre = trimmed; return;
    case 'COMMENT': song.comment = trimmed; return;
    case 'PANEL': song.panel = trimmed; return;
    case 'PREVIEW': song.preview = trimmed; return;
    case 'PREIMAGE': song.preimage = trimmed; return;
    case 'STAGEFILE': song.stageFile = trimmed; return;
    case 'BACKGROUND':
    case 'WALL': song.background = trimmed; return;
    case 'BPM': {
      const n = parseFloat(trimmed);
      if (Number.isFinite(n) && n > 0) song.baseBpm = n;
      return;
    }
    case 'BASEBPM': {
      const n = parseFloat(trimmed);
      if (Number.isFinite(n)) song.basebpmOffset = n;
      return;
    }
    case 'DLEVEL': {
      const n = parseInt(trimmed, 10);
      if (Number.isFinite(n)) song.drumLevel = n;
      return;
    }
  }

  const wavMatch = /^WAV([0-9A-Za-z]{2})$/.exec(name);
  if (wavMatch) {
    const id = decodeZz(wavMatch[1]!);
    upsertWav(song, id, { path: trimmed });
    return;
  }

  const volMatch = /^(?:WAVVOL|VOLUME)([0-9A-Za-z]{2})$/.exec(name);
  if (volMatch) {
    const id = decodeZz(volMatch[1]!);
    const vol = clamp(parseInt(trimmed, 10), 0, 100);
    upsertWav(song, id, { volume: vol });
    return;
  }

  const panMatch = /^(?:WAVPAN|PAN)([0-9A-Za-z]{2})$/.exec(name);
  if (panMatch) {
    const id = decodeZz(panMatch[1]!);
    const pan = clamp(parseInt(trimmed, 10), -100, 100);
    upsertWav(song, id, { pan });
    return;
  }

  const bpmMatch = /^BPM([0-9A-Za-z]{2})$/.exec(name);
  if (bpmMatch) {
    const id = decodeZz(bpmMatch[1]!);
    const v = parseFloat(trimmed);
    if (Number.isFinite(v) && v > 0) song.bpmTable.set(id, v);
    return;
  }
}

function upsertWav(song: Song, id: number, patch: Partial<Omit<WavDef, 'id'>>): void {
  const existing = song.wavTable.get(id);
  if (existing) {
    Object.assign(existing, patch);
  } else {
    song.wavTable.set(id, {
      id,
      path: patch.path ?? '',
      volume: patch.volume ?? 100,
      pan: patch.pan ?? 0,
    });
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

// Re-exported for convenience / debugging.
export { isBpmChange };
