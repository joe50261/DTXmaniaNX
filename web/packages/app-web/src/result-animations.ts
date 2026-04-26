/**
 * Result-screen animations — pure helpers, framework-free.
 *
 * Mirrors `CActResultRank.OnUpdateAndDraw` lines 173-188 (the
 * `ctランク表示` counter sequence) and exposes a small clip-rect /
 * opacity calculator the canvas layer feeds to its draw calls. No
 * THREE / DOM imports here so vitest can pin the math cheaply.
 */

/** Counter end-value (ms-equivalent ticks at 1 ms granularity in C#).
 *  Mirrors `new CCounter(0, 500, 1, ...)`. */
export const RANK_REVEAL_DURATION_MS = 500;

/** Counter value at which the slot-machine reveal starts. Before
 *  this, the rank glyph is not drawn at all. */
export const RANK_REVEAL_HOLD_MS = 200;

/** Length of the reveal-in window. */
export const RANK_REVEAL_GROWTH_MS =
  RANK_REVEAL_DURATION_MS - RANK_REVEAL_HOLD_MS;

export interface RankRevealState {
  /** True when nothing should be drawn yet (still in the hold phase). */
  hidden: boolean;
  /** 0..1 progress through the growth window once revealed.
   *  `hidden` is true ⇒ progress is irrelevant (returned 0). */
  progress: number;
}

/**
 * Resolve the rank glyph's reveal progress at `elapsedMs` from the
 * point the result scene started painting.
 *
 * Returns:
 *   - hidden=true, progress=0  while elapsedMs < RANK_REVEAL_HOLD_MS
 *   - hidden=false, progress = (elapsedMs - hold) / growth, clamped
 *     to 1 once elapsedMs ≥ RANK_REVEAL_DURATION_MS
 */
export function rankReveal(elapsedMs: number): RankRevealState {
  if (!Number.isFinite(elapsedMs) || elapsedMs < RANK_REVEAL_HOLD_MS) {
    return { hidden: true, progress: 0 };
  }
  const raw = (elapsedMs - RANK_REVEAL_HOLD_MS) / RANK_REVEAL_GROWTH_MS;
  const clamped = raw > 1 ? 1 : raw < 0 ? 0 : raw;
  return { hidden: false, progress: clamped };
}

/**
 * Resolved draw rect for the rank glyph given a sprite height. The
 * y-offset grows the image down from the top: at progress=0 the
 * sprite is fully shifted up (clipped to a 0-px slice); at
 * progress=1 it sits flush at `baseY` showing its full height.
 *
 * Mirrors C# line 188's
 *   draw(x, y + h*(1-p), srcRect(0, 0, w, h*p))
 */
export interface RankClip {
  /** y to draw the sprite at. */
  drawY: number;
  /** clip rect height (slice from top of the source). */
  clipH: number;
}

export function rankClip(
  baseY: number,
  spriteHeight: number,
  progress: number
): RankClip {
  const p = progress < 0 ? 0 : progress > 1 ? 1 : progress;
  return {
    drawY: baseY + spriteHeight * (1 - p),
    clipH: spriteHeight * p,
  };
}

/**
 * Whether the result scene's animation has finished — the
 * dismiss-hint can become active and `result-dismissed` events are
 * accepted. Matches `CActResultRank.OnUpdateAndDraw` returning 1
 * once the counter reaches its end.
 */
export function rankAnimationDone(elapsedMs: number): boolean {
  return Number.isFinite(elapsedMs) && elapsedMs >= RANK_REVEAL_DURATION_MS;
}
