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

// Difficulty grid (DR/GT/BS × DTX/MASTER/EXTREME/ADVANCED/BASIC).
// `5_difficulty panel.png` is 561×321 with the column / row labels
// baked in. Cells are 187×60 each, matching C# `nPanelW=187, nPanelH=60`
// from `CActSelectStatusPanel` lines 505-506. Y-baseline of difficulty
// `i` (0..4) = `STATUS_Y + 41 + (4 − i) × 60 − 2`; row 4 (DTX/Master)
// sits at the top, row 0 (Basic) at the bottom. The HEADER_H strip
// above row 4 is the column-header band inside the panel texture.
export const DIFF_GRID_X = STATUS_X + 5;
export const DIFF_GRID_Y_OFFSET = 41; // row 4 cell top relative to STATUS_Y
export const DIFF_HEADER_H = 21;
export const DIFF_ROW_H = 60;
export const DIFF_PART_W = 187; // per-instrument column width
export const DIFF_GRID_TOP = STATUS_Y + DIFF_GRID_Y_OFFSET - DIFF_HEADER_H;
/** Y-baseline of difficulty row `i` (0 = Basic at bottom, 4 = DTX at top). */
export function diffRowY(i: number): number {
  return STATUS_Y + DIFF_GRID_Y_OFFSET + (4 - i) * DIFF_ROW_H - 2;
}

// Skill-point panel chrome (`5_skill point panel.png`, 187×62).
// Position from C# `CActSelectStatusPanel` line 408.
export const SKILL_POINT_PANEL_X = 32;
export const SKILL_POINT_PANEL_Y = 180;

// Drum graph panel chrome (`5_graph panel drums.png`, 110×321).
// Position from C# `CActSelectStatusPanel` lines 422-436 — drums-only mode.
export const GRAPH_PANEL_X = 15;
export const GRAPH_PANEL_Y = 368;

// BPM block. Label texture (`5_BPM.png`) at the first pair, numeric
// digits (`5_bpm font.png`) at the second. Positions from C#
// `CActSelectStatusPanel` lines 290-401: `nBPM位置X/Y` are (90, 275)
// when the status panel body texture is loaded; the digits draw at
// `(nBPM位置X + 45, nBPM位置Y + 23)` = (135, 298).
export const BPM_LABEL_X = 90;
export const BPM_LABEL_Y = 275;
export const BPM_DIGITS_X = BPM_LABEL_X + 45;
export const BPM_DIGITS_Y = BPM_LABEL_Y + 23;

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

// Web-specific footer (Settings / Calibrate / Sort / Exit VR) —
// DTXMania proper has different chrome here, but VR users need a
// way out and a way to reach calibrate / sort without removing the
// headset, so we keep the strip and reposition it for the new
// canvas size. Heights are tight so the button row sits IN the
// `5_footer panel.png` strip (y=690..720) without clipping wheel
// slot 11 above (anchor (996, 617), bar height 48 → ends y=665).
export const FOOTER_EXIT_W = 200;
export const FOOTER_EXIT_H = 30;
export const FOOTER_UTIL_BTN_W = 160;
export const FOOTER_UTIL_BTN_H = 30;
export const FOOTER_MARGIN = 8;
export const FOOTER_EXIT_X = PANEL_W_PX - 40 - FOOTER_EXIT_W;
export const FOOTER_EXIT_Y = PANEL_H_PX - FOOTER_MARGIN - FOOTER_EXIT_H;
export const FOOTER_UTIL_BTN_Y =
  FOOTER_EXIT_Y + (FOOTER_EXIT_H - FOOTER_UTIL_BTN_H) / 2;
export const FOOTER_CONFIG_X = 40;
export const FOOTER_CALIB_X = FOOTER_CONFIG_X + FOOTER_UTIL_BTN_W + 12;
// Sort button sits between Calibrate and the right-side Exit VR rect.
// In VR the player has no other surface to change sort modes, so this
// is the canonical home (DTXMania proper exposes sort inside the
// wheel via dedicated controller buttons).
export const FOOTER_SORT_X = FOOTER_CALIB_X + FOOTER_UTIL_BTN_W + 12;
export const FOOTER_HINT_BASELINE_Y = FOOTER_UTIL_BTN_Y - 6;

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
