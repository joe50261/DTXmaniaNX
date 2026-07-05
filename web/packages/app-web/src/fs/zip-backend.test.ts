import {
  BlobWriter,
  TextReader,
  ZipWriter,
  configure,
} from '@zip.js/zip.js/index-native.js';
import { SongScanner, type DirEntry } from '@dtxmania/dtx-core';
import { describe, expect, it, vi } from 'vitest';
import { ZipAwareBackend, type ZipInnerBackend } from './zip-backend.js';

configure({ useWebWorkers: false });

/** Build a real `.zip` Blob with zip.js — same library the backend reads with,
 * so fixtures exercise the actual format path (no hand-rolled archive bytes). */
async function makeZip(files: Record<string, string>): Promise<Uint8Array> {
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  for (const [name, content] of Object.entries(files)) {
    await writer.add(name, new TextReader(content));
  }
  const blob = await writer.close();
  return new Uint8Array(await blob.arrayBuffer());
}

/** A fake inner backend: a flat root of files, some of which are `.zip` blobs.
 * Mirrors the slice of `HandleFileSystemBackend` the zip wrapper leans on. */
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

/** A two-song pack: box.def names the pack, each song has its own set.def
 * grouping difficulty charts. */
function packFixture(): Promise<Uint8Array> {
  return makeZip({
    'box.def': '#TITLE My Pack\n',
    'song-a/set.def': '#TITLE Song A\n#L1FILE bas.dtx\n#L2FILE adv.dtx\n',
    'song-a/bas.dtx': '#TITLE Song A\n#ARTIST Alice\n#DLEVEL: 25\n',
    'song-a/adv.dtx': '#TITLE Song A\n#ARTIST Alice\n#DLEVEL: 70\n',
    'song-b/set.def': '#TITLE Song B\n#L1FILE only.dtx\n',
    'song-b/only.dtx': '#TITLE Song B\n#ARTIST Bob\n#DLEVEL: 42\n',
  });
}

describe('ZipAwareBackend', () => {
  it('presents a .zip file as a directory with the extension stripped', async () => {
    const inner = new FakeInner();
    inner.setFile('pack.zip', await packFixture());
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
    inner.setFile('pack.zip', await packFixture());
    const backend = new ZipAwareBackend(inner);

    const top = await backend.listDir('pack.zip');
    expect(top.map((e) => e.name).sort()).toEqual(['box.def', 'song-a', 'song-b']);
    expect(top.find((e) => e.name === 'song-a')).toMatchObject({
      path: 'pack.zip/song-a',
      isDirectory: true,
    });

    const setdef = await backend.readText('pack.zip/song-a/set.def');
    expect(setdef).toContain('#L1FILE bas.dtx');

    const boxBytes = await backend.readFile('pack.zip/box.def');
    expect(new TextDecoder().decode(boxBytes)).toBe('#TITLE My Pack\n');
  });

  it('answers exists() for archive members and implied directories', async () => {
    const inner = new FakeInner();
    inner.setFile('pack.zip', await packFixture());
    const backend = new ZipAwareBackend(inner);

    expect(await backend.exists('pack.zip')).toBe(true);
    expect(await backend.exists('pack.zip/song-a')).toBe(true); // implied dir
    expect(await backend.exists('pack.zip/song-a/bas.dtx')).toBe(true);
    expect(await backend.exists('pack.zip/song-a/missing.dtx')).toBe(false);
  });

  it('opens each archive only once, however many members are read', async () => {
    const inner = new FakeInner();
    inner.setFile('pack.zip', await packFixture());
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
    inner.setFile('pack.zip', await packFixture());
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
