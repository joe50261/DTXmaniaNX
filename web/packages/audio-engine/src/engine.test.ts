import { describe, expect, it } from 'vitest';
import { clampVolume, computeScheduleWhen } from './engine.js';

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
    expect(computeScheduleWhen(5.2, 5.0)).toEqual({ when: 5.2, offset: 0 });
  });

  it('target === now: treat as on-time, no compensation', () => {
    expect(computeScheduleWhen(5.0, 5.0)).toEqual({ when: 5.0, offset: 0 });
  });

  it('past target: start now, fast-forward into the buffer by the shortfall', () => {
    // Target was 0.5s ago → start immediately, seek 0.5s into the buffer
    // so playback stays aligned with the conceptual song clock.
    expect(computeScheduleWhen(4.5, 5.0)).toEqual({ when: 5.0, offset: 0.5 });
  });

  it('the offset equals (now - target) exactly, no rounding', () => {
    // Pick a value that would reveal an off-by-something bug (e.g.
    // doubled offset, sign flip).
    expect(computeScheduleWhen(10.0, 10.125)).toEqual({ when: 10.125, offset: 0.125 });
  });

  it('very-far-past target: source still starts at `now` (not negative)', () => {
    // Even if target is 30 s behind, scheduleBuffer must never pass a
    // negative `when` to src.start() — the AudioNode spec rejects that
    // with DOMException. Protect the invariant.
    const r = computeScheduleWhen(-20, 10);
    expect(r.when).toBe(10);
    expect(r.offset).toBe(30);
  });

  it('monotonic: a later target yields a later (or equal) when', () => {
    // Sanity property — if regressions twist the comparison they'd
    // violate this.
    const a = computeScheduleWhen(6, 5);
    const b = computeScheduleWhen(7, 5);
    expect(b.when).toBeGreaterThanOrEqual(a.when);
  });
});
