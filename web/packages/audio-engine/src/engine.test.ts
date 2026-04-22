import { describe, expect, it } from 'vitest';
import {
  clampRate,
  clampVolume,
  computeScheduleWhen,
  computeSeekStart,
  rebaseSongStart,
} from './engine.js';

/**
 * These tests cover the two pure seams of AudioEngine: volume clamping
 * (Settings UI → master gain) and the past-time schedule compensation
 * (BGM / sample scheduling when a chip's target is already behind
 * ctx.currentTime). Both are regression-silent: a bug clamps to 0 and
 * the player just hears nothing; a bug in offset compensation starts
 * BGM from the top and it's audibly desynced from the clock but has
 * no error signal.
 *
 * AudioContext itself is exercised via the integration in game.ts (not
 * unit-tested here — happy-dom's AudioContext shim is incomplete, and
 * the interesting logic is all in these two helpers).
 */

describe('clampVolume', () => {
  it('passes through mid-range values unchanged', () => {
    expect(clampVolume(0.5)).toBe(0.5);
    expect(clampVolume(0)).toBe(0);
    expect(clampVolume(1)).toBe(1);
  });

  it('clamps values above 1 down to 1', () => {
    expect(clampVolume(1.5)).toBe(1);
    expect(clampVolume(100)).toBe(1);
    expect(clampVolume(Infinity)).toBe(1);
  });

  it('clamps negative values up to 0', () => {
    expect(clampVolume(-0.1)).toBe(0);
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(-Infinity)).toBe(0);
  });

  it('treats NaN as unity (silent-fallback to 1, not 0)', () => {
    // The intent is "a broken UI slider should not silently mute the
    // category". 1 means the user still hears audio, which is the less
    // bad failure mode.
    expect(clampVolume(NaN)).toBe(1);
  });
});

describe('computeScheduleWhen — past-time schedule compensation', () => {
  it('future target: play at target with zero source offset', () => {
    expect(computeScheduleWhen(5.2, 5.0, 1)).toEqual({ when: 5.2, offset: 0 });
  });

  it('target === now: treat as on-time, no compensation', () => {
    expect(computeScheduleWhen(5.0, 5.0, 1)).toEqual({ when: 5.0, offset: 0 });
  });

  it('past target at rate=1: start now, fast-forward by the shortfall', () => {
    // Target was 0.5 s ago → start immediately, seek 0.5 s into the buffer
    // so playback stays aligned with the conceptual song clock.
    expect(computeScheduleWhen(4.5, 5.0, 1)).toEqual({ when: 5.0, offset: 0.5 });
  });

  it('the rate=1 offset equals (now - target) exactly, no rounding', () => {
    // Pick a value that would reveal an off-by-something bug (e.g.
    // doubled offset, sign flip).
    expect(computeScheduleWhen(10.0, 10.125, 1)).toEqual({ when: 10.125, offset: 0.125 });
  });

  it('very-far-past target: source still starts at `now` (not negative)', () => {
    // Even if target is 30 s behind, scheduleBuffer must never pass a
    // negative `when` to src.start() — the AudioNode spec rejects that
    // with DOMException. Protect the invariant.
    const r = computeScheduleWhen(-20, 10, 1);
    expect(r.when).toBe(10);
    expect(r.offset).toBe(30);
  });

  it('monotonic: a later target yields a later (or equal) when', () => {
    // Sanity property — if regressions twist the comparison they'd
    // violate this.
    const a = computeScheduleWhen(6, 5, 1);
    const b = computeScheduleWhen(7, 5, 1);
    expect(b.when).toBeGreaterThanOrEqual(a.when);
  });

  it('rate < 1 scales the buffer offset down — wall shortfall ≠ buffer seconds', () => {
    // Past target by 1 wall second at rate 0.5: a source running at
    // half speed since `target` has consumed only 0.5 buffer-seconds in
    // that wall second, so the catch-up offset is 0.5 s, not 1 s.
    // Regression catcher for the loop-seek-at-slow-rate bug.
    const r = computeScheduleWhen(9.0, 10.0, 0.5);
    expect(r.when).toBe(10);
    expect(r.offset).toBeCloseTo(0.5, 9);
  });

  it('rate > 1 scales the buffer offset up', () => {
    const r = computeScheduleWhen(9.0, 10.0, 2);
    expect(r.when).toBe(10);
    expect(r.offset).toBeCloseTo(2.0, 9);
  });

  it('rate is ignored for future targets (offset stays 0)', () => {
    expect(computeScheduleWhen(12, 10, 0.5)).toEqual({ when: 12, offset: 0 });
    expect(computeScheduleWhen(12, 10, 2)).toEqual({ when: 12, offset: 0 });
  });
});

describe('clampRate — practice-rate bounds', () => {
  it('passes through mid-range values unchanged', () => {
    expect(clampRate(0.5)).toBe(0.5);
    expect(clampRate(1)).toBe(1);
    expect(clampRate(1.5)).toBe(1.5);
  });

  it('clamps to [0.25, 2.0]', () => {
    expect(clampRate(0.1)).toBe(0.25);
    expect(clampRate(0)).toBe(0.25);
    expect(clampRate(-1)).toBe(0.25);
    expect(clampRate(3)).toBe(2.0);
    expect(clampRate(Infinity)).toBe(2.0);
  });

  it('NaN → 1 (silent-fallback to normal speed)', () => {
    // Same philosophy as clampVolume: a broken slider should degrade to
    // "normal play", not "stopped" or "frozen at last good value".
    expect(clampRate(NaN)).toBe(1);
  });
});

describe('rebaseSongStart — rate-change continuity', () => {
  /** Helper: chart-ms given the song-start + rate formula used in
   * AudioEngine.songTimeMs. Matches the body exactly so test values
   * stay coupled to the real computation. */
  const songMs = (now: number, start: number, rate: number): number =>
    (now - start) * 1000 * rate;

  it('songTimeMs before == songTimeMs after a rate change (continuity invariant)', () => {
    const now = 10;
    const oldStart = 1;
    const oldRate = 1.0;
    const before = songMs(now, oldStart, oldRate);

    for (const newRate of [0.5, 0.75, 1.25, 2.0]) {
      const newStart = rebaseSongStart(now, oldStart, oldRate, newRate);
      const after = songMs(now, newStart, newRate);
      expect(after).toBeCloseTo(before, 9);
    }
  });

  it('rate = rate (no-op) leaves start unchanged', () => {
    // Not used by setRate (which early-returns on equality), but the
    // formula should still be a fixed point.
    expect(rebaseSongStart(10, 1, 0.75, 0.75)).toBeCloseTo(1, 9);
  });

  it('handles advance from 0.5 → 1.0 mid-song', () => {
    // At wall 4 s, half-speed song has advanced 2000 chart-ms. After
    // flipping to 1.0 at wall 4 s, the NEXT wall-ms should advance
    // chart-ms at 1:1 — i.e. at wall 4.001 s, songTimeMs == 2001.
    const newStart = rebaseSongStart(4, 0, 0.5, 1.0);
    expect(songMs(4, newStart, 1.0)).toBeCloseTo(2000, 9);
    expect(songMs(4.001, newStart, 1.0)).toBeCloseTo(2001, 9);
  });
});

describe('computeSeekStart — seek teleport invariant', () => {
  const songMs = (now: number, start: number, rate: number): number =>
    (now - start) * 1000 * rate;

  it('after seek, songTimeMs(now) == targetSongMs (rate = 1)', () => {
    const now = 5.25;
    for (const target of [0, 500, 12345, -100]) {
      const newStart = computeSeekStart(now, 1.0, target);
      expect(songMs(now, newStart, 1.0)).toBeCloseTo(target, 6);
    }
  });

  it('respects the practice rate: higher rate ⇒ smaller ctx delta for same target', () => {
    const now = 10;
    const targetSongMs = 4000;
    const slow = computeSeekStart(now, 0.5, targetSongMs);
    const fast = computeSeekStart(now, 2.0, targetSongMs);
    expect(now - slow).toBeCloseTo(8.0, 9);
    expect(now - fast).toBeCloseTo(2.0, 9);
    expect(songMs(now, slow, 0.5)).toBeCloseTo(targetSongMs, 6);
    expect(songMs(now, fast, 2.0)).toBeCloseTo(targetSongMs, 6);
  });

  it('seeking to 0 yields newStart === now (ctx reads exactly at song start)', () => {
    expect(computeSeekStart(42, 1.0, 0)).toBe(42);
  });
});
