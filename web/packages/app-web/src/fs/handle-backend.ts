import { decodeTextWithBom, type DirEntry, type FileSystemBackend } from '@dtxmania/dtx-core';

/**
 * FileSystemBackend implementation backed by a FileSystemDirectoryHandle
 * (the File System Access API). Used for the PWA bootstrap where the user
 * picks their Songs folder via showDirectoryPicker().
 *
 * POSIX-style paths are translated to handle navigation. The leading "/"
 * (if any) is treated as the root the handle was opened against; the
 * backend never escapes that root because navigation only uses
 * getDirectoryHandle / getFileHandle relative to the stored root.
 */
/**
 * Size of the LRU cache that maps already-resolved POSIX paths to their
 * FileSystemDirectoryHandle. Scanning a large library re-visits each
 * directory's ancestors over and over (listDir + readText + exists all
 * walk from root); with the cache a `getDirectoryHandle` per ancestor
 * turns into a Map hit. 256 entries comfortably covers the working set
 * of a typical scan (breadth-first walks only ever hold one branch's
 * ancestors live) without retaining handles forever.
 */
const DIR_HANDLE_CACHE_SIZE = 256;

export class HandleFileSystemBackend implements FileSystemBackend {
  /**
   * POSIX path → resolved DirHandle. Insertion-order Map used as an LRU:
   * on hit we re-insert to move-to-front; when over capacity we evict
   * the oldest key (first entry in iteration order).
   *
   * Correctness note: a DirHandle is a stable reference to its entry —
   * re-resolving from root yields the same handle object. Across a
   * single scan nothing mutates the tree under us, so caching is safe.
   * If the user changes folders the whole backend is recreated (see
   * main.ts scanIntoLibrary), which throws this cache away with it.
   */
  private readonly dirCache = new Map<string, FileSystemDirectoryHandle>();

  constructor(private readonly root: FileSystemDirectoryHandle) {}

  async listDir(path: string): Promise<DirEntry[]> {
    const dir = await this.resolveDir(path);
    const prefix = normalize(path);
    const entries: DirEntry[] = [];
    for await (const handle of dir.values()) {
      const childPath = prefix ? `${prefix}/${handle.name}` : handle.name;
      if (handle.kind === 'directory') {
        // Opportunistically populate the cache with every child dir
        // handle we iterate — we had to fetch them anyway to produce
        // the listing, so the subsequent walk's resolveDir on each
        // sub-path becomes a Map hit instead of another round trip.
        this.cacheDir(childPath, handle as FileSystemDirectoryHandle);
      }
      entries.push({
        name: handle.name,
        path: childPath,
        isDirectory: handle.kind === 'directory',
        isFile: handle.kind === 'file',
      });
    }
    return entries;
  }

  async readFile(path: string): Promise<ArrayBuffer> {
    const file = await this.getFile(path);
    return file.arrayBuffer();
  }

  async readText(path: string, encoding = 'shift-jis'): Promise<string> {
    const buf = await this.readFile(path);
    return decodeTextWithBom(buf, encoding);
  }

  async exists(path: string): Promise<boolean> {
    const segments = split(path);
    if (segments.length === 0) return true;
    const parent = await this.resolveDirSegments(segments.slice(0, -1));
    if (!parent) return false;
    const last = segments[segments.length - 1]!;
    try {
      await parent.getFileHandle(last);
      return true;
    } catch {
      /* not a file; try directory */
    }
    try {
      await parent.getDirectoryHandle(last);
      return true;
    } catch {
      return false;
    }
  }

  private async resolveDir(path: string): Promise<FileSystemDirectoryHandle> {
    const dir = await this.resolveDirSegments(split(path));
    if (!dir) throw new Error(`not a directory: ${path}`);
    return dir;
  }

  private async resolveDirSegments(
    segments: string[]
  ): Promise<FileSystemDirectoryHandle | null> {
    // Longest-prefix cache hit: walk segments from the full path down,
    // stopping at the first cached ancestor. Then only the uncached
    // tail segments need real getDirectoryHandle calls. For a deep tree
    // during a depth-first scan this typically finds a hit at depth-1.
    let startIdx = 0;
    let current: FileSystemDirectoryHandle = this.root;
    for (let i = segments.length; i > 0; i--) {
      const key = segments.slice(0, i).join('/');
      const cached = this.dirCache.get(key);
      if (cached) {
        // Move-to-front so cold ancestors don't evict hot branches.
        this.dirCache.delete(key);
        this.dirCache.set(key, cached);
        current = cached;
        startIdx = i;
        break;
      }
    }
    for (let i = startIdx; i < segments.length; i++) {
      try {
        current = await current.getDirectoryHandle(segments[i]!);
      } catch {
        return null;
      }
      this.cacheDir(segments.slice(0, i + 1).join('/'), current);
    }
    return current;
  }

  private cacheDir(key: string, handle: FileSystemDirectoryHandle): void {
    if (this.dirCache.has(key)) {
      // Refresh LRU position.
      this.dirCache.delete(key);
    } else if (this.dirCache.size >= DIR_HANDLE_CACHE_SIZE) {
      const oldest = this.dirCache.keys().next().value;
      if (oldest !== undefined) this.dirCache.delete(oldest);
    }
    this.dirCache.set(key, handle);
  }

  private async getFile(path: string): Promise<File> {
    const segments = split(path);
    if (segments.length === 0) throw new Error('empty path');
    const parent = await this.resolveDirSegments(segments.slice(0, -1));
    if (!parent) throw new Error(`parent directory missing: ${path}`);
    const fileHandle = await parent.getFileHandle(segments[segments.length - 1]!);
    return fileHandle.getFile();
  }
}

// Normalise a user-provided POSIX path to a slash-less-prefix, slash-less-suffix form.
function normalize(path: string): string {
  let p = path.replace(/\\/g, '/');
  while (p.startsWith('/')) p = p.slice(1);
  while (p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

function split(path: string): string[] {
  const n = normalize(path);
  if (n === '') return [];
  return n.split('/').filter((s) => s !== '' && s !== '.');
}
