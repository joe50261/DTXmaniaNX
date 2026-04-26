/**
 * Result-screen geometry constants. Pure data — no THREE, no DOM.
 * Source of truth: `result-design.md` (mirroring
 * `DTXMania/Code/Stage/08.Result/`).
 *
 * All coordinates are on the canonical 1280 × 720 logical canvas.
 * `result-canvas.ts` consumes these so test fixtures can pin the
 * layout without spinning up a renderer.
 */

export const RESULT_CANVAS_W = 1280;
export const RESULT_CANVAS_H = 720;

/** Drum-only rank glyph anchor (top-left). */
export const RANK_X = 480;
export const RANK_Y = 0;

/** Banner offset relative to the rank anchor.
 *  C#: `num14 = -165 + n本体X[j]`, `num15 = 100 + n本体Y[j]`. */
export const BANNER_OFFSET_X = -165;
export const BANNER_OFFSET_Y = 100;

/** Resolved banner position for the drum tower. */
export const BANNER_X = RANK_X + BANNER_OFFSET_X; // 315
export const BANNER_Y = RANK_Y + BANNER_OFFSET_Y; // 100

/** Sprite-sheet glyph cell geometry in `8_numbers_large.png`. The
 *  asset is a 142×112 atlas; the *normal* mode (used everywhere on
 *  the result screen) reads 18×24 cells laid out in a 5-col × 2-row
 *  grid. The bottom half (y ≥ 48) holds extra-large 24×32 cells the
 *  C# game uses for the SCORE display only — the web port renders
 *  every metric at the normal size for consistency. Pinned by
 *  `CActResultParameterPanel.cs` lines 116-165 (`st特大文字位置` table)
 *  + line 868 (`new Rectangle(..., bExtraLarge ? 24 : 18, ... ? 32 : 24)`). */
export const LARGE_DIGIT_W = 18;
export const LARGE_DIGIT_H = 24;

/** 5 cols × 2 rows in `8_numbers_large.png`'s normal-mode region. */
export const LARGE_DIGIT_COLS = 5;

/** Number of glyphs the atlas covers (0..9 + '.' + '%'). */
export const LARGE_DIGIT_COUNT = 12;

/** Atlas x base for the normal-mode region. The C# table reads
 *  from y = 0 / y = 24 for digit row 0/1 (5 each), with '.' at
 *  (90, 24) and '%' at (90, 0). */
export const LARGE_DIGIT_ATLAS_Y = 0;

/** New-record badge position, mirrored from `ptFullCombo位置[0]`. */
export const NEW_RECORD_X = 220;
export const NEW_RECORD_Y = 160;

// --- Web-port layout: centred metrics column ---

/** Score row baseline. */
export const SCORE_Y = 470;
/** Achievement-rate row baseline. */
export const RATE_Y = 510;
/** Max-combo row baseline. */
export const MAXCOMBO_Y = 550;

/** Right edge of the score / rate / maxcombo numerals (right-aligned). */
export const METRICS_RIGHT_X = 1000;

/** Judgement counts column — labels on left at JUDGE_LABEL_X,
 *  numbers right-aligned at JUDGE_NUMBER_RIGHT_X. */
export const JUDGE_LABEL_X = 280;
export const JUDGE_NUMBER_RIGHT_X = 520;
export const JUDGE_TOP_Y = 470;
export const JUDGE_ROW_STEP = 40;
export const JUDGE_ROW_COUNT = 5;

/** Footer hint text baseline. */
export const FOOTER_HINT_Y = 700;
export const FOOTER_HINT_X = RESULT_CANVAS_W / 2;

/** Glyph atlas (x, y) tuple for a renderable character. Returns
 *  null for unknown chars so callers can fall back to a text
 *  paint. Pinned by the `CActResultParameterPanel` `st特大文字位置`
 *  table (lines 116-165):
 *    '0'..'4' → row 0 at x = digit×18, y = 0
 *    '5'..'9' → row 1 at x = (digit-5)×18, y = 24
 *    '.'      → (90, 24)
 *    '%'      → (90, 0)
 */
export function digitAtlas(ch: string): { sx: number; sy: number } | null {
  if (ch.length !== 1) return null;
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) {
    const d = code - 48;
    return { sx: (d % LARGE_DIGIT_COLS) * LARGE_DIGIT_W, sy: Math.floor(d / LARGE_DIGIT_COLS) * LARGE_DIGIT_H };
  }
  if (ch === '.') return { sx: 90, sy: LARGE_DIGIT_H };
  if (ch === '%') return { sx: 90, sy: 0 };
  return null;
}

/** Back-compat shim — kept so existing tests that pin `digitAtlasX`
 *  still link. New code should use `digitAtlas` for the full (sx, sy). */
export function digitAtlasX(ch: string): number | null {
  const a = digitAtlas(ch);
  return a === null ? null : a.sx;
}

/** Resolve a per-judgement row baseline. `idx` 0..4 maps to
 *  PERFECT..MISS top-down. */
export function judgeRowY(idx: number): number {
  if (idx < 0 || idx >= JUDGE_ROW_COUNT) {
    throw new RangeError(`judge row idx out of range: ${idx}`);
  }
  return JUDGE_TOP_Y + idx * JUDGE_ROW_STEP;
}
