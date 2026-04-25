import { describe, expect, it } from 'vitest';
import type {
  BoxNode,
  ChartEntry,
  ChartRecord,
  LibraryNode,
  SongEntry,
  SongNode,
} from '@dtxmania/dtx-core';
import {
  buildBreadcrumbPath,
  buildDisplayEntries,
  cycleDifficultySlot,
  cycleFocus,
  lampTier,
  pickRandomSongIn,
  rowTitle,
  SORT_MODES,
} from './song-wheel-model.js';

/**
 * Exercises the shared model module that both `song-wheel.ts` (DOM)
 * and `song-select-canvas.ts` (Canvas) subscribe to. These tests are the contract
 * the two views agree on — if one of them starts doing its own thing,
 * it should instead extend this module.
 *
 * `compareNodes`, `findBoxByPath`, `pickChartForSlot` are covered in
 * `song-wheel.test.ts` (their tests predate the extraction).
 */

function makeChart(slot: number, label: string, overrides: Partial<ChartEntry> = {}): ChartEntry {
  return {
    slot,
    label,
    chartPath: `songs/${label.toLowerCase()}.dtx`,
    ...overrides,
  };
}

function makeSong(title: string, charts: ChartEntry[], overrides: Partial<SongEntry> = {}): SongEntry {
  return {
    title,
    folderPath: `songs/${title}`,
    fromSetDef: false,
    charts,
    ...overrides,
  };
}

function makeBox(
  name: string,
  path: string,
  parent: BoxNode | null = null,
  children: LibraryNode[] = []
): BoxNode {
  const box: BoxNode = { type: 'box', name, path, parent, children };
  for (const c of children) c.parent = box;
  return box;
}

function songNode(parent: BoxNode, song: SongEntry): SongNode {
  return { type: 'song', entry: song, parent };
}

describe('SORT_MODES — advancement order', () => {
  // The desktop SongWheel `cycleSortMode` button steps through this
  // tuple in order; changing the order shuffles the player's muscle
  // memory, so pin it down.
  it('steps title → level → bestRank → playCount → artist → bpm (matches C# CActSortSongs.EOrder for the canonical modes, with bpm appended)', () => {
    expect([...SORT_MODES]).toEqual([
      'title',
      'level',
      'bestRank',
      'playCount',
      'artist',
      'bpm',
    ]);
  });
});

describe('cycleFocus — index wrap arithmetic', () => {
  it('wraps forward past the end', () => {
    expect(cycleFocus(4, 5, 1)).toBe(0);
  });
  it('wraps backward past the start', () => {
    expect(cycleFocus(0, 5, -1)).toBe(4);
  });
  it('handles multi-step deltas', () => {
    expect(cycleFocus(2, 5, 3)).toBe(0);
    expect(cycleFocus(2, 5, -4)).toBe(3);
  });
  it('returns 0 for an empty list so callers don\'t have to guard', () => {
    expect(cycleFocus(0, 0, 1)).toBe(0);
    expect(cycleFocus(5, 0, -3)).toBe(0);
  });
});

describe('cycleDifficultySlot — step through a song\'s available slots', () => {
  it('cycles forward through contiguous slots', () => {
    const song = makeSong('x', [makeChart(0, 'N'), makeChart(1, 'R'), makeChart(2, 'E')]);
    expect(cycleDifficultySlot(song, 0, 1)).toBe(1);
    expect(cycleDifficultySlot(song, 1, 1)).toBe(2);
    expect(cycleDifficultySlot(song, 2, 1)).toBe(0); // wraps
  });

  it('cycles only through slots that actually exist (non-contiguous case)', () => {
    // Song has slot 1 + 3 only. Cycling from 1 → 3 → 1 → ..., never
    // lands on 0/2/4. Mirrors a real DTXmania authoring pattern.
    const song = makeSong('x', [makeChart(1, 'R'), makeChart(3, 'M')]);
    expect(cycleDifficultySlot(song, 1, 1)).toBe(3);
    expect(cycleDifficultySlot(song, 3, 1)).toBe(1);
    expect(cycleDifficultySlot(song, 3, -1)).toBe(1);
  });

  it('when the "current" slot is absent, steps from the effective (nearest-higher) slot', () => {
    // Preferred 2 maps to effective 3; stepping +1 from 3 wraps to 1.
    const song = makeSong('x', [makeChart(1, 'R'), makeChart(3, 'M')]);
    expect(cycleDifficultySlot(song, 2, 1)).toBe(1);
  });

  it('returns the input slot when the song has no charts (no-op guard)', () => {
    const song = makeSong('x', []);
    expect(cycleDifficultySlot(song, 3, 1)).toBe(3);
  });
});

describe('buildDisplayEntries — flat list for one box', () => {
  function tree() {
    const root = makeBox('/', 'Songs');
    const boxA = makeBox('A', 'Songs/A', root);
    const boxB = makeBox('B', 'Songs/B', root);
    const songX = songNode(root, makeSong('X', [makeChart(2, 'E')], { artist: 'Bravo' }));
    const songY = songNode(root, makeSong('Y', [makeChart(2, 'E')], { artist: 'Alpha' }));
    root.children = [boxA, boxB, songX, songY];
    return { root, boxA, boxB, songX, songY };
  }

  it('at root: no BACK entry, Random + children', () => {
    const { root } = tree();
    const out = buildDisplayEntries(root);
    expect(out[0]?.kind).toBe('random');
    // 1 random + 4 children = 5 entries.
    expect(out).toHaveLength(5);
    expect(out.find((e) => e.kind === 'back')).toBeUndefined();
  });

  it('in a child box: BACK + Random + children, in that order', () => {
    const { root, boxA } = tree();
    const out = buildDisplayEntries(boxA);
    expect(out[0]?.kind).toBe('back');
    expect(out[1]?.kind).toBe('random');
    void root;
  });

  it('null box returns an empty list', () => {
    expect(buildDisplayEntries(null)).toEqual([]);
  });

  it('applying sort reorders children (BACK + Random stay at top)', () => {
    const { root } = tree();
    const out = buildDisplayEntries(root, { sort: 'artist' });
    // Artist sort: Alpha (Y) < Bravo (X). Boxes come first regardless.
    const realChildren = out.filter((e) => e.kind === 'node').map((e) => {
      const n = (e as { kind: 'node'; node: LibraryNode }).node;
      return n.type === 'box' ? n.name : n.entry.title;
    });
    expect(realChildren).toEqual(['A', 'B', 'Y', 'X']);
  });

  it('sort: bestRank — songs with a higher record rank float to the top', () => {
    const root = makeBox('/', 'Songs');
    const make = (title: string, rank: ChartRecord['bestRank'] | null) => {
      const chart = makeChart(2, 'E');
      if (rank) {
        chart.record = {
          chartPath: chart.chartPath,
          bestScore: 0,
          bestRank: rank,
          bestAchievement: 0,
          fullCombo: false,
          excellent: false,
          plays: 1,
          lastPlayedMs: 0,
        };
      }
      return songNode(root, makeSong(title, [chart]));
    };
    const sUnplayed = make('Z-unplayed', null);
    const sC = make('Y-C', 'C');
    const sSS = make('X-SS', 'SS');
    root.children = [sUnplayed, sC, sSS];
    const out = buildDisplayEntries(root, { sort: 'bestRank' });
    const titles = out
      .filter((e) => e.kind === 'node')
      .map((e) => ((e as { kind: 'node'; node: SongNode }).node).entry.title);
    // SS first (best), then C, then unplayed last.
    expect(titles).toEqual(['X-SS', 'Y-C', 'Z-unplayed']);
  });

  it('sort: playCount — most-played songs float to the top', () => {
    const root = makeBox('/', 'Songs');
    const make = (title: string, plays: number) => {
      const chart = makeChart(2, 'E');
      if (plays > 0) {
        chart.record = {
          chartPath: chart.chartPath,
          bestScore: 0,
          bestRank: 'C',
          bestAchievement: 0,
          fullCombo: false,
          excellent: false,
          plays,
          lastPlayedMs: 0,
        };
      }
      return songNode(root, makeSong(title, [chart]));
    };
    const s0 = make('Z-zero', 0);
    const s5 = make('Y-five', 5);
    const s99 = make('X-ninety-nine', 99);
    root.children = [s0, s5, s99];
    const out = buildDisplayEntries(root, { sort: 'playCount' });
    const titles = out
      .filter((e) => e.kind === 'node')
      .map((e) => ((e as { kind: 'node'; node: SongNode }).node).entry.title);
    expect(titles).toEqual(['X-ninety-nine', 'Y-five', 'Z-zero']);
  });

  it('search filter: only children whose title contains the query survive; BACK + Random stay', () => {
    const { boxA } = tree();
    const out = buildDisplayEntries(boxA, { searchQuery: 'will-not-match' });
    expect(out.filter((e) => e.kind === 'node')).toHaveLength(0);
    expect(out[0]?.kind).toBe('back');
    expect(out[1]?.kind).toBe('random');
  });

  it('search is case-insensitive and trims whitespace', () => {
    const { root } = tree();
    const out = buildDisplayEntries(root, { searchQuery: '  x  ' });
    const children = out.filter((e) => e.kind === 'node');
    expect(children).toHaveLength(1);
    const only = (children[0] as { kind: 'node'; node: LibraryNode }).node;
    expect(only.type === 'song' && only.entry.title).toBe('X');
  });
});

describe('buildBreadcrumbPath — root → ... → current', () => {
  it('returns empty for null', () => {
    expect(buildBreadcrumbPath(null)).toEqual([]);
  });

  it('single segment when the current box is root', () => {
    const root = makeBox('Songs', 'Songs');
    const segs = buildBreadcrumbPath(root);
    expect(segs).toHaveLength(1);
    expect(segs[0]?.node).toBe(root);
    expect(segs[0]?.current).toBe(true);
  });

  it('root → ... → current, with only the last marked current', () => {
    const root = makeBox('Songs', 'Songs');
    const rock = makeBox('Rock', 'Songs/Rock', root);
    const ballads = makeBox('Ballads', 'Songs/Rock/Ballads', rock);
    const segs = buildBreadcrumbPath(ballads);
    expect(segs.map((s) => s.node.name)).toEqual(['Songs', 'Rock', 'Ballads']);
    expect(segs.map((s) => s.current)).toEqual([false, false, true]);
  });
});

describe('pickRandomSongIn — deep DFS over the subtree', () => {
  it('returns null for a box with no songs anywhere under it', () => {
    const empty = makeBox('Empty', 'Empty');
    expect(pickRandomSongIn(empty)).toBeNull();
  });

  it('returns the only song when there\'s exactly one', () => {
    const root = makeBox('/', 'Songs');
    const song = makeSong('Solo', [makeChart(0, 'N')]);
    root.children = [songNode(root, song)];
    expect(pickRandomSongIn(root)).toBe(song);
  });

  it('finds a song nested under multiple boxes', () => {
    const root = makeBox('/', 'Songs');
    const deep = makeBox('Deep', 'Songs/Deep', root);
    const song = makeSong('Nested', [makeChart(0, 'N')]);
    deep.children = [songNode(deep, song)];
    root.children = [deep];
    expect(pickRandomSongIn(root)).toBe(song);
  });
});

describe('rowTitle — emoji + glyph conventions', () => {
  it('formats BACK with up-arrow + parent name', () => {
    const parent = makeBox('Parent', 'P');
    expect(rowTitle({ kind: 'back', parent })).toBe('⬆  ..  (Parent)');
  });
  it('formats RANDOM with die emoji', () => {
    const box = makeBox('B', 'B');
    expect(rowTitle({ kind: 'random', box })).toBe('🎲  Random');
  });
  it('formats a box with folder emoji', () => {
    const parent = makeBox('/', '/');
    const box = makeBox('Folder', 'folder', parent);
    expect(rowTitle({ kind: 'node', node: box })).toBe('📁  Folder');
  });
  it('formats a song with its title (no decoration)', () => {
    const parent = makeBox('/', '/');
    const song = songNode(parent, makeSong('My Song', [makeChart(0, 'N')]));
    expect(rowTitle({ kind: 'node', node: song })).toBe('My Song');
  });
});

describe('lampTier — record → tier', () => {
  it('returns null for never-played charts', () => {
    expect(lampTier(makeChart(0, 'N'))).toBeNull();
  });
  function makeRecord(overrides: Partial<ChartRecord>): ChartRecord {
    return {
      chartPath: 'songs/x.dtx',
      bestScore: 0,
      bestRank: 'C',
      bestAchievement: 0,
      fullCombo: false,
      excellent: false,
      plays: 1,
      lastPlayedMs: 0,
      ...overrides,
    };
  }
  it('excellent beats full-combo', () => {
    const chart = makeChart(0, 'N', {
      record: makeRecord({ bestScore: 1_000_000, bestRank: 'SS', excellent: true, fullCombo: true }),
    });
    expect(lampTier(chart)).toBe('excellent');
  });
  it('full-combo beats played', () => {
    const chart = makeChart(0, 'N', {
      record: makeRecord({ bestScore: 900_000, bestRank: 'S', fullCombo: true }),
    });
    expect(lampTier(chart)).toBe('fullCombo');
  });
  it('played = record exists but neither excellent nor FC', () => {
    const chart = makeChart(0, 'N', {
      record: makeRecord({ bestScore: 500_000, bestRank: 'B' }),
    });
    expect(lampTier(chart)).toBe('played');
  });
});
