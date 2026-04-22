import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeTiming, parseDtx, Judgment, computeAchievementRate, computeRank } from '@dtxmania/dtx-core';
import { Lane, type LaneValue } from '@dtxmania/input';
import { channelToLane } from './lane-layout.js';
import { perfectScriptFor, simulatePlaythrough } from './simulate.js';

// Reuse dtx-core's hand-authored test chart. Small enough to reason
// about by inspection but exercises multiple lanes + mid-song BPM
// changes, which means the timing math gets a real workout.
const here = dirname(fileURLToPath(import.meta.url));
const dtxPath = join(here, '..', '..', 'dtx-core', 'tests', 'fixtures', 'simple-rock.dtx');
const dtxText = readFileSync(dtxPath, 'utf-8');
const song = computeTiming(parseDtx(dtxText));

// Count chips per visual lane for sanity assertions.
const chipsByLane: Map<LaneValue, number> = (() => {
  const m = new Map<LaneValue, number>();
  for (const c of song.chips) {
    const lane = channelToLane(c.channel);
    if (!lane) continue;
    m.set(lane.lane, (m.get(lane.lane) ?? 0) + 1);
  }
  return m;
})();
const totalPlayable = Array.from(chipsByLane.values()).reduce((a, b) => a + b, 0);

const ALL_LANES = new Set<LaneValue>([
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

describe('simulatePlaythrough: headless game loop', () => {
  it('all lanes auto → every chip counted as auto, rank collapses to E', () => {
    const snap = simulatePlaythrough(song, { autoLanes: ALL_LANES });
    expect(snap.autoCount).toBe(totalPlayable);
    expect(snap.counts[Judgment.MISS]).toBe(0);
    expect(snap.counts[Judgment.PERFECT]).toBe(0);
    expect(snap.score).toBe(0);
    expect(computeRank(computeAchievementRate(snap), snap.totalNotes)).toBe('E');
  });

  it('no input and no auto → every chip scored as MISS', () => {
    const snap = simulatePlaythrough(song);
    expect(snap.counts[Judgment.MISS]).toBe(totalPlayable);
    expect(snap.maxCombo).toBe(0);
    expect(snap.autoCount).toBe(0);
    expect(snap.score).toBe(0);
  });

  it('scripted perfect run on every lane → all PERFECT, full combo, top rank', () => {
    const script = perfectScriptFor(song, ALL_LANES);
    const snap = simulatePlaythrough(song, { scripted: script });
    expect(snap.counts[Judgment.PERFECT]).toBe(totalPlayable);
    expect(snap.counts[Judgment.MISS]).toBe(0);
    expect(snap.maxCombo).toBe(totalPlayable);
    expect(snap.score).toBe(1_000_000);
    // Perfect + full combo + every note PERFECT → SS.
    expect(computeRank(computeAchievementRate(snap), snap.totalNotes)).toBe('SS');
  });

  it('auto-kick only (BD + LBD) + perfect play on the rest → rank SS, kicks excluded from denominator', () => {
    const autoLanes = new Set<LaneValue>([Lane.BD, Lane.LBD]);
    const humanLanes = new Set<LaneValue>(
      [...ALL_LANES].filter((l) => !autoLanes.has(l)),
    );
    const script = perfectScriptFor(song, humanLanes);
    const snap = simulatePlaythrough(song, { autoLanes, scripted: script });
    const autoPlayable = (chipsByLane.get(Lane.BD) ?? 0) + (chipsByLane.get(Lane.LBD) ?? 0);
    const humanPlayable = totalPlayable - autoPlayable;
    expect(snap.autoCount).toBe(autoPlayable);
    expect(snap.counts[Judgment.PERFECT]).toBe(humanPlayable);
    expect(snap.counts[Judgment.MISS]).toBe(0);
    // Effective denominator excludes the auto kicks; a perfect run on
    // the remaining lanes still hits the 1 M ceiling.
    expect(snap.score).toBe(1_000_000);
    expect(computeRank(computeAchievementRate(snap), snap.totalNotes)).toBe('SS');
  });

  it('late-by-50ms press on every chip → all GREAT (outside PERFECT, inside GREAT)', () => {
    // PERFECT ±34, GREAT ±67. 50 ms is inside GREAT but past PERFECT.
    const script = perfectScriptFor(song, ALL_LANES).map((h) => ({
      ...h,
      timeMs: h.timeMs + 50,
    }));
    const snap = simulatePlaythrough(song, { scripted: script });
    expect(snap.counts[Judgment.GREAT]).toBe(totalPlayable);
    expect(snap.counts[Judgment.PERFECT]).toBe(0);
    expect(snap.counts[Judgment.MISS]).toBe(0);
    expect(snap.maxCombo).toBe(totalPlayable);
  });

  it('press beyond POOR window on every chip → script hits registered as strays (no tracker change), every chip miss-detected', () => {
    // POOR window = ±117 ms; chips in this chart are at ≥ 250 ms
    // spacing per lane. Pressing at chip + 125 puts every press
    // squarely between adjacent chip windows (target delta 125,
    // next-chip delta -125, both outside POOR), so no match on any
    // chip → pure stray path, and each chip expires as MISS on its
    // own when its POOR window passes.
    const script = perfectScriptFor(song, ALL_LANES).map((h) => ({
      ...h,
      timeMs: h.timeMs + 125,
    }));
    const snap = simulatePlaythrough(song, { scripted: script });
    expect(snap.counts[Judgment.MISS]).toBe(totalPlayable);
    expect(snap.counts[Judgment.PERFECT]).toBe(0);
    expect(snap.counts[Judgment.GREAT]).toBe(0);
  });
});
