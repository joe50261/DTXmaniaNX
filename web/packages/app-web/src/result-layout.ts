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

/** Sprite-sheet column step in `8_numbers_large.png` (28 px per
 *  glyph, table at `CActResultParameterPanel` 24-66). */
export const LARGE_DIGIT_W = 28;
export const LARGE_DIGIT_H = 24;

/** Number of glyphs in the strip (0..9 + ':'). */
export const LARGE_DIGIT_COUNT = 11;

/** Atlas y of the digit row in `8_numbers_large.png`. The C# table
 *  pins every glyph at y=0 — there's only one row in this sprite. */
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

/** Glyph atlas X for a numeric character. Returns null for
 *  non-digit, non-':' characters so callers fall back to a text
 *  paint. Pinned by the C# table at lines 24-66. */
export function digitAtlasX(ch: string): number | null {
  if (ch.length !== 1) return null;
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) return (code - 48) * LARGE_DIGIT_W;
  if (ch === ':') return 10 * LARGE_DIGIT_W;
  return null;
}

/** Resolve a per-judgement row baseline. `idx` 0..4 maps to
 *  PERFECT..MISS top-down. */
export function judgeRowY(idx: number): number {
  if (idx < 0 || idx >= JUDGE_ROW_COUNT) {
    throw new RangeError(`judge row idx out of range: ${idx}`);
  }
  return JUDGE_TOP_Y + idx * JUDGE_ROW_STEP;
}
