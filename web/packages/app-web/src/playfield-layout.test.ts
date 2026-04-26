import { describe, expect, it } from 'vitest';
import { Lane } from '@dtxmania/input';
import {
  laneFlushAsset,
  LANE_FLUSH_ASSET_FORWARD,
  LANE_FLUSH_FORWARD_FILES,
  LANE_FLUSH_FRAME_COUNT,
  LANE_FLUSH_FRAME_H,
  LANE_FLUSH_FRAME_W,
  LANE_FLUSH_LIFETIME_MS,
  LANE_FLUSH_TRAVEL_PX,
} from './playfield-layout.js';

describe('lane-flush layout — sprite geometry', () => {
  it('matches CActPerfDrumsLaneFlushD constants', () => {
    expect(LANE_FLUSH_FRAME_W).toBe(42);
    expect(LANE_FLUSH_FRAME_H).toBe(128);
    expect(LANE_FLUSH_FRAME_COUNT).toBe(3);
    expect(LANE_FLUSH_LIFETIME_MS).toBe(500);
    expect(LANE_FLUSH_TRAVEL_PX).toBe(740);
  });
});

describe('lane-flush layout — per-lane asset map', () => {
  it('covers every drum lane', () => {
    for (const lane of [Lane.LC, Lane.HH, Lane.LP, Lane.SD, Lane.HT, Lane.BD, Lane.LT, Lane.FT, Lane.CY, Lane.RD, Lane.LBD]) {
      expect(LANE_FLUSH_ASSET_FORWARD[lane]).toMatch(/^ScreenPlayDrums lane flush /);
    }
  });

  it('LBD shares the BD asset (no separate left-pedal-bass asset)', () => {
    expect(LANE_FLUSH_ASSET_FORWARD[Lane.LBD]).toBe(LANE_FLUSH_ASSET_FORWARD[Lane.BD]);
  });

  it('unique-file list excludes the duplicate BD/LBD and CY/RD assets', () => {
    // 11 logical lanes minus 2 dedupes (LBD↔BD share bass.png,
    // RD↔CY share cymbal.png since the bundled skin has no
    // dedicated ridecymbal asset) ⇒ 9 unique fetches.
    expect(LANE_FLUSH_FORWARD_FILES.length).toBe(9);
  });
});

describe('lane-flush layout — laneFlushAsset()', () => {
  it('returns the correct filename for known lanes', () => {
    expect(laneFlushAsset(Lane.SD)).toBe('ScreenPlayDrums lane flush snare.png');
    // RD shares the cymbal asset because no `ridecymbal.png` ships.
    expect(laneFlushAsset(Lane.RD)).toBe('ScreenPlayDrums lane flush cymbal.png');
  });

  it('returns null for an unknown numeric value', () => {
    // Using a non-LaneValue number to simulate corrupt input.
    expect(laneFlushAsset(99 as unknown as typeof Lane.SD)).toBe(null);
  });
});
