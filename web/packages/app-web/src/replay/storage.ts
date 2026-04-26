/**
 * Hand-rolled IndexedDB store for `Replay` envelopes.
 *
 * Pattern mirrors `fs/handle-store.ts`. We use a SEPARATE DB
 * (`dtxmania-replays`, not `dtxmania`) for two reasons:
 *  - Growth profile differs — replay payloads can be hundreds of KB
 *    each; isolating them lets future quota / eviction policies stay
 *    local to this module without touching song-library state.
 *  - Schema decoupling — adding the replays object store via a
 *    DB_VERSION bump on the shared `dtxmania` DB would force
 *    `handle-store.ts` to know about replays. Cleaner to keep them
 *    apart while the replay subsystem is still settling.
 *
 * Records:
 *  - Key: a `crypto.randomUUID()` string generated at save time.
 *  - Value: the full `Replay` (structured-clone-friendly: arrays,
 *    objects, primitives, no class instances). The list-screen UI
 *    only needs a summary, but storing the projection separately
 *    would double the write cost for no real benefit at MVP scale —
 *    a few hundred replays is well under what IDB can scan quickly.
 *
 * NOT in this layer:
 *  - Sort / filter — caller (Replays screen) decides ordering.
 *  - Quota handling — when we hit it, a future "evict oldest" policy
 *    can live here. For MVP, IDB throws and the caller surfaces it.
 *  - Cross-tab notification — caller polls.
 */

import type { Replay } from './recorder-model.js';

const DB_NAME = 'dtxmania-replays';
const DB_VERSION = 1;
const STORE_REPLAYS = 'replays';

/** Compact projection of a `Replay` for the list screen. The full
 * envelope is large (hits + poses); summaries let the UI render
 * a wheel without paying the full deserialise cost per row. */
export interface ReplaySummary {
  id: string;
  chartHash: string;
  title: string | undefined;
  artist: string | undefined;
  durationMs: number;
  /** ISO 8601, mirrors `Replay.startedAt`. Caller sorts on this. */
  startedAt: string;
  finalScoreNorm: number;
  comboMax: number;
  fullCombo: boolean;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_REPLAYS)) {
        db.createObjectStore(STORE_REPLAYS);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE_REPLAYS, mode);
        const request = fn(transaction.objectStore(STORE_REPLAYS));
        transaction.oncomplete = () => {
          db.close();
          resolve(request.result);
        };
        transaction.onerror = () => {
          db.close();
          reject(transaction.error);
        };
        transaction.onabort = () => {
          db.close();
          reject(transaction.error);
        };
      }),
  );
}

/** Generate the row id. Pulled out so tests can stub it. */
function newId(): string {
  return crypto.randomUUID();
}

/** Persist a replay; returns the generated id. */
export function saveReplay(_replay: Replay): Promise<string> {
  throw new Error('saveReplay: not implemented');
}

/** List every saved replay's summary. Caller sorts by `startedAt`. */
export function listReplaySummaries(): Promise<ReplaySummary[]> {
  throw new Error('listReplaySummaries: not implemented');
}

/** Load the full envelope by id, or null if not found. */
export function loadReplay(_id: string): Promise<Replay | null> {
  throw new Error('loadReplay: not implemented');
}

/** Idempotent — deleting a nonexistent id is a no-op. */
export function deleteReplay(_id: string): Promise<void> {
  throw new Error('deleteReplay: not implemented');
}

/** Project a stored Replay row + its key into a summary. Exposed
 * (testable in isolation) so the projection rule is in one place. */
export function summarise(id: string, replay: Replay): ReplaySummary {
  return {
    id,
    chartHash: replay.meta.chartHash,
    title: replay.meta.title,
    artist: replay.meta.artist,
    durationMs: replay.meta.durationMs,
    startedAt: replay.startedAt,
    finalScoreNorm: replay.final.finalScoreNorm,
    comboMax: replay.final.comboMax,
    fullCombo: replay.final.fullCombo,
  };
}

// Export internals only for tests (the real code path uses the
// public functions above).
export const __test__ = { DB_NAME, STORE_REPLAYS };
