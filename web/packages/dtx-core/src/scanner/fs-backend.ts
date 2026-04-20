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

/**
 * Decode a file's raw bytes to text, honouring any Unicode byte-order mark.
 *
 * Real-world DTX + set.def files come in three flavours:
 *   - UTF-16 LE with BOM (DTXCreator default on Windows; very common)
 *   - UTF-8 with BOM (newer charts saved from Notepad / VSCode)
 *   - Shift_JIS with no BOM (legacy, still the most common for .dtx bodies)
 *
 * If no BOM is present we try the caller's expected encoding (usually
 * `shift-jis`) with `fatal: true`; if that throws (invalid bytes in that
 * encoding) we fall back to `utf-8` non-fatal so at least something comes
 * out. Callers that know the encoding can still pass it explicitly.
 */
export function decodeTextWithBom(
  buf: ArrayBuffer,
  fallbackEncoding: string = 'shift-jis'
): string {
  const bytes = new Uint8Array(buf);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder(fallbackEncoding, { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}
