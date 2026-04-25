import { describe, expect, it } from 'vitest';
import {
  PANEL_H_PX,
  PANEL_W_PX,
  PREIMAGE_SIZE,
  PREIMAGE_X,
  PREIMAGE_Y,
  SCROLLBAR_H,
  SCROLLBAR_X,
  SCROLLBAR_Y,
  WHEEL_BAR_ANCHORS,
  WHEEL_FOCUS_INDEX,
  WHEEL_VISIBLE_BARS,
} from './song-select-layout.js';

/**
 * Pins the geometric invariants that song-select-design.md spells out
 * for the C# Stage 05 layout. If a future tweak nudges these out of
 * spec, the test fails before the visual regression ships.
 */

describe('song-select-layout — DTXMania Stage 05 invariants', () => {
  it('canvas is 1280×720 (the C# skin grid)', () => {
    expect(PANEL_W_PX).toBe(1280);
    expect(PANEL_H_PX).toBe(720);
  });

  it('wheel has 13 visible bars and the focus row is index 5', () => {
    expect(WHEEL_VISIBLE_BARS).toBe(13);
    expect(WHEEL_FOCUS_INDEX).toBe(5);
    expect(WHEEL_BAR_ANCHORS).toHaveLength(13);
  });

  it('focus bar sits at the canonical (464, 270)', () => {
    const focus = WHEEL_BAR_ANCHORS[WHEEL_FOCUS_INDEX]!;
    expect(focus.x).toBe(464);
    expect(focus.y).toBe(270);
  });

  it('wheel anchors curve right around the focus row (DTXMania signature)', () => {
    // Walking outward from the focus row, x must monotonically increase
    // both upward and downward — the visual signature of the C# wheel
    // is bars drifting right as they leave the focus.
    const focusX = WHEEL_BAR_ANCHORS[WHEEL_FOCUS_INDEX]!.x;
    for (let i = WHEEL_FOCUS_INDEX - 1; i >= 0; i--) {
      const above = WHEEL_BAR_ANCHORS[i]!.x;
      const below = WHEEL_BAR_ANCHORS[i + 1]!.x;
      expect(above).toBeGreaterThanOrEqual(below);
      expect(above).toBeGreaterThan(focusX);
    }
    for (let i = WHEEL_FOCUS_INDEX + 1; i < WHEEL_VISIBLE_BARS; i++) {
      const here = WHEEL_BAR_ANCHORS[i]!.x;
      const prev = WHEEL_BAR_ANCHORS[i - 1]!.x;
      expect(here).toBeGreaterThanOrEqual(prev);
      expect(here).toBeGreaterThan(focusX);
    }
  });

  it('wheel anchors are sorted top-to-bottom by y', () => {
    for (let i = 1; i < WHEEL_VISIBLE_BARS; i++) {
      expect(WHEEL_BAR_ANCHORS[i]!.y).toBeGreaterThan(WHEEL_BAR_ANCHORS[i - 1]!.y);
    }
  });

  it('preimage panel fits inside the canvas', () => {
    expect(PREIMAGE_X).toBeGreaterThanOrEqual(0);
    expect(PREIMAGE_Y).toBeGreaterThanOrEqual(0);
    expect(PREIMAGE_X + PREIMAGE_SIZE).toBeLessThan(PANEL_W_PX);
    expect(PREIMAGE_Y + PREIMAGE_SIZE).toBeLessThan(PANEL_H_PX);
  });

  it('scrollbar hugs the right edge inside the canvas', () => {
    expect(SCROLLBAR_X).toBeGreaterThan(PANEL_W_PX - 50);
    expect(SCROLLBAR_X).toBeLessThan(PANEL_W_PX);
    expect(SCROLLBAR_Y + SCROLLBAR_H).toBeLessThan(PANEL_H_PX);
  });
});
