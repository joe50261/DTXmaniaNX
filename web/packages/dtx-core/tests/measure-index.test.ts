import { describe, it, expect } from 'vitest';
import { parseDtx } from '../src/parser/parser.js';
import { computeTiming } from '../src/timing/timing.js';
import { buildMeasureStartMsIndex } from '../src/timing/measure-index.js';
import { createEmptySong } from '../src/model/chip.js';

describe('buildMeasureStartMsIndex', () => {
  it('returns single sentinel for empty song', () => {
    const song = createEmptySong();
    song.baseBpm = 120;
    computeTiming(song);
    const idx = buildMeasureStartMsIndex(song);
    // No chips → maxMeasure = 0, one measure at 0ms + sentinel at 2000ms.
    expect(idx).toHaveLength(2);
    expect(idx[0]).toBe(0);
    expect(idx[1]).toBeCloseTo(2000, 3);
  });

  it('constant 120 BPM: out[i] === i * 2000', () => {
    const dtx = [
      '#BPM 120',
      '#WAV01 s.wav',
      '#00012:01000000',
      '#00112:01000000',
      '#00212:01000000',
      '#00312:01000000',
    ].join('\n');
    const song = computeTiming(parseDtx(dtx));
    const idx = buildMeasureStartMsIndex(song);
    // measures 0..3 + sentinel 4 → length 5
    expect(idx).toHaveLength(5);
    expect(idx[0]).toBeCloseTo(0, 3);
    expect(idx[1]).toBeCloseTo(2000, 3);
    expect(idx[2]).toBeCloseTo(4000, 3);
    expect(idx[3]).toBeCloseTo(6000, 3);
    expect(idx[4]).toBeCloseTo(8000, 3);
  });

  it('BPM change at start of measure 1 applies to measure 1 onward', () => {
    // 120 BPM → measure 0 is 2000ms. BPM change to 240 at tick 0 of measure 1.
    // At 240 BPM, measure = 1000ms. So measure 2 starts at 3000ms, measure 3 at 4000ms.
    const dtx = [
      '#BPM 120',
      '#BPM01 240',
      '#WAV01 s.wav',
      '#00012:01000000',
      '#00108:01000000',
      '#00212:01000000',
      '#00312:01000000',
    ].join('\n');
    const song = computeTiming(parseDtx(dtx));
    const idx = buildMeasureStartMsIndex(song);
    expect(idx[0]).toBeCloseTo(0, 3);
    expect(idx[1]).toBeCloseTo(2000, 3);
    expect(idx[2]).toBeCloseTo(3000, 3);
    expect(idx[3]).toBeCloseTo(4000, 3);
    expect(idx[4]).toBeCloseTo(5000, 3);
  });

  it('mid-measure BPM change affects tail of that measure', () => {
    // 120 BPM → first 192 ticks = 1000ms. BPM doubles at tick 192 → next 192 ticks = 500ms.
    // So measure 0 = 1500ms total. Measure 1 starts at 1500ms.
    const dtx = [
      '#BPM 120',
      '#BPM01 240',
      '#WAV01 s.wav',
      '#00008:00000100',
      '#00112:01000000',
    ].join('\n');
    const song = computeTiming(parseDtx(dtx));
    const idx = buildMeasureStartMsIndex(song);
    expect(idx[0]).toBeCloseTo(0, 3);
    expect(idx[1]).toBeCloseTo(1500, 3);
  });

  it('empty measures between chips are filled in', () => {
    // Snare at measure 0, next at measure 5. All entries must exist.
    const dtx = ['#BPM 120', '#WAV01 s.wav', '#00012:01000000', '#00512:01000000'].join('\n');
    const song = computeTiming(parseDtx(dtx));
    const idx = buildMeasureStartMsIndex(song);
    expect(idx).toHaveLength(7);
    for (let i = 0; i < idx.length - 1; i++) {
      expect(idx[i + 1]!).toBeGreaterThan(idx[i]!);
    }
    expect(idx[5]).toBeCloseTo(10000, 3);
  });

  it('trailing sentinel matches song.durationMs', () => {
    const dtx = [
      '#BPM 150',
      '#WAV01 s.wav',
      '#00012:01000000',
      '#00112:01000000',
    ].join('\n');
    const song = computeTiming(parseDtx(dtx));
    const idx = buildMeasureStartMsIndex(song);
    expect(idx[idx.length - 1]!).toBeCloseTo(song.durationMs, 3);
  });
});
