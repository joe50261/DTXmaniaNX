import { describe, expect, it } from 'vitest';
import {
  findButtonAtPoint,
  stepStickAxis,
  STICK_RELEASE,
  STICK_THRESHOLD,
} from './song-select-input.js';

/**
 * Tests for the two pure seams of SongSelectCanvas.tick(): the stick-axis
 * Schmitt trigger (focus / difficulty cycling) and the raycast →
 * button rect hit test. Regression-silent if they drift: focus
 * spams, or jitters at the threshold, or a laser hit a few pixels
 * off drops the chart button press.
 */

describe('stepStickAxis — Schmitt-trigger stick state', () => {
  it('fires +1 when the stick crosses the upward threshold from neutral', () => {
    expect(stepStickAxis(STICK_THRESHOLD, 0)).toEqual({ next: 1, fired: 1 });
    expect(stepStickAxis(1, 0)).toEqual({ next: 1, fired: 1 });
  });

  it('fires -1 when the stick crosses the downward threshold from neutral', () => {
    expect(stepStickAxis(-STICK_THRESHOLD, 0)).toEqual({ next: -1, fired: -1 });
    expect(stepStickAxis(-1, 0)).toEqual({ next: -1, fired: -1 });
  });

  it('does NOT re-fire while held past the threshold (the Schmitt latch)', () => {
    // Simulates 5 frames with the stick held fully up.
    let state: -1 | 0 | 1 = 0;
    let fires = 0;
    for (let f = 0; f < 5; f++) {
      const r = stepStickAxis(1, state);
      state = r.next;
      if (r.fired !== 0) fires++;
    }
    // Exactly one fire — the initial edge.
    expect(fires).toBe(1);
  });

  it('resets the latch only after the stick falls below STICK_RELEASE', () => {
    // Start latched up, drift down through the release band.
    const hold1 = stepStickAxis(1, 0);
    expect(hold1).toEqual({ next: 1, fired: 1 });
    // Stick still above release: state sticks at 1, no fire.
    const hold2 = stepStickAxis(0.4, hold1.next); // 0.3 < 0.4 < 0.55
    expect(hold2).toEqual({ next: 1, fired: 0 });
    // Fall under release: latch clears to 0.
    const released = stepStickAxis(0.2, hold2.next);
    expect(released).toEqual({ next: 0, fired: 0 });
    // Now a fresh push fires.
    const next = stepStickAxis(1, released.next);
    expect(next).toEqual({ next: 1, fired: 1 });
  });

  it('flipping sign — +1 latched then hard pull the other way — fires -1 immediately', () => {
    // Holding up, then the player slams the stick to the opposite
    // direction. That's a valid new edge (crosses the opposite
    // threshold), should fire. Matches what a real Quest thumbstick
    // does when the player "jabs" to cycle quickly.
    const up = stepStickAxis(1, 0);
    expect(up.fired).toBe(1);
    const down = stepStickAxis(-1, up.next);
    expect(down).toEqual({ next: -1, fired: -1 });
  });

  it('value within the release band (|axis| < 0.3) forces state back to neutral', () => {
    expect(stepStickAxis(0, 1)).toEqual({ next: 0, fired: 0 });
    expect(stepStickAxis(0.2, -1)).toEqual({ next: 0, fired: 0 });
    expect(stepStickAxis(-0.2, 1)).toEqual({ next: 0, fired: 0 });
  });

  it('between release and threshold — keep state, do not re-fire or reset', () => {
    // This is the dead-band: stick is past the dead-band but not yet
    // above the trigger. State should not change — no new fire, no
    // stale clear.
    expect(stepStickAxis(0.4, 0)).toEqual({ next: 0, fired: 0 });
    expect(stepStickAxis(0.4, 1)).toEqual({ next: 1, fired: 0 });
    expect(stepStickAxis(-0.4, -1)).toEqual({ next: -1, fired: 0 });
  });

  it('constants: threshold > release (guards the Schmitt trigger property)', () => {
    // If these ever cross (threshold ≤ release) the Schmitt trigger
    // degenerates into a single-level comparator and the stick will
    // jitter-fire right at the threshold.
    expect(STICK_THRESHOLD).toBeGreaterThan(STICK_RELEASE);
  });

  it('edge boundary inclusivity — exactly STICK_THRESHOLD fires; exactly STICK_RELEASE does not reset', () => {
    // Pin the `<=` / `>=` / `<` choices in the implementation so a
    // future refactor to strict/inclusive flips gets caught.
    expect(stepStickAxis(STICK_THRESHOLD, 0).fired).toBe(1);
    expect(stepStickAxis(-STICK_THRESHOLD, 0).fired).toBe(-1);
    // `Math.abs(axis) < STICK_RELEASE` is strict — at exactly the
    // release value, we keep whatever state we had (neither reset
    // nor fire).
    expect(stepStickAxis(STICK_RELEASE, 1).fired).toBe(0);
    expect(stepStickAxis(STICK_RELEASE, 1).next).toBe(1);
  });
});

describe('findButtonAtPoint — raycast hit-test', () => {
  const buttons = [
    { x: 10, y: 10, w: 100, h: 40 }, // #0: top bar
    { x: 200, y: 200, w: 80, h: 80 }, // #1: centre square
    { x: 50, y: 300, w: 50, h: 50 }, // #2: bottom-left box
  ];

  it('returns the index of the rect containing the point', () => {
    expect(findButtonAtPoint(buttons, 50, 30)).toBe(0);
    expect(findButtonAtPoint(buttons, 240, 240)).toBe(1);
    expect(findButtonAtPoint(buttons, 70, 320)).toBe(2);
  });

  it('returns -1 for a point outside every rect', () => {
    expect(findButtonAtPoint(buttons, 0, 0)).toBe(-1);
    expect(findButtonAtPoint(buttons, 500, 500)).toBe(-1);
    // Between button 1 and button 2 — no rect covers (150, 275).
    expect(findButtonAtPoint(buttons, 150, 275)).toBe(-1);
  });

  it('rect edges are inclusive (>=x && <=x+w)', () => {
    const b = buttons[0]!;
    expect(findButtonAtPoint(buttons, b.x, b.y)).toBe(0);
    expect(findButtonAtPoint(buttons, b.x + b.w, b.y + b.h)).toBe(0);
  });

  it('first-match-wins when rects overlap', () => {
    const overlap = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 40, y: 40, w: 60, h: 60 }, // nested inside #0
    ];
    expect(findButtonAtPoint(overlap, 50, 50)).toBe(0);
  });

  it('empty list returns -1', () => {
    expect(findButtonAtPoint([], 10, 10)).toBe(-1);
  });

  it('1-pixel miss on a tight rect returns -1 (catches integer-vs-float bugs)', () => {
    // A 100-px-wide button with a UV that maps 1px past the edge
    // should miss. Pin the inclusive contract so a refactor to <
    // catches.
    const b = buttons[0]!;
    expect(findButtonAtPoint(buttons, b.x + b.w + 1, b.y + b.h / 2)).toBe(-1);
    expect(findButtonAtPoint(buttons, b.x - 1, b.y + b.h / 2)).toBe(-1);
  });
});
