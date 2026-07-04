import {
  decodeTextWithBom,
  listZipDir,
  normalizeZipPath,
  readZipDirectory,
  readZipEntry,
  zipEntryExists,
  type ByteSource,
  type DirEntry,
  type ZipDirectory,
} from '@dtxmania/dtx-core';
import type { AppFileSystemBackend } from './handle-backend.js';

/**
 * Reads song packs straight out of `.zip` files — no extraction, the Songs
 * folder is never modified.
 *
 * ## How it stays invisible to the scanner
 *
 * The whole feature is a *view* layered over an inner backend: a `.zip` file
 * is presented as if it were a directory. `listDir` at the Songs root rewrites
 * every `foo.zip` file into a directory entry (`isDirectory: true`, name with
 * the `.zip` stripped for display, **path kept as `foo.zip`** so reads can
 * route back in). Any path that descends through a `.zip` segment
 * (`foo.zip/song/adv.dtx`) is served from the archive's central directory.
 *
 * Because the archive looks like a plain directory tree, `SongScanner` walks
 * it, finds `set.def` / `box.def` / `.dtx`, reads headers, builds the index,
 * and persists the scan cache with **zero scanner changes**. Playback, preview
 * audio and cover art also flow through this backend's `readFile`, so they
 * inflate on demand from the same archive.
 *
 * ## Memory
 *
 * The archive is opened once as a `Blob` and only ever range-`slice()`d — the
 * end-of-central-directory tail, the central directory, and one entry's
 * compressed bytes at a time. A multi-hundred-MB pack is never materialised
 * whole, which matters on a Quest 3.
 *
 * Non-`.zip` paths and the write operations (`writeText` / `removeFile`, used
 * only for the root scan-cache file) pass straight through to the inner
 * backend.
 */

/** The inner backend a `ZipAwareBackend` wraps: the app backend contract plus
 * the ability to hand out a `Blob` for ranged reads. `HandleFileSystemBackend`
 * satisfies this structurally. */
export interface ZipInnerBackend extends AppFileSystemBackend {
  openFile(path: string): Promise<Blob>;
}

const ZIP_EXT = '.zip';

interface ZipHandle {
  source: ByteSource;
  dir: ZipDirectory;
}

export class ZipAwareBackend implements AppFileSystemBackend {
  /** zipPath → (opened archive + parsed central directory). Memoised so a
   * scan that lists many subdirectories of one pack parses the central
   * directory once. A single scan never mutates the tree under us, so caching
   * for the backend's lifetime is safe; a folder change rebuilds the backend. */
  private readonly zips = new Map<string, Promise<ZipHandle>>();

  constructor(private readonly inner: ZipInnerBackend) {}

  async listDir(path: string): Promise<DirEntry[]> {
    const route = splitZipPath(path);
    if (route) {
      const { dir } = await this.zipHandle(route.zipPath);
      const prefix = normalizeZipPath(path);
      return listZipDir(dir.entries, route.innerPath).map((child) => ({
        name: child.name,
        path: `${prefix}/${child.name}`,
        isDirectory: child.isDirectory,
        isFile: !child.isDirectory,
      }));
    }

    const entries = await this.inner.listDir(path);
    return entries.map((entry) => {
      if (entry.isFile && hasZipExt(entry.name)) {
        // Surface the archive as a browsable directory (the song pack). The
        // path keeps its `.zip` so subsequent reads route back into it; only
        // the display name is stripped.
        return {
          name: entry.name.slice(0, -ZIP_EXT.length),
          path: entry.path,
          isDirectory: true,
          isFile: false,
        };
      }
      return entry;
    });
  }

  async readFile(path: string): Promise<ArrayBuffer> {
    const route = splitZipPath(path);
    if (!route) return this.inner.readFile(path);
    const bytes = await this.readZip(route.zipPath, route.innerPath);
    // Return a standalone ArrayBuffer sliced to exactly the entry's bytes.
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async readText(path: string, encoding = 'shift-jis'): Promise<string> {
    const route = splitZipPath(path);
    if (!route) return this.inner.readText(path, encoding);
    const bytes = await this.readZip(route.zipPath, route.innerPath);
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    return decodeTextWithBom(buf, encoding);
  }

  async exists(path: string): Promise<boolean> {
    const route = splitZipPath(path);
    if (!route) return this.inner.exists(path);
    try {
      const { dir } = await this.zipHandle(route.zipPath);
      // innerPath === '' is the archive root — it exists iff the archive
      // parsed, which `zipHandle` already proved by not throwing.
      return route.innerPath === '' || zipEntryExists(dir.entries, route.innerPath);
    } catch {
      return false;
    }
  }

  // The scan cache is a single JSON file at the Songs-folder root — never
  // inside an archive — so these forward unconditionally to the inner backend.
  writeText(path: string, text: string): Promise<void> {
    return this.inner.writeText(path, text);
  }

  removeFile(path: string): Promise<void> {
    return this.inner.removeFile(path);
  }

  private async readZip(zipPath: string, innerPath: string): Promise<Uint8Array> {
    const { source, dir } = await this.zipHandle(zipPath);
    const entry = dir.byName.get(normalizeZipPath(innerPath));
    if (!entry || entry.isDirectory) {
      throw new Error(`not a file inside ${zipPath}: ${innerPath}`);
    }
    return readZipEntry(source, entry, inflateRaw);
  }

  private zipHandle(zipPath: string): Promise<ZipHandle> {
    let handle = this.zips.get(zipPath);
    if (!handle) {
      handle = (async () => {
        const blob = await this.inner.openFile(zipPath);
        const source = blobByteSource(blob);
        const dir = await readZipDirectory(source);
        return { source, dir };
      })();
      // If the open/parse rejects, drop the cached rejection so a later
      // attempt (e.g. after the user re-grants access) can retry cleanly.
      handle.catch(() => this.zips.delete(zipPath));
      this.zips.set(zipPath, handle);
    }
    return handle;
  }
}

/** Split a POSIX path at its first `.zip` segment. Returns the archive path
 * (through and including the `.zip` segment) and the remaining in-archive
 * path, or `null` when no segment is a `.zip`. The first `.zip` wins, so a
 * (pathological) nested archive is treated as opaque bytes rather than a
 * second directory layer. */
export function splitZipPath(path: string): { zipPath: string; innerPath: string } | null {
  const segments = normalizeZipPath(path)
    .split('/')
    .filter((s) => s.length > 0);
  for (let i = 0; i < segments.length; i++) {
    if (hasZipExt(segments[i]!)) {
      return {
        zipPath: segments.slice(0, i + 1).join('/'),
        innerPath: segments.slice(i + 1).join('/'),
      };
    }
  }
  return null;
}

function hasZipExt(name: string): boolean {
  return name.toLowerCase().endsWith(ZIP_EXT);
}

/** `ByteSource` backed by a `Blob`, using `slice()` for genuine ranged reads
 * (the browser only pulls the requested window off disk). */
function blobByteSource(blob: Blob): ByteSource {
  return {
    size: () => blob.size,
    read: async (offset, length) =>
      new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
  };
}

/** Raw-DEFLATE inflate via the platform `DecompressionStream`. Supported by
 * every Chromium the app targets (desktop, Edge, Quest Browser) and by Node
 * ≥ 21.2, which is what the tests run on. */
async function inflateRaw(deflated: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([deflated as BlobPart]).stream().pipeThrough(
    new DecompressionStream('deflate-raw')
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
