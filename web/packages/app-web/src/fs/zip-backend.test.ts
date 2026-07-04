import { deflateRawSync } from 'node:zlib';
import { SongScanner, type DirEntry } from '@dtxmania/dtx-core';
import { describe, expect, it, vi } from 'vitest';
import { ZipAwareBackend, splitZipPath, type ZipInnerBackend } from './zip-backend.js';

// --- a tiny real-ZIP builder (STORE + DEFLATE) ------------------------------

interface ZipFile {
  name: string;
  content: string;
  method?: 0 | 8;
}

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function makeZip(files: ZipFile[]): Uint8Array {
  const enc = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];
  const u16 = (a: number[], v: number) => a.push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (a: number[], v: number) =>
    a.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);

  for (const f of files) {
    const method = f.method ?? 8;
    const data = enc.encode(f.content);
    const stored = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const name = enc.encode(f.name);
    const crc = crc32(data);
    const offset = local.length;

    u32(local, 0x04034b50);
    u16(local, 20);
    u16(local, 0);
    u16(local, method);
    u16(local, 0);
    u16(local, 0);
    u32(local, crc);
    u32(local, stored.length);
    u32(local, data.length);
    u16(local, name.length);
    u16(local, 0);
    local.push(...name, ...stored);

    u32(central, 0x02014b50);
    u16(central, 20);
    u16(central, 20);
    u16(central, 0);
    u16(central, method);
    u16(central, 0);
    u16(central, 0);
    u32(central, crc);
    u32(central, stored.length);
    u32(central, data.length);
    u16(central, name.length);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u32(central, 0);
    u32(central, offset);
    central.push(...name);
  }

  const cdOffset = local.length;
  const eocd: number[] = [];
  u32(eocd, 0x06054b50);
  u16(eocd, 0);
  u16(eocd, 0);
  u16(eocd, files.length);
  u16(eocd, files.length);
  u32(eocd, central.length);
  u32(eocd, cdOffset);
  u16(eocd, 0);
  return new Uint8Array([...local, ...central, ...eocd]);
}

// --- a fake inner backend: a flat root of files (some are .zip blobs) -------

class FakeInner implements ZipInnerBackend {
  private readonly files = new Map<string, Uint8Array>();
  readonly writes = new Map<string, string>();
  readonly removed: string[] = [];

  setFile(path: string, bytes: Uint8Array | string): void {
    this.files.set(path, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
  }

  async listDir(path: string): Promise<DirEntry[]> {
    if (path !== '') throw new Error(`fake only has a root: ${path}`);
    return Array.from(this.files.keys()).map((name) => ({
      name,
      path: name,
      isDirectory: false,
      isFile: true,
    }));
  }

  async readFile(path: string): Promise<ArrayBuffer> {
    const b = this.files.get(path);
    if (!b) throw new Error(`no such file: ${path}`);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder('utf-8').decode(await this.readFile(path));
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async openFile(path: string): Promise<Blob> {
    const b = this.files.get(path);
    if (!b) throw new Error(`no such file: ${path}`);
    return new Blob([b as BlobPart]);
  }

  async writeText(path: string, text: string): Promise<void> {
    this.writes.set(path, text);
  }

  async removeFile(path: string): Promise<void> {
    this.removed.push(path);
  }
}

function packFixture(): Uint8Array {
  // A two-song pack: box.def names the pack, each song has its own set.def
  // grouping two difficulty charts.
  return makeZip([
    { name: 'box.def', content: '#TITLE My Pack\n', method: 0 },
    { name: 'song-a/set.def', content: '#TITLE Song A\n#L1FILE bas.dtx\n#L2FILE adv.dtx\n' },
    { name: 'song-a/bas.dtx', content: '#TITLE Song A\n#ARTIST Alice\n#DLEVEL: 25\n' },
    { name: 'song-a/adv.dtx', content: '#TITLE Song A\n#ARTIST Alice\n#DLEVEL: 70\n' },
    { name: 'song-b/set.def', content: '#TITLE Song B\n#L1FILE only.dtx\n' },
    { name: 'song-b/only.dtx', content: '#TITLE Song B\n#ARTIST Bob\n#DLEVEL: 42\n' },
  ]);
}

describe('splitZipPath', () => {
  it('splits at the first .zip segment', () => {
    expect(splitZipPath('pack.zip')).toEqual({ zipPath: 'pack.zip', innerPath: '' });
    expect(splitZipPath('pack.zip/song/adv.dtx')).toEqual({
      zipPath: 'pack.zip',
      innerPath: 'song/adv.dtx',
    });
    expect(splitZipPath('a/b/pack.ZIP/x.dtx')).toEqual({
      zipPath: 'a/b/pack.ZIP',
      innerPath: 'x.dtx',
    });
  });

  it('returns null when no segment is a .zip', () => {
    expect(splitZipPath('songs/plain/adv.dtx')).toBeNull();
    expect(splitZipPath('')).toBeNull();
  });
});

describe('ZipAwareBackend', () => {
  it('presents a .zip file as a directory with the extension stripped', async () => {
    const inner = new FakeInner();
    inner.setFile('pack.zip', packFixture());
    inner.setFile('loose.dtx', '#TITLE Loose\n');
    const backend = new ZipAwareBackend(inner);

    const root = await backend.listDir('');
    const pack = root.find((e) => e.path === 'pack.zip')!;
    expect(pack).toMatchObject({ name: 'pack', path: 'pack.zip', isDirectory: true, isFile: false });
    // Non-zip files pass through untouched.
    expect(root.find((e) => e.name === 'loose.dtx')).toMatchObject({ isFile: true });
  });

  it('lists entries inside the archive and reads their content', async () => {
    const inner = new FakeInner();
    inner.setFile('pack.zip', packFixture());
    const backend = new ZipAwareBackend(inner);

    const top = await backend.listDir('pack.zip');
    expect(top.map((e) => e.name).sort()).toEqual(['box.def', 'song-a', 'song-b']);
    expect(top.find((e) => e.name === 'song-a')).toMatchObject({
      path: 'pack.zip/song-a',
      isDirectory: true,
    });

    // DEFLATE entry, read as text.
    const setdef = await backend.readText('pack.zip/song-a/set.def');
    expect(setdef).toContain('#L1FILE bas.dtx');

    // STORE entry (box.def), read as bytes.
    const boxBytes = await backend.readFile('pack.zip/box.def');
    expect(new TextDecoder().decode(boxBytes)).toBe('#TITLE My Pack\n');
  });

  it('answers exists() for archive members and implied directories', async () => {
    const inner = new FakeInner();
    inner.setFile('pack.zip', packFixture());
    const backend = new ZipAwareBackend(inner);

    expect(await backend.exists('pack.zip')).toBe(true);
    expect(await backend.exists('pack.zip/song-a')).toBe(true); // implied dir
    expect(await backend.exists('pack.zip/song-a/bas.dtx')).toBe(true);
    expect(await backend.exists('pack.zip/song-a/missing.dtx')).toBe(false);
  });

  it('parses each archive central directory only once', async () => {
    const inner = new FakeInner();
    inner.setFile('pack.zip', packFixture());
    const open = vi.spyOn(inner, 'openFile');
    const backend = new ZipAwareBackend(inner);

    await backend.listDir('pack.zip');
    await backend.listDir('pack.zip/song-a');
    await backend.readText('pack.zip/song-a/bas.dtx');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('forwards writes and removals to the inner backend', async () => {
    const inner = new FakeInner();
    const backend = new ZipAwareBackend(inner);
    await backend.writeText('.dtxmania-song-index.json', '{}');
    await backend.removeFile('.dtxmania-song-index.json');
    expect(inner.writes.get('.dtxmania-song-index.json')).toBe('{}');
    expect(inner.removed).toEqual(['.dtxmania-song-index.json']);
  });

  it('passes non-zip reads straight through', async () => {
    const inner = new FakeInner();
    inner.setFile('loose.dtx', '#TITLE Loose\n');
    const backend = new ZipAwareBackend(inner);
    expect(await backend.readText('loose.dtx')).toBe('#TITLE Loose\n');
    expect(await backend.exists('loose.dtx')).toBe(true);
    expect(await backend.exists('nope.dtx')).toBe(false);
  });
});

describe('SongScanner over a zip song pack', () => {
  it('scans, indexes, and reads chart metadata straight from the archive', async () => {
    const inner = new FakeInner();
    inner.setFile('pack.zip', packFixture());
    const backend = new ZipAwareBackend(inner);

    const index = await new SongScanner(backend).scan('');

    // Two songs, both with chart paths that live *inside* the archive.
    const titles = index.songs.map((s) => s.title).sort();
    expect(titles).toEqual(['Song A', 'Song B']);

    const songA = index.songs.find((s) => s.title === 'Song A')!;
    expect(songA.folderPath).toBe('pack.zip/song-a');
    expect(songA.charts.map((c) => c.chartPath)).toEqual([
      'pack.zip/song-a/bas.dtx',
      'pack.zip/song-a/adv.dtx',
    ]);
    // Metadata parsed by reading (inflating) the .dtx headers from the zip.
    expect(songA.artist).toBe('Alice');
    expect(songA.charts[0]!.drumLevel).toBe(25);
    expect(songA.charts[1]!.drumLevel).toBe(70);

    // box.def named the pack: it surfaces as an explicit box in the tree.
    const box = index.root.children.find((n) => n.type === 'box' && n.name === 'My Pack');
    expect(box).toBeDefined();

    expect(index.errors).toEqual([]);
  });
});
