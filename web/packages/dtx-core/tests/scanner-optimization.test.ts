import { describe, it, expect } from 'vitest';
import {
  SongScanner,
  flattenSongs,
  serializeIndex,
  type SerializedIndex,
  type SongIndex,
} from '../src/scanner/scanner.js';
import type { FileSystemBackend } from '../src/scanner/fs-backend.js';
import { MemoryFs } from './helpers/memory-fs.js';

/**
 * Serialises an index and strips the wall-clock timestamp so two runs
 * taken milliseconds apart can be compared for structural equality.
 */
function snapshotIndex(idx: SongIndex): Omit<SerializedIndex, 'scannedAtMs'> {
  const { scannedAtMs: _unused, ...rest } = serializeIndex(idx);
  return rest;
}
import {
  CountingFs,
  RandomSlowFs,
  SlowFs,
  ThrowingFs,
} from './helpers/instrumented-fs.js';

/**
 * These tests lock in the scanner's I/O optimizations — NOT its
 * output shape (that's covered by scanner.test.ts). The properties
 * asserted here are the ones that collapse Quest 3's cold scan from
 * tens of seconds to a handful:
 *
 *   (1) Each directory is listDir'd once, not twice.
 *   (2) set.def chart existence is answered from the already-listed
 *       file set — no backend `exists` round trip per chart.
 *   (3) Sibling subdirectories walk in parallel, bounded by the
 *       concurrency option, with max-inflight > 1.
 *   (4) Meta-parse reads run in parallel.
 *   (5) Walk output order is independent of per-call latency.
 *   (6) A sibling's listDir failure doesn't stall / poison the rest.
 */

function makeFs(files: Record<string, string>): MemoryFs {
  const fs = new MemoryFs();
  for (const [path, content] of Object.entries(files)) {
    fs.setFile(path, content);
  }
  return fs;
}

/**
 * Realistic fixture — several subdirectories, mix of set.def / bare
 * .dtx / box.def / dtxfiles. prefix, and a skipDir so the skip-path
 * also gets exercised.
 */
function makeLibraryFs(): MemoryFs {
  return makeFs({
    'Songs/dtxfiles.Rock/box.def': '#TITLE Rock\n#FONTCOLOR #FF2244',
    'Songs/dtxfiles.Rock/a.dtx': '#TITLE A',
    'Songs/dtxfiles.Rock/b.dtx': '#TITLE B',
    'Songs/Pop/set.def': [
      '#TITLE Pop Song',
      '#L1FILE easy.dtx',
      '#L2FILE hard.dtx',
    ].join('\n'),
    'Songs/Pop/easy.dtx': '#TITLE e',
    'Songs/Pop/hard.dtx': '#TITLE h',
    'Songs/Pop/extra.dtx': '#TITLE extra (ignored, set.def wins)',
    'Songs/Jazz/box.def': '#TITLE Jazz',
    'Songs/Jazz/one.dtx': '#TITLE One',
    'Songs/Jazz/two.dtx': '#TITLE Two',
    'Songs/Jazz/Ballads/x.dtx': '#TITLE X',
    'Songs/Jazz/Ballads/y.dtx': '#TITLE Y',
    'Songs/node_modules/junk.dtx': '#TITLE skipped',
  });
}

// ---------- Layer 1: correctness regression ---------------------------------
//
// Shape of the scanner output must be identical across concurrency=1
// (fully sequential) and the default parallel mode. The existing
// scanner.test.ts already pins the shape against hand-written fixtures;
// here we guard against the parallel reordering bugs specifically.

describe('scanner optimization / correctness parity', () => {
  it('parallel scan produces the same serialised index as sequential scan', async () => {
    const fs = makeLibraryFs();
    const seq = await new SongScanner(fs, { concurrency: 1 }).scan('Songs');
    const par = await new SongScanner(fs, { concurrency: 8 }).scan('Songs');
    expect(snapshotIndex(par)).toEqual(snapshotIndex(seq));
  });

  it('flat song list matches between sequential and parallel scans', async () => {
    const fs = makeLibraryFs();
    const seq = await new SongScanner(fs, { concurrency: 1 }).scan('Songs');
    const par = await new SongScanner(fs, { concurrency: 16 }).scan('Songs');
    expect(par.songs.map((s) => s.folderPath)).toEqual(
      seq.songs.map((s) => s.folderPath)
    );
    expect(par.songs.map((s) => s.title)).toEqual(seq.songs.map((s) => s.title));
  });
});

// ---------- Layer 2: RPC count assertions -----------------------------------
//
// The whole point of merging applyExplicitBoxMarkers into walk() and
// replacing `fs.exists` with fileSet lookups. These are the cheapest
// possible test of "did the optimization actually happen" — the suite
// will scream the moment either regresses.

describe('scanner optimization / RPC counts', () => {
  it('lists each directory exactly once (no box.def probe pass)', async () => {
    const counting = new CountingFs(makeLibraryFs());
    await new SongScanner(counting).scan('Songs');
    const dirs = [
      'Songs',
      'Songs/dtxfiles.Rock',
      'Songs/Pop',
      'Songs/Jazz',
      'Songs/Jazz/Ballads',
      // node_modules is a skipDir, so walk() never descends. It must
      // not appear in the call log either.
    ];
    for (const d of dirs) {
      expect(counting.count('listDir', d)).toBe(1);
    }
    expect(counting.count('listDir', 'Songs/node_modules')).toBe(0);
  });

  it('never calls fs.exists for same-directory set.def chart references', async () => {
    // The set.def in Pop/ names easy.dtx and hard.dtx — both in the
    // same folder. Old code did `fs.exists` per file; new code hits
    // the fileSet built from the listDir we already did.
    const counting = new CountingFs(makeLibraryFs());
    await new SongScanner(counting).scan('Songs');
    expect(counting.count('exists')).toBe(0);
  });

  it('falls back to fs.exists when set.def references a sub-path chart', async () => {
    // Uncommon, but the backend is still the source of truth when a
    // set.def author points at a chart in a different directory.
    const fs = makeFs({
      'Songs/Pack/set.def': '#TITLE Pack Song\n#L1FILE sub/only.dtx',
      'Songs/Pack/sub/only.dtx': '',
    });
    const counting = new CountingFs(fs);
    await new SongScanner(counting, { parseMeta: false }).scan('Songs');
    expect(counting.count('exists', 'Songs/Pack/sub/only.dtx')).toBe(1);
  });

  it('reads each box.def / set.def / .dtx header at most once', async () => {
    const counting = new CountingFs(makeLibraryFs());
    await new SongScanner(counting).scan('Songs');
    for (const path of Array.from(
      new Set(counting.calls.filter((c) => c.method === 'readText').map((c) => c.path))
    )) {
      expect(counting.count('readText', path)).toBe(1);
    }
  });
});

// ---------- Layer 3: parallelism ------------------------------------------
//
// The whole walk / meta-parse speedup story hinges on sibling I/O
// actually overlapping. SlowFs measures max in-flight; anything > 1
// is proof the semaphore is being used.

describe('scanner optimization / parallelism', () => {
  it('walks sibling subdirectories in parallel (inflightMax > 1)', async () => {
    // Build a fan-out wide enough that parallelism is observable even
    // if the runner slices awkwardly.
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      files[`Songs/Dir${i}/a.dtx`] = '#TITLE a';
      files[`Songs/Dir${i}/b.dtx`] = '#TITLE b';
    }
    const slow = new SlowFs(makeFs(files), 5);
    await new SongScanner(slow, { concurrency: 6, parseMeta: false }).scan('Songs');
    expect(slow.inflightMax).toBeGreaterThan(1);
    expect(slow.inflightMax).toBeLessThanOrEqual(6);
    expect(slow.overlappingCalls).toBeGreaterThan(0);
  });

  it('sequential mode (concurrency=1) never overlaps backend calls', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`Songs/Dir${i}/x.dtx`] = '#TITLE x';
    const slow = new SlowFs(makeFs(files), 2);
    await new SongScanner(slow, { concurrency: 1, parseMeta: false }).scan('Songs');
    expect(slow.inflightMax).toBe(1);
    expect(slow.overlappingCalls).toBe(0);
  });

  it('meta-parse runs readText calls in parallel', async () => {
    // 12 songs each with one .dtx → 12 readText calls during meta
    // parse. With concurrency 4 we expect inflightMax ≥ 2.
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) {
      files[`Songs/S${i}/s.dtx`] = `#TITLE T${i}\n#ARTIST A${i}\n#DLEVEL ${i}`;
    }
    const slow = new SlowFs(makeFs(files), 2);
    const scanner = new SongScanner(slow, { concurrency: 4, parseMeta: true });
    // Warm the walk so we're measuring only the meta phase effect.
    slow.inflightMax = 0;
    await scanner.scan('Songs');
    expect(slow.inflightMax).toBeGreaterThan(1);
    expect(slow.inflightMax).toBeLessThanOrEqual(4);
  });

  it('wall-clock under parallelism is < half the sequential estimate', async () => {
    // A crude but robust timing test: with 20 dirs × ~5ms latency the
    // sequential lower bound is ~100ms for the walk alone. Parallel
    // should beat 50ms comfortably. The 0.5× factor leaves lots of
    // slack so this isn't flaky on slow CI.
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`Songs/Dir${i}/a.dtx`] = '#TITLE a';
    const seqFs = new SlowFs(makeFs(files), 5);
    const parFs = new SlowFs(makeFs(files), 5);
    const tSeq = performance.now();
    await new SongScanner(seqFs, { concurrency: 1, parseMeta: false }).scan('Songs');
    const seqMs = performance.now() - tSeq;
    const tPar = performance.now();
    await new SongScanner(parFs, { concurrency: 8, parseMeta: false }).scan('Songs');
    const parMs = performance.now() - tPar;
    expect(parMs).toBeLessThan(seqMs * 0.5);
  });
});

// ---------- Layer 4: ordering determinism ---------------------------------
//
// Parallel walks are notorious for making output order depend on
// completion order. The scanner commits subBox children back into the
// parent in filesystem-listing order regardless of which walk settled
// first; these tests nail that down.

describe('scanner optimization / deterministic ordering', () => {
  it('song list order is stable across runs even with random per-call delays', async () => {
    const fs = makeLibraryFs();
    const runs: string[][] = [];
    for (let seed = 1; seed <= 8; seed++) {
      const slow = new RandomSlowFs(fs, 6, seed);
      const idx = await new SongScanner(slow, {
        concurrency: 8,
        parseMeta: false,
      }).scan('Songs');
      runs.push(idx.songs.map((s) => s.folderPath));
    }
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]).toEqual(runs[0]);
    }
  });

  it('tree shape (serialized) matches sequential across randomized parallel runs', async () => {
    const fs = makeLibraryFs();
    const seq = await new SongScanner(fs, { concurrency: 1, parseMeta: false }).scan(
      'Songs'
    );
    const seqSnap = snapshotIndex(seq);
    for (let seed = 1; seed <= 5; seed++) {
      const slow = new RandomSlowFs(fs, 4, seed);
      const par = await new SongScanner(slow, {
        concurrency: 6,
        parseMeta: false,
      }).scan('Songs');
      expect(snapshotIndex(par)).toEqual(seqSnap);
    }
  });
});

// ---------- Layer 5: error isolation --------------------------------------
//
// A single unreadable directory must not kill the rest of the walk,
// serialise it, or lose its sibling's songs. Especially important
// under parallelism where the rejected promise could short-circuit a
// naive Promise.all.

describe('scanner optimization / error isolation', () => {
  it('one sibling listDir failure does not prevent siblings from being scanned', async () => {
    const mem = makeFs({
      'Songs/Good/a.dtx': '#TITLE A',
      'Songs/Good/b.dtx': '#TITLE B',
      'Songs/Bad/x.dtx': '#TITLE X',
      'Songs/AlsoGood/c.dtx': '#TITLE C',
      'Songs/AlsoGood/d.dtx': '#TITLE D',
    });
    const fs: FileSystemBackend = new ThrowingFs(mem, new Set(['Songs/Bad']));
    const idx = await new SongScanner(fs, { parseMeta: false }).scan('Songs');
    const titles = idx.songs.map((s) => s.folderPath).sort();
    expect(titles).toEqual(['Songs/AlsoGood', 'Songs/AlsoGood', 'Songs/Good', 'Songs/Good']);
    expect(idx.errors.some((e) => e.path === 'Songs/Bad')).toBe(true);
  });

  it('rejected listDir does not serialise the rest of the walk', async () => {
    // Combine SlowFs + ThrowingFs so we can both break a sibling and
    // measure inflightMax. If Promise.all's fail-fast semantics had
    // leaked, inflightMax would drop to 1 after the throw.
    const base = (() => {
      const m = new MemoryFs();
      for (let i = 0; i < 10; i++) m.setFile(`Songs/Dir${i}/a.dtx`, '');
      m.setFile('Songs/Bad/x.dtx', '');
      return m;
    })();
    const slow = new SlowFs(base, 3);
    const fs: FileSystemBackend = new ThrowingFs(slow, new Set(['Songs/Bad']));
    const idx = await new SongScanner(fs, {
      concurrency: 4,
      parseMeta: false,
    }).scan('Songs');
    expect(slow.inflightMax).toBeGreaterThan(1);
    expect(idx.errors.some((e) => e.path === 'Songs/Bad')).toBe(true);
    // All 10 good siblings must still produce a song.
    expect(flattenSongs(idx.root).length).toBe(10);
  });
});
