import { Channel } from '../model/channel.js';
import { MEASURE_TICKS, type Song } from '../model/chip.js';
import { measureDurationMs } from './timing.js';

/**
 * Builds a lookup `out[measureIndex] = songMs` covering every measure from
 * 0 to `maxMeasure + 1`. The trailing `maxMeasure + 1` entry is a sentinel
 * for "end of last measure" so loop-end = maxMeasure+1 resolves cleanly to
 * `song.durationMs`.
 *
 * Walks chips in (measure, tick) order with a running BPM, mirroring
 * `computeTiming`: BPM changes apply *after* the chip that triggered them,
 * so mid-measure BPM changes correctly influence the tail of that measure.
 */
export function buildMeasureStartMsIndex(song: Song): number[] {
  const ordered = [...song.chips].sort((a, b) => {
    if (a.measure !== b.measure) return a.measure - b.measure;
    if (a.tick !== b.tick) return a.tick - b.tick;
    return controlRank(a.channel) - controlRank(b.channel);
  });

  const maxMeasure = ordered.length > 0 ? ordered[ordered.length - 1]!.measure : 0;
  const out = new Array<number>(maxMeasure + 2);
  out[0] = 0;

  let currentBpm = song.baseBpm > 0 ? song.baseBpm : 120;
  let currentMeasure = 0;
  let lastTickInMeasure = 0;
  let lastTickTimeMs = 0;

  for (const chip of ordered) {
    while (currentMeasure < chip.measure) {
      const remTicks = MEASURE_TICKS - lastTickInMeasure;
      lastTickTimeMs += (remTicks / MEASURE_TICKS) * measureDurationMs(currentBpm);
      currentMeasure += 1;
      lastTickInMeasure = 0;
      out[currentMeasure] = lastTickTimeMs;
    }

    const tickDelta = chip.tick - lastTickInMeasure;
    lastTickTimeMs += (tickDelta / MEASURE_TICKS) * measureDurationMs(currentBpm);
    lastTickInMeasure = chip.tick;

    if (chip.channel === Channel.BPMChangeExtended && chip.bpmId !== undefined) {
      const next = song.bpmTable.get(chip.bpmId);
      if (next !== undefined && next > 0) currentBpm = next;
    } else if (chip.channel === Channel.BPMChange && chip.rawBpm !== undefined) {
      const next = song.basebpmOffset + chip.rawBpm;
      if (next > 0) currentBpm = next;
    }
  }

  const remTicks = MEASURE_TICKS - lastTickInMeasure;
  lastTickTimeMs += (remTicks / MEASURE_TICKS) * measureDurationMs(currentBpm);
  out[maxMeasure + 1] = lastTickTimeMs;

  return out;
}

function controlRank(channel: number): number {
  if (channel === Channel.BPMChange || channel === Channel.BPMChangeExtended) return 0;
  if (channel === Channel.BarLength) return 1;
  return 2;
}
