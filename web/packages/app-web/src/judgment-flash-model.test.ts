import { describe, it, expect } from 'vitest';
import { Lane } from '@dtxmania/input';
import { Judgment, type JudgmentKind } from '@dtxmania/dtx-core';
import {
  type JudgmentFlash,
  JUDGMENT_FLASH_LIFE_MS,
  upsertLaneFlash,
  pruneJudgmentFlashes,
} from './judgment-flash-model.js';

function flash(
  lane: JudgmentFlash['lane'],
  spawnedMs: number,
  judgment: JudgmentKind = Judgment.PERFECT,
): JudgmentFlash {
  return {
    text: judgment,
    judgment,
    color: '#fff',
    lane,
    spawnedMs,
  };
}

describe('upsertLaneFlash — the multiple-simultaneous-judgment fix', () => {
  it('keeps one flash per lane so a chord shows several at once', () => {
    // A snare+hihat+kick chord: three lanes struck in the same frame.
    // The old single-slot field could only ever hold the last one; the
    // per-lane store must surface all three.
    let flashes: JudgmentFlash[] = [];
    flashes = upsertLaneFlash(flashes, flash(Lane.SD, 1000));
    flashes = upsertLaneFlash(flashes, flash(Lane.HH, 1000));
    flashes = upsertLaneFlash(flashes, flash(Lane.BD, 1000));

    expect(flashes).toHaveLength(3);
    expect(flashes.map((f) => f.lane).sort()).toEqual(
      [Lane.SD, Lane.HH, Lane.BD].sort(),
    );
  });

  it('replaces an existing flash on the same lane (newest wins, DTXMania restarts the lane counter)', () => {
    let flashes: JudgmentFlash[] = [];
    flashes = upsertLaneFlash(flashes, flash(Lane.SD, 1000, Judgment.GREAT));
    flashes = upsertLaneFlash(flashes, flash(Lane.SD, 1200, Judgment.PERFECT));

    expect(flashes).toHaveLength(1);
    expect(flashes[0]!.spawnedMs).toBe(1200);
    expect(flashes[0]!.judgment).toBe(Judgment.PERFECT);
  });

  it('does not mutate the input array (pure — callers reassign)', () => {
    const original: JudgmentFlash[] = [flash(Lane.SD, 1000)];
    const next = upsertLaneFlash(original, flash(Lane.HH, 1000));
    expect(original).toHaveLength(1);
    expect(next).not.toBe(original);
    expect(next).toHaveLength(2);
  });

  it('replacing one lane leaves other lanes untouched', () => {
    let flashes: JudgmentFlash[] = [];
    flashes = upsertLaneFlash(flashes, flash(Lane.SD, 1000));
    flashes = upsertLaneFlash(flashes, flash(Lane.HH, 1000));
    flashes = upsertLaneFlash(flashes, flash(Lane.SD, 1300, Judgment.GOOD));

    expect(flashes).toHaveLength(2);
    const hh = flashes.find((f) => f.lane === Lane.HH)!;
    const sd = flashes.find((f) => f.lane === Lane.SD)!;
    expect(hh.spawnedMs).toBe(1000);
    expect(sd.spawnedMs).toBe(1300);
    expect(sd.judgment).toBe(Judgment.GOOD);
  });
});

describe('pruneJudgmentFlashes', () => {
  it('drops flashes at or past their life and keeps fresh ones', () => {
    const flashes: JudgmentFlash[] = [
      flash(Lane.SD, 1000),
      flash(Lane.HH, 1500),
    ];
    // now = 1000 + life → SD (age = life) is expired, HH (age = 900 < life) stays.
    const kept = pruneJudgmentFlashes(flashes, 1000 + JUDGMENT_FLASH_LIFE_MS);
    expect(kept.map((f) => f.lane)).toEqual([Lane.HH]);
  });

  it('keeps everything when all flashes are within life', () => {
    const flashes: JudgmentFlash[] = [
      flash(Lane.SD, 1000),
      flash(Lane.HH, 1000),
    ];
    expect(pruneJudgmentFlashes(flashes, 1100)).toHaveLength(2);
  });

  it('honours a custom life window', () => {
    const flashes: JudgmentFlash[] = [flash(Lane.SD, 1000)];
    expect(pruneJudgmentFlashes(flashes, 1050, 40)).toHaveLength(0);
    expect(pruneJudgmentFlashes(flashes, 1020, 40)).toHaveLength(1);
  });
});
