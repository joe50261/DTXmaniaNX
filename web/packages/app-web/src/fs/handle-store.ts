// Minimal IndexedDB keyval store for persisting a FileSystemDirectoryHandle
// + the scan cache. Hand-rolled to avoid a new npm dep. Both handle and
// SerializedIndex are structured-cloneable, so they survive IDB round-trip.

import type { SerializedIndex } from '@dtxmania/dtx-core';

const DB_NAME = 'dtxmania';
/** v2 adds the 'scan-cache' object store. Older DBs are migrated in-place
 * by onupgradeneeded — existing 'handles' store is left untouched. */
const DB_VERSION = 2;
const STORE_HANDLES = 'handles';
const STORE_SCAN_CACHE = 'scan-cache';
const KEY_ROOT = 'songs-root';
/** Single-slot cache for now (we only support one library at a time). If
 * we ever allow multi-library, this becomes a composite key. */
const KEY_INDEX = 'current';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES);
      if (!db.objectStoreNames.contains(STORE_SCAN_CACHE)) db.createObjectStore(STORE_SCAN_CACHE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = fn(transaction.objectStore(store));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      })
  );
}

export function saveRootHandle(handle: FileSystemDirectoryHandle): Promise<IDBValidKey> {
  return tx(STORE_HANDLES, 'readwrite', (s) => s.put(handle, KEY_ROOT));
}

export async function loadRootHandle(): Promise<FileSystemDirectoryHandle | null> {
  const value = await tx<unknown>(STORE_HANDLES, 'readonly', (s) => s.get(KEY_ROOT));
  if (!value) return null;
  // Browsers store these as FileSystemDirectoryHandle instances via structured clone.
  if (isDirectoryHandle(value)) return value;
  return null;
}

export function clearRootHandle(): Promise<undefined> {
  return tx<undefined>(STORE_HANDLES, 'readwrite', (s) => s.delete(KEY_ROOT));
}

/**
 * Persist the latest scan result. Called once per successful scan so the
 * next boot can skip re-walking the directory. The whole SerializedIndex
 * goes in as one blob — IDB handles the structured clone.
 */
export function saveScanCache(index: SerializedIndex): Promise<IDBValidKey> {
  return tx(STORE_SCAN_CACHE, 'readwrite', (s) => s.put(index, KEY_INDEX));
}

export async function loadScanCache(): Promise<SerializedIndex | null> {
  const value = await tx<unknown>(STORE_SCAN_CACHE, 'readonly', (s) => s.get(KEY_INDEX));
  if (!value || typeof value !== 'object') return null;
  // Structural sanity so a stale shape can't crash deserializeIndex.
  const v = value as Partial<SerializedIndex>;
  if (typeof v.version !== 'number' || !v.root || !('rootPath' in v)) return null;
  return value as SerializedIndex;
}

export function clearScanCache(): Promise<undefined> {
  return tx<undefined>(STORE_SCAN_CACHE, 'readwrite', (s) => s.delete(KEY_INDEX));
}

function isDirectoryHandle(v: unknown): v is FileSystemDirectoryHandle {
  return typeof v === 'object' && v !== null && (v as { kind?: string }).kind === 'directory';
}
