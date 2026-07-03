import { describe, it, expect } from 'vitest';
import { HandleFileSystemBackend } from './handle-backend.js';

/**
 * Minimal fake that models the subset of the File System Access API
 * that HandleFileSystemBackend actually calls, plus a counter on
 * `getDirectoryHandle` so we can observe the LRU cache cutting round
 * trips. Doesn't pretend to be a full FSA polyfill — just enough for
 * the backend's resolve / listDir / readText paths.
 */
class FakeDirHandle {
  readonly kind = 'directory' as const;
  readonly name: string;
  readonly children = new Map<string, FakeDirHandle | FakeFileHandle>();
  getDirectoryHandleCalls = 0;

  constructor(name: string) {
    this.name = name;
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<FakeDirHandle> {
    this.getDirectoryHandleCalls++;
    let child = this.children.get(name);
    if (!child && options?.create) child = this.mkdir(name);
    if (!child || child.kind !== 'directory') {
      throw new Error(`no such directory: ${name}`);
    }
    return child;
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<FakeFileHandle> {
    let child = this.children.get(name);
    if (!child && options?.create) child = this.mkfile(name, '');
    if (!child || child.kind !== 'file') throw new Error(`no such file: ${name}`);
    return child;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.children.has(name)) throw new Error(`no such entry: ${name}`);
    this.children.delete(name);
  }

  async *values(): AsyncIterable<FakeDirHandle | FakeFileHandle> {
    for (const v of this.children.values()) yield v;
  }

  mkdir(name: string): FakeDirHandle {
    const d = new FakeDirHandle(name);
    this.children.set(name, d);
    return d;
  }

  mkfile(name: string, content: string): FakeFileHandle {
    const f = new FakeFileHandle(name, content);
    this.children.set(name, f);
    return f;
  }
}

class FakeFileHandle {
  readonly kind = 'file' as const;
  readonly name: string;
  content: string;

  constructor(name: string, content: string) {
    this.name = name;
    this.content = content;
  }

  async getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }> {
    const bytes = new TextEncoder().encode(this.content);
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    return { arrayBuffer: async () => buf };
  }

  // Models FileSystemFileHandle.createWritable(): buffers writes and
  // commits them to `content` on close(), like a real writable truncates
  // and replaces the file.
  async createWritable(): Promise<{
    write(data: string): Promise<void>;
    close(): Promise<void>;
  }> {
    let buffer = '';
    return {
      write: async (data: string) => {
        buffer += data;
      },
      close: async () => {
        this.content = buffer;
      },
    };
  }
}

/**
 * Returns every FakeDirHandle reachable from `root` so tests can sum
 * `getDirectoryHandleCalls` across the whole tree.
 */
function allDirs(root: FakeDirHandle): FakeDirHandle[] {
  const out: FakeDirHandle[] = [root];
  for (const child of root.children.values()) {
    if (child.kind === 'directory') out.push(...allDirs(child as FakeDirHandle));
  }
  return out;
}

function totalGetDirCalls(root: FakeDirHandle): number {
  return allDirs(root).reduce((n, d) => n + d.getDirectoryHandleCalls, 0);
}

describe('HandleFileSystemBackend / dir handle cache', () => {
  it('listDir on the same path twice only calls getDirectoryHandle once in total', async () => {
    const root = new FakeDirHandle('root');
    const rock = root.mkdir('Rock');
    rock.mkfile('a.dtx', '#TITLE A');
    rock.mkfile('b.dtx', '#TITLE B');

    const backend = new HandleFileSystemBackend(root as unknown as FileSystemDirectoryHandle);
    await backend.listDir('Rock');
    const callsAfterFirst = totalGetDirCalls(root);
    await backend.listDir('Rock');
    const callsAfterSecond = totalGetDirCalls(root);

    // First call resolves Rock from root (1 getDirectoryHandle). Second
    // call must hit the cache — no extra getDirectoryHandle.
    expect(callsAfterFirst).toBe(1);
    expect(callsAfterSecond).toBe(callsAfterFirst);
  });

  it('nested reads reuse the cached ancestor instead of re-walking from root', async () => {
    const root = new FakeDirHandle('root');
    const a = root.mkdir('a');
    const b = a.mkdir('b');
    const c = b.mkdir('c');
    c.mkfile('leaf.dtx', '#TITLE leaf');

    const backend = new HandleFileSystemBackend(root as unknown as FileSystemDirectoryHandle);
    // Warm the cache for the full chain a/b/c.
    await backend.listDir('a/b/c');
    const warm = totalGetDirCalls(root);
    // Read a file under the same dir — the cache should let us jump
    // straight to c without re-resolving a or b.
    await backend.readText('a/b/c/leaf.dtx');
    const afterRead = totalGetDirCalls(root);
    expect(afterRead).toBe(warm);
  });

  it('listDir opportunistically caches child dir handles from the iteration', async () => {
    const root = new FakeDirHandle('root');
    const a = root.mkdir('a');
    a.mkdir('b');
    a.mkdir('c');
    a.mkdir('d');

    const backend = new HandleFileSystemBackend(root as unknown as FileSystemDirectoryHandle);
    await backend.listDir('a');
    const afterList = totalGetDirCalls(root);
    // Listing a/ iterates its children via values() (no
    // getDirectoryHandle call). Now listing each child should find
    // its handle already in the cache.
    await backend.listDir('a/b');
    await backend.listDir('a/c');
    await backend.listDir('a/d');
    const afterChildren = totalGetDirCalls(root);
    expect(afterChildren).toBe(afterList);
  });

  it('still works correctly when an uncached path is requested (cold miss)', async () => {
    const root = new FakeDirHandle('root');
    const a = root.mkdir('alpha');
    a.mkfile('x.dtx', '#TITLE X');

    const backend = new HandleFileSystemBackend(root as unknown as FileSystemDirectoryHandle);
    // Sanity: the backend still returns correct data even though the
    // cache is empty before the first call.
    const entries = await backend.listDir('alpha');
    expect(entries.map((e) => e.name).sort()).toEqual(['x.dtx']);
  });
});

describe('HandleFileSystemBackend / writeText + removeFile', () => {
  it('writes a root-level file that reads back verbatim (UTF-8)', async () => {
    const root = new FakeDirHandle('root');
    const backend = new HandleFileSystemBackend(root as unknown as FileSystemDirectoryHandle);

    const payload = JSON.stringify({ hi: '東京 \u{1F941}' });
    await backend.writeText('.dtxmania-song-index.json', payload);

    // Present as a real child, and round-trips through readText (utf-8).
    expect(root.children.has('.dtxmania-song-index.json')).toBe(true);
    expect(await backend.readText('.dtxmania-song-index.json', 'utf-8')).toBe(payload);
  });

  it('overwrites an existing file rather than appending', async () => {
    const root = new FakeDirHandle('root');
    root.mkfile('.dtxmania-song-index.json', 'STALE-CONTENT');
    const backend = new HandleFileSystemBackend(root as unknown as FileSystemDirectoryHandle);

    await backend.writeText('.dtxmania-song-index.json', 'fresh');
    expect(await backend.readText('.dtxmania-song-index.json', 'utf-8')).toBe('fresh');
  });

  it('creates missing parent directories on write', async () => {
    const root = new FakeDirHandle('root');
    const backend = new HandleFileSystemBackend(root as unknown as FileSystemDirectoryHandle);

    await backend.writeText('cache/nested/index.json', '{}');
    expect(await backend.readText('cache/nested/index.json', 'utf-8')).toBe('{}');
  });

  it('removeFile deletes the file so a later read throws', async () => {
    const root = new FakeDirHandle('root');
    root.mkfile('.dtxmania-song-index.json', '{}');
    const backend = new HandleFileSystemBackend(root as unknown as FileSystemDirectoryHandle);

    await backend.removeFile('.dtxmania-song-index.json');
    expect(root.children.has('.dtxmania-song-index.json')).toBe(false);
    await expect(backend.readText('.dtxmania-song-index.json', 'utf-8')).rejects.toThrow();
  });

  it('removeFile on an absent file is a silent no-op', async () => {
    const root = new FakeDirHandle('root');
    const backend = new HandleFileSystemBackend(root as unknown as FileSystemDirectoryHandle);
    await expect(backend.removeFile('nope.json')).resolves.toBeUndefined();
  });
});
