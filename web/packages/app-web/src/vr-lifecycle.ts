import type { Song } from '@dtxmania/dtx-core';

/** Narrow shape of the "empty" chart-visible state. Every field is
 * typed as its literal empty / null value rather than the wider type
 * it would carry during play, so `game.ts` can assign fields
 * directly without casts (`null` is assignable to `T | null`,
 * `never[]` spreads into `T[]`, the `[false, false]` tuple matches
 * the rising-edge pair exactly). The tightening also enforces the
 * promise `emptyChartState` is making: a change adding a new Game
 * field that tick() reads would need a matching null literal here,
 * caught at the call site. */
export interface ChartVisibleStateEmpty {
  song: null;
  status: 'idle';
  finishedAtMs: null;
  finishedReturnHandled: false;
  judgmentFlash: null;
  hitFlashes: readonly never[];
  playables: readonly never[];
  measureStartMs: readonly never[];
  loopedAtLeastOnce: false;
  loopMarkerPressed: readonly [false, false];
}

/** Values every field in `ChartVisibleStateEmpty` must hold after a
 * fresh `loadAndStart` entry, before any async work kicks off.
 *
 * Why: between the first await (engine.resume) and the final status
 * flip to 'playing', the `renderer.onFrame(tick)` loop keeps firing. If
 * `song` / `status` / `hitFlashes` still carry the PREVIOUS chart's
 * values, tick() paints that stale state into the VR panel texture —
 * players see the last chart's chips or its RESULTS overlay bleed
 * through the new chart's preload window. Zeroing everything up front
 * lets tick()'s `if (!this.song) return;` early-exit kick in cleanly
 * until the new chart is ready. Exported so the invariant can be
 * asserted without constructing an AudioEngine + Three.js scene. */
export function emptyChartState(): ChartVisibleStateEmpty {
  return {
    song: null,
    status: 'idle',
    finishedAtMs: null,
    finishedReturnHandled: false,
    judgmentFlash: null,
    hitFlashes: [],
    playables: [],
    measureStartMs: [],
    loopedAtLeastOnce: false,
    loopMarkerPressed: [false, false],
  };
}


/**
 * Pure state helper for the VR-session-end cleanup path. Keeping this
 * separate from Game.enterXR's callback lets us regression-test the
 * "finished → idle reset" rule without standing up a Three.js
 * WebGLRenderer + WebXR session.
 *
 * The concrete bug this guards against: exiting VR while the RESULTS
 * screen was up left `status` pinned at 'finished'. On the next
 * enterXR, `finishedReturnHandled` was already latched from the prior
 * session, so none of the return-to-menu paths would fire — the
 * player would be stuck staring at stale results with no way out.
 * Nulling `song` as well makes main.ts's post-enter handler see
 * `hasChart === false` and auto-open the VR menu, matching a fresh
 * boot.
 */
export type VrExitGameStatus = 'idle' | 'playing' | 'finished';

export interface VrExitState {
  status: VrExitGameStatus;
  song: Song | null;
  finishedAtMs: number | null;
  finishedReturnHandled: boolean;
}

/** Returns the state Game should adopt after XR session end. If the
 * session ended mid-play or before a play started, nothing changes. If
 * it ended on the RESULTS screen, everything resets. */
export function resetStateOnVrExit(state: VrExitState): VrExitState {
  if (state.status !== 'finished') return state;
  return {
    status: 'idle',
    song: null,
    finishedAtMs: null,
    finishedReturnHandled: false,
  };
}
