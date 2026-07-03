// Durable, folder-resident scan cache.
//
// The primary scan cache lives in IndexedDB (see handle-store.ts), which is
// fast but *best-effort* storage: the Meta Quest Browser (and other
// Chromium/Android browsers) evict best-effort IndexedDB between sessions
// under storage pressure or inactivity. When that happens the app loses its
// cached song index — and the picked directory handle — and has to re-walk
// the whole library (~50 s on a Quest 3), which is the "cache keeps getting
// invalidated, it rescans every time" symptom.
//
// This module adds a second, more durable copy: the serialized index is
// written as a single hidden JSON file at the root of the user's Songs
// folder. A file inside the folder survives IndexedDB eviction, travels with
// the folder across devices, and is inherently tied to the library it
// describes (no single-slot "which folder was this?" ambiguity the IDB cache
// has). It mirrors the desktop DTXmania, which persists its enumerated song
// list to `songlist.db` / `songs.db` next to the executable.
//
// Writing requires the directory handle to hold `readwrite` permission. When
// only `read` was granted every write here fails softly and the app falls
// back to the IDB cache — nothing breaks, the folder copy is just skipped.

import type { SerializedIndex } from '@dtxmania/dtx-core';

/**
 * Filename of the on-disk scan cache, written at the library root. A leading
 * dot keeps it out of the way in file listings. The scanner only parses
 * `.dtx` / `set.def` / `box.def`, so this stray `.json` is inert during a
 * walk — it is neither recursed into (it is a file) nor turned into a song.
 */
export const FOLDER_CACHE_FILENAME = '.dtxmania-song-index.json';

/**
 * The slice of a file-system backend the folder cache needs. Kept minimal
 * (and separate from the full `FileSystemBackend`) so it is trivially
 * fakeable in unit tests and so read-only callers can satisfy it too.
 * `HandleFileSystemBackend` implements this structurally.
 */
export interface CacheFileIO {
  readText(path: string, encoding?: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  removeFile(path: string): Promise<void>;
}

/**
 * Read and structurally validate the folder cache. Returns `null` — never
 * throws — when the file is absent, unreadable, not JSON, or the wrong
 * shape, so the caller can cleanly fall through to the IDB cache or a fresh
 * scan. Version compatibility is *not* checked here; that is the caller's
 * `deserializeIndex` step, matching how the IDB cache is consumed.
 */
export async function loadFolderCache(io: CacheFileIO): Promise<SerializedIndex | null> {
  let text: string;
  try {
    // UTF-8: we write the JSON as UTF-8, so decode it as such rather than
    // the DTX-default shift-jis (song titles can carry multibyte chars).
    text = await io.readText(FOLDER_CACHE_FILENAME, 'utf-8');
  } catch {
    return null; // no cache file yet, or read denied
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null; // truncated / corrupt write
  }
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<SerializedIndex>;
  if (typeof v.version !== 'number' || !v.root || !('rootPath' in v)) return null;
  return value as SerializedIndex;
}

/**
 * Persist the serialized index into the Songs folder. Returns `true` on
 * success, `false` if the write failed (read-only permission, quota, an
 * unsupported backend, …). Never throws — a failed folder write must not
 * take down the scan, which has already succeeded and been cached in IDB by
 * the time this runs.
 */
export async function saveFolderCache(
  io: CacheFileIO,
  index: SerializedIndex
): Promise<boolean> {
  try {
    await io.writeText(FOLDER_CACHE_FILENAME, JSON.stringify(index));
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the folder cache file. Best-effort and silent — used by "Rescan"
 * so a stale copy can't be read back before the fresh scan overwrites it.
 */
export async function clearFolderCache(io: CacheFileIO): Promise<void> {
  try {
    await io.removeFile(FOLDER_CACHE_FILENAME);
  } catch {
    /* nothing to clear */
  }
}
