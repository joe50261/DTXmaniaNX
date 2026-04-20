import { describe, it, expect } from 'vitest';
import { parseDtx } from '../src/parser/parser.js';
import { computeTiming } from '../src/timing/timing.js';
import { Channel } from '../src/model/channel.js';

describe('computeTiming', () => {
  it('at 120 BPM, one measure = 2000ms and a single note at tick 0 of measure 1 is at 2000ms', () => {
    const dtx = ['#BPM 120', '#WAV01 s.wav', '#00112:01000000'].join('\n');
    const song = computeTiming(parseDtx(dtx));
    const snare = song.chips.find((c) => c.channel === Channel.Snare)!;
    expect(snare.playbackTimeMs).toBeCloseTo(2000, 3);
  });

  it('four quarter-notes in measure 0 at 120 BPM land on 0, 500, 1000, 1500ms', () => {
    const dtx = ['#BPM 120', '#WAV01 s.wav', '#00012:01010101'].join('\n');
    const song = computeTiming(parseDtx(dtx));
    const snare = song.chips.filter((c) => c.channel === Channel.Snare);
    const times = snare.map((c) => c.playbackTimeMs);
    expect(times[0]).toBeCloseTo(0, 3);
    expect(times[1]).toBeCloseTo(500, 3);
    expect(times[2]).toBeCloseTo(1000, 3);
    expect(times[3]).toBeCloseTo(1500, 3);
  });

  it('applies BPMChangeExtended mid-song', () => {
    // measure 0 at 120 BPM (2000ms), BPM change at tick 0 of measure 1 to 240 BPM,
    // then a snare at tick 0 of measure 2 which should be at 2000 + 1000 = 3000ms.
    const dtx = [
      '#BPM 120',
      '#BPM01 240',
      '#WAV01 s.wav',
      '#00012:01000000',   // snare at 0ms
      '#00108:01000000',   // BPM change at start of measure 1 (2000ms)
      '#00212:01000000',   // snare at start of measure 2 (should be 3000ms)
    ].join('\n');

    const song = computeTiming(parseDtx(dtx));
    const snares = song.chips.filter((c) => c.channel === Channel.Snare);
    expect(snares).toHaveLength(2);
    expect(snares[0]?.playbackTimeMs).toBeCloseTo(0, 3);
    expect(snares[1]?.playbackTimeMs).toBeCloseTo(3000, 3);
  });

  it('BPM change mid-measure affects only subsequent ticks', () => {
    // At 120 BPM, tick 192 is 1000ms into the measure. If BPM doubles at tick 192,
    // tick 288 (3/4 of measure) should be at 1000 + (96/384)*(1000) = 1250ms
    // (remaining 192 ticks take half the normal time).
    const dtx = [
      '#BPM 120',
      '#BPM01 240',
      '#WAV01 s.wav',
      '#00008:00000100',   // BPM change at tick 192
      '#00012:00000001',   // snare at tick 288 (3rd of 4 quarters would be 1500ms, but we made it tick 288)
    ].join('\n');

    const song = computeTiming(parseDtx(dtx));
    const snare = song.chips.find((c) => c.channel === Channel.Snare)!;
    // Without BPM change: 288/384 * 2000 = 1500ms
    // With doubling at tick 192: first 192 ticks at 120 BPM = 1000ms,
    //   next 96 ticks at 240 BPM = (96/384)*1000 = 250ms, total = 1250ms.
    expect(snare.playbackTimeMs).toBeCloseTo(1250, 3);
  });

  it('sorts chips chronologically after timing', () => {
    const dtx = [
      '#BPM 120',
      '#WAV01 s.wav',
      '#00212:01000000',   // measure 2
      '#00012:01000000',   // measure 0
      '#00112:01000000',   // measure 1
    ].join('\n');
    const song = computeTiming(parseDtx(dtx));
    const times = song.chips.map((c) => c.playbackTimeMs);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]!);
    }
  });

  it('durationMs equals last-chip-time plus measure remainder', () => {
    const dtx = ['#BPM 120', '#WAV01 s.wav', '#00212:01000000'].join('\n');
    const song = computeTiming(parseDtx(dtx));
    // Chip at measure 2 tick 0 = 4000ms, remainder of measure = 2000ms → 6000ms.
    expect(song.durationMs).toBeCloseTo(6000, 3);
  });
});
