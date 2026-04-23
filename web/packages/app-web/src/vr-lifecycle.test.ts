import { describe, expect, it } from 'vitest';
import {
  emptyChartState,
  resetStateOnVrExit,
  type VrExitState,
} from './vr-lifecycle.js';
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

describe('emptyChartState — loadAndStart entry-point reset', () => {
  // The bug this guards against: loadAndStart awaits engine.resume()
  // and then preloadSamples(); during those awaits the per-frame tick
  // keeps rendering whatever `this.song` + `this.status` currently
  // point at, which without a reset is the PREVIOUS chart. Players
  // picking a song from the VR menu saw the last chart's chips or its
  // RESULTS overlay bleed through while samples preloaded. Each field
  // below has a specific screen symptom if it leaks from the prior
  // run, so the test enumerates them rather than relying on a single
  // `toEqual` that would mask a regression adding a new field.

  it('song is null — the only gate that makes tick() early-return during preload', () => {
    // `if (!this.song) return;` in tick() is what suppresses rendering
    // while preloadSamples runs. Any non-null song here breaks the
    // whole fix.
    expect(emptyChartState().song).toBeNull();
  });

  it("status is 'idle' — clears a stale 'finished' so the RESULTS overlay doesn't paint", () => {
    expect(emptyChartState().status).toBe('idle');
  });

  it('finishedReturnHandled is false so the next chart can auto-return / pad-skip from its own RESULTS', () => {
    // Mirrors the resetStateOnVrExit latch clear — same failure mode
    // (player stuck on RESULTS forever) if it leaks true.
    expect(emptyChartState().finishedReturnHandled).toBe(false);
  });

  it('visual flash fields (judgmentFlash, hitFlashes) are cleared — 400ms afterglow would paint on top of idle panel', () => {
    const s = emptyChartState();
    expect(s.judgmentFlash).toBeNull();
    expect(s.hitFlashes).toEqual([]);
  });

  it('playables + measureStartMs start empty so renderer has nothing to iterate over', () => {
    const s = emptyChartState();
    expect(s.playables).toEqual([]);
    expect(s.measureStartMs).toEqual([]);
  });

  it('loop state is cleared so a previous chart\'s A/B window cannot fire on the new chart', () => {
    // A leaked loopedAtLeastOnce would flip onChartFinished into
    // practice-mode, silently suppressing the new chart's best-score
    // write. loopMarkerPressed leaking 'true' would make the rising-
    // edge detector miss the first press on the new chart.
    const s = emptyChartState();
    expect(s.loopedAtLeastOnce).toBe(false);
    expect(s.loopMarkerPressed).toEqual([false, false]);
  });

  it('returns a fresh object each call (no shared mutable arrays)', () => {
    // Game writes into the returned arrays (e.g. hitFlashes.push). A
    // shared module-level constant would be mutated across chart
    // reloads and leak the first run's flashes into the second.
    const a = emptyChartState();
    const b = emptyChartState();
    expect(a).not.toBe(b);
    expect(a.hitFlashes).not.toBe(b.hitFlashes);
    expect(a.playables).not.toBe(b.playables);
    expect(a.loopMarkerPressed).not.toBe(b.loopMarkerPressed);
  });
});
