import { describe, it, expect } from 'vitest';
import { SongScanner, flattenSongs } from '../src/scanner/scanner.js';
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

  it('parses a UTF-16 LE BOM-prefixed set.def (DTXCreator Windows output)', async () => {
    // Seen in the wild with DTXCreator: SET.def saved as UTF-16 LE with BOM.
    // Before BOM detection the file decoded as Shift_JIS garbage → 0 blocks
    // → the whole folder fell through to per-.dtx rows instead of grouping.
    const utf16leWithBom = (s: string): Uint8Array => {
      const buf = new Uint8Array(2 + s.length * 2);
      buf[0] = 0xff;
      buf[1] = 0xfe;
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        buf[2 + i * 2] = c & 0xff;
        buf[2 + i * 2 + 1] = (c >> 8) & 0xff;
      }
      return buf;
    };
    const fs = new MemoryFs();
    fs.setFile(
      'Songs/Rock/SET.def',
      utf16leWithBom(
        [
          '#TITLE 天ノ弱',
          '#L1LABEL BASIC',
          '#L1FILE bsc.dtx',
          '#L2LABEL ADVANCED',
          '#L2FILE adv.dtx',
          '#L3LABEL EXTREME',
          '#L3FILE ext.dtx',
          '#L4LABEL MASTER',
          '#L4FILE mstr.dtx',
          '',
        ].join('\r\n')
      )
    );
    fs.setFile('Songs/Rock/bsc.dtx', '#TITLE 天ノ弱');
    fs.setFile('Songs/Rock/adv.dtx', '#TITLE 天ノ弱');
    fs.setFile('Songs/Rock/ext.dtx', '#TITLE 天ノ弱');
    fs.setFile('Songs/Rock/mstr.dtx', '#TITLE 天ノ弱');
    const index = await new SongScanner(fs).scan('Songs');
    expect(index.songs).toHaveLength(1);
    expect(index.songs[0]?.title).toBe('天ノ弱');
    expect(index.songs[0]?.fromSetDef).toBe(true);
    expect(index.songs[0]?.charts.map((c) => c.label)).toEqual([
      'BASIC',
      'ADVANCED',
      'EXTREME',
      'MASTER',
    ]);
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

  it('fills chart.drumLevel / song.artist from each .dtx header when parseMeta is on', async () => {
    const fs = makeFs({
      'Songs/Rock/song.dtx': [
        '#TITLE Tricky Song',
        '#ARTIST The Band',
        '#GENRE Rock',
        '#BPM 172',
        '#DLEVEL 562',
      ].join('\n'),
    });
    const index = await new SongScanner(fs).scan('Songs');
    expect(index.songs).toHaveLength(1);
    const song = index.songs[0]!;
    expect(song.artist).toBe('The Band');
    expect(song.genre).toBe('Rock');
    expect(song.bpm).toBe(172);
    expect(song.charts[0]?.drumLevel).toBe(562);
    expect(song.charts[0]?.bpm).toBe(172);
  });

  it('skips header parse when parseMeta is disabled', async () => {
    const fs = makeFs({
      'Songs/Rock/song.dtx': '#TITLE X\n#ARTIST Y\n#DLEVEL 300',
    });
    const index = await new SongScanner(fs, { parseMeta: false }).scan('Songs');
    expect(index.songs[0]?.artist).toBeUndefined();
    expect(index.songs[0]?.charts[0]?.drumLevel).toBeUndefined();
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

  it('exposes a folder tree: root BoxNode with nested Box + Song children', async () => {
    // Each directory intentionally has ≥2 songs so the single-child
    // hoisting rule doesn't kick in — the test is specifically about the
    // tree shape, not about when boxes get elided.
    const fs = makeFs({
      'Songs/Rock/a1.dtx': '#TITLE A1',
      'Songs/Rock/a2.dtx': '#TITLE A2',
      'Songs/Pop/Bubblegum/b1.dtx': '#TITLE B1',
      'Songs/Pop/Bubblegum/b2.dtx': '#TITLE B2',
      'Songs/Pop/Ballads/c1.dtx': '#TITLE C1',
      'Songs/Pop/Ballads/c2.dtx': '#TITLE C2',
    });
    const index = await new SongScanner(fs, { parseMeta: false }).scan('Songs');
    // Flat list still preserved for back-compat.
    expect(flattenSongs(index.root)).toEqual(index.songs);
    // Root has two child boxes: Rock + Pop.
    const rootBoxes = index.root.children.filter((c) => c.type === 'box');
    expect(rootBoxes.map((b) => (b as { name: string }).name).sort()).toEqual(['Pop', 'Rock']);
    const pop = rootBoxes.find((b) => (b as { name: string }).name === 'Pop');
    expect(pop?.type).toBe('box');
    if (pop?.type !== 'box') throw new Error('pop must be a box');
    // Pop has two sub-boxes (Bubblegum, Ballads), each with two songs.
    expect(pop.children).toHaveLength(2);
    for (const sub of pop.children) {
      expect(sub.type).toBe('box');
      if (sub.type !== 'box') continue;
      expect(sub.children).toHaveLength(2);
      expect(sub.children[0]!.type).toBe('song');
      expect(sub.parent).toBe(pop);
    }
  });

  it('prunes empty boxes so dead folders do not clutter the tree', async () => {
    const fs = makeFs({
      'Songs/Rock/a.dtx': '#TITLE A',
      'Songs/EmptyDir/placeholder.txt': 'not a chart',
    });
    const index = await new SongScanner(fs, { parseMeta: false }).scan('Songs');
    const boxes = index.root.children.filter((c) => c.type === 'box');
    // Rock has exactly one song → the rule below hoists it, so Rock the
    // box disappears and only its song remains under root.
    expect(boxes).toHaveLength(0);
    expect(index.root.children).toHaveLength(1);
    expect(index.root.children[0]?.type).toBe('song');
  });

  it('hoists single-child folders so set.def packs do not get a redundant wrapper box', async () => {
    const fs = makeFs({
      'Songs/Pack/set.def': [
        '#TITLE My Song',
        '#L1FILE easy.dtx',
        '#L2FILE hard.dtx',
      ].join('\n'),
      'Songs/Pack/easy.dtx': '#TITLE ignored',
      'Songs/Pack/hard.dtx': '#TITLE ignored',
    });
    const index = await new SongScanner(fs, { parseMeta: false }).scan('Songs');
    // Expected: root → "My Song" directly. "Pack" disappears because it
    // only contained one song entry (from the single set.def block).
    expect(index.root.children).toHaveLength(1);
    const only = index.root.children[0]!;
    expect(only.type).toBe('song');
    if (only.type !== 'song') throw new Error('expected song');
    expect(only.entry.title).toBe('My Song');
    expect(only.parent).toBe(index.root);
  });

  it('keeps multi-child folders as boxes (pack with two standalone songs)', async () => {
    const fs = makeFs({
      'Songs/Pack/a.dtx': '#TITLE A',
      'Songs/Pack/b.dtx': '#TITLE B',
    });
    const index = await new SongScanner(fs, { parseMeta: false }).scan('Songs');
    // Pack has 2 songs → stays as a box so the player can see the grouping
    // when mouse-browsing. Matches the user request to only flatten the
    // single-song redundancy case.
    expect(index.root.children).toHaveLength(1);
    const pack = index.root.children[0]!;
    expect(pack.type).toBe('box');
    if (pack.type !== 'box') throw new Error('expected box');
    expect(pack.name).toBe('Pack');
    expect(pack.children).toHaveLength(2);
  });

  it('cascades: a plain folder wrapping another plain folder with one song collapses both', async () => {
    const fs = makeFs({
      'Songs/Outer/Inner/set.def': [
        '#TITLE Deep Song',
        '#L1FILE only.dtx',
      ].join('\n'),
      'Songs/Outer/Inner/only.dtx': '',
    });
    const index = await new SongScanner(fs, { parseMeta: false }).scan('Songs');
    // Inner has 1 song → hoisted into Outer; Outer then has 1 child (that
    // song) → hoisted into root. Both wrappers disappear.
    expect(index.root.children).toHaveLength(1);
    expect(index.root.children[0]?.type).toBe('song');
    expect(
      (index.root.children[0] as { entry: { title: string } }).entry.title
    ).toBe('Deep Song');
  });

  it('fills preview / preimage / comment metadata when parseMeta is on', async () => {
    const fs = makeFs({
      'Songs/Rock/song.dtx': [
        '#TITLE Foo',
        '#ARTIST Someone',
        '#PREVIEW pv.wav',
        '#PREIMAGE cover.png',
        '#COMMENT A short blurb',
      ].join('\n'),
    });
    const index = await new SongScanner(fs, { parseMeta: true }).scan('Songs');
    expect(index.songs[0]?.preview).toBe('pv.wav');
    expect(index.songs[0]?.preimage).toBe('cover.png');
    expect(index.songs[0]?.comment).toBe('A short blurb');
  });
});
