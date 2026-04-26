import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Judgment } from '@dtxmania/dtx-core';
import { Lane } from '@dtxmania/input';
import {
  Recorder,
  REPLAY_FORMAT_VERSION,
  deserializeReplay,
  replayMatchesChart,
  serializeReplay,
  type ChartMeta,
  type FinalSnapshot,
  type HitEvent,
  type PoseSample,
  type Replay,
} from './recorder-model.js';

/**
 * The Recorder is one instance per recording — no module-level
 * singleton — so tests just construct fresh ones. The only ambient
 * dependency is `Date.now()` for `startedAt`, which we pin via
 * `vi.setSystemTime` so assertions can be exact.
 */

const FIXED_WALL_CLOCK = Date.UTC(2025, 0, 2, 3, 4, 5, 678);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_WALL_CLOCK);
});

afterEach(() => {
  vi.useRealTimers();
});

const SAMPLE_META: ChartMeta = {
  chartHash: 'abc123',
  title: 'Test Song',
  artist: 'Test Artist',
  durationMs: 180_000,
};

const SAMPLE_FINAL: FinalSnapshot = {
  finalScoreNorm: 0.8765,
  comboMax: 42,
  fullCombo: false,
  counts: {
    PERFECT: 30,
    GREAT: 8,
    GOOD: 2,
    POOR: 1,
    MISS: 1,
  },
};

function makeHit(overrides: Partial<HitEvent> = {}): HitEvent {
  return {
    songTimeMs: 1000,
    lane: Lane.SD,
    source: 'keyboard',
    chipIndex: 5,
    lagMs: 12,
    judgment: Judgment.PERFECT,
    ...overrides,
  };
}

function makePose(overrides: Partial<PoseSample> = {}): PoseSample {
  return {
    songTimeMs: 1000,
    head: { pos: [0, 1.6, 0], quat: [0, 0, 0, 1] },
    left: { pos: [-0.3, 1.0, -0.2], quat: [0, 0, 0, 1] },
    right: { pos: [0.3, 1.0, -0.2], quat: [0, 0, 0, 1] },
    ...overrides,
  };
}

describe('Recorder — lifecycle', () => {
  it('starts idle with zero counts', () => {
    const r = new Recorder();
    expect(r.isRecording()).toBe(false);
    expect(r.hitCount()).toBe(0);
    expect(r.poseCount()).toBe(0);
  });

  it('start() flips to recording and leaves counts at zero', () => {
    const r = new Recorder();
    r.start(SAMPLE_META);
    expect(r.isRecording()).toBe(true);
    expect(r.hitCount()).toBe(0);
    expect(r.poseCount()).toBe(0);
  });

  it('recordHit / recordPose while idle is silently dropped', () => {
    const r = new Recorder();
    expect(() => r.recordHit(makeHit())).not.toThrow();
    expect(() => r.recordPose(makePose())).not.toThrow();
    expect(r.hitCount()).toBe(0);
    expect(r.poseCount()).toBe(0);
  });

  it('recordHit / recordPose while recording increment counts', () => {
    const r = new Recorder();
    r.start(SAMPLE_META);
    r.recordHit(makeHit());
    r.recordHit(makeHit({ songTimeMs: 1500 }));
    r.recordPose(makePose());
    expect(r.hitCount()).toBe(2);
    expect(r.poseCount()).toBe(1);
  });

  it('finish() returns a Replay and goes back to idle', () => {
    const r = new Recorder();
    r.start(SAMPLE_META);
    r.recordHit(makeHit());
    const replay = r.finish(SAMPLE_FINAL);
    expect(replay.formatVersion).toBe(REPLAY_FORMAT_VERSION);
    expect(replay.hits).toHaveLength(1);
    expect(r.isRecording()).toBe(false);
  });

  it('record* after finish() is a silent no-op (does not pollute next recording)', () => {
    const r = new Recorder();
    r.start(SAMPLE_META);
    r.finish(SAMPLE_FINAL);
    r.recordHit(makeHit());
    r.recordPose(makePose());
    expect(r.hitCount()).toBe(0);
    expect(r.poseCount()).toBe(0);
  });

  it('start() while already recording resets buffers (idempotent reset)', () => {
    const r = new Recorder();
    r.start(SAMPLE_META);
    r.recordHit(makeHit());
    r.recordPose(makePose());
    r.start({ ...SAMPLE_META, chartHash: 'different' });
    expect(r.isRecording()).toBe(true);
    expect(r.hitCount()).toBe(0);
    expect(r.poseCount()).toBe(0);
  });

  it('two sequential recordings on the same instance do not cross-contaminate', () => {
    const r = new Recorder();
    r.start(SAMPLE_META);
    r.recordHit(makeHit({ songTimeMs: 100 }));
    const first = r.finish(SAMPLE_FINAL);

    r.start({ ...SAMPLE_META, chartHash: 'second' });
    r.recordHit(makeHit({ songTimeMs: 200 }));
    const second = r.finish(SAMPLE_FINAL);

    expect(first.hits).toHaveLength(1);
    expect(second.hits).toHaveLength(1);
    expect(first.hits[0]?.songTimeMs).toBe(100);
    expect(second.hits[0]?.songTimeMs).toBe(200);
    expect(first.meta.chartHash).toBe('abc123');
    expect(second.meta.chartHash).toBe('second');
  });
});

describe('Recorder — Replay payload', () => {
  it('preserves meta verbatim', () => {
    const r = new Recorder();
    r.start(SAMPLE_META);
    const replay = r.finish(SAMPLE_FINAL);
    expect(replay.meta).toEqual(SAMPLE_META);
  });

  it('preserves hits in append order', () => {
    const r = new Recorder();
    r.start(SAMPLE_META);
    const a = makeHit({ songTimeMs: 100, lane: Lane.SD });
    const b = makeHit({ songTimeMs: 200, lane: Lane.HH });
    const c = makeHit({ songTimeMs: 150, lane: Lane.BD });
    // Caller passes events out-of-order on purpose; recorder must NOT
    // re-sort. The viewer relies on append-order = causal-order.
    r.recordHit(a);
    r.recordHit(b);
    r.recordHit(c);
    const { hits } = r.finish(SAMPLE_FINAL);
    expect(hits.map((h) => h.songTimeMs)).toEqual([100, 200, 150]);
  });

  it('preserves poses in append order', () => {
    const r = new Recorder();
    r.start(SAMPLE_META);
    const p1 = makePose({ songTimeMs: 0 });
    const p2 = makePose({ songTimeMs: 16 });
    const p3 = makePose({ songTimeMs: 32 });
    r.recordPose(p1);
    r.recordPose(p2);
    r.recordPose(p3);
    const { poses } = r.finish(SAMPLE_FINAL);
    expect(poses.map((p) => p.songTimeMs)).toEqual([0, 16, 32]);
  });

  it('embeds the FinalSnapshot exactly', () => {
    const r = new Recorder();
    r.start(SAMPLE_META);
    const replay = r.finish(SAMPLE_FINAL);
    expect(replay.final).toEqual(SAMPLE_FINAL);
  });

  it('startedAt is captured at start() time (not finish() time)', () => {
    const r = new Recorder();
    r.start(SAMPLE_META);
    // Advance the clock between start and finish — startedAt should
    // still reflect the start moment, not finish.
    vi.setSystemTime(FIXED_WALL_CLOCK + 60_000);
    const replay = r.finish(SAMPLE_FINAL);
    expect(replay.startedAt).toBe(FIXED_WALL_CLOCK);
  });

  it('formatVersion is REPLAY_FORMAT_VERSION', () => {
    const r = new Recorder();
    r.start(SAMPLE_META);
    const replay = r.finish(SAMPLE_FINAL);
    expect(replay.formatVersion).toBe(REPLAY_FORMAT_VERSION);
  });
});

describe('Recorder — sparse / desktop scenarios', () => {
  it('records stray hits with lagMs=null and chipIndex=-1', () => {
    const r = new Recorder();
    r.start(SAMPLE_META);
    r.recordHit(
      makeHit({ chipIndex: -1, lagMs: null, judgment: Judgment.MISS })
    );
    const { hits } = r.finish(SAMPLE_FINAL);
    expect(hits[0]?.chipIndex).toBe(-1);
    expect(hits[0]?.lagMs).toBeNull();
  });

  it('records pose samples with all-null tracking (desktop play)', () => {
    const r = new Recorder();
    r.start(SAMPLE_META);
    r.recordPose({
      songTimeMs: 100,
      head: null,
      left: null,
      right: null,
    });
    const { poses } = r.finish(SAMPLE_FINAL);
    expect(poses[0]?.head).toBeNull();
    expect(poses[0]?.left).toBeNull();
    expect(poses[0]?.right).toBeNull();
  });

  it('accepts asymmetric pose tracking (head + one controller)', () => {
    const r = new Recorder();
    r.start(SAMPLE_META);
    r.recordPose({
      songTimeMs: 100,
      head: { pos: [0, 1.6, 0], quat: [0, 0, 0, 1] },
      left: null,
      right: { pos: [0.3, 1, 0], quat: [0, 0, 0, 1] },
    });
    const { poses } = r.finish(SAMPLE_FINAL);
    expect(poses[0]?.head).not.toBeNull();
    expect(poses[0]?.left).toBeNull();
    expect(poses[0]?.right).not.toBeNull();
  });
});

describe('serializeReplay / deserializeReplay', () => {
  function makeReplay(): Replay {
    const r = new Recorder();
    r.start(SAMPLE_META);
    r.recordHit(makeHit({ songTimeMs: 100 }));
    r.recordHit(
      makeHit({
        songTimeMs: 250,
        chipIndex: -1,
        lagMs: null,
        judgment: Judgment.MISS,
      })
    );
    r.recordPose(makePose({ songTimeMs: 0 }));
    r.recordPose(makePose({ songTimeMs: 16, left: null }));
    return r.finish(SAMPLE_FINAL);
  }

  it('produces a valid JSON string', () => {
    const replay = makeReplay();
    const json = serializeReplay(replay);
    expect(typeof json).toBe('string');
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('round-trips a replay losslessly', () => {
    const original = makeReplay();
    const restored = deserializeReplay(serializeReplay(original));
    expect(restored).not.toBeNull();
    expect(restored).toEqual(original);
  });

  it('preserves null lagMs through round-trip (no NaN sneaks in)', () => {
    const original = makeReplay();
    const restored = deserializeReplay(serializeReplay(original))!;
    const stray = restored.hits.find((h) => h.chipIndex === -1);
    expect(stray?.lagMs).toBeNull();
  });

  it('preserves null pose fields through round-trip', () => {
    const original = makeReplay();
    const restored = deserializeReplay(serializeReplay(original))!;
    const sparse = restored.poses[1]!;
    expect(sparse.left).toBeNull();
    expect(sparse.head).not.toBeNull();
    expect(sparse.right).not.toBeNull();
  });

  it('returns null for non-JSON garbage', () => {
    expect(deserializeReplay('not json {{{')).toBeNull();
  });

  it('returns null for the empty string', () => {
    expect(deserializeReplay('')).toBeNull();
  });

  it('returns null for a JSON value with the wrong formatVersion', () => {
    const replay = makeReplay();
    const obj = JSON.parse(serializeReplay(replay));
    obj.formatVersion = 999;
    expect(deserializeReplay(JSON.stringify(obj))).toBeNull();
  });

  it('returns null for a JSON value missing required envelope fields', () => {
    expect(deserializeReplay(JSON.stringify({ formatVersion: REPLAY_FORMAT_VERSION }))).toBeNull();
    expect(
      deserializeReplay(
        JSON.stringify({
          formatVersion: REPLAY_FORMAT_VERSION,
          meta: SAMPLE_META,
          // missing hits/poses/final
        })
      )
    ).toBeNull();
  });
});

describe('replayMatchesChart', () => {
  it('matches when chartHash is equal', () => {
    const r = new Recorder();
    r.start(SAMPLE_META);
    const replay = r.finish(SAMPLE_FINAL);
    expect(replayMatchesChart(replay, SAMPLE_META.chartHash)).toBe(true);
  });

  it('rejects a different chartHash', () => {
    const r = new Recorder();
    r.start(SAMPLE_META);
    const replay = r.finish(SAMPLE_FINAL);
    expect(replayMatchesChart(replay, 'different-hash')).toBe(false);
  });
});
