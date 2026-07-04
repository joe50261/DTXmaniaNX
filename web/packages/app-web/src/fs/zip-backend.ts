import {
  BlobReader,
  configure,
  ZipReader,
  type Entry,
} from '@zip.js/zip.js/index-native.js';
import { decodeTextWithBom, type DirEntry } from '@dtxmania/dtx-core';
import type { AppFileSystemBackend } from './handle-backend.js';
import {
  hasZipExt,
  listZipChildren,
  normalizeZipPath,
  splitZipPath,
  zipEntryExists,
  type ZipMember,
} from './zip-tree.js';

/**
 * Reads song packs straight out of `.zip` files — no extraction, the Songs
 * folder is never modified.
 *
 * ## How it stays invisible to the scanner
 *
 * The whole feature is a *view* layered over an inner backend: a `.zip` file
 * is presented as if it were a directory. `listDir` at the Songs root rewrites
 * every `foo.zip` file into a directory entry (`isDirectory: true`, name with
 * the `.zip` stripped for display, **path kept as `foo.zip`** so reads route
 * back in). Any path that descends through a `.zip` segment
 * (`foo.zip/song/adv.dtx`) is served from the archive.
 *
 * Because the archive looks like a plain directory tree, `SongScanner` walks
 * it, finds `set.def` / `box.def` / `.dtx`, reads headers, builds the index,
 * and persists the scan cache with **zero scanner changes**. Playback, preview
 * audio and cover art also flow through this backend's `readFile`, so they
 * decompress on demand from the same archive.
 *
 * ## Zip handling is zip.js, not hand-rolled
 *
 * All archive parsing + inflation is delegated to `@zip.js/zip.js`. Its
 * `BlobReader` does genuine **ranged** reads (`Blob.slice()`): opening a pack
 * reads only the end-of-central-directory tail + central directory, and each
 * member's bytes are pulled on demand. A multi-hundred-MB pack is never
 * materialised whole, which matters on a Quest 3. We use the *native* build,
 * so decompression is the platform `DecompressionStream` (every target
 * Chromium + Node ≥ 21.2 for tests) — no bundled WASM codec, no web workers.
 *
 * Non-`.zip` paths and the write operations (`writeText` / `removeFile`, used
 * only for the root scan-cache file) pass straight through to the inner
 * backend.
 */

// Inline codec, no worker/asset URLs to bundle. Idempotent; safe at module load.
configure({ useWebWorkers: false });

// Non-UTF-8 member names are decoded as Shift_JIS — the DTX ecosystem's legacy
// convention — so in-archive names match the Shift_JIS `set.def` references
// that point at them. Names flagged UTF-8 (bit 11) still decode as UTF-8.
const FILENAME_ENCODING = 'shift_jis';

/** The inner backend a `ZipAwareBackend` wraps: the app backend contract plus
 * the ability to hand out a `Blob` for ranged reads. `HandleFileSystemBackend`
 * satisfies this structurally. */
export interface ZipInnerBackend extends AppFileSystemBackend {
  openFile(path: string): Promise<Blob>;
}

interface ZipHandle {
  reader: ZipReader<unknown>;
  /** Directory-tree view used for listing / existence checks. */
  members: ZipMember[];
  /** Normalised member name → zip.js entry, for reading bytes. */
  byName: Map<string, Entry>;
}

export class ZipAwareBackend implements AppFileSystemBackend {
  /** zipPath → (open zip.js reader + its parsed entries). Memoised so a scan
   * that lists many subdirectories of one pack parses the central directory
   * once. A scan never mutates the tree under us; a folder change rebuilds the
   * backend, which drops this cache with it. */
  private readonly zips = new Map<string, Promise<ZipHandle>>();

  constructor(private readonly inner: ZipInnerBackend) {}

  async listDir(path: string): Promise<DirEntry[]> {
    const route = splitZipPath(path);
    if (route) {
      const { members } = await this.zipHandle(route.zipPath);
      const prefix = normalizeZipPath(path);
      return listZipChildren(members, route.innerPath).map((child) => ({
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
        // path keeps its `.zip` so later reads route back into it; only the
        // display name is stripped.
        return {
          name: entry.name.slice(0, -'.zip'.length),
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
    return this.readZipBytes(route.zipPath, route.innerPath);
  }

  async readText(path: string, encoding = 'shift-jis'): Promise<string> {
    const route = splitZipPath(path);
    if (!route) return this.inner.readText(path, encoding);
    const buf = await this.readZipBytes(route.zipPath, route.innerPath);
    return decodeTextWithBom(buf, encoding);
  }

  async exists(path: string): Promise<boolean> {
    const route = splitZipPath(path);
    if (!route) return this.inner.exists(path);
    try {
      const { members } = await this.zipHandle(route.zipPath);
      // innerPath === '' is the archive root — it exists iff the archive
      // parsed, which `zipHandle` proved by not throwing.
      return route.innerPath === '' || zipEntryExists(members, route.innerPath);
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

  /** Inflate one in-archive file to its raw bytes (ranged read + decompress
   * via zip.js). Throws for a missing entry, a directory, or an encrypted
   * member. */
  private async readZipBytes(zipPath: string, innerPath: string): Promise<ArrayBuffer> {
    const { byName } = await this.zipHandle(zipPath);
    const entry = byName.get(normalizeZipPath(innerPath));
    if (!entry || entry.directory) {
      throw new Error(`not a file inside ${zipPath}: ${innerPath}`);
    }
    if (entry.encrypted) {
      throw new Error(`encrypted zip entries are not supported: ${zipPath}/${innerPath}`);
    }
    // `directory: false` narrows `Entry` to `FileEntry`, which carries
    // `arrayBuffer()`.
    return entry.arrayBuffer();
  }

  private zipHandle(zipPath: string): Promise<ZipHandle> {
    let handle = this.zips.get(zipPath);
    if (!handle) {
      handle = (async () => {
        const blob = await this.inner.openFile(zipPath);
        const reader = new ZipReader(new BlobReader(blob), {
          filenameEncoding: FILENAME_ENCODING,
        });
        const entries = await reader.getEntries();
        const members: ZipMember[] = [];
        const byName = new Map<string, Entry>();
        for (const entry of entries) {
          const name = normalizeZipPath(entry.filename);
          if (name.length === 0) continue; // stray root "/" member
          members.push({ name, isDirectory: entry.directory });
          byName.set(name, entry);
        }
        return { reader, members, byName };
      })();
      // Drop a cached rejection so a later attempt (e.g. after the user
      // re-grants folder access) can retry cleanly.
      handle.catch(() => this.zips.delete(zipPath));
      this.zips.set(zipPath, handle);
    }
    return handle;
  }
}
