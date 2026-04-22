import { describe, expect, it } from 'vitest';
import { resetStateOnVrExit, type VrExitState } from './vr-lifecycle.js';
import type { Song } from '@dtxmania/dtx-core';

/** Minimal Song stub; resetStateOnVrExit never inspects its fields. */
const fakeSong = {} as unknown as Song;

describe('resetStateOnVrExit', () => {
  it('resets a finished session so the next enterXR starts fresh', () => {
    const before: VrExitState = {
      status: 'finished',
      song: fakeSong,
      finishedAtMs: 12_345,
      finishedReturnHandled: true,
    };
    expect(resetStateOnVrExit(before)).toEqual({
      status: 'idle',
      song: null,
      finishedAtMs: null,
      finishedReturnHandled: false,
    });
  });

  it('leaves an idle session untouched (VR exit before any play)', () => {
    const before: VrExitState = {
      status: 'idle',
      song: null,
      finishedAtMs: null,
      finishedReturnHandled: false,
    };
    expect(resetStateOnVrExit(before)).toBe(before);
  });

  it('leaves a playing session untouched — abort path handles its own cleanup', () => {
    // Players who squeeze-cancel mid-song transition through 'playing' →
    // leaveSong() which clears state; the VR session-end handler should
    // not stomp on that work.
    const before: VrExitState = {
      status: 'playing',
      song: fakeSong,
      finishedAtMs: null,
      finishedReturnHandled: false,
    };
    expect(resetStateOnVrExit(before)).toBe(before);
  });

  it('returns a fresh object on reset (not a mutated input)', () => {
    // Game.enterXR's callback reads fields off the return value one by
    // one, so it's fine either way — but aliasing would let callers
    // accidentally mutate each others' state. Keep the contract pure.
    const before: VrExitState = {
      status: 'finished',
      song: fakeSong,
      finishedAtMs: 0,
      finishedReturnHandled: true,
    };
    const after = resetStateOnVrExit(before);
    expect(after).not.toBe(before);
    expect(before.status).toBe('finished'); // input unchanged
    expect(before.finishedReturnHandled).toBe(true);
  });

  it('clears finishedReturnHandled specifically — the latch that prevents return paths', () => {
    // If this stays true after reset, neither the 5-second auto-return
    // nor the pad-hit-skip will fire on the next song's RESULTS, and
    // the player is stuck. Call it out explicitly so a careless refactor
    // (e.g. "just null song and status, keep the latch") is caught.
    const after = resetStateOnVrExit({
      status: 'finished',
      song: fakeSong,
      finishedAtMs: 9999,
      finishedReturnHandled: true,
    });
    expect(after.finishedReturnHandled).toBe(false);
  });
});
