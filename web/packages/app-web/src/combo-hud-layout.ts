/**
 * Combo-HUD layout constants — combo digit atlas geometry +
 * danger-overlay tuning. Pure data; mirrors
 * `CActPerfCommonCombo` / `CActPerfCommonDanger`.
 */

/** Drum combo digit cell width in `ScreenPlayDrums combo.png`. */
export const COMBO_DIGIT_W = 120;
/** Drum combo digit cell height. */
export const COMBO_DIGIT_H = 160;
/** Number of digit columns in the atlas (0..4 in row 0, 5..9 in row 1). */
export const COMBO_DIGIT_COLS = 5;
/** Atlas y of the "COMBO" label strip. */
export const COMBO_LABEL_ATLAS_Y = 320;
/** Width of the "COMBO" label strip (full row in source from x=0). */
export const COMBO_LABEL_W = 250;
/** Height of the "COMBO" label strip. */
export const COMBO_LABEL_H = 60;

/** Web-port placement on the 1280×720 canvas (relative to the
 *  judge line — Renderer.judgeLineY). Hard-coded here so tests can
 *  pin them without spinning up a renderer. */
export const COMBO_DIGITS_OFFSET_Y = -200;
export const COMBO_LABEL_OFFSET_Y = -60;
export const COMBO_CENTRE_X = 640;

/** Cap for the rendered digit count. Combos >= 1000 collapse to a
 *  fixed "999+" glyph fallback rather than swap to combo_2.png. */
export const COMBO_DIGIT_CAP = 4;
export const COMBO_NUMERIC_CAP = 999;

/** Atlas X for a single decimal digit (0..9). Throws on invalid
 *  input — caller must clamp. */
export function comboDigitAtlasX(digit: number): number {
  if (digit < 0 || digit > 9 || !Number.isInteger(digit)) {
    throw new RangeError(`combo digit out of range: ${digit}`);
  }
  return (digit % COMBO_DIGIT_COLS) * COMBO_DIGIT_W;
}

/** Atlas Y for a single decimal digit (0..9). */
export function comboDigitAtlasY(digit: number): number {
  if (digit < 0 || digit > 9 || !Number.isInteger(digit)) {
    throw new RangeError(`combo digit out of range: ${digit}`);
  }
  return Math.floor(digit / COMBO_DIGIT_COLS) * COMBO_DIGIT_H;
}

/** Split a non-negative combo count into ones-first digit array.
 *  Caps at COMBO_DIGIT_CAP digits — combos beyond render as the
 *  capped string "999+" via the canvas. Returns an empty array for
 *  combo === 0 (the canvas should skip the paint entirely). */
export function comboDigits(combo: number): number[] {
  if (!Number.isFinite(combo) || combo <= 0) return [];
  const capped = Math.min(Math.floor(combo), COMBO_NUMERIC_CAP);
  const out: number[] = [];
  let n = capped;
  while (n > 0 && out.length < COMBO_DIGIT_CAP) {
    out.push(n % 10);
    n = Math.floor(n / 10);
  }
  return out;
}

/** Whether the combo should render the "999+" overflow tag instead
 *  of the literal digit string. */
export function isComboOverflow(combo: number): boolean {
  return Number.isFinite(combo) && combo > COMBO_NUMERIC_CAP;
}

// --- Danger overlay ----------------------------------------------------

/** Gauge level at or below which the danger overlay activates.
 *  Same threshold the desktop pad-bounce code uses. */
export const DANGER_THRESHOLD = 0.3;

/** Danger pulse rate in Hz — used by `dangerAlpha()` below. */
export const DANGER_PULSE_HZ = 4;

/** Maximum danger overlay alpha (clamped). */
export const DANGER_MAX_ALPHA = 0.7;

/**
 * Compute the danger overlay alpha at `nowMs` for a given gauge
 * value (0..1). Returns 0 when the gauge is above the threshold.
 *
 * Pulled into a pure helper so the canvas layer can be a one-line
 * `ctx.globalAlpha = dangerAlpha(...)`.
 */
export function dangerAlpha(gauge: number, nowMs: number): number {
  if (!Number.isFinite(gauge) || gauge > DANGER_THRESHOLD) return 0;
  const base = (DANGER_THRESHOLD - gauge) / DANGER_THRESHOLD;
  const pulse = 0.5 + 0.5 * Math.sin((2 * Math.PI * DANGER_PULSE_HZ * nowMs) / 1000);
  const raw = base * 0.6 + pulse * 0.2;
  return Math.max(0, Math.min(DANGER_MAX_ALPHA, raw));
}
