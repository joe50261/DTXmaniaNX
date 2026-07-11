import { describe, it, expect } from 'vitest';
import {
  buildMetaCache,
  serializeIndex,
  SongScanner,
  type SerializedIndex,
  type SongIndex,
} from '../src/scanner/scanner.js';
import { MemoryFs } from './helpers/memory-fs.js';
import { CountingFs, ThrowingFs } from './helpers/instrumented-fs.js';

/**
 * Incremental-rescan coverage: `buildMetaCache` + `ScanOptions.metaCache`.
 * The contract under test:
 *
 *   (1) A rescan fed the previous index's meta cache produces the SAME
 *       index as a cold scan of the same tree — reuse must be invisible
 *       in the output.
 *   (2) Charts already in the cache pay NO header read; only new charts
 *       do. (The walk's set.def / box.def reads still happen — that is
 *       how added/removed songs are discovered.)
 *   (3) Removed songs do not survive via the cache, and cache entries
 *       for charts that carried no meta are not created (so a
 *       parseMeta:false index can't poison a later incremental scan).
 */

function makeFs(files: Record<string, string>): MemoryFs {
  const fs = new MemoryFs();
  for (const [path, content] of Object.entries(files)) {
    fs.setFile(path, content);
  }
  return fs;
}

/** Meta-rich fixture: one set.def song (2 charts) + one bare .dtx song. */
function libraryFiles(): Record<string, string> {
  return {
    'Songs/Rock/set.def': ['#TITLE Rock Anthem', '#L1FILE bas.dtx', '#L2FILE adv.dtx'].join('\n'),
    'Songs/Rock/bas.dtx': [
      '#TITLE ra',
      '#ARTIST The Band',
      '#GENRE Rock',
      '#BPM 172',
      '#DLEVEL 30',
      '#PREVIEW pre.ogg',
      '#PREIMAGE cover.png',
      '#COMMENT a blurb',
    ].join('\n'),
    'Songs/Rock/adv.dtx': '#TITLE ra\n#BPM 172\n#DLEVEL 55',
    'Songs/Jazz/one.dtx': '#TITLE One\n#ARTIST Trio\n#BPM 140\n#DLEVEL 42',
  };
}

function snapshotIndex(idx: SongIndex): Omit<SerializedIndex, 'scannedAtMs'> {
  const { scannedAtMs: _unused, ...rest } = serializeIndex(idx);
  return rest;
}

function dtxReads(fs: CountingFs): number {
  return fs.calls.filter((c) => c.method === 'readText' && c.path.endsWith('.dtx')).length;
}

describe('buildMetaCache', () => {
  it('keys every meta-carrying chart by chartPath, with chart + song fields', async () => {
    const index = await new SongScanner(makeFs(libraryFiles())).scan('');
    const cache = buildMetaCache(index.songs);

    expect(cache.size).toBe(3);
    const bas = cache.get('Songs/Rock/bas.dtx')!;
    expect(bas).toEqual({
      drumLevel: 30,
      bpm: 172,
      artist: 'The Band',
      genre: 'Rock',
      songBpm: 172,
      preview: 'pre.ogg',
      preimage: 'cover.png',
      comment: 'a blurb',
    });
    // Chart-level fields are the chart's own; song-level fields are the
    // owning song's merged view, carried on every chart of that song.
    const adv = cache.get('Songs/Rock/adv.dtx')!;
    expect(adv.drumLevel).toBe(55);
    expect(adv.artist).toBe('The Band');
  });

  it('skips charts whose header read failed (no meta to reuse)', async () => {
    const files = { ...libraryFiles(), 'Songs/Broken/bad.dtx': '#TITLE never read' };
    const throwing = new ThrowingFs(
      makeFs(files),
      new Set(),
      new Set(['Songs/Broken/bad.dtx'])
    );
    const index = await new SongScanner(throwing).scan('');
    const cache = buildMetaCache(index.songs);
    // The failed chart must be absent so the next scan retries the read
    // instead of "reusing" nothing.
    expect(cache.has('Songs/Broken/bad.dtx')).toBe(false);
    expect(cache.size).toBe(3);
  });

  it('returns an empty map for a parseMeta:false index', async () => {
    const index = await new SongScanner(makeFs(libraryFiles()), { parseMeta: false }).scan('');
    expect(buildMetaCache(index.songs).size).toBe(0);
  });
});

describe('incremental rescan via ScanOptions.metaCache', () => {
  it('reads no chart headers when nothing changed, and output matches a cold scan', async () => {
    const cold = await new SongScanner(makeFs(libraryFiles())).scan('');
    const counting = new CountingFs(makeFs(libraryFiles()));
    const warm = await new SongScanner(counting, {
      metaCache: buildMetaCache(cold.songs),
    }).scan('');

    expect(dtxReads(counting)).toBe(0);
    expect(snapshotIndex(warm)).toEqual(snapshotIndex(cold));
    expect(warm.metaStats).toEqual({ reused: 3, read: 0 });
  });

  it('reads only the headers of charts added since the cached scan', async () => {
    const cold = await new SongScanner(makeFs(libraryFiles())).scan('');
    const grown = {
      ...libraryFiles(),
      'Songs/Metal/new.dtx': '#TITLE New\n#ARTIST Fresh\n#BPM 200\n#DLEVEL 80',
    };
    const counting = new CountingFs(makeFs(grown));
    const warm = await new SongScanner(counting, {
      metaCache: buildMetaCache(cold.songs),
    }).scan('');

    expect(dtxReads(counting)).toBe(1);
    expect(warm.metaStats).toEqual({ reused: 3, read: 1 });

    // A bare .dtx song's title is the filename stem, not the #TITLE header.
    const fresh = warm.songs.find((s) => s.title === 'new')!;
    expect(fresh.artist).toBe('Fresh');
    expect(fresh.charts[0]!.drumLevel).toBe(80);
    // Reused songs keep their full meta without a read.
    const rock = warm.songs.find((s) => s.title === 'Rock Anthem')!;
    expect(rock.artist).toBe('The Band');
    expect(rock.genre).toBe('Rock');
    expect(rock.bpm).toBe(172);
    expect(rock.preview).toBe('pre.ogg');
    expect(rock.preimage).toBe('cover.png');
    expect(rock.comment).toBe('a blurb');
    expect(rock.charts.map((c) => c.drumLevel)).toEqual([30, 55]);
  });

  it('does not resurrect songs deleted since the cached scan', async () => {
    const cold = await new SongScanner(makeFs(libraryFiles())).scan('');
    const shrunk = libraryFiles();
    delete shrunk['Songs/Jazz/one.dtx'];
    const warm = await new SongScanner(makeFs(shrunk), {
      metaCache: buildMetaCache(cold.songs),
    }).scan('');

    expect(warm.songs.map((s) => s.title)).toEqual(['Rock Anthem']);
    expect(warm.metaStats).toEqual({ reused: 2, read: 0 });
  });

  it('falls back to reading when the cache has no entry for a chart', async () => {
    // A parseMeta:false index yields an empty cache — the "incremental"
    // scan must then behave exactly like a cold one, meta included.
    const bare = await new SongScanner(makeFs(libraryFiles()), { parseMeta: false }).scan('');
    const counting = new CountingFs(makeFs(libraryFiles()));
    const warm = await new SongScanner(counting, {
      metaCache: buildMetaCache(bare.songs),
    }).scan('');

    expect(dtxReads(counting)).toBe(3);
    expect(warm.metaStats).toEqual({ reused: 0, read: 3 });
    expect(warm.songs.find((s) => s.title === 'Rock Anthem')!.artist).toBe('The Band');
  });

  it('keeps metaStats out of the serialized cache blob', async () => {
    const index = await new SongScanner(makeFs(libraryFiles())).scan('');
    expect(index.metaStats).toBeDefined();
    expect('metaStats' in serializeIndex(index)).toBe(false);
  });
});
