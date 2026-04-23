import { describe, expect, it, vi } from 'vitest';
import {
  AUDIO_OFFSET_LS_KEY,
  MIN_USABLE_PRESSES,
  PRESS_MATCH_WINDOW_SEC,
  loadAudioOffsetMs,
  makeClickBuffer,
  saveAudioOffsetMs,
  scheduleBeats,
} from './calibrate-model.js';

/**
 * `computeOffset` is already covered by `calibrate.test.ts`. These
 * tests focus on the newer exports that the VR calibration panel
 * shares with the DOM overlay: the scheduler, the persistence
 * helpers, and the constants both views rely on.
 */

describe('calibrate-model constants', () => {
  it('exposes the tolerance / quorum / storage-key values as named exports', () => {
    expect(PRESS_MATCH_WINDOW_SEC).toBeGreaterThan(0);
    expect(MIN_USABLE_PRESSES).toBeGreaterThanOrEqual(3);
    expect(AUDIO_OFFSET_LS_KEY).toMatch(/dtxmania/);
  });
});

describe('scheduleBeats — metronome scheduler', () => {
  /** Minimal fake AudioContext sufficient for scheduleBeats; records
   * every buffer source + start time so the test can assert. */
  function makeFakeCtx(nowSec = 0): {
    ctx: AudioContext;
    scheduled: { when: number }[];
  } {
    const scheduled: { when: number }[] = [];
    const fakeBuffer = {} as AudioBuffer;
    const gainNode = {
      gain: { value: 0 },
      connect: vi.fn(),
    };
    const fakeCtx = {
      currentTime: nowSec,
      destination: {},
      createBuffer: () => fakeBuffer,
      createBufferSource: () => ({
        buffer: null as AudioBuffer | null,
        connect: vi.fn(),
        start: (when: number) => scheduled.push({ when }),
      }),
      createGain: () => gainNode,
    } as unknown as AudioContext;
    return { ctx: fakeCtx, scheduled };
  }

  it('returns exactly `beats` beatTimes at the requested interval after the lead-in', () => {
    const { ctx } = makeFakeCtx(10);
    const buf = makeClickBuffer(makeRealCtx()); // real ctx for buffer gen
    const { beatTimes, startAt } = scheduleBeats(ctx, buf, {
      beats: 5,
      intervalMs: 200,
      leadInSec: 0.6,
    });
    expect(beatTimes).toHaveLength(5);
    expect(startAt).toBeCloseTo(10.6, 5);
    // Interval is 200 ms = 0.2 s.
    expect(beatTimes[1]! - beatTimes[0]!).toBeCloseTo(0.2, 5);
    expect(beatTimes[4]! - beatTimes[0]!).toBeCloseTo(0.8, 5);
  });

  it('calls ctx.createBufferSource().start() once per beat at the scheduled time', () => {
    const { ctx, scheduled } = makeFakeCtx(5);
    const buf = makeClickBuffer(makeRealCtx());
    const { beatTimes } = scheduleBeats(ctx, buf, { beats: 3, intervalMs: 100, leadInSec: 0.1 });
    expect(scheduled).toHaveLength(3);
    expect(scheduled.map((s) => s.when)).toEqual(beatTimes);
  });

  it('defaults beats=12, intervalMs=500, leadInSec=0.6 when no options are passed', () => {
    const { ctx } = makeFakeCtx(0);
    const buf = makeClickBuffer(makeRealCtx());
    const { beatTimes } = scheduleBeats(ctx, buf);
    expect(beatTimes).toHaveLength(12);
    expect(beatTimes[0]!).toBeCloseTo(0.6, 5);
    expect(beatTimes[11]! - beatTimes[0]!).toBeCloseTo(5.5, 5); // 11 * 0.5 s
  });
});

describe('loadAudioOffsetMs / saveAudioOffsetMs', () => {
  it('returns 0 when no offset is persisted', () => {
    window.localStorage.removeItem(AUDIO_OFFSET_LS_KEY);
    expect(loadAudioOffsetMs()).toBe(0);
  });
  it('round-trips a saved value', () => {
    saveAudioOffsetMs(42.5);
    expect(loadAudioOffsetMs()).toBeCloseTo(42.5, 5);
  });
  it('round-trips a negative value (player pressed early)', () => {
    saveAudioOffsetMs(-17);
    expect(loadAudioOffsetMs()).toBe(-17);
  });
  it('returns 0 when the stored value is garbage (defensive against bad writes)', () => {
    window.localStorage.setItem(AUDIO_OFFSET_LS_KEY, 'not-a-number');
    expect(loadAudioOffsetMs()).toBe(0);
  });
});

describe('makeClickBuffer', () => {
  it('produces a short buffer (~40 ms at the context sample rate)', () => {
    const ctx = makeRealCtx();
    const buf = makeClickBuffer(ctx);
    const expectedLen = Math.round(ctx.sampleRate * 0.04);
    expect(buf.length).toBe(expectedLen);
    expect(buf.numberOfChannels).toBe(1);
    expect(buf.sampleRate).toBe(ctx.sampleRate);
  });
});

/** Minimum AudioContext shape `makeClickBuffer` + `scheduleBeats`
 * touch — happy-dom doesn't expose AudioContext so we hand-roll one. */
function makeRealCtx(sampleRate = 48_000): AudioContext {
  return {
    sampleRate,
    currentTime: 0,
    destination: {},
    createBuffer(channels: number, length: number, rate: number): AudioBuffer {
      const channelData: Float32Array[] = [];
      for (let i = 0; i < channels; i++) channelData.push(new Float32Array(length));
      return {
        length,
        numberOfChannels: channels,
        sampleRate: rate,
        duration: length / rate,
        getChannelData: (i: number) => channelData[i]!,
      } as unknown as AudioBuffer;
    },
    createBufferSource() {
      return {
        buffer: null as AudioBuffer | null,
        connect: () => {},
        start: () => {},
      };
    },
    createGain() {
      return { gain: { value: 0 }, connect: () => {} };
    },
  } as unknown as AudioContext;
}
