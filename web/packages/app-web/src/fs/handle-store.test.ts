import { beforeEach, describe, expect, it } from 'vitest';
// `fake-indexeddb/auto` patches globalThis.indexedDB with an in-memory
// implementation — happy-dom's own IDB shim is incomplete, and real
// browsers aren't available in vitest anyway. This side-effect import
// has to land before handle-store is evaluated, but since we only
// import the store functions (not trigger them at module load) it's
// fine here.
import 'fake-indexeddb/auto';
import {
  clearChartRecords,
  clearRootHandle,
  clearScanCache,
  loadAllChartRecords,
  loadScanCache,
  saveChartRecord,
  saveScanCache,
} from './handle-store.js';
import type { ChartRecord, SerializedIndex } from '@dtxmania/dtx-core';

/** Delete the app's IDB between cases so one test's writes don't
 * bleed into the next. `deleteDatabase` blocks until all open
 * connections close; with our handle-store opening fresh connections
 * per call that's always immediate. */
beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('dtxmania');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
});

function record(chartPath: string, overrides: Partial<ChartRecord> = {}): ChartRecord {
  return {
    chartPath,
    bestScore: 500_000,
    bestRank: 'A',
    bestAchievement: 72,
    fullCombo: false,
    excellent: false,
    plays: 1,
    lastPlayedMs: 1000,
    ...overrides,
  };
}

describe('chart-records IDB store', () => {
  it('round-trips a single record', async () => {
    const rec = record('Songs/Rock/a.dtx', {
      bestScore: 823_456,
      bestRank: 'S',
      fullCombo: true,
      plays: 3,
    });
    await saveChartRecord(rec);
    const all = await loadAllChartRecords();
    expect(all.size).toBe(1);
    const got = all.get('Songs/Rock/a.dtx');
    expect(got).toEqual(rec);
  });

  it('loads every stored record into the map keyed by chartPath', async () => {
    const a = record('Songs/A.dtx', { bestScore: 100_000 });
    const b = record('Songs/B.dtx', { bestScore: 200_000 });
    const c = record('Songs/C.dtx', { bestScore: 300_000, excellent: true });
    await Promise.all([saveChartRecord(a), saveChartRecord(b), saveChartRecord(c)]);
    const all = await loadAllChartRecords();
    expect(all.size).toBe(3);
    expect(all.get('Songs/A.dtx')?.bestScore).toBe(100_000);
    expect(all.get('Songs/B.dtx')?.bestScore).toBe(200_000);
    expect(all.get('Songs/C.dtx')?.excellent).toBe(true);
  });

  it('save on the same chartPath overwrites the previous entry', async () => {
    await saveChartRecord(record('x.dtx', { bestScore: 100, plays: 1 }));
    await saveChartRecord(record('x.dtx', { bestScore: 900, plays: 5 }));
    const all = await loadAllChartRecords();
    expect(all.size).toBe(1);
    expect(all.get('x.dtx')?.bestScore).toBe(900);
    expect(all.get('x.dtx')?.plays).toBe(5);
  });

  it('clearChartRecords removes everything', async () => {
    await saveChartRecord(record('a.dtx'));
    await saveChartRecord(record('b.dtx'));
    await clearChartRecords();
    const all = await loadAllChartRecords();
    expect(all.size).toBe(0);
  });

  it('returns an empty map when nothing has been written', async () => {
    const all = await loadAllChartRecords();
    expect(all.size).toBe(0);
  });
});

describe('scan-cache IDB store', () => {
  it('round-trips a SerializedIndex with nested boxes + songs', async () => {
    const idx: SerializedIndex = {
      version: 2,
      rootPath: 'Songs',
      scannedAtMs: Date.now(),
      errors: [],
      root: {
        kind: 'box',
        name: '/',
        path: 'Songs',
        children: [
          {
            kind: 'box',
            name: 'Rock',
            path: 'Songs/Rock',
            children: [
              {
                kind: 'song',
                entry: {
                  title: 'A',
                  folderPath: 'Songs/Rock',
                  fromSetDef: false,
                  charts: [
                    { slot: 0, label: 'DTX', chartPath: 'Songs/Rock/a.dtx' },
                  ],
                },
              },
            ],
          },
        ],
      },
    };
    await saveScanCache(idx);
    const got = await loadScanCache();
    expect(got).toEqual(idx);
  });

  it('clearScanCache wipes the cached index', async () => {
    await saveScanCache({
      version: 2,
      rootPath: 'Songs',
      scannedAtMs: 0,
      errors: [],
      root: { kind: 'box', name: '/', path: 'Songs', children: [] },
    });
    await clearScanCache();
    expect(await loadScanCache()).toBeNull();
  });

  it('loadScanCache returns null when no cache exists', async () => {
    expect(await loadScanCache()).toBeNull();
  });

  it('rejects a structurally-invalid blob instead of handing back garbage', async () => {
    // Hand-write an entry missing the required `version` / `root`
    // fields, the shape loadScanCache's vetting pass is supposed to
    // reject. Need to open the store directly since saveScanCache
    // would write a valid blob.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('dtxmania', 3);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('handles')) d.createObjectStore('handles');
        if (!d.objectStoreNames.contains('scan-cache')) d.createObjectStore('scan-cache');
        if (!d.objectStoreNames.contains('chart-records')) d.createObjectStore('chart-records');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('scan-cache', 'readwrite');
      tx.objectStore('scan-cache').put({ version: 'bad', rootPath: 'X' }, 'current');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    expect(await loadScanCache()).toBeNull();
  });
});

describe('handles store', () => {
  it('clearRootHandle on an empty slot is a no-op (does not throw)', async () => {
    await expect(clearRootHandle()).resolves.toBeUndefined();
  });
});
