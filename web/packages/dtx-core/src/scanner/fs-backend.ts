/**
 * Abstract filesystem backend. Different environments provide different
 * implementations:
 *   - Node: fs/promises wrapper (for tests + headless CLI)
 *   - PWA: FileSystemDirectoryHandle (File System Access API)
 *   - Capacitor APK: @capacitor/filesystem
 *
 * All paths are POSIX-style ("/") even on Windows hosts; backends translate.
 */

export interface DirEntry {
  name: string;
  /** Full path from the root the backend was opened against. */
  path: string;
  isDirectory: boolean;
  isFile: boolean;
}

export interface FileSystemBackend {
  /** List immediate children of `path`. Throws if `path` is not a directory. */
  listDir(path: string): Promise<DirEntry[]>;

  /** Read a file as raw bytes. */
  readFile(path: string): Promise<ArrayBuffer>;

  /**
   * Read a file as text, decoding with `encoding` (default "shift-jis",
   * the DTX convention). Implementations should tolerate "utf-8".
   */
  readText(path: string, encoding?: string): Promise<string>;

  /** True if the path exists (as file or directory). */
  exists(path: string): Promise<boolean>;
}

/** Joins POSIX path segments, collapsing duplicate slashes. */
export function joinPath(...segments: string[]): string {
  const joined = segments.filter((s) => s.length > 0).join('/');
  return joined.replace(/\/+/g, '/');
}

/** Returns the parent directory path (POSIX). Returns "" for top-level. */
export function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '' : path.slice(0, idx);
}

/** Returns the basename (last segment) of a POSIX path. */
export function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? path : path.slice(idx + 1);
}

/** Returns the lowercase file extension including the dot, or "". */
export function extname(path: string): string {
  const base = basename(path);
  const idx = base.lastIndexOf('.');
  return idx <= 0 ? '' : base.slice(idx).toLowerCase();
}
