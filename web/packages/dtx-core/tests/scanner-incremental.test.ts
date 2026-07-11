import { describe, it, expect } from 'vitest';
import {
  buildMetaCache,
  deserializeIndex,
  serializeIndex,
  SongScanner,
  type SerializedIndex,
  type SongIndex,
} from '../src/scanner/scanner.js';
import { MemoryFs } from './helpers/memory-fs.js';
import { CountingFs, RandomSlowFs, ThrowingFs } from './helpers/instrumented-fs.js';

/**
 * Incremental-rescan coverage: `buildMetaCache` + `ScanOptions.metaCache`.
 * The contract under test:
 *
 *   (1) A rescan fed the previous index's meta cache produces the SAME
 *       index as a cold scan of the same tree — reuse must be invisible
 *       in the output. This must hold when the tree changed shape around
 *       the cached charts: songs added/removed, set.def edited, charts
 *       added to / removed from an existing song.
 *   (2) Charts already in the cache pay NO header read; only new charts
 *       do. (The walk's set.def / box.def reads still happen — that is
 *       how added/removed songs are discovered.)
 *   (3) Charts never successfully read get NO cache entry — even when a
 *       sibling chart gave their song meta — so the next scan retries
 *       the read instead of silently "reusing" nothing.
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

async function coldScan(files: Record<string, string>): Promise<SongIndex> {
  return new SongScanner(makeFs(files)).scan('');
}

describe('buildMetaCache', () => {
  it("keys every parsed chart by chartPath with the chart's OWN fields, not the song's merged view", async () => {
    const index = await coldScan(libraryFiles());
    const cache = buildMetaCache(index.songs);

    expect(cache.size).toBe(3);
    expect(cache.get('Songs/Rock/bas.dtx')).toEqual({
      drumLevel: 30,
      bpm: 172,
      artist: 'The Band',
      genre: 'Rock',
      preview: 'pre.ogg',
      preimage: 'cover.png',
      comment: 'a blurb',
    });
    // adv.dtx declares no #ARTIST — its entry must NOT inherit the song's
    // merged artist (that came from bas.dtx and would be resurrected even
    // after bas.dtx is deleted).
    expect(cache.get('Songs/Rock/adv.dtx')).toEqual({ drumLevel: 55, bpm: 172 });
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

  it('skips a failed chart even when a SIBLING chart gave its song meta', async () => {
    // Regression: the guard must key off chart-level parse success. With a
    // song-level guard, bas.dtx's artist would smuggle adv.dtx into the
    // cache despite its read having failed — permanently suppressing the
    // retry and its scan error.
    const throwing = new ThrowingFs(
      makeFs(libraryFiles()),
      new Set(),
      new Set(['Songs/Rock/adv.dtx'])
    );
    const broken = await new SongScanner(throwing).scan('');
    expect(broken.errors.map((e) => e.path)).toEqual(['Songs/Rock/adv.dtx']);
    const cache = buildMetaCache(broken.songs);
    expect(cache.has('Songs/Rock/adv.dtx')).toBe(false);

    // Next incremental scan (fs healthy again) retries exactly that read.
    const counting = new CountingFs(makeFs(libraryFiles()));
    const warm = await new SongScanner(counting, { metaCache: cache }).scan('');
    expect(counting.calls.filter((c) => c.method === 'readText' && c.path === 'Songs/Rock/adv.dtx')).toHaveLength(1);
    expect(warm.metaStats).toEqual({ reused: 2, read: 1 });
    expect(warm.errors).toEqual([]);
    expect(snapshotIndex(warm)).toEqual(snapshotIndex(await coldScan(libraryFiles())));
  });

  it('returns an empty map for a parseMeta:false index', async () => {
    const index = await new SongScanner(makeFs(libraryFiles()), { parseMeta: false }).scan('');
    expect(buildMetaCache(index.songs).size).toBe(0);
  });
});

describe('incremental rescan via ScanOptions.metaCache', () => {
  it('reads no chart headers when nothing changed, and output matches a cold scan', async () => {
    const cold = await coldScan(libraryFiles());
    const counting = new CountingFs(makeFs(libraryFiles()));
    const warm = await new SongScanner(counting, {
      metaCache: buildMetaCache(cold.songs),
    }).scan('');

    expect(dtxReads(counting)).toBe(0);
    expect(snapshotIndex(warm)).toEqual(snapshotIndex(cold));
    expect(warm.metaStats).toEqual({ reused: 3, read: 0 });
  });

  it('reads only the headers of charts added since the cached scan', async () => {
    const cold = await coldScan(libraryFiles());
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
    expect(snapshotIndex(warm)).toEqual(snapshotIndex(await coldScan(grown)));

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

  it('handles a mixed song — new chart added to an EXISTING set.def song', async () => {
    const cold = await coldScan(libraryFiles());
    const grown = {
      ...libraryFiles(),
      'Songs/Rock/set.def': [
        '#TITLE Rock Anthem',
        '#L1FILE bas.dtx',
        '#L2FILE adv.dtx',
        '#L3FILE ext.dtx',
      ].join('\n'),
      'Songs/Rock/ext.dtx': '#TITLE ra\n#ARTIST ExtBand\n#BPM 190\n#DLEVEL 88',
    };
    const counting = new CountingFs(makeFs(grown));
    const warm = await new SongScanner(counting, {
      metaCache: buildMetaCache(cold.songs),
    }).scan('');

    expect(dtxReads(counting)).toBe(1);
    expect(warm.metaStats).toEqual({ reused: 3, read: 1 });
    // Song-level merge order (bas declares first, ExtBand loses) must match
    // a cold scan exactly.
    expect(snapshotIndex(warm)).toEqual(snapshotIndex(await coldScan(grown)));
  });

  it('handles a mixed song where the NEW chart occupies the first slot', async () => {
    // Inverse of the test above: the fresh read comes first in merge order,
    // so ITS song-level fields must win over the cached later slots —
    // exactly as a cold scan would order it.
    const cold = await coldScan(libraryFiles());
    const modified = {
      ...libraryFiles(),
      'Songs/Rock/set.def': [
        '#TITLE Rock Anthem',
        '#L1FILE new1.dtx',
        '#L2FILE bas.dtx',
        '#L3FILE adv.dtx',
      ].join('\n'),
      'Songs/Rock/new1.dtx': '#TITLE ra\n#ARTIST NewBand\n#BPM 190\n#DLEVEL 10\n#PREVIEW newpre.ogg',
    };
    const counting = new CountingFs(makeFs(modified));
    const warm = await new SongScanner(counting, {
      metaCache: buildMetaCache(cold.songs),
    }).scan('');

    expect(dtxReads(counting)).toBe(1);
    expect(warm.metaStats).toEqual({ reused: 3, read: 1 });
    const rock = warm.songs.find((s) => s.title === 'Rock Anthem')!;
    expect(rock.artist).toBe('NewBand');
    expect(rock.preview).toBe('newpre.ogg');
    expect(snapshotIndex(warm)).toEqual(snapshotIndex(await coldScan(modified)));
  });

  it('does not resurrect a deleted chart\'s song-level meta through surviving siblings', async () => {
    const files = {
      'Songs/Duo/set.def': ['#TITLE Duo', '#L1FILE bas.dtx', '#L2FILE adv.dtx'].join('\n'),
      'Songs/Duo/bas.dtx': '#TITLE d\n#ARTIST BandA\n#BPM 172\n#DLEVEL 30\n#PREVIEW baspre.ogg',
      'Songs/Duo/adv.dtx': '#TITLE d\n#ARTIST BandB\n#BPM 180\n#DLEVEL 70\n#PREVIEW advpre.ogg',
    };
    const cold = await coldScan(files);
    expect(cold.songs[0]!.artist).toBe('BandA'); // merged from first slot

    // bas.dtx deleted and dropped from set.def — the walk discovers this.
    const shrunk = {
      'Songs/Duo/set.def': ['#TITLE Duo', '#L1FILE adv.dtx'].join('\n'),
      'Songs/Duo/adv.dtx': files['Songs/Duo/adv.dtx'],
    };
    const counting = new CountingFs(makeFs(shrunk));
    const warm = await new SongScanner(counting, {
      metaCache: buildMetaCache(cold.songs),
    }).scan('');

    // The surviving chart is still served from cache…
    expect(dtxReads(counting)).toBe(0);
    expect(warm.metaStats).toEqual({ reused: 1, read: 0 });
    // …but the deleted chart's fields are gone, exactly as in a cold scan.
    const duo = warm.songs[0]!;
    expect(duo.artist).toBe('BandB');
    expect(duo.preview).toBe('advpre.ogg');
    expect(duo.bpm).toBe(180);
    expect(snapshotIndex(warm)).toEqual(snapshotIndex(await coldScan(shrunk)));
  });

  it('picks up a set.def edit (retitle) with zero header reads', async () => {
    // The headline contract: the walk discovers set.def edits, meta reuse
    // is keyed by chartPath — so a retitled song must surface WITHOUT
    // re-reading its unchanged charts.
    const cold = await coldScan(libraryFiles());
    const edited = {
      ...libraryFiles(),
      'Songs/Rock/set.def': [
        '#TITLE Rock Anthem Remastered',
        '#L1FILE bas.dtx',
        '#L2FILE adv.dtx',
      ].join('\n'),
    };
    const counting = new CountingFs(makeFs(edited));
    const warm = await new SongScanner(counting, {
      metaCache: buildMetaCache(cold.songs),
    }).scan('');

    expect(dtxReads(counting)).toBe(0);
    expect(warm.metaStats).toEqual({ reused: 3, read: 0 });
    const rock = warm.songs.find((s) => s.title === 'Rock Anthem Remastered')!;
    expect(rock.artist).toBe('The Band');
    expect(rock.charts.map((c) => c.drumLevel)).toEqual([30, 55]);
    expect(snapshotIndex(warm)).toEqual(snapshotIndex(await coldScan(edited)));
  });

  it('does not resurrect songs deleted since the cached scan', async () => {
    const cold = await coldScan(libraryFiles());
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

  it('works from a serialize→deserialize roundtripped cache — the production Rescan input', async () => {
    // In the app, Rescan builds the cache from library.songs, which after a
    // cache-hit boot came through serializeIndex/deserializeIndex. Any
    // "slim the persisted blob" refactor that drops per-chart fields would
    // silently strip meta from every later incremental rescan — this pins it.
    const cold = await coldScan(libraryFiles());
    const roundtripped = deserializeIndex(
      JSON.parse(JSON.stringify(serializeIndex(cold))) as SerializedIndex
    );
    const counting = new CountingFs(makeFs(libraryFiles()));
    const warm = await new SongScanner(counting, {
      metaCache: buildMetaCache(roundtripped.songs),
    }).scan('');

    expect(dtxReads(counting)).toBe(0);
    expect(warm.metaStats).toEqual({ reused: 3, read: 0 });
    expect(snapshotIndex(warm)).toEqual(snapshotIndex(cold));
  });

  it('is deterministic under parallel I/O with a partial cache', async () => {
    // Cache hits complete synchronously while misses await real reads —
    // the mix must not let backend completion order leak into song-level
    // merges or output ordering.
    const grown = {
      ...libraryFiles(),
      'Songs/Metal/m.dtx': '#TITLE M\n#ARTIST MB\n#BPM 210\n#DLEVEL 91',
      'Songs/Punk/p.dtx': '#TITLE P\n#ARTIST PB\n#BPM 220\n#DLEVEL 60',
      'Songs/Ska/s.dtx': '#TITLE S\n#ARTIST SB\n#BPM 160\n#DLEVEL 40',
    };
    const cache = buildMetaCache((await coldScan(libraryFiles())).songs);
    const sequential = await new SongScanner(makeFs(grown), { concurrency: 1 }).scan('');

    for (const seed of [1, 7, 42]) {
      const warm = await new SongScanner(new RandomSlowFs(makeFs(grown), 8, seed), {
        metaCache: cache,
        concurrency: 8,
      }).scan('');
      expect(snapshotIndex(warm)).toEqual(snapshotIndex(sequential));
      expect(warm.metaStats).toEqual({ reused: 3, read: 3 });
    }
  });

  it('resets metaStats between scan() calls on a reused scanner instance', async () => {
    const cache = buildMetaCache((await coldScan(libraryFiles())).songs);
    const scanner = new SongScanner(makeFs(libraryFiles()), { metaCache: cache });
    const first = await scanner.scan('');
    const second = await scanner.scan('');
    // An accumulation bug would report {reused: 6} on the second call.
    expect(first.metaStats).toEqual({ reused: 3, read: 0 });
    expect(second.metaStats).toEqual({ reused: 3, read: 0 });
  });

  it('keeps metaStats out of the serialized cache blob', async () => {
    const index = await coldScan(libraryFiles());
    expect(index.metaStats).toBeDefined();
    expect('metaStats' in serializeIndex(index)).toBe(false);
  });
});
