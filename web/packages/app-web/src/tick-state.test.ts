import { describe, expect, it } from 'vitest';
import { Judgment } from '@dtxmania/dtx-core';
import {
  applyGaugeDelta,
  gaugeDeltaFor,
  GAUGE_DELTAS,
  RESULT_PAD_HIT_DWELL_MS,
  resolveLoopWindow,
  risingEdge,
  shouldEnterFinishedState,
  shouldFireResultPadHitReturn,
  shouldFireVrAutoReturn,
  shouldLoopFire,
  snapSongMsToMeasure,
  SONG_END_TAIL_MS,
  updateCancelEdgeState,
  VR_AUTO_RETURN_DWELL_MS,
  type VrAutoReturnInput,
  type ResultPadHitReturnInput,
} from './tick-state.js';

describe('gaugeDeltaFor + GAUGE_DELTAS', () => {
  it('maps each judgment to its canonical delta', () => {
    expect(gaugeDeltaFor(Judgment.PERFECT)).toBe(0.025);
    expect(gaugeDeltaFor(Judgment.GREAT)).toBe(0.015);
    expect(gaugeDeltaFor(Judgment.GOOD)).toBe(0.005);
    expect(gaugeDeltaFor(Judgment.POOR)).toBe(-0.02);
    expect(gaugeDeltaFor(Judgment.MISS)).toBe(-0.05);
  });

  it('hits always give non-negative delta; misses/POOR always negative', () => {
    expect(GAUGE_DELTAS.PERFECT).toBeGreaterThan(0);
    expect(GAUGE_DELTAS.GREAT).toBeGreaterThan(0);
    expect(GAUGE_DELTAS.GOOD).toBeGreaterThan(0);
    expect(GAUGE_DELTAS.POOR).toBeLessThan(0);
    expect(GAUGE_DELTAS.MISS).toBeLessThan(0);
  });

  it('MISS drains harder than POOR — intentional difficulty tuning', () => {
    // If refactored to equal or inverted, the gauge wouldn't punish
    // note-skips more than late hits. Pin the relationship.
    expect(GAUGE_DELTAS.MISS).toBeLessThan(GAUGE_DELTAS.POOR);
  });
});

describe('applyGaugeDelta — clamped gauge update', () => {
  it('adds the PERFECT delta in the normal range', () => {
    expect(applyGaugeDelta(0.5, Judgment.PERFECT)).toBeCloseTo(0.525, 10);
  });

  it('clamps to 1 at the ceiling — a perfect on a full gauge stays at 1', () => {
    expect(applyGaugeDelta(0.99, Judgment.PERFECT)).toBe(1);
    expect(applyGaugeDelta(1, Judgment.PERFECT)).toBe(1);
  });

  it('clamps to 0 at the floor — a miss on an empty gauge stays at 0', () => {
    expect(applyGaugeDelta(0.01, Judgment.MISS)).toBe(0);
    expect(applyGaugeDelta(0, Judgment.MISS)).toBe(0);
  });

  it('produces the same result as table lookup + manual clamp (cross-check)', () => {
    for (const g of [0, 0.3, 0.5, 0.7, 1]) {
      for (const j of [Judgment.PERFECT, Judgment.GREAT, Judgment.GOOD, Judgment.POOR, Judgment.MISS]) {
        const expected = Math.max(0, Math.min(1, g + gaugeDeltaFor(j)));
        expect(applyGaugeDelta(g, j)).toBeCloseTo(expected, 10);
      }
    }
  });
});

describe('shouldEnterFinishedState', () => {
  it('returns true when songTime exceeds duration + tail while playing', () => {
    expect(shouldEnterFinishedState(90500 + SONG_END_TAIL_MS + 1, 90500, 'playing')).toBe(true);
  });

  it('returns false before the tail has elapsed — last miss window stays open', () => {
    // Chip at (durationMs - 5) still has its POOR window through the
    // end. If we flip to 'finished' at exactly durationMs, that chip
    // never logs as MISS. Tail guards against that.
    expect(shouldEnterFinishedState(90500, 90500, 'playing')).toBe(false);
    expect(shouldEnterFinishedState(90500 + SONG_END_TAIL_MS, 90500, 'playing')).toBe(false);
  });

  it('never fires outside status=playing — finished stays finished, idle never transitions', () => {
    const songTimeBeyond = 99999;
    expect(shouldEnterFinishedState(songTimeBeyond, 90500, 'idle')).toBe(false);
    expect(shouldEnterFinishedState(songTimeBeyond, 90500, 'finished')).toBe(false);
  });

  it('SONG_END_TAIL_MS is 500 — pin the constant', () => {
    expect(SONG_END_TAIL_MS).toBe(500);
  });
});

describe('shouldFireVrAutoReturn', () => {
  const base: VrAutoReturnInput = {
    status: 'finished',
    finishedReturnHandled: false,
    inXR: true,
    hasOnRestart: true,
    finishedAtMs: 1000,
    nowMs: 1000 + VR_AUTO_RETURN_DWELL_MS + 1,
  };

  it('fires when every condition holds and the dwell has elapsed', () => {
    expect(shouldFireVrAutoReturn(base)).toBe(true);
  });

  it('does not fire at exactly the dwell (strict >)', () => {
    expect(shouldFireVrAutoReturn({ ...base, nowMs: 1000 + VR_AUTO_RETURN_DWELL_MS })).toBe(false);
  });

  it('does not fire before the dwell elapses (even by 1ms)', () => {
    expect(shouldFireVrAutoReturn({ ...base, nowMs: 1000 + VR_AUTO_RETURN_DWELL_MS - 1 })).toBe(false);
  });

  it('does not re-fire if finishedReturnHandled is latched', () => {
    expect(shouldFireVrAutoReturn({ ...base, finishedReturnHandled: true })).toBe(false);
  });

  it('does not fire outside VR (desktop uses Esc instead)', () => {
    expect(shouldFireVrAutoReturn({ ...base, inXR: false })).toBe(false);
  });

  it('does not fire without an onRestart callback — nothing to call', () => {
    expect(shouldFireVrAutoReturn({ ...base, hasOnRestart: false })).toBe(false);
  });

  it('does not fire if finishedAtMs is null (guard against stale state)', () => {
    expect(shouldFireVrAutoReturn({ ...base, finishedAtMs: null })).toBe(false);
  });

  it('does not fire from status=playing or status=idle', () => {
    expect(shouldFireVrAutoReturn({ ...base, status: 'playing' })).toBe(false);
    expect(shouldFireVrAutoReturn({ ...base, status: 'idle' })).toBe(false);
  });

  it('VR_AUTO_RETURN_DWELL_MS is 5000 — pin the 5-second UX constant', () => {
    expect(VR_AUTO_RETURN_DWELL_MS).toBe(5000);
  });
});

describe('shouldFireResultPadHitReturn', () => {
  const base: ResultPadHitReturnInput = {
    status: 'finished',
    finishedReturnHandled: false,
    hasOnRestart: true,
    finishedAtMs: 1000,
    nowMs: 1000 + RESULT_PAD_HIT_DWELL_MS,
  };

  it('fires at exactly the 400 ms dwell (inclusive >= boundary)', () => {
    expect(shouldFireResultPadHitReturn(base)).toBe(true);
  });

  it('does not fire before the dwell — last in-song strike cannot double-skip', () => {
    // The specific regression this guards: a PERFECT hit at
    // songTime ≈ durationMs + 500 would land as the tick flips to
    // 'finished'. Without the dwell, the same keystroke would
    // trigger the skip.
    expect(shouldFireResultPadHitReturn({ ...base, nowMs: 1000 + RESULT_PAD_HIT_DWELL_MS - 1 })).toBe(false);
  });

  it('does not fire if the latch is set', () => {
    expect(shouldFireResultPadHitReturn({ ...base, finishedReturnHandled: true })).toBe(false);
  });

  it('does not fire without an onRestart', () => {
    expect(shouldFireResultPadHitReturn({ ...base, hasOnRestart: false })).toBe(false);
  });

  it('does not fire when finishedAtMs is null', () => {
    expect(shouldFireResultPadHitReturn({ ...base, finishedAtMs: null })).toBe(false);
  });

  it('does not fire outside status=finished', () => {
    expect(shouldFireResultPadHitReturn({ ...base, status: 'playing' })).toBe(false);
    expect(shouldFireResultPadHitReturn({ ...base, status: 'idle' })).toBe(false);
  });

  it('RESULT_PAD_HIT_DWELL_MS is 400 — pin the dwell constant', () => {
    expect(RESULT_PAD_HIT_DWELL_MS).toBe(400);
  });
});

describe('risingEdge — single-input edge detect for VR loop markers', () => {
  it('false → true: fires', () => {
    expect(risingEdge(false, true)).toBe(true);
  });
  it('true → true: held, no re-fire', () => {
    expect(risingEdge(true, true)).toBe(false);
  });
  it('true → false: released, no fire', () => {
    expect(risingEdge(true, false)).toBe(false);
  });
  it('false → false: idle, no fire', () => {
    expect(risingEdge(false, false)).toBe(false);
  });
});

describe('resolveLoopWindow — config → absolute song-ms bounds', () => {
  const idx = [0, 2000, 4000, 6000, 8000]; // 4 measures + sentinel
  const duration = 8000;

  it('returns null when disabled', () => {
    expect(resolveLoopWindow(idx, duration, false, 0, 3)).toBeNull();
  });

  it('returns null for empty index (no chart loaded)', () => {
    expect(resolveLoopWindow([], duration, true, 0, 3)).toBeNull();
  });

  it('resolves a valid measure range to absolute ms', () => {
    expect(resolveLoopWindow(idx, duration, true, 1, 3)).toEqual({ start: 2000, end: 6000 });
  });

  it('end = null (sentinel) resolves to end of index, clamped to durationMs', () => {
    expect(resolveLoopWindow(idx, duration, true, 1, null)).toEqual({ start: 2000, end: 8000 });
  });

  it('clamps out-of-range start + end indices', () => {
    expect(resolveLoopWindow(idx, duration, true, -5, 99)).toEqual({ start: 0, end: 8000 });
  });

  it('zero-length window (end ≤ start) returns null — silently disable', () => {
    expect(resolveLoopWindow(idx, duration, true, 2, 2)).toBeNull();
    expect(resolveLoopWindow(idx, duration, true, 3, 1)).toBeNull();
  });

  it('caps end at durationMs when the sentinel would overshoot', () => {
    // Index sentinel at 8000, but the chart is only 7500ms long.
    expect(resolveLoopWindow(idx, 7500, true, 0, null)).toEqual({ start: 0, end: 7500 });
  });

  it('floors fractional measure inputs', () => {
    // Config saves integers but defend against hand-edited storage.
    expect(resolveLoopWindow(idx, duration, true, 1.7, 3.2)).toEqual({ start: 2000, end: 6000 });
  });
});

describe('shouldLoopFire — tick-time predicate for loop rebase', () => {
  it('fires when songTime reaches loopEnd while playing', () => {
    expect(shouldLoopFire(4000, 4000, 'playing')).toBe(true);
    expect(shouldLoopFire(4001, 4000, 'playing')).toBe(true);
  });

  it('does not fire before loopEnd', () => {
    expect(shouldLoopFire(3999, 4000, 'playing')).toBe(false);
  });

  it('does not fire when loopEnd is null (no window)', () => {
    expect(shouldLoopFire(999999, null, 'playing')).toBe(false);
  });

  it('does not fire outside status=playing — loop respects finished/idle', () => {
    expect(shouldLoopFire(5000, 4000, 'finished')).toBe(false);
    expect(shouldLoopFire(5000, 4000, 'idle')).toBe(false);
  });
});

describe('snapSongMsToMeasure', () => {
  const idx = [0, 2000, 4000, 6000, 8000];

  it('songMs = 0 (exactly on boundary 0): floor → 0, ceil → 1 (next boundary)', () => {
    expect(snapSongMsToMeasure(0, idx, 'floor')).toBe(0);
    expect(snapSongMsToMeasure(0, idx, 'ceil')).toBe(1);
  });

  it('exactly on a boundary: floor returns that measure, ceil returns next', () => {
    // 4000 is the start of measure 2. floor → 2, ceil → 3 (next boundary).
    expect(snapSongMsToMeasure(4000, idx, 'floor')).toBe(2);
    expect(snapSongMsToMeasure(4000, idx, 'ceil')).toBe(3);
  });

  it('mid-measure: floor returns containing measure, ceil returns next', () => {
    expect(snapSongMsToMeasure(3500, idx, 'floor')).toBe(1);
    expect(snapSongMsToMeasure(3500, idx, 'ceil')).toBe(2);
  });

  it('past the last entry: clamps to last index', () => {
    expect(snapSongMsToMeasure(99999, idx, 'floor')).toBe(4);
    expect(snapSongMsToMeasure(99999, idx, 'ceil')).toBe(4);
  });

  it('empty index returns 0', () => {
    expect(snapSongMsToMeasure(5000, [], 'floor')).toBe(0);
    expect(snapSongMsToMeasure(5000, [], 'ceil')).toBe(0);
  });
});

describe('updateCancelEdgeState — VR face-button edge detect', () => {
  it('inactive → both latches reset, no fire', () => {
    // Not in VR, or not playing. Held buttons must not fire on
    // re-entry; the latches clear so the next active frame treats
    // a held button as if it were just pressed.
    expect(
      updateCancelEdgeState({ prev: [true, true], pressed: [true, true], active: false })
    ).toEqual({ next: [false, false], firedBy: null });
  });

  it('rising edge on controller 0 → fire + latch', () => {
    const out = updateCancelEdgeState({ prev: [false, false], pressed: [true, false], active: true });
    expect(out.firedBy).toBe(0);
    expect(out.next).toEqual([true, false]);
  });

  it('rising edge on controller 1 → fire + latch (right controller works too)', () => {
    const out = updateCancelEdgeState({ prev: [false, false], pressed: [false, true], active: true });
    expect(out.firedBy).toBe(1);
    expect(out.next).toEqual([false, true]);
  });

  it('held button (prev latched, still pressed) → no re-fire', () => {
    const out = updateCancelEdgeState({ prev: [true, false], pressed: [true, false], active: true });
    expect(out.firedBy).toBeNull();
    expect(out.next).toEqual([true, false]);
  });

  it('release clears the latch so the next press fires again', () => {
    const released = updateCancelEdgeState({
      prev: [true, false],
      pressed: [false, false],
      active: true,
    });
    expect(released.firedBy).toBeNull();
    expect(released.next).toEqual([false, false]);
    // Next frame: press again → fires.
    const pressAgain = updateCancelEdgeState({
      prev: released.next,
      pressed: [true, false],
      active: true,
    });
    expect(pressAgain.firedBy).toBe(0);
  });

  it('simultaneous edge on both controllers → controller 0 wins (first-press priority)', () => {
    // Either controller's press should abort the song; the caller
    // only cares that _some_ controller fired. Still, pin the
    // priority so a refactor can't silently swap it.
    const out = updateCancelEdgeState({ prev: [false, false], pressed: [true, true], active: true });
    expect(out.firedBy).toBe(0);
    // Both latches set since both pressed; caller uses leaveSong()
    // immediately so the right-hand latch is cosmetic.
    expect(out.next).toEqual([true, true]);
  });

  it('a held press on one, fresh press on the other → only the fresh one fires', () => {
    const out = updateCancelEdgeState({ prev: [true, false], pressed: [true, true], active: true });
    expect(out.firedBy).toBe(1);
    expect(out.next).toEqual([true, true]);
  });
});
