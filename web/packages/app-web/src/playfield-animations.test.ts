import { describe, expect, it } from 'vitest';
import {
  flushFrameIndex,
  laneFlushFrame,
} from './playfield-animations.js';
import {
  LANE_FLUSH_FRAME_COUNT,
  LANE_FLUSH_FRAME_PERIOD_MS,
  LANE_FLUSH_LIFETIME_MS,
  LANE_FLUSH_TRAVEL_PX,
} from './playfield-layout.js';

describe('flushFrameIndex', () => {
  it('starts at frame 0', () => {
    expect(flushFrameIndex(0)).toBe(0);
  });

  it('cycles through 0..N-1 over time', () => {
    for (let i = 0; i < LANE_FLUSH_FRAME_COUNT * 2; i++) {
      const t = i * LANE_FLUSH_FRAME_PERIOD_MS;
      expect(flushFrameIndex(t)).toBe(i % LANE_FLUSH_FRAME_COUNT);
    }
  });

  it('returns 0 for non-finite / negative elapsed', () => {
    expect(flushFrameIndex(Number.NaN)).toBe(0);
    expect(flushFrameIndex(-100)).toBe(0);
  });
});

describe('laneFlushFrame — lifecycle', () => {
  it('reports expired before the hit and after the lifetime ends', () => {
    expect(laneFlushFrame(100, 200, 720).expired).toBe(true); // before hit
    expect(laneFlushFrame(800, 100, 720).expired).toBe(true); // 700 ms after hit (lifetime 500)
    expect(laneFlushFrame(LANE_FLUSH_LIFETIME_MS, 0, 720).expired).toBe(true); // boundary
  });

  it('returns full alpha at the moment of impact', () => {
    const f = laneFlushFrame(100, 100, 720);
    expect(f.expired).toBe(false);
    expect(f.alpha).toBe(1);
    expect(f.y).toBe(720);
  });

  it('rides up the playfield as time progresses', () => {
    const start = laneFlushFrame(100, 100, 720);
    const mid = laneFlushFrame(100 + LANE_FLUSH_LIFETIME_MS / 2, 100, 720);
    const late = laneFlushFrame(100 + LANE_FLUSH_LIFETIME_MS - 10, 100, 720);
    expect(start.y).toBeGreaterThan(mid.y);
    expect(mid.y).toBeGreaterThan(late.y);
  });

  it('fades alpha linearly to 0 over the lifetime', () => {
    const mid = laneFlushFrame(LANE_FLUSH_LIFETIME_MS / 2, 0, 720);
    expect(mid.alpha).toBeCloseTo(0.5);
  });

  it('matches the documented y formula', () => {
    const half = laneFlushFrame(LANE_FLUSH_LIFETIME_MS / 2, 0, 720);
    expect(half.y).toBeCloseTo(720 - LANE_FLUSH_TRAVEL_PX / 2);
  });
});
