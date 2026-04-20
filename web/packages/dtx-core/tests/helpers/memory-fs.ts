import {
  decodeTextWithBom,
  type DirEntry,
  type FileSystemBackend,
} from '../../src/scanner/fs-backend.js';

type Entry = { kind: 'file'; bytes: Uint8Array } | { kind: 'dir' };

/**
 * Test-only in-memory FileSystemBackend. Paths are POSIX; directories are
 * implicit (any path that is a prefix of a file path acts as a directory).
 */
export class MemoryFs implements FileSystemBackend {
  private readonly entries = new Map<string, Entry>();

  setFile(path: string, content: string | Uint8Array): void {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    this.entries.set(normalize(path), { kind: 'file', bytes });
    // Register parent chain as directories for exists()/listDir().
    let parent = parentOf(normalize(path));
    while (parent.length > 0 && !this.entries.has(parent)) {
      this.entries.set(parent, { kind: 'dir' });
      parent = parentOf(parent);
    }
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const norm = normalize(path);
    const prefix = norm === '' ? '' : norm + '/';
    const seen = new Map<string, DirEntry>();
    for (const [p, entry] of this.entries) {
      if (p === norm) continue;
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const name = rest.split('/')[0]!;
      const childPath = prefix + name;
      if (seen.has(name)) continue;
      const childEntry = this.entries.get(childPath);
      const isDir = childEntry?.kind === 'dir';
      seen.set(name, {
        name,
        path: childPath,
        isDirectory: isDir,
        isFile: !isDir,
      });
    }
    return Array.from(seen.values());
  }

  async readFile(path: string): Promise<ArrayBuffer> {
    const e = this.entries.get(normalize(path));
    if (!e || e.kind !== 'file') throw new Error(`not a file: ${path}`);
    return e.bytes.slice().buffer;
  }

  async readText(path: string, encoding: string = 'shift-jis'): Promise<string> {
    const e = this.entries.get(normalize(path));
    if (!e || e.kind !== 'file') throw new Error(`not a file: ${path}`);
    return decodeTextWithBom(e.bytes.buffer.slice(e.bytes.byteOffset, e.bytes.byteOffset + e.bytes.byteLength) as ArrayBuffer, encoding);
  }

  async exists(path: string): Promise<boolean> {
    return this.entries.has(normalize(path));
  }
}

function normalize(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/+$/, '');
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? '' : path.slice(0, idx);
}
