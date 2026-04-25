/**
 * Geometric constants for the song-select scene.
 *
 * Numbers come from `song-select-design.md`, which itself was lifted
 * from the C# DTXMania reference at
 * `DTXMania/Code/Stage/05.SongSelection/`. Keep this module pure (no
 * imports beyond `as const`) so any unit test can cheaply pin
 * geometric invariants — non-overlap, in-bounds, etc.
 */

// Logical canvas. Every other constant in this file is in the same grid.
export const PANEL_W_PX = 1280;
export const PANEL_H_PX = 720;

// Three.js plane this canvas is uploaded onto. Width matches the
// previous VR build so the panel reads at roughly the same arc-minutes
// at the standard 1.5 m headset distance; height follows the 16:9
// aspect so the panel doesn't squash.
export const PANEL_WORLD_W = 1.92;
export const PANEL_WORLD_H = (PANEL_WORLD_W * PANEL_H_PX) / PANEL_W_PX;
export const PANEL_POS_Y = 1.45;
export const PANEL_POS_Z = -1.5;

// Preimage panel — left column. The C# code switches between a 368
// "alone" pose and a 292 "with status panel" pose; the web port always
// shows status, so we use the compact pose.
export const PREIMAGE_X = 250;
export const PREIMAGE_Y = 34;
export const PREIMAGE_SIZE = 292;

// Status panel — left-mid. Origin is the panel body top-left.
export const STATUS_X = 130;
export const STATUS_Y = 350;

// 13-bar wheel anchors. Each entry is the (x, y) of the LEFT edge of
// the bar texture on the canvas. Index 5 is the focus row (its bar is
// the active one and the title font is upgraded). Curving x values
// give the scene its DTXMania signature; flattening this into a
// vertical column is a regression.
export interface BarAnchor {
  x: number;
  y: number;
}
export const WHEEL_BAR_ANCHORS: readonly BarAnchor[] = Object.freeze([
  { x: 708, y: 5 },
  { x: 626, y: 56 },
  { x: 578, y: 107 },
  { x: 546, y: 158 },
  { x: 528, y: 209 },
  { x: 464, y: 270 }, // ← focus
  { x: 548, y: 362 },
  { x: 578, y: 413 },
  { x: 624, y: 464 },
  { x: 686, y: 515 },
  { x: 788, y: 566 },
  { x: 996, y: 617 },
  { x: 1280, y: 668 },
]);
export const WHEEL_FOCUS_INDEX = 5;
export const WHEEL_VISIBLE_BARS = WHEEL_BAR_ANCHORS.length;
/** Pixel offset from the bar's left edge to the title baseline. */
export const WHEEL_TITLE_X_OFFSET = 55;

// Comment bar — bottom strip that scrolls the focused song's #COMMENT.
export const COMMENT_BAR_X = 560;
export const COMMENT_BAR_Y = 257;
/** X-offset inside the comment bar where the text rect starts (matches
 *  C# `5_comment bar.png` interior). */
export const COMMENT_TEXT_OFFSET_X = 123;
/** Y-offset inside the comment bar for the text baseline. */
export const COMMENT_TEXT_OFFSET_Y = 82;
/** Horizontal clip width applied to the comment text. Long comments
 *  scroll left across this rect; short ones sit static at the left. */
export const COMMENT_CLIP_W_PX = 750;
/** Vertical clip height — the comment bar is single-line so we just
 *  match the bar texture's interior. */
export const COMMENT_CLIP_H_PX = 30;

// Artist name — right of the focused row.
export const ARTIST_RIGHT_EDGE = 1260;
export const ARTIST_Y = 320;

// Scrollbar — right edge.
export const SCROLLBAR_X = 1244;
export const SCROLLBAR_Y = 120;
export const SCROLLBAR_W = 12;
export const SCROLLBAR_H = 492;

// Web-specific footer (Settings / Calibrate / Exit VR) — DTXMania
// proper has different chrome here, but VR users need a way out and a
// way to reach calibrate without removing the headset, so we keep the
// strip and reposition it for the new canvas size.
export const FOOTER_EXIT_W = 200;
export const FOOTER_EXIT_H = 50;
export const FOOTER_UTIL_BTN_W = 180;
export const FOOTER_UTIL_BTN_H = 36;
export const FOOTER_MARGIN = 16;
export const FOOTER_EXIT_X = PANEL_W_PX - 40 - FOOTER_EXIT_W;
export const FOOTER_EXIT_Y = PANEL_H_PX - FOOTER_MARGIN - FOOTER_EXIT_H;
export const FOOTER_UTIL_BTN_Y =
  FOOTER_EXIT_Y + (FOOTER_EXIT_H - FOOTER_UTIL_BTN_H) / 2;
export const FOOTER_CONFIG_X = 40;
export const FOOTER_CALIB_X = FOOTER_CONFIG_X + FOOTER_UTIL_BTN_W + 16;
// Sort button sits between Calibrate and the right-side Exit VR rect.
// In VR the player has no other surface to change sort modes, so this
// is the canonical home (DTXMania proper exposes sort inside the
// wheel via dedicated controller buttons).
export const FOOTER_SORT_X = FOOTER_CALIB_X + FOOTER_UTIL_BTN_W + 16;
export const FOOTER_HINT_BASELINE_Y = FOOTER_UTIL_BTN_Y - 14;

// Frozen view of the footer geometry, used by song-select-canvas.test.ts
// to pin the "hint text doesn't sit under the button rectangle"
// invariant without standing up a canvas.
export const SONG_SELECT_FOOTER = Object.freeze({
  PANEL_W_PX,
  PANEL_H_PX,
  EXIT_W: FOOTER_EXIT_W,
  EXIT_H: FOOTER_EXIT_H,
  UTIL_BTN_W: FOOTER_UTIL_BTN_W,
  UTIL_BTN_H: FOOTER_UTIL_BTN_H,
  EXIT_Y: FOOTER_EXIT_Y,
  UTIL_BTN_Y: FOOTER_UTIL_BTN_Y,
  hintBaselineY: (): number => FOOTER_HINT_BASELINE_Y,
});
