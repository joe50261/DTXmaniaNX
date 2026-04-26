// fake-indexeddb patches globalThis.indexedDB so the capture's
// finish() path (which calls saveReplay) hits an in-memory store.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Judgment, type ScoreSnapshot } from '@dtxmania/dtx-core';
import { Lane, type LaneValue } from '@dtxmania/input';
import {
  buildFinalSnapshot,
  buildHitEvent,
  buildPoseSample,
  createReplayCapture,
} from './capture-glue.js';
import {
  type ChartMeta,
  type PlayerSettings,
} from './recorder-model.js';
import { listReplaySummaries, loadReplay, __test__ as storage__test__ } from './storage.js';
import type { HitProcessedEvent } from '../game.js';
import type { XrPoseSnapshot } from '../xr-controllers.js';

async function wipeReplaysDb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(storage__test__.DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => { await wipeReplaysDb(); });
afterEach(async () => { await wipeReplaysDb(); });

const META: ChartMeta = {
  chartPath: 'test/song.dtx',
  title: 'Test',
  artist: 'Test',
  durationMs: 60_000,
};

const PLAYER: PlayerSettings = {
  audioOffsetMs: 0,
  autoPlayLanes: [],
};

const NO_AUTO = new Set<LaneValue>();

const POSE_SNAP: XrPoseSnapshot = {
  head: { pos: [0, 1.6, 0], quat: [0, 0, 0, 1] },
  left: { pos: [-0.3, 1, 0], quat: [0, 0, 0, 1] },
  right: { pos: [0.3, 1, 0], quat: [0, 0, 0, 1] },
};

function strayHpe(over: Partial<HitProcessedEvent> = {}): HitProcessedEvent {
  return { lane: Lane.SD, songTimeMs: 100, matched: null, ...over };
}

function matchedHpe(over: {
  lane?: LaneValue;
  songTimeMs?: number;
  idx?: number;
  deltaMs?: number | null;
  judgment?: HitProcessedEvent['matched'] extends infer M
    ? M extends { judgment: infer J } ? J : never
    : never;
} = {}): HitProcessedEvent {
  return {
    lane: over.lane ?? Lane.SD,
    songTimeMs: over.songTimeMs ?? 100,
    matched: {
      idx: over.idx ?? 5,
      deltaMs: over.deltaMs ?? 12,
      judgment: over.judgment ?? Judgment.PERFECT,
    },
  };
}

describe('buildHitEvent', () => {
  it('stray (matched=null) → chipIndex=-1, lagMs=null, MISS placeholder', () => {
    const ev = buildHitEvent(strayHpe(), NO_AUTO);
    expect(ev.chipIndex).toBe(-1);
    expect(ev.lagMs).toBeNull();
    expect(ev.judgment).toBe(Judgment.MISS);
    expect(ev.source).toBe('xr-right');
  });

  it('matched human input → carries idx + deltaMs + judgment, source=xr-right', () => {
    const ev = buildHitEvent(
      matchedHpe({ idx: 7, deltaMs: -8, judgment: Judgment.GREAT }),
      NO_AUTO,
    );
    expect(ev.chipIndex).toBe(7);
    expect(ev.lagMs).toBe(-8);
    expect(ev.judgment).toBe(Judgment.GREAT);
    expect(ev.source).toBe('xr-right');
  });

  it('auto-detected miss (matched.deltaMs===null) → source=auto, judgment=MISS', () => {
    const ev = buildHitEvent(
      matchedHpe({ idx: 3, deltaMs: null, judgment: Judgment.MISS }),
      NO_AUTO,
    );
    expect(ev.source).toBe('auto');
    expect(ev.chipIndex).toBe(3);
    expect(ev.lagMs).toBeNull();
    expect(ev.judgment).toBe(Judgment.MISS);
  });

  it('matched on autoPlay lane → source=auto (defensive — usually unreachable)', () => {
    const auto = new Set<LaneValue>([Lane.BD]);
    const ev = buildHitEvent(matchedHpe({ lane: Lane.BD }), auto);
    expect(ev.source).toBe('auto');
  });

  it('matched on non-autoPlay lane stays xr-right even if other lanes are auto', () => {
    const auto = new Set<LaneValue>([Lane.BD]);
    const ev = buildHitEvent(matchedHpe({ lane: Lane.SD }), auto);
    expect(ev.source).toBe('xr-right');
  });

  it('preserves songTimeMs + lane verbatim', () => {
    const ev = buildHitEvent(matchedHpe({ lane: Lane.HH, songTimeMs: 9999 }), NO_AUTO);
    expect(ev.songTimeMs).toBe(9999);
    expect(ev.lane).toBe(Lane.HH);
  });
});

describe('buildPoseSample', () => {
  it('stamps songTimeMs + carries head / left / right verbatim', () => {
    const out = buildPoseSample(POSE_SNAP, 12345);
    expect(out.songTimeMs).toBe(12345);
    expect(out.head).toEqual(POSE_SNAP.head);
    expect(out.left).toEqual(POSE_SNAP.left);
    expect(out.right).toEqual(POSE_SNAP.right);
  });

  it('preserves null pose fields (desktop play / lost tracking)', () => {
    const out = buildPoseSample(
      { head: null, left: null, right: null },
      0,
    );
    expect(out.head).toBeNull();
    expect(out.left).toBeNull();
    expect(out.right).toBeNull();
  });
});

describe('buildFinalSnapshot', () => {
  function snap(over: Partial<ScoreSnapshot> = {}): ScoreSnapshot {
    return {
      totalNotes: 100,
      counts: { PERFECT: 90, GREAT: 5, GOOD: 3, POOR: 1, MISS: 1 },
      combo: 0,
      maxCombo: 50,
      score: 876_500,
      autoCount: 0,
      ...over,
    };
  }

  it('normalises score to 0..1', () => {
    const out = buildFinalSnapshot(snap({ score: 500_000 }));
    expect(out.finalScoreNorm).toBeCloseTo(0.5);
  });

  it('carries maxCombo as comboMax', () => {
    expect(buildFinalSnapshot(snap({ maxCombo: 42 })).comboMax).toBe(42);
  });

  it('fullCombo = (POOR + MISS = 0) && totalNotes > 0', () => {
    expect(buildFinalSnapshot(snap({
      counts: { PERFECT: 100, GREAT: 0, GOOD: 0, POOR: 0, MISS: 0 },
    })).fullCombo).toBe(true);
    expect(buildFinalSnapshot(snap({
      counts: { PERFECT: 99, GREAT: 0, GOOD: 0, POOR: 1, MISS: 0 },
    })).fullCombo).toBe(false);
    expect(buildFinalSnapshot(snap({
      counts: { PERFECT: 99, GREAT: 0, GOOD: 0, POOR: 0, MISS: 1 },
    })).fullCombo).toBe(false);
    expect(buildFinalSnapshot(snap({
      totalNotes: 0,
      counts: { PERFECT: 0, GREAT: 0, GOOD: 0, POOR: 0, MISS: 0 },
    })).fullCombo).toBe(false);
  });

  it('counts is a shallow copy (mutation on input does not leak)', () => {
    const original = snap();
    const out = buildFinalSnapshot(original);
    (original.counts as { PERFECT: number }).PERFECT = 0;
    expect(out.counts.PERFECT).toBe(90);
  });
});

describe('createReplayCapture — lifecycle', () => {
  function snap(): ScoreSnapshot {
    return {
      totalNotes: 1,
      counts: { PERFECT: 1, GREAT: 0, GOOD: 0, POOR: 0, MISS: 0 },
      combo: 1,
      maxCombo: 1,
      score: 1_000_000,
      autoCount: 0,
    };
  }

  it('start → onHit / onPose accumulate → finish persists, returns id', async () => {
    const capture = createReplayCapture(NO_AUTO);
    capture.start(META, PLAYER);
    capture.onHit(matchedHpe({ idx: 0 }));
    capture.onPose(POSE_SNAP, 100);
    const id = await capture.finish(snap());
    expect(typeof id).toBe('string');
    const saved = await loadReplay(id);
    expect(saved?.hits).toHaveLength(1);
    expect(saved?.poses).toHaveLength(1);
    expect(saved?.meta.chartPath).toBe(META.chartPath);
  });

  it('discard → finish path NOT executed; nothing in storage', async () => {
    const capture = createReplayCapture(NO_AUTO);
    capture.start(META, PLAYER);
    capture.onHit(matchedHpe({ idx: 0 }));
    capture.discard();
    expect(await listReplaySummaries()).toEqual([]);
  });

  it('onHit / onPose before start are silently dropped (no recording active)', async () => {
    const capture = createReplayCapture(NO_AUTO);
    capture.onHit(matchedHpe());
    capture.onPose(POSE_SNAP, 0);
    capture.start(META, PLAYER);
    const id = await capture.finish(snap());
    const saved = await loadReplay(id);
    expect(saved?.hits).toHaveLength(0);
    expect(saved?.poses).toHaveLength(0);
  });

  it('discard then start again works (next run is independent)', async () => {
    const capture = createReplayCapture(NO_AUTO);
    capture.start(META, PLAYER);
    capture.onHit(matchedHpe({ songTimeMs: 100 }));
    capture.discard();
    capture.start(META, PLAYER);
    capture.onHit(matchedHpe({ songTimeMs: 200 }));
    const id = await capture.finish(snap());
    const saved = await loadReplay(id);
    expect(saved?.hits).toHaveLength(1);
    expect(saved?.hits[0]?.songTimeMs).toBe(200);
  });

  it('source derivation respects autoPlayLanes captured at construction', async () => {
    const auto = new Set<LaneValue>([Lane.BD]);
    const capture = createReplayCapture(auto);
    capture.start(META, PLAYER);
    capture.onHit(matchedHpe({ lane: Lane.BD }));
    capture.onHit(matchedHpe({ lane: Lane.SD }));
    const id = await capture.finish(snap());
    const saved = await loadReplay(id);
    expect(saved?.hits[0]?.source).toBe('auto');
    expect(saved?.hits[1]?.source).toBe('xr-right');
  });

  it('finish stores the FinalSnapshot derived from the live ScoreSnapshot', async () => {
    const capture = createReplayCapture(NO_AUTO);
    capture.start(META, PLAYER);
    const id = await capture.finish({
      totalNotes: 10,
      counts: { PERFECT: 10, GREAT: 0, GOOD: 0, POOR: 0, MISS: 0 },
      combo: 10,
      maxCombo: 10,
      score: 1_000_000,
      autoCount: 0,
    });
    const saved = await loadReplay(id);
    expect(saved?.final.finalScoreNorm).toBeCloseTo(1);
    expect(saved?.final.comboMax).toBe(10);
    expect(saved?.final.fullCombo).toBe(true);
    expect(saved?.final.counts.PERFECT).toBe(10);
  });
});
