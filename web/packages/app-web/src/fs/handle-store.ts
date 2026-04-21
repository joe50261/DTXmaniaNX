// Minimal IndexedDB keyval store for persisting a FileSystemDirectoryHandle
// + the scan cache + per-chart records. Hand-rolled to avoid a new npm dep.
// All stored values (handle, SerializedIndex, ChartRecord) are structured-
// cloneable, so they survive IDB round-trip with no manual serialisation.

import type { ChartRecord, SerializedIndex } from '@dtxmania/dtx-core';

const DB_NAME = 'dtxmania';
/** Bumped as new stores appear. The upgrade handler adds missing stores
 * without touching old ones, so existing users keep their handle +
 * scan-cache when we introduce chart-records in v3. */
const DB_VERSION = 3;
const STORE_HANDLES = 'handles';
const STORE_SCAN_CACHE = 'scan-cache';
const STORE_CHART_RECORDS = 'chart-records';
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
      if (!db.objectStoreNames.contains(STORE_CHART_RECORDS)) {
        // Key is supplied explicitly (chartPath) — no keyPath / autoIncrement,
        // so the store just holds {key → ChartRecord}. Matches how the other
        // two stores work.
        db.createObjectStore(STORE_CHART_RECORDS);
      }
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

/**
 * Persist (or overwrite) a ChartRecord keyed by its chartPath. Called
 * by the game layer once per song-finish after merging the snapshot
 * into the previous record.
 */
export function saveChartRecord(rec: ChartRecord): Promise<IDBValidKey> {
  return tx(STORE_CHART_RECORDS, 'readwrite', (s) => s.put(rec, rec.chartPath));
}

/**
 * Read all records in one go so the caller can attach them to the scanned
 * ChartEntry list with a plain Map lookup afterwards. N records per
 * library is tiny (<10k even for huge collections), so loading them all
 * is cheaper than per-chart async IDB reads during wheel paint.
 */
export async function loadAllChartRecords(): Promise<Map<string, ChartRecord>> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_CHART_RECORDS, 'readonly');
    const store = transaction.objectStore(STORE_CHART_RECORDS);
    const req = store.openCursor();
    const out = new Map<string, ChartRecord>();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return; // transaction.oncomplete resolves
      const rec = cursor.value as ChartRecord;
      if (rec && typeof rec === 'object' && typeof rec.chartPath === 'string') {
        out.set(rec.chartPath, rec);
      }
      cursor.continue();
    };
    transaction.oncomplete = () => resolve(out);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** Wipe every ChartRecord. Called from "Forget folder" so switching
 * libraries doesn't carry stale medals. */
export function clearChartRecords(): Promise<undefined> {
  return tx<undefined>(STORE_CHART_RECORDS, 'readwrite', (s) => s.clear());
}
