/**
 * Pure animation helpers for the song-select scene.
 *
 * Frame-counter style timings ported from the C# DTXMania reference
 * (`DTXMania/Code/Stage/05.SongSelection/`):
 *
 * - Wheel scroll: focus change kicks off a short cubic-out tween that
 *   slides each visible bar from its previous slot anchor to its new
 *   one. ~200 ms feels right for a thumbstick edge-trigger.
 * - Preimage fade-in: 100-frame counter, opacity ramps from 0.9 to 1.0
 *   (the C# code never drops below 0.9 once the panel has started).
 * - Comment scroll: 10 px/frame (~600 px/s) infinite loop with a fixed
 *   gap between repeats so the eye gets a momentary clear edge before
 *   the text re-enters.
 *
 * Everything in this module is pure (no DOM, no Three, no Canvas).
 * Unit tests pin the math.
 */

/** Cubic ease-out — fast at the start, decelerates to t=1.
 *  Matches the "snappy bar settle" feel of the C# wheel. */
export function easeOutCubic(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

/** Linear interpolation. Out-of-range t isn't clamped — callers feed
 *  eased t which already is. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ---------- Wheel scroll easing ----------

/** Duration of a single-step wheel scroll, in milliseconds. */
export const WHEEL_SCROLL_MS = 200;

export interface WheelScrollState {
  /** 0 = no animation in progress; otherwise milliseconds remaining. */
  remainingMs: number;
  /** Sign of the scroll direction: +1 = focus moved DOWN (entries shift
   *  upward visually), −1 = up. 0 when idle. */
  dir: 1 | -1 | 0;
}

export function newWheelScrollState(): WheelScrollState {
  return { remainingMs: 0, dir: 0 };
}

/** Called when focusIdx changes by ±1 (single-step). Multi-step jumps
 *  (entering a box, snapping back) should pass dir=0 to skip animation. */
export function startWheelScroll(state: WheelScrollState, dir: 1 | -1 | 0): WheelScrollState {
  if (dir === 0) return { remainingMs: 0, dir: 0 };
  return { remainingMs: WHEEL_SCROLL_MS, dir };
}

/** Advance a wheel-scroll state by `dtMs`. Returns the updated state. */
export function tickWheelScroll(state: WheelScrollState, dtMs: number): WheelScrollState {
  if (state.remainingMs <= 0) return state.dir === 0 ? state : { remainingMs: 0, dir: 0 };
  const next = state.remainingMs - dtMs;
  if (next <= 0) return { remainingMs: 0, dir: 0 };
  return { remainingMs: next, dir: state.dir };
}

/** 0 = animation just started (bars at the *previous* anchors),
 *  1 = animation finished (bars at their canonical anchors). */
export function wheelScrollProgress(state: WheelScrollState): number {
  if (state.dir === 0 || state.remainingMs <= 0) return 1;
  const t = 1 - state.remainingMs / WHEEL_SCROLL_MS;
  return easeOutCubic(t);
}

// ---------- Preimage fade-in ----------

/** Total fade duration in milliseconds. C# uses a 100-frame counter at
 *  ~60 Hz. */
export const PREIMAGE_FADE_MS = 1666;
/** Opacity floor — the panel never drops below this once started, so
 *  the new cover pops without flashing fully transparent. */
export const PREIMAGE_FADE_MIN_ALPHA = 0.9;

export interface PreimageFadeState {
  /** Milliseconds elapsed since the last focus change. */
  elapsedMs: number;
}

export function newPreimageFadeState(): PreimageFadeState {
  return { elapsedMs: 0 };
}

export function restartPreimageFade(): PreimageFadeState {
  return { elapsedMs: 0 };
}

export function tickPreimageFade(
  state: PreimageFadeState,
  dtMs: number,
): PreimageFadeState {
  const next = state.elapsedMs + dtMs;
  return { elapsedMs: next > PREIMAGE_FADE_MS ? PREIMAGE_FADE_MS : next };
}

/** 0.9 at t=0, 1.0 at t≥PREIMAGE_FADE_MS. Matches C#'s
 *  `0.9 + 0.1 × (counter / 100)`. */
export function preimageOpacity(state: PreimageFadeState): number {
  const t = state.elapsedMs / PREIMAGE_FADE_MS;
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return PREIMAGE_FADE_MIN_ALPHA + (1 - PREIMAGE_FADE_MIN_ALPHA) * clamped;
}

// ---------- Comment scroll ----------

/** 10 px/frame at 60 Hz = 600 px/s. */
export const COMMENT_SCROLL_PX_PER_SEC = 600;
/** Gap between the end of the comment text and the start of its repeat,
 *  in pixels. Picks a value wide enough that the eye registers a
 *  separator on long looping text but doesn't leave the strip blank. */
export const COMMENT_SCROLL_GAP_PX = 80;

export interface CommentScrollState {
  /** Pixels of x-offset already scrolled. Always 0 when the text fits. */
  offsetPx: number;
}

export function newCommentScrollState(): CommentScrollState {
  return { offsetPx: 0 };
}

export function restartCommentScroll(): CommentScrollState {
  return { offsetPx: 0 };
}

/** Advance the comment-scroll offset by `dtMs`. If `textWidthPx` fits
 *  inside `clipWidthPx`, the offset is held at 0 (no scroll). Otherwise
 *  the offset wraps once it exceeds `textWidthPx + COMMENT_SCROLL_GAP_PX`
 *  so the same text re-enters from the right. */
export function tickCommentScroll(
  state: CommentScrollState,
  dtMs: number,
  textWidthPx: number,
  clipWidthPx: number,
): CommentScrollState {
  if (textWidthPx <= clipWidthPx) return state.offsetPx === 0 ? state : { offsetPx: 0 };
  const period = textWidthPx + COMMENT_SCROLL_GAP_PX;
  const advance = (COMMENT_SCROLL_PX_PER_SEC * dtMs) / 1000;
  let next = state.offsetPx + advance;
  // Keep the modulo cheap — a single wrap is enough because dtMs is
  // small per frame.
  if (next >= period) next -= period;
  if (next < 0) next += period; // defensive against negative dtMs in tests
  return { offsetPx: next };
}
