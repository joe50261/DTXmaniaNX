import { describe, it, expect } from 'vitest';
import type { Chip } from '@dtxmania/dtx-core';
import { Lane, type LaneValue } from '@dtxmania/input';
import { applyAutoFire, type AutoFireCandidate } from './autofire.js';

/** Bare-minimum Chip stand-in — the auto-fire path only reads
 * `playbackTimeMs`, so the other required fields (channel, measure,
 * tick, wavId) just need to typecheck. */
function chipAt(ms: number): Chip {
  return {
    measure: 0,
    tick: 0,
    channel: 0,
    wavId: 0,
    playbackTimeMs: ms,
  };
}

function candidate(lane: LaneValue, timeMs: number): AutoFireCandidate {
  return { chip: chipAt(timeMs), laneValue: lane, hit: false, missed: false };
}

describe('applyAutoFire', () => {
  it('empty auto set yields no events', () => {
    const cs = [candidate(Lane.BD, 100), candidate(Lane.SD, 200)];
    const out = applyAutoFire(cs, new Set(), 500);
    expect(out).toHaveLength(0);
    expect(cs[0]!.hit).toBe(false);
    expect(cs[1]!.hit).toBe(false);
  });

  it('only lanes in the auto set fire', () => {
    const cs = [
      candidate(Lane.BD, 100),
      candidate(Lane.SD, 100),
      candidate(Lane.HH, 100),
    ];
    const out = applyAutoFire(cs, new Set([Lane.BD, Lane.HH]), 200);
    expect(out.map((e) => e.lane).sort()).toEqual([Lane.BD, Lane.HH].sort());
    expect(cs[0]!.hit).toBe(true); // BD
    expect(cs[1]!.hit).toBe(false); // SD stayed
    expect(cs[2]!.hit).toBe(true); // HH
  });

  it('does not fire chips whose playback time is still in the future', () => {
    const cs = [candidate(Lane.BD, 1000)];
    const out = applyAutoFire(cs, new Set([Lane.BD]), 500);
    expect(out).toHaveLength(0);
    expect(cs[0]!.hit).toBe(false);
  });

  it('fires exactly at the playback-time boundary (songTime === playbackTime)', () => {
    const cs = [candidate(Lane.BD, 500)];
    const out = applyAutoFire(cs, new Set([Lane.BD]), 500);
    expect(out).toHaveLength(1);
    expect(cs[0]!.hit).toBe(true);
  });

  it('already-hit chip is skipped even with matching lane + time', () => {
    const c = candidate(Lane.BD, 100);
    c.hit = true;
    const out = applyAutoFire([c], new Set([Lane.BD]), 500);
    expect(out).toHaveLength(0);
  });

  it('already-missed chip is skipped (auto-play never resurrects a miss)', () => {
    const c = candidate(Lane.BD, 100);
    c.missed = true;
    const out = applyAutoFire([c], new Set([Lane.BD]), 500);
    expect(out).toHaveLength(0);
  });

  it('second call at the same songTime is a no-op (hit latch)', () => {
    const cs = [candidate(Lane.BD, 100)];
    const first = applyAutoFire(cs, new Set([Lane.BD]), 500);
    const second = applyAutoFire(cs, new Set([Lane.BD]), 500);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('returns indices that line up with the input array order', () => {
    const cs = [
      candidate(Lane.SD, 100), // 0
      candidate(Lane.BD, 100), // 1 — fires
      candidate(Lane.CY, 100), // 2
      candidate(Lane.BD, 200), // 3 — fires
    ];
    const out = applyAutoFire(cs, new Set([Lane.BD]), 300);
    expect(out.map((e) => e.idx)).toEqual([1, 3]);
  });

  it('scans across every lane when the full auto set is enabled (matches all-auto gameplay)', () => {
    const cs = [
      candidate(Lane.HH, 100),
      candidate(Lane.SD, 150),
      candidate(Lane.BD, 200),
      candidate(Lane.CY, 250),
      candidate(Lane.RD, 300),
    ];
    const all = new Set<LaneValue>([
      Lane.LC,
      Lane.HH,
      Lane.LP,
      Lane.SD,
      Lane.HT,
      Lane.BD,
      Lane.LT,
      Lane.FT,
      Lane.CY,
      Lane.RD,
      Lane.LBD,
    ]);
    const out = applyAutoFire(cs, all, 400);
    expect(out).toHaveLength(cs.length);
    for (const c of cs) expect(c.hit).toBe(true);
  });
});
