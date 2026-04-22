import { describe, it, expect } from 'vitest';
import type { Chip } from '@dtxmania/dtx-core';
import { HIT_RANGES_MS, Judgment } from '@dtxmania/dtx-core';
import { Lane, type LaneValue } from '@dtxmania/input';
import { detectMisses, matchLaneHit, type MatchCandidate } from './matcher.js';

function chipAt(ms: number, channel = 0x13): Chip {
  return { measure: 0, tick: 0, channel, wavId: 0, playbackTimeMs: ms };
}

function candidate(lane: LaneValue, timeMs: number): MatchCandidate {
  return { chip: chipAt(timeMs), laneValue: lane, hit: false, missed: false };
}

describe('matchLaneHit', () => {
  it('exact-on-target press scores PERFECT', () => {
    const cs = [candidate(Lane.BD, 1000)];
    const m = matchLaneHit(cs, Lane.BD, 1000, 0);
    expect(m?.judgment).toBe(Judgment.PERFECT);
    expect(m?.deltaMs).toBe(0);
    expect(cs[0]!.hit).toBe(true);
  });

  it('small negative delta → FAST side; classifies per HIT_RANGES_MS', () => {
    const cs = [candidate(Lane.BD, 1000)];
    // 20 ms early → inside PERFECT window (34 ms).
    const m = matchLaneHit(cs, Lane.BD, 980, 0);
    expect(m?.deltaMs).toBe(-20);
    expect(m?.judgment).toBe(Judgment.PERFECT);
  });

  it('beyond POOR window → null (stray hit)', () => {
    const cs = [candidate(Lane.BD, 1000)];
    const m = matchLaneHit(cs, Lane.BD, 1000 + HIT_RANGES_MS.POOR + 5, 0);
    expect(m).toBeNull();
    expect(cs[0]!.hit).toBe(false);
  });

  it('wrong lane → null even if timing is perfect', () => {
    const cs = [candidate(Lane.BD, 1000)];
    const m = matchLaneHit(cs, Lane.SD, 1000, 0);
    expect(m).toBeNull();
    expect(cs[0]!.hit).toBe(false);
  });

  it('offsetMs shifts the judgment window (player-calibrated latency)', () => {
    const cs = [candidate(Lane.BD, 1000)];
    // Player consistently 30 ms late → offset=30 cancels it → PERFECT.
    const m = matchLaneHit(cs, Lane.BD, 1030, 30);
    expect(m?.judgment).toBe(Judgment.PERFECT);
    expect(m?.deltaMs).toBe(0);
  });

  it('picks the nearest-in-time of multiple candidates on the same lane', () => {
    const cs = [
      candidate(Lane.BD, 1000),
      candidate(Lane.BD, 1100), // closer to the press time
      candidate(Lane.BD, 1200),
    ];
    const m = matchLaneHit(cs, Lane.BD, 1095, 0);
    expect(m?.idx).toBe(1);
  });

  it('skips already-hit / missed chips and matches the next one', () => {
    const cs = [candidate(Lane.BD, 1000), candidate(Lane.BD, 1100)];
    cs[0]!.hit = true; // first already handled
    const m = matchLaneHit(cs, Lane.BD, 1000, 0);
    expect(m?.idx).toBe(1);
    // The second one — not the one we locked — is the match.
    expect(cs[0]!.hit).toBe(true);
    expect(cs[1]!.hit).toBe(true);
  });

  it('second press at the same time finds null (first call latched hit=true)', () => {
    const cs = [candidate(Lane.BD, 1000)];
    expect(matchLaneHit(cs, Lane.BD, 1000, 0)).not.toBeNull();
    expect(matchLaneHit(cs, Lane.BD, 1000, 0)).toBeNull();
  });
});

describe('detectMisses', () => {
  it('chips still inside POOR window stay live', () => {
    const cs = [candidate(Lane.BD, 1000)];
    const events = detectMisses(cs, 1000 + HIT_RANGES_MS.POOR);
    expect(events).toHaveLength(0);
    expect(cs[0]!.missed).toBe(false);
  });

  it('chips past POOR window get flagged and returned once', () => {
    const cs = [candidate(Lane.BD, 1000)];
    const first = detectMisses(cs, 1000 + HIT_RANGES_MS.POOR + 1);
    expect(first).toHaveLength(1);
    expect(first[0]!.idx).toBe(0);
    expect(first[0]!.lane).toBe(Lane.BD);
    expect(cs[0]!.missed).toBe(true);
    // Repeat in the same frame — already missed, stays suppressed.
    const second = detectMisses(cs, 1000 + HIT_RANGES_MS.POOR + 5);
    expect(second).toHaveLength(0);
  });

  it('already-hit chip is not fired as a miss', () => {
    const cs = [candidate(Lane.BD, 1000)];
    cs[0]!.hit = true;
    const events = detectMisses(cs, 5000);
    expect(events).toHaveLength(0);
    expect(cs[0]!.missed).toBe(false);
  });

  it('captures multiple simultaneous misses in one call', () => {
    const cs = [
      candidate(Lane.HH, 100),
      candidate(Lane.SD, 150),
      candidate(Lane.BD, 200),
    ];
    const events = detectMisses(cs, 500);
    expect(events.map((e) => e.lane).sort()).toEqual([Lane.BD, Lane.HH, Lane.SD].sort());
    for (const c of cs) expect(c.missed).toBe(true);
  });
});
