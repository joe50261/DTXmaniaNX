import { describe, expect, it } from 'vitest';
import type { BoxNode, ChartEntry, LibraryNode, SongEntry, SongNode } from '@dtxmania/dtx-core';
import { compareNodes, findBoxByPath, pickChartForSlot } from './song-wheel-model.js';

/**
 * Tests exercise SongWheel's pure decision helpers — the parts that hold
 * the wheel's navigation invariants (difficulty cycling, breadcrumb
 * restoration across rescans, sort ordering). DOM wiring lives in the
 * class and is out of scope here; it's validated by the dev build +
 * future Playwright pass.
 */

function makeChart(slot: number, label: string, overrides: Partial<ChartEntry> = {}): ChartEntry {
  return {
    slot,
    label,
    chartPath: `songs/${label.toLowerCase()}.dtx`,
    ...overrides,
  };
}

function makeSong(
  title: string,
  charts: ChartEntry[],
  overrides: Partial<SongEntry> = {}
): SongEntry {
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

describe('pickChartForSlot — difficulty-cycle destination', () => {
  const master = makeChart(3, 'MASTER');
  const extreme = makeChart(2, 'EXTREME');
  const regular = makeChart(1, 'REGULAR');
  const novice = makeChart(0, 'NOVICE');

  it('exact-slot match wins when the song has that difficulty', () => {
    const song = makeSong('x', [novice, regular, extreme, master]);
    expect(pickChartForSlot(song, 2)).toBe(extreme);
  });

  it('falls back to the nearest-higher slot when the preferred is absent', () => {
    // Player likes MASTER (3) but song only has NOVICE + REGULAR +
    // EXTREME. Nearest-higher is EXTREME (the "next up" after 3 → none,
    // so falls through to highest). Cover the regular-higher case:
    const song = makeSong('x', [novice, extreme]); // 0 + 2
    // Preferred 1 → nearest higher is 2 (EXTREME).
    expect(pickChartForSlot(song, 1)).toBe(extreme);
  });

  it('falls back to the highest available when no higher slot exists', () => {
    // Preferred is 4 (DTX), song has only 0+1+2. Highest = 2.
    const song = makeSong('x', [novice, regular, extreme]);
    expect(pickChartForSlot(song, 4)).toBe(extreme);
  });

  it('handles non-contiguous slot lists correctly', () => {
    // Only slots 1 + 3 present (a real DTXmania authoring pattern).
    const song = makeSong('x', [regular, master]);
    expect(pickChartForSlot(song, 0)?.slot).toBe(1); // next-higher from 0 is 1
    expect(pickChartForSlot(song, 1)?.slot).toBe(1); // exact
    expect(pickChartForSlot(song, 2)?.slot).toBe(3); // next-higher from 2 is 3
    expect(pickChartForSlot(song, 3)?.slot).toBe(3); // exact
    expect(pickChartForSlot(song, 4)?.slot).toBe(3); // fallback to highest
  });

  it('single-chart songs always return that chart regardless of preferred', () => {
    const song = makeSong('x', [regular]);
    for (const p of [0, 1, 2, 3, 4]) {
      expect(pickChartForSlot(song, p)).toBe(regular);
    }
  });
});

describe('findBoxByPath — rescan resume', () => {
  // Build a realistic tree. Box IDs (paths) are what survive rescans;
  // Box object identities do not, which is the whole reason this
  // lookup exists.
  function buildTree(): BoxNode {
    const root = makeBox('/', 'Songs');
    const rock = makeBox('Rock', 'Songs/Rock', root);
    const pop = makeBox('Pop', 'Songs/Pop', root);
    const ballads = makeBox('Ballads', 'Songs/Rock/Ballads', rock);
    root.children = [rock, pop];
    rock.children = [ballads];
    return root;
  }

  it('returns the matching box for the root path', () => {
    const t = buildTree();
    expect(findBoxByPath(t, 'Songs')).toBe(t);
  });

  it('finds a top-level child box by path', () => {
    const t = buildTree();
    expect(findBoxByPath(t, 'Songs/Rock')?.name).toBe('Rock');
  });

  it('descends through nested boxes', () => {
    const t = buildTree();
    expect(findBoxByPath(t, 'Songs/Rock/Ballads')?.name).toBe('Ballads');
  });

  it('returns null for a missing path so setRoot can fall back to root', () => {
    const t = buildTree();
    expect(findBoxByPath(t, 'Songs/Jazz')).toBeNull();
    expect(findBoxByPath(t, 'Songs/Rock/Missing')).toBeNull();
    expect(findBoxByPath(t, '')).toBeNull();
  });

  it('does not descend into song children — songs are not boxes', () => {
    // Safety: a SongNode's folderPath could in theory collide with a
    // box's path. findBoxByPath must never return a song.
    const root = makeBox('/', 'Songs');
    const rock = makeBox('Rock', 'Songs/Rock', root);
    root.children = [rock];
    rock.children = [songNode(rock, makeSong('s', [makeChart(0, 'DTX')]))];
    // Looking up a path that doesn't match any box returns null even
    // if a song with that folderPath exists — we only walk the box
    // spine.
    expect(findBoxByPath(root, 'Songs/Rock/s')).toBeNull();
  });
});

describe('compareNodes — sort-mode ordering', () => {
  const root = makeBox('/', 'Songs');
  const subBox = makeBox('ZFolder', 'Songs/ZFolder', root);
  const songA = songNode(
    root,
    makeSong('Alpha', [makeChart(2, 'EXT', { drumLevel: 800 })], { artist: 'Zed', bpm: 90 })
  );
  const songB = songNode(
    root,
    makeSong('Beta', [makeChart(2, 'EXT', { drumLevel: 500 })], { artist: 'Aaron', bpm: 200 })
  );
  const songC = songNode(
    root,
    makeSong('Charlie', [makeChart(2, 'EXT', { drumLevel: 200 })], { artist: 'Milo', bpm: 140 })
  );

  it('boxes always sort above songs regardless of mode', () => {
    for (const mode of ['title', 'artist', 'bpm', 'level'] as const) {
      expect(compareNodes(subBox, songA, mode)).toBeLessThan(0);
      expect(compareNodes(songA, subBox, mode)).toBeGreaterThan(0);
    }
  });

  it('boxes compared to boxes sort by name in title mode', () => {
    const boxA = makeBox('Alpha', 'Songs/Alpha', root);
    const boxZ = makeBox('Zebra', 'Songs/Zebra', root);
    expect(compareNodes(boxA, boxZ, 'title')).toBeLessThan(0);
    expect(compareNodes(boxZ, boxA, 'title')).toBeGreaterThan(0);
  });

  it('title mode: sorts alphabetically', () => {
    const sorted = [songC, songA, songB].sort((a, b) => compareNodes(a, b, 'title'));
    expect(sorted.map((s) => (s.type === 'song' ? s.entry.title : ''))).toEqual([
      'Alpha',
      'Beta',
      'Charlie',
    ]);
  });

  it('artist mode: sorts by artist, then by title as tiebreak', () => {
    // Zed (songA), Aaron (songB), Milo (songC) → Aaron < Milo < Zed
    const sorted = [songA, songB, songC].sort((a, b) => compareNodes(a, b, 'artist'));
    expect(sorted.map((s) => (s.type === 'song' ? s.entry.title : ''))).toEqual([
      'Beta',
      'Charlie',
      'Alpha',
    ]);
  });

  it('bpm mode: sorts ascending by bpm', () => {
    const sorted = [songA, songB, songC].sort((a, b) => compareNodes(a, b, 'bpm'));
    expect(sorted.map((s) => (s.type === 'song' ? s.entry.bpm : 0))).toEqual([90, 140, 200]);
  });

  it('level mode: sorts ascending by max drumLevel', () => {
    const sorted = [songA, songB, songC].sort((a, b) => compareNodes(a, b, 'level'));
    expect(sorted.map((s) => (s.type === 'song' ? s.entry.title : ''))).toEqual([
      'Charlie', // 200
      'Beta', // 500
      'Alpha', // 800
    ]);
  });

  it('level mode: songs with no parsed drumLevel sort to the top ("ungraded")', () => {
    // Matches DTXmania's convention: charts whose #DLEVEL hasn't been
    // parsed (or is 0) are treated as 0 → top. The regression this
    // guards is a silent "fall to bottom" that would bury newly-added
    // charts.
    const ungraded = songNode(
      root,
      makeSong('Ungraded', [makeChart(2, 'EXT')], { bpm: 120 })
    );
    const sorted = [songA, ungraded].sort((a, b) => compareNodes(a, b, 'level'));
    expect((sorted[0] as SongNode).entry.title).toBe('Ungraded');
  });

  it('artist / bpm tie-break falls back to title alphabetical', () => {
    const a = songNode(
      root,
      makeSong('Zebra', [makeChart(2, 'EXT', { drumLevel: 500 })], { artist: 'Same', bpm: 140 })
    );
    const b = songNode(
      root,
      makeSong('Apple', [makeChart(2, 'EXT', { drumLevel: 500 })], { artist: 'Same', bpm: 140 })
    );
    // Same artist → same primary; title breaks tie.
    expect(compareNodes(a, b, 'artist')).toBeGreaterThan(0);
    expect(compareNodes(a, b, 'bpm')).toBeGreaterThan(0);
    expect(compareNodes(a, b, 'level')).toBeGreaterThan(0);
  });

  it('songs with missing artist/bpm compare as empty/zero (sort to the front)', () => {
    const noMeta = songNode(root, makeSong('NoMeta', [makeChart(2, 'EXT')]));
    const withMeta = songNode(
      root,
      makeSong('WithMeta', [makeChart(2, 'EXT')], { artist: 'Z', bpm: 150 })
    );
    expect(compareNodes(noMeta, withMeta, 'artist')).toBeLessThan(0);
    expect(compareNodes(noMeta, withMeta, 'bpm')).toBeLessThan(0);
  });
});
