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
export class HandleFileSystemBackend implements FileSystemBackend {
  constructor(private readonly root: FileSystemDirectoryHandle) {}

  async listDir(path: string): Promise<DirEntry[]> {
    const dir = await this.resolveDir(path);
    const prefix = normalize(path);
    const entries: DirEntry[] = [];
    for await (const handle of dir.values()) {
      entries.push({
        name: handle.name,
        path: prefix ? `${prefix}/${handle.name}` : handle.name,
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
    let current: FileSystemDirectoryHandle = this.root;
    for (const seg of segments) {
      try {
        current = await current.getDirectoryHandle(seg);
      } catch {
        return null;
      }
    }
    return current;
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
