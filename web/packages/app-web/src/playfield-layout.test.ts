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
  PARET_ASSET,
  PARET_LANE_SLICE,
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

describe('7_Paret.png lane chrome — slice table', () => {
  it('matches the C# CActPerfDrumsLaneFlushD.cs Type-A slice rects', () => {
    // Pinned to lines 189-298. Exact src x / w per lane.
    expect(PARET_LANE_SLICE[Lane.LC]).toEqual({ sx: 0,   sw: 72 });
    expect(PARET_LANE_SLICE[Lane.HH]).toEqual({ sx: 72,  sw: 49 });
    expect(PARET_LANE_SLICE[Lane.LP]).toEqual({ sx: 121, sw: 51 });
    expect(PARET_LANE_SLICE[Lane.SD]).toEqual({ sx: 172, sw: 57 });
    expect(PARET_LANE_SLICE[Lane.HT]).toEqual({ sx: 229, sw: 49 });
    expect(PARET_LANE_SLICE[Lane.BD]).toEqual({ sx: 278, sw: 69 });
    expect(PARET_LANE_SLICE[Lane.LT]).toEqual({ sx: 347, sw: 49 });
    expect(PARET_LANE_SLICE[Lane.FT]).toEqual({ sx: 396, sw: 54 });
    expect(PARET_LANE_SLICE[Lane.CY]).toEqual({ sx: 450, sw: 70 });
    expect(PARET_LANE_SLICE[Lane.RD]).toEqual({ sx: 520, sw: 38 });
  });

  it('LBD / HHO share their main-lane slices', () => {
    expect(PARET_LANE_SLICE[Lane.LBD]).toEqual(PARET_LANE_SLICE[Lane.BD]);
    expect(PARET_LANE_SLICE[Lane.HHO]).toEqual(PARET_LANE_SLICE[Lane.HH]);
  });

  it('PARET_ASSET filename matches the canonical Runtime path', () => {
    expect(PARET_ASSET).toBe('7_Paret.png');
  });

  it('every slice src rect stays inside the 558-px source width', () => {
    for (const slice of Object.values(PARET_LANE_SLICE)) {
      if (!slice) continue;
      expect(slice.sx).toBeGreaterThanOrEqual(0);
      expect(slice.sx + slice.sw).toBeLessThanOrEqual(558);
    }
  });
});
