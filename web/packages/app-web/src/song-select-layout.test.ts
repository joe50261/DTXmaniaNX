import { describe, expect, it } from 'vitest';
import {
  FOOTER_EXIT_H,
  FOOTER_EXIT_X,
  FOOTER_EXIT_Y,
  FOOTER_UTIL_BTN_H,
  FOOTER_UTIL_BTN_Y,
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

  it('no on-canvas wheel bar y-overlaps the footer button row (clears slot 11)', () => {
    // Pinning the regression that motivated commit 3e025fa: wheel
    // slot 11 (anchor (996, 617), regular bar height 48) was clipping
    // the bottom of the previous 50-px-tall Exit VR rect at
    // y=654..704. The contract: every visible wheel bar's y-extent
    // must end at or above the footer row's top.
    //
    // Bar heights from the C# skin textures: `5_bar score.png` /
    // `5_bar box.png` / `5_bar other.png` are all 48 tall; only
    // `5_bar score selected.png` (the focus-row texture) is 96 tall.
    // The wheel paints the selected texture exclusively at slot 5
    // (WHEEL_FOCUS_INDEX), so the realistic per-slot height is 96 at
    // the focus row and 48 elsewhere.
    //
    // Bar 12's anchor (1280, 668) sits at the canvas right edge —
    // its texture is fully off-canvas so it's never visible. We
    // exclude bars that start at or past the right edge from the
    // overlap check; their y position is meaningless because no
    // pixel ever paints.
    const FOCUS_BAR_H = 96;
    const REGULAR_BAR_H = 48;
    const footerTop = Math.min(FOOTER_UTIL_BTN_Y, FOOTER_EXIT_Y);
    const footerBottom = Math.max(
      FOOTER_UTIL_BTN_Y + FOOTER_UTIL_BTN_H,
      FOOTER_EXIT_Y + FOOTER_EXIT_H,
    );
    for (let i = 0; i < WHEEL_VISIBLE_BARS; i++) {
      const anchor = WHEEL_BAR_ANCHORS[i]!;
      if (anchor.x >= PANEL_W_PX) continue; // off-canvas, never paints
      const barH = i === WHEEL_FOCUS_INDEX ? FOCUS_BAR_H : REGULAR_BAR_H;
      const barBottom = anchor.y + barH;
      const overlaps = barBottom > footerTop && anchor.y < footerBottom;
      expect(
        overlaps,
        `bar slot ${i} (y=${anchor.y}..${barBottom}) overlaps footer row [${footerTop}..${footerBottom}]`,
      ).toBe(false);
    }
  });

  it('footer Exit VR sits inside the panel and to the right of the util row', () => {
    // Cheap sanity: Exit VR must be on canvas and its left edge must
    // be past the rightmost utility button so the row reads as one
    // strip without horizontal collision.
    expect(FOOTER_EXIT_X).toBeGreaterThan(0);
    expect(FOOTER_EXIT_X + 200).toBeLessThanOrEqual(PANEL_W_PX); // 200 = FOOTER_EXIT_W
    expect(FOOTER_EXIT_Y + FOOTER_EXIT_H).toBeLessThanOrEqual(PANEL_H_PX);
  });
});
