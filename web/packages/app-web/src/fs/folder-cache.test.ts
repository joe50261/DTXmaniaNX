import { describe, it, expect } from 'vitest';
import type { SerializedIndex } from '@dtxmania/dtx-core';
import {
  FOLDER_CACHE_FILENAME,
  clearFolderCache,
  loadFolderCache,
  saveFolderCache,
  type CacheFileIO,
} from './folder-cache.js';

/**
 * In-memory CacheFileIO. Records the encoding each read was asked for and
 * can be flipped read-only to model a folder the user only granted `read`
 * permission on.
 */
class FakeIO implements CacheFileIO {
  files = new Map<string, string>();
  readEncodings: string[] = [];
  readonlyMode = false;

  async readText(path: string, encoding?: string): Promise<string> {
    this.readEncodings.push(encoding ?? 'shift-jis');
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`no such file: ${path}`);
    return v;
  }

  async writeText(path: string, text: string): Promise<void> {
    if (this.readonlyMode) throw new Error('NotAllowedError: read-only');
    this.files.set(path, text);
  }

  async removeFile(path: string): Promise<void> {
    this.files.delete(path);
  }
}

function sampleIndex(title = 'Rock Song'): SerializedIndex {
  return {
    version: 2,
    rootPath: '',
    scannedAtMs: 1_700_000_000_000,
    errors: [],
    root: {
      kind: 'box',
      name: '/',
      path: '',
      children: [
        {
          kind: 'song',
          entry: {
            title,
            folderPath: 'Rock',
            fromSetDef: false,
            charts: [{ slot: 0, label: 'DTX', chartPath: 'Rock/a.dtx' }],
          },
        },
      ],
    },
  } as SerializedIndex;
}

describe('folder-cache', () => {
  it('round-trips a serialized index through save → load', async () => {
    const io = new FakeIO();
    const idx = sampleIndex();
    expect(await saveFolderCache(io, idx)).toBe(true);
    // Persisted under the hidden root filename.
    expect(io.files.has(FOLDER_CACHE_FILENAME)).toBe(true);
    const loaded = await loadFolderCache(io);
    expect(loaded).toEqual(idx);
  });

  it('reads the cache as UTF-8 so multibyte titles survive', async () => {
    const io = new FakeIO();
    const idx = sampleIndex('東京ロック \u{1F941}');
    await saveFolderCache(io, idx);
    const loaded = await loadFolderCache(io);
    expect(loaded?.root.children[0]).toMatchObject({
      kind: 'song',
      entry: { title: '東京ロック \u{1F941}' },
    });
    // Every read must ask for utf-8, never the DTX-default shift-jis.
    expect(io.readEncodings.every((e) => e === 'utf-8')).toBe(true);
  });

  it('returns null when the cache file is absent', async () => {
    const io = new FakeIO();
    expect(await loadFolderCache(io)).toBeNull();
  });

  it('returns null on corrupt (non-JSON) contents', async () => {
    const io = new FakeIO();
    io.files.set(FOLDER_CACHE_FILENAME, '{ this is not json');
    expect(await loadFolderCache(io)).toBeNull();
  });

  it('returns null on a structurally wrong payload', async () => {
    const io = new FakeIO();
    // Valid JSON, but missing version / root / rootPath.
    io.files.set(FOLDER_CACHE_FILENAME, JSON.stringify({ hello: 'world' }));
    expect(await loadFolderCache(io)).toBeNull();
  });

  it('save returns false (does not throw) when the folder is read-only', async () => {
    const io = new FakeIO();
    io.readonlyMode = true;
    expect(await saveFolderCache(io, sampleIndex())).toBe(false);
    expect(io.files.has(FOLDER_CACHE_FILENAME)).toBe(false);
  });

  it('clear removes the file so a later load misses', async () => {
    const io = new FakeIO();
    await saveFolderCache(io, sampleIndex());
    await clearFolderCache(io);
    expect(io.files.has(FOLDER_CACHE_FILENAME)).toBe(false);
    expect(await loadFolderCache(io)).toBeNull();
  });

  it('clear on an absent file is a silent no-op', async () => {
    const io = new FakeIO();
    await expect(clearFolderCache(io)).resolves.toBeUndefined();
  });
});
