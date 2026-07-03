import { describe, it, expect } from 'vitest';
import {
  endJob,
  idleJobState,
  isCurrentJob,
  isJobRunning,
  startJob,
  throwIfRenderAborted,
} from './render-job-model.js';

describe('render job single-flight state', () => {
  it('starts idle', () => {
    const s = idleJobState();
    expect(isJobRunning(s)).toBe(false);
    expect(s.replayId).toBeNull();
  });

  it('startJob reserves the slot and hands out a token', () => {
    const started = startJob(idleJobState(), 'replay-a');
    expect(started).not.toBeNull();
    expect(isJobRunning(started!.state)).toBe(true);
    expect(started!.state.replayId).toBe('replay-a');
    expect(isCurrentJob(started!.state, started!.token)).toBe(true);
  });

  it('a second start is refused while a job is running — same or different replay', () => {
    const started = startJob(idleJobState(), 'replay-a')!;
    expect(startJob(started.state, 'replay-a')).toBeNull();
    expect(startJob(started.state, 'replay-b')).toBeNull();
  });

  it('endJob with the owning token frees the slot for the next job', () => {
    const first = startJob(idleJobState(), 'replay-a')!;
    const idle = endJob(first.state, first.token);
    expect(isJobRunning(idle)).toBe(false);
    expect(idle.replayId).toBeNull();
    const second = startJob(idle, 'replay-b');
    expect(second).not.toBeNull();
    expect(second!.state.replayId).toBe('replay-b');
  });

  it('tokens are never reused across jobs', () => {
    const first = startJob(idleJobState(), 'replay-a')!;
    const second = startJob(endJob(first.state, first.token), 'replay-b')!;
    expect(second.token).not.toBe(first.token);
    // The old job's callbacks are stale against the new state.
    expect(isCurrentJob(second.state, first.token)).toBe(false);
    expect(isCurrentJob(second.state, second.token)).toBe(true);
  });

  it('endJob with a stale token does not clear a newer job', () => {
    const first = startJob(idleJobState(), 'replay-a')!;
    const afterFirst = endJob(first.state, first.token);
    const second = startJob(afterFirst, 'replay-b')!;
    // First job's finally fires late (e.g. after cancellation) — must
    // be a no-op against the second job's reservation.
    const s = endJob(second.state, first.token);
    expect(s).toBe(second.state);
    expect(isJobRunning(s)).toBe(true);
    expect(isCurrentJob(s, second.token)).toBe(true);
  });

  it('isCurrentJob is false once the job has ended', () => {
    const started = startJob(idleJobState(), 'replay-a')!;
    const ended = endJob(started.state, started.token);
    expect(isCurrentJob(ended, started.token)).toBe(false);
  });
});

describe('throwIfRenderAborted', () => {
  it('passes through when no signal / not aborted', () => {
    expect(() => throwIfRenderAborted(undefined)).not.toThrow();
    expect(() => throwIfRenderAborted(new AbortController().signal)).not.toThrow();
  });

  it('throws a DOMException named AbortError once aborted', () => {
    const c = new AbortController();
    c.abort();
    let caught: unknown;
    try {
      throwIfRenderAborted(c.signal);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
  });
});
