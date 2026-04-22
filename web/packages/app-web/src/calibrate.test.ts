import { describe, expect, it } from 'vitest';
import { computeOffset } from './calibrate.js';

/**
 * `computeOffset` is the silent-regression-prone heart of latency
 * calibration: if it drifts, every user's judgment window is wrong by
 * however many ms the bug introduced, with no error message. Units are
 * seconds (AudioContext time) in / ms out.
 */

/** Build a beat grid: `count` beats, `interval` seconds apart, starting
 * at t=1.0 (same shape runCalibration uses). */
function beats(count: number, interval = 0.5, start = 1.0): number[] {
  return Array.from({ length: count }, (_, i) => start + i * interval);
}

/** Synthetic presses `deltaSec` away from each (non-warmup) beat. */
function presses(beatTimes: number[], warmup: number, deltaSec: number[]): { audioTime: number }[] {
  const active = beatTimes.slice(warmup);
  return deltaSec.map((d, i) => ({ audioTime: active[i]! + d }));
}

describe('computeOffset — median-of-deltas core', () => {
  it('returns the press-minus-beat median as ms (late press → positive offset)', () => {
    const b = beats(5);
    // 3 presses, each 30 ms late: median = 30
    const p = presses(b, 2, [0.03, 0.03, 0.03]);
    expect(computeOffset(b, p, 2)).toBeCloseTo(30, 5);
  });

  it('early press → negative offset (player anticipating the beat)', () => {
    const b = beats(5);
    const p = presses(b, 2, [-0.02, -0.02, -0.02]);
    expect(computeOffset(b, p, 2)).toBeCloseTo(-20, 5);
  });

  it('takes the median, not the mean — outliers under the 300ms threshold are resistant', () => {
    const b = beats(7);
    // 5 late presses: 30, 30, 30, 30, 150. Mean = 54, median = 30.
    // All deltas are within the 300ms cutoff so none are discarded.
    const p = presses(b, 2, [0.03, 0.03, 0.03, 0.03, 0.15]);
    const result = computeOffset(b, p, 2);
    expect(result).toBeCloseTo(30, 5);
  });

  it('median of an even count averages the middle pair', () => {
    const b = beats(6);
    // deltas: 10, 20, 40, 50  →  middle pair = (20, 40), median = 30
    const p = presses(b, 2, [0.01, 0.02, 0.04, 0.05]);
    expect(computeOffset(b, p, 2)).toBeCloseTo(30, 5);
  });

  it('discards presses more than 300 ms from any non-warmup beat', () => {
    const b = beats(5);
    // Three legit 25-ms-late presses, plus one stray that lands 400 ms
    // past the last beat — stray is dropped; the three survivors yield 25.
    const active = b.slice(2);
    const p: { audioTime: number }[] = [
      { audioTime: active[0]! + 0.025 },
      { audioTime: active[1]! + 0.025 },
      { audioTime: active[2]! + 0.025 },
      { audioTime: active[2]! + 0.4 }, // stray — nearest beat still 400ms away
    ];
    expect(computeOffset(b, p, 2)).toBeCloseTo(25, 5);
  });

  it('returns null when fewer than 3 presses survive — too noisy to trust', () => {
    const b = beats(5);
    // Only 2 valid presses.
    const p = presses(b, 2, [0.01, 0.02]);
    expect(computeOffset(b, p, 2)).toBeNull();
  });

  it('returns null when every press is too far from any beat (all rejected)', () => {
    const b = beats(5);
    // 4 presses, each 500 ms late → all beyond the 300 ms cutoff.
    const p = presses(b, 2, [0.5, 0.5, 0.5, 0.5]);
    expect(computeOffset(b, p, 2)).toBeNull();
  });

  it('does not match presses against warm-up beats — only the active range counts', () => {
    // Warmup = 2 beats; construct presses that land on the first warmup
    // beat exactly. They should be matched to the NEAREST active beat
    // (warmup+0), making their delta the full interval (-500 ms), which
    // exceeds the 300 ms cutoff → all rejected → null.
    const b = beats(5, 0.5);
    const p = [
      { audioTime: b[0]! },
      { audioTime: b[0]! },
      { audioTime: b[0]! },
    ];
    expect(computeOffset(b, p, 2)).toBeNull();
  });

  it('each press matches its nearest beat, not the beat at the same index', () => {
    // Three presses, all clustered ~20ms past beat #3 (index 1 of active).
    // If the algorithm matched by index (buggy), two of the three would
    // compare against the wrong beats and land beyond 300ms. Matching by
    // nearest is what keeps the median at 20.
    const b = beats(6, 0.5);
    const active = b.slice(2);
    const target = active[1]!;
    const p = [
      { audioTime: target + 0.02 },
      { audioTime: target + 0.02 },
      { audioTime: target + 0.02 },
    ];
    expect(computeOffset(b, p, 2)).toBeCloseTo(20, 5);
  });

  it('treats a press exactly at the 300 ms boundary as accepted (inclusive)', () => {
    // |delta| === 0.3 exactly → kept. Test the boundary so a >/>= swap
    // is caught. Wide 1-second beat interval so the press doesn't end
    // up closer to the NEXT beat (0.2s away) under a 0.5-s interval.
    const b = beats(5, 1.0);
    const active = b.slice(2);
    const p = [
      { audioTime: active[0]! + 0.3 },
      { audioTime: active[1]! + 0.3 },
      { audioTime: active[2]! + 0.3 },
    ];
    expect(computeOffset(b, p, 2)).toBeCloseTo(300, 5);
  });
});
