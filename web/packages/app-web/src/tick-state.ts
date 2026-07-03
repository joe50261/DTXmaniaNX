import { Judgment } from '@dtxmania/dtx-core';
import { Lane, type LaneValue } from '@dtxmania/input';

/**
 * Pure decision helpers extracted from `Game.tick()` and
 * `Game.handleLaneHit()`. Each one captures a rule that would be
 * regression-silent if it drifted — the magic dwell windows
 * (400 ms pad-hit skip, 5 s VR auto-return, 500 ms song-end tail),
 * the gauge deltas per judgment, and the per-controller edge
 * detection for VR face-button cancel.
 *
 * All functions here are pure: outputs depend only on arguments, no
 * clock reads, no I/O, no `this`. The Game class is the side-effect
 * substrate; these are the rules it obeys.
 */

export type GameStatus = 'idle' | 'playing' | 'finished';

// ---- Gauge ----------------------------------------------------------

/** Per-judgment gauge delta. Values mirror DTXmania's feel tuning:
 * PERFECT adds 2.5%, GREAT 1.5%, GOOD a token 0.5%, POOR drains 2%,
 * MISS drains 5%. Exported so tests can pin the numbers and so
 * future UI that surfaces the deltas (e.g. "+2.5%" popup) reads
 * them from one source. */
export const GAUGE_DELTAS = {
  PERFECT: 0.025,
  GREAT: 0.015,
  GOOD: 0.005,
  POOR: -0.02,
  MISS: -0.05,
} as const;

export function gaugeDeltaFor(judgment: typeof Judgment[keyof typeof Judgment]): number {
  switch (judgment) {
    case Judgment.PERFECT: return GAUGE_DELTAS.PERFECT;
    case Judgment.GREAT: return GAUGE_DELTAS.GREAT;
    case Judgment.GOOD: return GAUGE_DELTAS.GOOD;
    case Judgment.POOR: return GAUGE_DELTAS.POOR;
    case Judgment.MISS: return GAUGE_DELTAS.MISS;
  }
}

/** Apply a judgment to the gauge, clamped to [0, 1]. */
export function applyGaugeDelta(
  gauge: number,
  judgment: typeof Judgment[keyof typeof Judgment],
): number {
  return Math.max(0, Math.min(1, gauge + gaugeDeltaFor(judgment)));
}

// ---- Song-end transition -------------------------------------------

/** Small tail after `durationMs` to catch the last chip's miss window
 * before flipping to 'finished'. Without it, a chip whose scheduled
 * time lands at `durationMs - 5` would still have its POOR window
 * hanging past the end and would never register as miss. */
export const SONG_END_TAIL_MS = 500;

export function shouldEnterFinishedState(
  songTimeMs: number,
  durationMs: number,
  status: GameStatus,
): boolean {
  return status === 'playing' && songTimeMs > durationMs + SONG_END_TAIL_MS;
}

// ---- VR auto-return -------------------------------------------------

/** Dwell on the result screen before VR auto-fires onRestart. Long
 * enough for the player to read the rank; short enough that an
 * unattended headset eventually returns to the picker. */
export const VR_AUTO_RETURN_DWELL_MS = 5000;

export interface VrAutoReturnInput {
  status: GameStatus;
  /** One-shot latch so neither auto-return nor pad-hit-skip double-fires. */
  finishedReturnHandled: boolean;
  inXR: boolean;
  /** The host's restart callback; no return without one. */
  hasOnRestart: boolean;
  /** performance.now() at the 'playing' → 'finished' transition. */
  finishedAtMs: number | null;
  /** Current performance.now(). */
  nowMs: number;
}

/** Every clause must hold — any drift silently breaks the dwell. */
export function shouldFireVrAutoReturn(i: VrAutoReturnInput): boolean {
  if (i.status !== 'finished') return false;
  if (i.finishedReturnHandled) return false;
  if (!i.inXR) return false;
  if (!i.hasOnRestart) return false;
  if (i.finishedAtMs === null) return false;
  return i.nowMs - i.finishedAtMs > VR_AUTO_RETURN_DWELL_MS;
}

// ---- Pad-hit result-screen skip -------------------------------------

/** Dwell after the song flips to 'finished' before a pad hit counts
 * as a skip. Without it, the last in-song strike would double-fire
 * as a skip the instant the song ended. */
export const RESULT_PAD_HIT_DWELL_MS = 400;

export interface ResultPadHitReturnInput {
  status: GameStatus;
  finishedReturnHandled: boolean;
  hasOnRestart: boolean;
  finishedAtMs: number | null;
  nowMs: number;
}

export function shouldFireResultPadHitReturn(i: ResultPadHitReturnInput): boolean {
  if (i.status !== 'finished') return false;
  if (i.finishedReturnHandled) return false;
  if (!i.hasOnRestart) return false;
  if (i.finishedAtMs === null) return false;
  return i.nowMs - i.finishedAtMs >= RESULT_PAD_HIT_DWELL_MS;
}

// ---- VR face-button cancel edge detection --------------------------

export interface CancelEdgeInput {
  /** Previous-frame "is this controller currently latched as pressed?"
   * for controllers [0, 1]. */
  prev: readonly [boolean, boolean];
  /** This frame's raw pressed state for each controller. */
  pressed: readonly [boolean, boolean];
  /** Whether cancel input is active this frame. When false (not in
   * VR, or not in 'playing' status) we reset the latches so a button
   * held across a mode change doesn't fire on re-entry. */
  active: boolean;
}

export interface CancelEdgeOutput {
  next: [boolean, boolean];
  /** Which controller edge-fired this frame (0 or 1), or null if
   * none. The caller invokes leaveSong() on any non-null result. */
  firedBy: 0 | 1 | null;
}

/** Rising-edge detector for a single boolean input. Returns true on the
 * first frame where `cur` is true and `prev` was false. Used by the
 * per-controller loop-marker capture in VR (right-A / right-B). Held
 * presses don't re-fire; releases re-arm. Pure for testability. */
export function risingEdge(prev: boolean, cur: boolean): boolean {
  return cur && !prev;
}

// ---- Practice-mode loop --------------------------------------------

export interface ResolvedLoopWindow {
  /** Inclusive song-ms of the loop start. */
  start: number;
  /** Exclusive song-ms of the loop end (seek back when songTime ≥ end). */
  end: number;
}

/** Validate + snap a measure-based loop window to absolute song ms.
 *
 * Returns null when any of:
 *   - loop is disabled
 *   - measureStartMs is empty (chart not yet ready)
 *   - the resolved window is zero-or-negative length
 *
 * Clamps out-of-range measure indices to the index bounds. `endMeasure
 * = null` resolves to the sentinel (end of song). The returned `end`
 * is further clamped to `durationMs` so seeking past song end is
 * impossible.
 */
export function resolveLoopWindow(
  measureStartMs: readonly number[],
  durationMs: number,
  enabled: boolean,
  startMeasure: number,
  endMeasure: number | null,
): ResolvedLoopWindow | null {
  if (!enabled) return null;
  if (measureStartMs.length === 0) return null;
  const maxIdx = measureStartMs.length - 1;
  const sIdx = Math.max(0, Math.min(Math.floor(startMeasure), maxIdx));
  const eIdx = endMeasure === null
    ? maxIdx
    : Math.max(0, Math.min(Math.floor(endMeasure), maxIdx));
  const start = measureStartMs[sIdx]!;
  const end = Math.min(measureStartMs[eIdx]!, durationMs);
  if (end <= start) return null;
  return { start, end };
}

/** Whether the loop's seek-back should fire this frame. Separate from
 * `shouldEnterFinishedState` so a loop ending at song-end doesn't race
 * the finished transition — the caller checks this FIRST. */
export function shouldLoopFire(
  songTimeMs: number,
  loopEnd: number | null,
  status: GameStatus,
): boolean {
  if (status !== 'playing') return false;
  if (loopEnd === null) return false;
  return songTimeMs >= loopEnd;
}

/** Snap a song-ms to the nearest measure boundary. `floor` picks the
 * measure containing the time (used for loop A). `ceil` picks the next
 * boundary after the time (used for loop B). Clamps to the index range
 * on either end. Returns 0 for an empty index (no chart). */
export function snapSongMsToMeasure(
  songMs: number,
  measureStartMs: readonly number[],
  mode: 'floor' | 'ceil',
): number {
  if (measureStartMs.length === 0) return 0;
  for (let i = 0; i < measureStartMs.length; i++) {
    if (measureStartMs[i]! > songMs) {
      return mode === 'floor' ? Math.max(0, i - 1) : i;
    }
  }
  return measureStartMs.length - 1;
}

export function updateCancelEdgeState(i: CancelEdgeInput): CancelEdgeOutput {
  if (!i.active) {
    return { next: [false, false], firedBy: null };
  }
  const next: [boolean, boolean] = [i.prev[0], i.prev[1]];
  let firedBy: 0 | 1 | null = null;
  for (let c = 0 as 0 | 1; c < 2; c = (c + 1) as 0 | 1) {
    const pressed = i.pressed[c];
    const wasLatched = i.prev[c];
    if (pressed && !wasLatched) {
      // Edge: rising. Latch + fire (first-press wins).
      next[c] = true;
      if (firedBy === null) firedBy = c;
    } else if (!pressed) {
      // Release clears latch so the next press fires again.
      next[c] = false;
    }
    // else: still pressed, still latched — no change.
  }
  return { next, firedBy };
}

// ---- VR trigger → kick-pedal edge detection -------------------------

/** Which judgment lane each hand's trigger drives. Quest has no foot
 * tracking, so the index-finger triggers stand in for the pedals:
 * left trigger = left pedal lane (LP, DTX channel 0x1B), right
 * trigger = bass drum lane (BD, 0x13). LBD 0x1C — the LEFT-foot
 * double-bass channel — is projected onto BD by channelToLane, so
 * after projection BD carries both feet's bass notes and the right
 * trigger plays them all. */
export const TRIGGER_KICK_LANE_BY_HAND = {
  left: Lane.LP,
  right: Lane.BD,
} as const;

export interface TriggerKickInput {
  /** Previous-frame trigger latch per controller slot [0, 1]. */
  prev: readonly [boolean, boolean];
  /** Whether each slot had a connected input source LAST frame. On a
   * slot's first observed frame (null → source transition: controller
   * reconnect, re-enter VR mid-song) the raw pressed state seeds the
   * latch WITHOUT firing — a pull that predates observation isn't a
   * kick. Without this, a trigger already squeezed while the slot was
   * unobserved (masked to pressed=false) would edge-fire a phantom
   * hit the moment the source appears. */
  prevConnected: readonly [boolean, boolean];
  /** This frame's raw trigger-pressed state per controller slot. */
  pressed: readonly [boolean, boolean];
  /** `XRInputSource.handedness` per slot, or null when that slot has
   * no connected source. Slot order is NOT handedness (WebXR assigns
   * slots independently of which hand connects first), which is why
   * the lane is resolved from handedness here rather than from the
   * slot index. */
  handedness: readonly ['left' | 'right' | 'none' | null, 'left' | 'right' | 'none' | null];
  /** Whether trigger-kick input is live this frame (in VR and
   * status === 'playing'). While false the latches TRACK the raw
   * pressed state (without firing) instead of resetting — the VR menu
   * confirms song picks with the same trigger, so a pull still held
   * when the song starts must not edge-fire a kick on the first
   * playing frame. The player has to release and re-pull. */
  active: boolean;
}

export interface TriggerKickFire {
  /** Controller slot that fired — the caller pulses haptics on this
   * slot (haptic routing is slot-indexed, see XrControllers.pulseHaptic). */
  slot: 0 | 1;
  lane: LaneValue;
  /** Debug tag for LaneHitEvent.key. */
  key: string;
}

export interface TriggerKickOutput {
  next: [boolean, boolean];
  /** Lane hits to dispatch this frame. Unlike the cancel edge (first
   * press wins), both triggers may fire in the same frame — a
   * simultaneous double-kick is two independent hits. */
  fires: TriggerKickFire[];
}

export function stepTriggerKick(i: TriggerKickInput): TriggerKickOutput {
  if (!i.active) {
    return { next: [i.pressed[0], i.pressed[1]], fires: [] };
  }
  const next: [boolean, boolean] = [i.prev[0], i.prev[1]];
  const fires: TriggerKickFire[] = [];
  for (let s = 0 as 0 | 1; s < 2; s = (s + 1) as 0 | 1) {
    const pressed = i.pressed[s];
    if (!i.prevConnected[s]) {
      // First observed frame for this slot — adopt the raw state
      // without edge detection so a pull that predates observation
      // can't fire.
      next[s] = pressed;
      continue;
    }
    if (pressed && !i.prev[s]) {
      // Rising edge: latch. Fire only when the hand is known —
      // 'none' (trackers) still latches so the press can't
      // retro-fire if handedness resolves while held.
      next[s] = true;
      const hand = i.handedness[s];
      if (hand === 'left' || hand === 'right') {
        fires.push({
          slot: s,
          lane: TRIGGER_KICK_LANE_BY_HAND[hand],
          key: `xr-trigger-${hand}`,
        });
      }
    } else if (!pressed) {
      // Release re-arms the trigger.
      next[s] = false;
    }
    // else: still held, still latched — no change.
  }
  return { next, fires };
}
