import { describe, it, expect } from 'vitest';
import { SongScanner } from '../src/scanner/scanner.js';
import { MemoryFs } from './helpers/memory-fs.js';

function makeFs(files: Record<string, string>): MemoryFs {
  const fs = new MemoryFs();
  for (const [path, content] of Object.entries(files)) {
    fs.setFile(path, content);
  }
  return fs;
}

describe('SongScanner', () => {
  it('returns a single song for a lone .dtx file', async () => {
    const fs = makeFs({
      'Songs/Rock/song.dtx': '#TITLE Foo',
    });
    const index = await new SongScanner(fs).scan('Songs');
    expect(index.songs).toHaveLength(1);
    expect(index.songs[0]?.title).toBe('song');
    expect(index.songs[0]?.fromSetDef).toBe(false);
    expect(index.songs[0]?.charts).toHaveLength(1);
    expect(index.songs[0]?.charts[0]?.chartPath).toBe('Songs/Rock/song.dtx');
  });

  it('groups difficulties via set.def', async () => {
    const fs = makeFs({
      'Songs/Rock/set.def': [
        '#TITLE My Song',
        '#L1FILE nov.dtx',
        '#L2FILE reg.dtx',
      ].join('\n'),
      'Songs/Rock/nov.dtx': '#TITLE My Song',
      'Songs/Rock/reg.dtx': '#TITLE My Song',
    });
    const index = await new SongScanner(fs).scan('Songs');
    expect(index.songs).toHaveLength(1);
    expect(index.songs[0]?.title).toBe('My Song');
    expect(index.songs[0]?.fromSetDef).toBe(true);
    expect(index.songs[0]?.charts.map((c) => c.slot)).toEqual([0, 1]);
    expect(index.songs[0]?.charts.map((c) => c.label)).toEqual(['NOVICE', 'REGULAR']);
  });

  it('drops set.def entries whose files are missing on disk', async () => {
    const fs = makeFs({
      'Songs/Rock/set.def': [
        '#TITLE My Song',
        '#L1FILE missing.dtx',
        '#L2FILE reg.dtx',
      ].join('\n'),
      'Songs/Rock/reg.dtx': '#TITLE My Song',
    });
    const index = await new SongScanner(fs).scan('Songs');
    expect(index.songs[0]?.charts).toHaveLength(1);
    expect(index.songs[0]?.charts[0]?.slot).toBe(1);
  });

  it('recurses into subdirectories', async () => {
    const fs = makeFs({
      'Songs/Rock/a.dtx': '#TITLE A',
      'Songs/Pop/b.dtx': '#TITLE B',
      'Songs/Pop/sub/c.dtx': '#TITLE C',
    });
    const index = await new SongScanner(fs).scan('Songs');
    expect(index.songs.map((s) => s.title).sort()).toEqual(['a', 'b', 'c']);
  });

  it('when both set.def and bare .dtx exist, set.def wins (no dupes)', async () => {
    const fs = makeFs({
      'Songs/Rock/set.def': '#TITLE My Song\n#L1FILE master.dtx',
      'Songs/Rock/master.dtx': '#TITLE My Song',
      'Songs/Rock/stray.dtx': '#TITLE Stray', // should be ignored because set.def present
    });
    const index = await new SongScanner(fs).scan('Songs');
    expect(index.songs).toHaveLength(1);
    expect(index.songs[0]?.title).toBe('My Song');
  });

  it('skips system/$recycle.bin/node_modules by default', async () => {
    const fs = makeFs({
      'Songs/Real/a.dtx': '#TITLE A',
      'Songs/System/x.dtx': '#TITLE X',
      'Songs/node_modules/y.dtx': '#TITLE Y',
    });
    const index = await new SongScanner(fs).scan('Songs');
    expect(index.songs.map((s) => s.title).sort()).toEqual(['a']);
  });

  it('reports errors instead of throwing when a directory is unreadable', async () => {
    const fs = makeFs({
      'Songs/Rock/a.dtx': '#TITLE A',
    });
    // Monkey-patch listDir to fail on a specific path.
    const origList = fs.listDir.bind(fs);
    fs.listDir = async (p: string) => {
      if (p === 'Songs/Rock') throw new Error('EACCES');
      return origList(p);
    };
    const index = await new SongScanner(fs).scan('Songs');
    expect(index.errors).toHaveLength(1);
    expect(index.errors[0]?.path).toBe('Songs/Rock');
    expect(index.songs).toHaveLength(0);
  });

  it('falls back to .dtx scan when set.def yields zero surviving songs', async () => {
    // set.def refers to files that are not on disk (common with renamed charts
    // or case mismatches on case-sensitive filesystems). Before the fallback
    // the whole folder was silently dropped; now we still surface the .dtx.
    const fs = makeFs({
      'Songs/Rock/SET.def': [
        '#TITLE My Song',
        '#L1FILE nonexistent.dtx',
      ].join('\n'),
      'Songs/Rock/bsc.dtx': '#TITLE B',
      'Songs/Rock/adv.dtx': '#TITLE A',
    });
    const index = await new SongScanner(fs).scan('Songs');
    expect(index.songs.map((s) => s.title).sort()).toEqual(['adv', 'bsc']);
    expect(index.songs.every((s) => !s.fromSetDef)).toBe(true);
  });

  it('only picks up .dtx (not .gda/.bms/.bme) in v1', async () => {
    const fs = makeFs({
      'Songs/A/a.dtx': '#TITLE A',
      'Songs/A/b.gda': '#TITLE B',
      'Songs/A/c.bms': '#TITLE C',
    });
    const index = await new SongScanner(fs).scan('Songs');
    expect(index.songs).toHaveLength(1);
    expect(index.songs[0]?.title).toBe('a');
  });
});
