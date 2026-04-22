import { Channel } from '../model/channel.js';
import { MEASURE_TICKS, type Chip, type Song } from '../model/chip.js';

/**
 * Fills in `chip.playbackTimeMs` for every chip in the song, sorts chips
 * chronologically, and sets `song.durationMs`.
 *
 * Algorithm: walk chips in (measure, tick) order with a running `currentBpm`.
 * Each tick advanced adds `(deltaTicks / MEASURE_TICKS) * measureMs(currentBpm)`
 * to the accumulated time. BPM changes apply *after* the chip that triggered
 * them is scheduled, so a chip at the same tick as a BPM change is still
 * timed with the previous BPM (matching DTXMania's behavior).
 *
 * 4/4 is assumed. BarLength (#MMM02: N) is ignored in v1 (rare in drum charts).
 */
export function computeTiming(song: Song): Song {
  const chips = song.chips;
  chips.sort(compareChipsByPosition);

  if (chips.length === 0) {
    song.durationMs = 0;
    return song;
  }

  let currentBpm = song.baseBpm > 0 ? song.baseBpm : 120;
  let currentMeasure = 0;
  let lastTickInMeasure = 0;
  let lastTickTimeMs = 0;

  for (const chip of chips) {
    // Close out intermediate measures at whatever BPM is currently running.
    while (currentMeasure < chip.measure) {
      const remTicks = MEASURE_TICKS - lastTickInMeasure;
      const remMs = (remTicks / MEASURE_TICKS) * measureDurationMs(currentBpm);
      lastTickTimeMs += remMs;
      currentMeasure += 1;
      lastTickInMeasure = 0;
    }

    // Advance to chip.tick within the current measure.
    const tickDelta = chip.tick - lastTickInMeasure;
    const msDelta = (tickDelta / MEASURE_TICKS) * measureDurationMs(currentBpm);
    chip.playbackTimeMs = lastTickTimeMs + msDelta;
    lastTickInMeasure = chip.tick;
    lastTickTimeMs = chip.playbackTimeMs;

    // Apply BPM change *after* scheduling this chip.
    if (chip.channel === Channel.BPMChangeExtended && chip.bpmId !== undefined) {
      const next = song.bpmTable.get(chip.bpmId);
      if (next !== undefined && next > 0) currentBpm = next;
    } else if (chip.channel === Channel.BPMChange && chip.rawBpm !== undefined) {
      // Channel 0x03: bpm = BASEBPM + hexValue (CDTX.cs:3799).
      const next = song.basebpmOffset + chip.rawBpm;
      if (next > 0) currentBpm = next;
    }
  }

  // Duration = last chip + remainder of its measure at the current BPM.
  const lastChip = chips[chips.length - 1]!;
  const remTicks = MEASURE_TICKS - lastChip.tick;
  const remMs = (remTicks / MEASURE_TICKS) * measureDurationMs(currentBpm);
  song.durationMs = lastChip.playbackTimeMs + remMs;

  chips.sort((a, b) => a.playbackTimeMs - b.playbackTimeMs);
  return song;
}

function compareChipsByPosition(a: Chip, b: Chip): number {
  if (a.measure !== b.measure) return a.measure - b.measure;
  if (a.tick !== b.tick) return a.tick - b.tick;
  // Stable within a tick; control channels first keeps semantics explicit.
  return controlRank(a.channel) - controlRank(b.channel);
}

function controlRank(channel: number): number {
  if (channel === Channel.BPMChange || channel === Channel.BPMChangeExtended) return 0;
  if (channel === Channel.BarLength) return 1;
  return 2;
}

export function measureDurationMs(bpm: number): number {
  return (60 / bpm) * 4 * 1000;
}
