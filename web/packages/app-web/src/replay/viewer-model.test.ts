import { describe, expect, it } from 'vitest';
import { Judgment } from '@dtxmania/dtx-core';
import { Lane } from '@dtxmania/input';
import {
  HIT_FLASH_LIFE_MS,
  JUDGMENT_FLASH_LIFE_MS,
  lerpPoseSample,
  replayActiveHitFlashes,
  replayActiveJudgmentFlash,
  replayHitsInRange,
  replayScoreSnapshotAt,
  replayStatus,
} from './viewer-model.js';
import {
  Recorder,
  type ChartMeta,
  type FinalSnapshot,
  type HitEvent,
  type PlayerSettings,
  type Pose,
  type PoseSample,
  type Replay,
} from './recorder-model.js';

/**
 * The viewer-model functions are pure: given a Replay + cutoff time
 * they always return the same answer. Tests build small Replay
 * fixtures via the Recorder (so the construction path matches what
 * production will produce) and assert on derived values.
 */

const META: ChartMeta = {
  chartPath: 'h',
  durationMs: 10_000,
};

const PLAYER: PlayerSettings = {
  audioOffsetMs: 0,
  autoPlayLanes: [],
};

const FINAL: FinalSnapshot = {
  finalScoreNorm: 0,
  comboMax: 0,
  fullCombo: false,
  counts: { PERFECT: 0, GREAT: 0, GOOD: 0, POOR: 0, MISS: 0 },
};

function makeReplay(hits: HitEvent[] = [], poses: PoseSample[] = []): Replay {
  const r = new Recorder();
  r.start(META, PLAYER);
  for (const h of hits) r.recordHit(h);
  for (const p of poses) r.recordPose(p);
  return r.finish(FINAL);
}

function hit(overrides: Partial<HitEvent> = {}): HitEvent {
  return {
    songTimeMs: 0,
    lane: Lane.SD,
    source: 'xr-left',
    chipIndex: 0,
    lagMs: 0,
    judgment: Judgment.PERFECT,
    ...overrides,
  };
}

function pose(overrides: Partial<PoseSample> = {}): PoseSample {
  return {
    songTimeMs: 0,
    head: { pos: [0, 1.6, 0], quat: [0, 0, 0, 1] },
    left: { pos: [-0.3, 1.0, -0.2], quat: [0, 0, 0, 1] },
    right: { pos: [0.3, 1.0, -0.2], quat: [0, 0, 0, 1] },
    ...overrides,
  };
}

describe('replayScoreSnapshotAt', () => {
  it('empty replay → all zeros', () => {
    const snap = replayScoreSnapshotAt(makeReplay(), 5000, 0);
    expect(snap.combo).toBe(0);
    expect(snap.maxCombo).toBe(0);
    expect(snap.score).toBe(0);
    expect(snap.counts.PERFECT).toBe(0);
    expect(snap.counts.MISS).toBe(0);
  });

  it('single PERFECT before cutoff → combo 1, count 1', () => {
    const replay = makeReplay([hit({ songTimeMs: 100, judgment: Judgment.PERFECT })]);
    const snap = replayScoreSnapshotAt(replay, 200, 1);
    expect(snap.combo).toBe(1);
    expect(snap.counts.PERFECT).toBe(1);
    expect(snap.maxCombo).toBe(1);
  });

  it('hits after cutoff are excluded', () => {
    const replay = makeReplay([
      hit({ songTimeMs: 100, judgment: Judgment.PERFECT }),
      hit({ songTimeMs: 500, judgment: Judgment.PERFECT }),
    ]);
    const snap = replayScoreSnapshotAt(replay, 200, 2);
    expect(snap.counts.PERFECT).toBe(1);
  });

  it('hits exactly at cutoff are included (cutoff is inclusive)', () => {
    const replay = makeReplay([
      hit({ songTimeMs: 200, judgment: Judgment.PERFECT }),
    ]);
    const snap = replayScoreSnapshotAt(replay, 200, 1);
    expect(snap.counts.PERFECT).toBe(1);
  });

  it('MISS breaks combo; max combo retained', () => {
    const replay = makeReplay([
      hit({ songTimeMs: 100, judgment: Judgment.PERFECT }),
      hit({ songTimeMs: 200, judgment: Judgment.PERFECT }),
      hit({ songTimeMs: 300, judgment: Judgment.MISS, lagMs: null }),
      hit({ songTimeMs: 400, judgment: Judgment.PERFECT }),
    ]);
    const snap = replayScoreSnapshotAt(replay, 1000, 4);
    expect(snap.combo).toBe(1);
    expect(snap.maxCombo).toBe(2);
  });

  it('POOR breaks combo (matches ScoreTracker semantics)', () => {
    const replay = makeReplay([
      hit({ songTimeMs: 100, judgment: Judgment.PERFECT }),
      hit({ songTimeMs: 200, judgment: Judgment.POOR }),
      hit({ songTimeMs: 300, judgment: Judgment.PERFECT }),
    ]);
    const snap = replayScoreSnapshotAt(replay, 1000, 3);
    expect(snap.combo).toBe(1);
    expect(snap.maxCombo).toBe(1);
  });

  it('strays (chipIndex=-1) are excluded from scoring', () => {
    const replay = makeReplay([
      hit({ songTimeMs: 100, chipIndex: -1, lagMs: null, judgment: Judgment.MISS }),
      hit({ songTimeMs: 200, judgment: Judgment.PERFECT }),
    ]);
    const snap = replayScoreSnapshotAt(replay, 1000, 1);
    expect(snap.counts.PERFECT).toBe(1);
    expect(snap.counts.MISS).toBe(0);
    expect(snap.combo).toBe(1);
  });
});

describe('replayActiveHitFlashes', () => {
  it('empty replay → []', () => {
    expect(replayActiveHitFlashes(makeReplay(), 0)).toEqual([]);
  });

  it('hit just spawned (currentTime == spawnedMs) → included', () => {
    const replay = makeReplay([hit({ songTimeMs: 100 })]);
    const out = replayActiveHitFlashes(replay, 100);
    expect(out).toHaveLength(1);
    expect(out[0]?.spawnedMs).toBe(100);
  });

  it('hit aged < lifeMs → included; aged > lifeMs → excluded', () => {
    const replay = makeReplay([hit({ songTimeMs: 100, lane: Lane.SD })]);
    expect(replayActiveHitFlashes(replay, 100 + HIT_FLASH_LIFE_MS - 1)).toHaveLength(1);
    expect(replayActiveHitFlashes(replay, 100 + HIT_FLASH_LIFE_MS + 1)).toHaveLength(0);
  });

  it('future hits (spawnedMs > currentTime) excluded', () => {
    const replay = makeReplay([hit({ songTimeMs: 500 })]);
    expect(replayActiveHitFlashes(replay, 100)).toEqual([]);
  });

  it('strays included as visual events', () => {
    const replay = makeReplay([
      hit({ songTimeMs: 100, chipIndex: -1, lagMs: null, judgment: Judgment.MISS, lane: Lane.HH }),
    ]);
    expect(replayActiveHitFlashes(replay, 150)).toHaveLength(1);
  });

  it('preserves recorded order', () => {
    const replay = makeReplay([
      hit({ songTimeMs: 100, lane: Lane.SD }),
      hit({ songTimeMs: 110, lane: Lane.HH }),
      hit({ songTimeMs: 120, lane: Lane.BD }),
    ]);
    const out = replayActiveHitFlashes(replay, 130);
    expect(out.map((f) => f.lane)).toEqual([Lane.SD, Lane.HH, Lane.BD]);
  });

  it('custom lifeMs override is respected', () => {
    const replay = makeReplay([hit({ songTimeMs: 100 })]);
    expect(replayActiveHitFlashes(replay, 1000, 50)).toHaveLength(0);
    expect(replayActiveHitFlashes(replay, 1000, 5000)).toHaveLength(1);
  });
});

describe('replayActiveJudgmentFlash', () => {
  it('empty replay → null', () => {
    expect(replayActiveJudgmentFlash(makeReplay(), 0)).toBeNull();
  });

  it('returns the most recent matched hit within lifeMs', () => {
    const replay = makeReplay([
      hit({ songTimeMs: 100, judgment: Judgment.PERFECT, lagMs: 5 }),
      hit({ songTimeMs: 200, judgment: Judgment.GREAT, lagMs: -40 }),
    ]);
    const out = replayActiveJudgmentFlash(replay, 250);
    expect(out?.judgment).toBe(Judgment.GREAT);
    expect(out?.deltaMs).toBe(-40);
    expect(out?.spawnedMs).toBe(200);
  });

  it('returns null when last hit is older than lifeMs', () => {
    const replay = makeReplay([
      hit({ songTimeMs: 100, judgment: Judgment.PERFECT }),
    ]);
    expect(replayActiveJudgmentFlash(replay, 100 + JUDGMENT_FLASH_LIFE_MS + 1)).toBeNull();
  });

  it('strays are skipped — falls back to previous matched hit', () => {
    const replay = makeReplay([
      hit({ songTimeMs: 100, judgment: Judgment.PERFECT, lagMs: 5 }),
      hit({
        songTimeMs: 200,
        chipIndex: -1,
        lagMs: null,
        judgment: Judgment.MISS,
      }),
    ]);
    const out = replayActiveJudgmentFlash(replay, 250);
    expect(out?.judgment).toBe(Judgment.PERFECT);
    expect(out?.spawnedMs).toBe(100);
  });

  it('future hits are not surfaced', () => {
    const replay = makeReplay([hit({ songTimeMs: 500 })]);
    expect(replayActiveJudgmentFlash(replay, 100)).toBeNull();
  });

  it('custom lifeMs override is respected', () => {
    const replay = makeReplay([hit({ songTimeMs: 100 })]);
    expect(replayActiveJudgmentFlash(replay, 1000, 50)).toBeNull();
    expect(replayActiveJudgmentFlash(replay, 1000, 5000)).not.toBeNull();
  });
});

describe('replayHitsInRange', () => {
  it('empty replay → []', () => {
    expect(replayHitsInRange(makeReplay(), 0, 1000)).toEqual([]);
  });

  it('exclusive low, inclusive high: hits at fromMs are excluded', () => {
    const replay = makeReplay([
      hit({ songTimeMs: 100 }),
      hit({ songTimeMs: 200 }),
    ]);
    const out = replayHitsInRange(replay, 100, 200);
    expect(out).toHaveLength(1);
    expect(out[0]?.songTimeMs).toBe(200);
  });

  it('zero-width range (from == to) produces no hits', () => {
    const replay = makeReplay([hit({ songTimeMs: 100 })]);
    expect(replayHitsInRange(replay, 100, 100)).toEqual([]);
  });

  it('range entirely before / after the stream → []', () => {
    const replay = makeReplay([hit({ songTimeMs: 500 })]);
    expect(replayHitsInRange(replay, 0, 100)).toEqual([]);
    expect(replayHitsInRange(replay, 1000, 2000)).toEqual([]);
  });

  it('preserves recorded order across multiple matches', () => {
    const replay = makeReplay([
      hit({ songTimeMs: 100, lane: Lane.SD }),
      hit({ songTimeMs: 200, lane: Lane.HH }),
      hit({ songTimeMs: 300, lane: Lane.BD }),
    ]);
    const out = replayHitsInRange(replay, 50, 250);
    expect(out.map((h) => h.songTimeMs)).toEqual([100, 200]);
  });

  it('strays are included (audio fires need them)', () => {
    const replay = makeReplay([
      hit({
        songTimeMs: 150,
        chipIndex: -1,
        lagMs: null,
        judgment: Judgment.MISS,
      }),
    ]);
    expect(replayHitsInRange(replay, 100, 200)).toHaveLength(1);
  });
});

describe('replayStatus', () => {
  it("'playing' before durationMs", () => {
    const replay = makeReplay();
    expect(replayStatus(replay, META.durationMs - 1)).toBe('playing');
  });

  it("'finished' at durationMs (boundary inclusive)", () => {
    const replay = makeReplay();
    expect(replayStatus(replay, META.durationMs)).toBe('finished');
  });

  it("'finished' after durationMs", () => {
    const replay = makeReplay();
    expect(replayStatus(replay, META.durationMs + 1000)).toBe('finished');
  });

  it("'playing' for negative time (pre-roll)", () => {
    const replay = makeReplay();
    expect(replayStatus(replay, -100)).toBe('playing');
  });
});

describe('lerpPoseSample', () => {
  const A: Pose = { pos: [0, 0, 0], quat: [0, 0, 0, 1] };
  const B: Pose = { pos: [1, 2, 3], quat: [0, 0, 0, 1] };

  it('empty buffer → null', () => {
    expect(lerpPoseSample([], 100)).toBeNull();
  });

  it('time before first sample → null', () => {
    const ps = [pose({ songTimeMs: 100 })];
    expect(lerpPoseSample(ps, 50)).toBeNull();
  });

  it('time after last sample → null', () => {
    const ps = [pose({ songTimeMs: 100 })];
    expect(lerpPoseSample(ps, 150)).toBeNull();
  });

  it('exact match on a sample returns that sample', () => {
    const ps = [pose({ songTimeMs: 100, head: { pos: [9, 9, 9], quat: [0, 0, 0, 1] } })];
    const out = lerpPoseSample(ps, 100);
    expect(out?.head?.pos).toEqual([9, 9, 9]);
  });

  it('halfway between two samples lerps position', () => {
    const ps = [
      pose({ songTimeMs: 0, head: A, left: A, right: A }),
      pose({ songTimeMs: 100, head: B, left: B, right: B }),
    ];
    const out = lerpPoseSample(ps, 50);
    expect(out?.head?.pos[0]).toBeCloseTo(0.5);
    expect(out?.head?.pos[1]).toBeCloseTo(1);
    expect(out?.head?.pos[2]).toBeCloseTo(1.5);
  });

  it('outputs null for a field whose bracket has either side null', () => {
    const ps = [
      pose({ songTimeMs: 0, left: null }),
      pose({ songTimeMs: 100, left: A }),
    ];
    expect(lerpPoseSample(ps, 50)?.left).toBeNull();

    const ps2 = [
      pose({ songTimeMs: 0, left: A }),
      pose({ songTimeMs: 100, left: null }),
    ];
    expect(lerpPoseSample(ps2, 50)?.left).toBeNull();
  });

  it('outputs non-null for a field whose bracket has both sides non-null', () => {
    const ps = [
      pose({ songTimeMs: 0, head: A }),
      pose({ songTimeMs: 100, head: B }),
    ];
    const out = lerpPoseSample(ps, 50);
    expect(out?.head).not.toBeNull();
  });

  it('quaternion output is unit-length after lerp+renormalise', () => {
    const ps = [
      pose({ songTimeMs: 0, head: { pos: [0, 0, 0], quat: [1, 0, 0, 0] } }),
      pose({ songTimeMs: 100, head: { pos: [0, 0, 0], quat: [0, 1, 0, 0] } }),
    ];
    const q = lerpPoseSample(ps, 50)!.head!.quat;
    const len = Math.hypot(q[0], q[1], q[2], q[3]);
    expect(len).toBeCloseTo(1);
  });

  it('handles a single sample at the requested time exactly', () => {
    const ps = [pose({ songTimeMs: 100 })];
    expect(lerpPoseSample(ps, 100)).not.toBeNull();
    expect(lerpPoseSample(ps, 99)).toBeNull();
    expect(lerpPoseSample(ps, 101)).toBeNull();
  });

  it('finds the correct bracket when the buffer has many samples', () => {
    const ps = [
      pose({ songTimeMs: 0 }),
      pose({ songTimeMs: 100 }),
      pose({ songTimeMs: 200 }),
      pose({ songTimeMs: 300, head: { pos: [10, 10, 10], quat: [0, 0, 0, 1] } }),
      pose({ songTimeMs: 400, head: { pos: [20, 20, 20], quat: [0, 0, 0, 1] } }),
    ];
    const out = lerpPoseSample(ps, 350);
    expect(out?.head?.pos[0]).toBeCloseTo(15);
  });
});
