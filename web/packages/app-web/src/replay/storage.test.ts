// `fake-indexeddb/auto` patches globalThis.indexedDB with an in-memory
// implementation, so the storage layer's real IDB code path runs
// against a stub that survives test isolation.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Judgment } from '@dtxmania/dtx-core';
import { Lane } from '@dtxmania/input';
import {
  Recorder,
  type ChartMeta,
  type FinalSnapshot,
  type HitEvent,
  type PlayerSettings,
  type PoseSample,
  type Replay,
} from './recorder-model.js';
import {
  __test__,
  deleteReplay,
  listReplaySummaries,
  loadReplay,
  saveReplay,
  summarise,
  type ReplaySummary,
} from './storage.js';

/**
 * Each test runs against a fresh DB. fake-indexeddb's `IDBFactory.databases()`
 * isn't fully implemented, so we just delete by name between cases.
 */
async function wipeDb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(__test__.DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  await wipeDb();
});

afterEach(async () => {
  await wipeDb();
});

const META: ChartMeta = {
  chartPath: 'h-test',
  title: 'Test Song',
  artist: 'Test Artist',
  durationMs: 180_000,
};

const PLAYER: PlayerSettings = {
  audioOffsetMs: 0,
  autoPlayLanes: [],
};

const FINAL: FinalSnapshot = {
  finalScoreNorm: 0.8765,
  comboMax: 42,
  fullCombo: false,
  counts: { PERFECT: 30, GREAT: 8, GOOD: 2, POOR: 1, MISS: 1 },
};

function makeReplay(overrides: { meta?: Partial<ChartMeta>; final?: Partial<FinalSnapshot> } = {}): Replay {
  const r = new Recorder();
  r.start({ ...META, ...overrides.meta }, PLAYER);
  r.recordHit({
    songTimeMs: 1000,
    lane: Lane.SD,
    source: 'xr-left',
    chipIndex: 0,
    lagMs: 5,
    judgment: Judgment.PERFECT,
  } satisfies HitEvent);
  r.recordPose({
    songTimeMs: 1000,
    head: { pos: [0, 1.6, 0], quat: [0, 0, 0, 1] },
    left: { pos: [-0.3, 1, 0], quat: [0, 0, 0, 1] },
    right: { pos: [0.3, 1, 0], quat: [0, 0, 0, 1] },
  } satisfies PoseSample);
  return r.finish({ ...FINAL, ...overrides.final });
}

describe('summarise', () => {
  it('projects every meta + final field exactly, plus the id', () => {
    const replay = makeReplay();
    const s = summarise('abc', replay);
    expect(s).toEqual<ReplaySummary>({
      id: 'abc',
      chartPath: META.chartPath,
      title: META.title,
      artist: META.artist,
      durationMs: META.durationMs,
      startedAt: replay.startedAt,
      finalScoreNorm: FINAL.finalScoreNorm,
      comboMax: FINAL.comboMax,
      fullCombo: FINAL.fullCombo,
    });
  });

  it('preserves missing title / artist (replays without metadata)', () => {
    // Build a meta WITHOUT optional fields. exactOptionalPropertyTypes
    // forbids `title: undefined`, so we omit them from the object
    // entirely — that's the actual production shape when title /
    // artist aren't known.
    const r = new Recorder();
    r.start(
      {
        chartPath: 'no-meta',
        durationMs: 1000,
      },
      PLAYER,
    );
    const replay = r.finish(FINAL);
    const s = summarise('id', replay);
    expect(s.title).toBeUndefined();
    expect(s.artist).toBeUndefined();
  });
});

describe('saveReplay + loadReplay', () => {
  it('returns the generated id (UUID-shaped)', async () => {
    const id = await saveReplay(makeReplay());
    expect(typeof id).toBe('string');
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('loadReplay returns the saved envelope verbatim (lossless round-trip)', async () => {
    const original = makeReplay();
    const id = await saveReplay(original);
    const restored = await loadReplay(id);
    expect(restored).toEqual(original);
  });

  it('two saves of the same replay produce two distinct rows', async () => {
    const replay = makeReplay();
    const a = await saveReplay(replay);
    const b = await saveReplay(replay);
    expect(a).not.toBe(b);
    const summaries = await listReplaySummaries();
    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.id).sort()).toEqual([a, b].sort());
  });
});

describe('listReplaySummaries', () => {
  it('returns [] on an empty DB', async () => {
    expect(await listReplaySummaries()).toEqual([]);
  });

  it('returns a summary per saved replay', async () => {
    await saveReplay(makeReplay({ meta: { chartPath: 'one' } }));
    await saveReplay(makeReplay({ meta: { chartPath: 'two' } }));
    await saveReplay(makeReplay({ meta: { chartPath: 'three' } }));
    const out = await listReplaySummaries();
    expect(out).toHaveLength(3);
    expect(out.map((s) => s.chartPath).sort()).toEqual(['one', 'three', 'two']);
  });

  it('summary mirrors Replay.final values', async () => {
    await saveReplay(
      makeReplay({
        final: { finalScoreNorm: 0.5, comboMax: 7, fullCombo: true },
      }),
    );
    const [s] = await listReplaySummaries();
    expect(s?.finalScoreNorm).toBe(0.5);
    expect(s?.comboMax).toBe(7);
    expect(s?.fullCombo).toBe(true);
  });

  it('does NOT impose an order — caller sorts on startedAt', async () => {
    // Sanity: a list call returns whatever order IDB cursors yield.
    // We don't assert an order here; the test on saveReplay already
    // pins "all rows surfaced". Marker test so a future change to
    // pre-sort here gets caught.
    await saveReplay(makeReplay());
    await saveReplay(makeReplay());
    expect((await listReplaySummaries()).length).toBe(2);
  });
});

describe('deleteReplay', () => {
  it('removes the replay so listReplaySummaries omits it', async () => {
    const id = await saveReplay(makeReplay());
    await deleteReplay(id);
    expect(await listReplaySummaries()).toEqual([]);
  });

  it('makes loadReplay return null', async () => {
    const id = await saveReplay(makeReplay());
    await deleteReplay(id);
    expect(await loadReplay(id)).toBeNull();
  });

  it('is idempotent: deleting a nonexistent id resolves without error', async () => {
    await expect(deleteReplay('does-not-exist')).resolves.toBeUndefined();
  });

  it('only removes the targeted row', async () => {
    const a = await saveReplay(makeReplay({ meta: { chartPath: 'a' } }));
    const b = await saveReplay(makeReplay({ meta: { chartPath: 'b' } }));
    await deleteReplay(a);
    const remaining = await listReplaySummaries();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(b);
  });
});

describe('loadReplay (negative cases)', () => {
  it('returns null for a nonexistent id', async () => {
    expect(await loadReplay('no-such-id')).toBeNull();
  });

  it('returns null after the DB has been wiped (no leftover state)', async () => {
    const id = await saveReplay(makeReplay());
    await wipeDb();
    expect(await loadReplay(id)).toBeNull();
  });
});

