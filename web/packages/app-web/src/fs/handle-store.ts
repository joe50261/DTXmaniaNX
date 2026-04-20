// Minimal IndexedDB keyval store for persisting a FileSystemDirectoryHandle.
// Hand-rolled to avoid a new npm dep. `FileSystemDirectoryHandle` is
// structured-cloneable, so it survives an IDB round-trip.

const DB_NAME = 'dtxmania';
const DB_VERSION = 1;
const STORE = 'handles';
const KEY_ROOT = 'songs-root';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = fn(transaction.objectStore(STORE));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      })
  );
}

export function saveRootHandle(handle: FileSystemDirectoryHandle): Promise<IDBValidKey> {
  return tx('readwrite', (s) => s.put(handle, KEY_ROOT));
}

export async function loadRootHandle(): Promise<FileSystemDirectoryHandle | null> {
  const value = await tx<unknown>('readonly', (s) => s.get(KEY_ROOT));
  if (!value) return null;
  // Browsers store these as FileSystemDirectoryHandle instances via structured clone.
  if (isDirectoryHandle(value)) return value;
  return null;
}

export function clearRootHandle(): Promise<undefined> {
  return tx<undefined>('readwrite', (s) => s.delete(KEY_ROOT));
}

function isDirectoryHandle(v: unknown): v is FileSystemDirectoryHandle {
  return typeof v === 'object' && v !== null && (v as { kind?: string }).kind === 'directory';
}
