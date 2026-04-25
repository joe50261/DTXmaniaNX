/**
 * Pure helpers for SongSelectCanvas's input handling. Extracted so the stick-
 * axis state machine and the raycast→button hit-test can be unit-
 * tested without standing up Three.js + a WebXR session.
 *
 * These are the parts of song-select that hold UX-sensitive rules:
 * stick edge-triggering (don't spam focus changes when a thumbstick
 * is held); dead-band release (don't jitter at the threshold); rect
 * hit test (a 1-pixel UV error drops a chart-button press).
 */

/** Stick magnitude past which an axis counts as "pushed". Paired
 * with STICK_RELEASE as a Schmitt trigger — the stick must swing
 * past the release band before the next press can fire. */
export const STICK_THRESHOLD = 0.55;
/** Dead-band the stick must fall below before the latch resets. */
export const STICK_RELEASE = 0.3;

export type StickAxisState = -1 | 0 | 1;

export interface StickAxisStepResult {
  /** The new latched state. Callers persist this between frames. */
  next: StickAxisState;
  /** `-1` or `+1` if the stick edge-fired this frame (e.g. focus
   * moved up / down), `0` if no fire. The caller dispatches the
   * corresponding action (moveFocus / cycleDifficulty) on non-zero. */
  fired: -1 | 0 | 1;
}

/**
 * Advance the stick-axis state machine by one frame.
 *
 * The three-state `prev` captures whether we're currently latched
 * pushed-up (+1), pushed-down (-1), or in the neutral dead-band (0).
 * A stick held past the threshold does not re-fire until it falls
 * back under STICK_RELEASE, which happens at a distinctly smaller
 * magnitude so jitter around the threshold can't spam events.
 */
export function stepStickAxis(axisValue: number, prev: StickAxisState): StickAxisStepResult {
  if (axisValue <= -STICK_THRESHOLD && prev !== -1) {
    return { next: -1, fired: -1 };
  }
  if (axisValue >= STICK_THRESHOLD && prev !== 1) {
    return { next: 1, fired: 1 };
  }
  if (Math.abs(axisValue) < STICK_RELEASE) {
    return { next: 0, fired: 0 };
  }
  // Between release and threshold, or already latched in the same
  // direction — keep state, no fire.
  return { next: prev, fired: 0 };
}

export interface ButtonRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Index of the button whose rect contains the panel-space point, or
 * `-1` if none. Iteration order matches the input array (caller owns
 * overlap semantics — first match wins).
 *
 * Used by the raycast path: a laser hit on the panel mesh produces a
 * UV coordinate, which is scaled by the panel's pixel dimensions and
 * tested against the same rects the 2D canvas paints. Keeping the
 * predicate out of tick() lets us regression-test the rect math
 * without Three.js.
 */
export function findButtonAtPoint<T extends ButtonRect>(buttons: readonly T[], px: number, py: number): number {
  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i]!;
    if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return i;
  }
  return -1;
}
