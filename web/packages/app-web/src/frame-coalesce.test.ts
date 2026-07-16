import { describe, expect, it } from 'vitest';
import { coalesceToFrame } from './frame-coalesce.js';

/** Manual scheduler: collects callbacks, runs them on flush(). */
function manualScheduler(): {
  schedule: (cb: () => void) => void;
  flush: () => void;
  queued: () => number;
} {
  let queue: Array<() => void> = [];
  return {
    schedule: (cb) => queue.push(cb),
    flush: () => {
      const q = queue;
      queue = [];
      for (const cb of q) cb();
    },
    queued: () => queue.length,
  };
}

describe('coalesceToFrame', () => {
  it('defers fn to the scheduler tick instead of running inline', () => {
    const s = manualScheduler();
    let runs = 0;
    const trigger = coalesceToFrame(s.schedule, () => runs++);
    trigger();
    expect(runs).toBe(0);
    s.flush();
    expect(runs).toBe(1);
  });

  it('coalesces a burst of triggers into a single run', () => {
    const s = manualScheduler();
    let runs = 0;
    const trigger = coalesceToFrame(s.schedule, () => runs++);
    trigger();
    trigger();
    trigger();
    expect(s.queued()).toBe(1);
    s.flush();
    expect(runs).toBe(1);
  });

  it('re-arms after a flush so later triggers still fire', () => {
    const s = manualScheduler();
    let runs = 0;
    const trigger = coalesceToFrame(s.schedule, () => runs++);
    trigger();
    s.flush();
    trigger();
    trigger();
    s.flush();
    expect(runs).toBe(2);
  });

  it('a trigger from inside fn schedules a fresh run (no lost resize)', () => {
    const s = manualScheduler();
    let runs = 0;
    const trigger = coalesceToFrame(s.schedule, () => {
      runs++;
      if (runs === 1) trigger();
    });
    trigger();
    s.flush(); // runs fn once, which re-triggers
    expect(runs).toBe(1);
    s.flush();
    expect(runs).toBe(2);
  });
});
