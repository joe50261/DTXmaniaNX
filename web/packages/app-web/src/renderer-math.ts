/**
 * Pure numeric helpers for renderer.ts animations. Extracted so the
 * easing curves and fade-in / fade-out ratios can be unit-tested
 * without a Canvas2D / Three.js scene.
 *
 * Every function here is pure: output depends only on arguments, no
 * side effects, no clock reads. Callers supply `age` (ms since the
 * event) and `life` / `duration` (ms total).
 */

/**
 * Pad bounce on hit: the pad dips down fast, then springs back up
 * over `bounceDurMs`. Returns a negative-or-zero offset from the
 * pad's base Y; 0 at t=0 and t=1, minimum at t=0.35 (the "down"
 * phase ending). Output is clamped to `[-amount, 0]` so a caller
 * that stretches `age` past `bounceDurMs` still yields 0 (rest
 * position), never a stray positive bounce that would punch the
 * pad up through its render layer.
 *
 * The 35/65 split matches the eye's expectation of a real drum head:
 * the downstroke is noticeably faster than the recovery. Pick a new
 * split and the bounce reads as "sluggish" (higher first fraction)
 * or "twitchy" (lower).
 */
export function padBounceOffset(age: number, bounceDurMs: number, amount: number): number {
  const t = Math.max(0, Math.min(1, age / bounceDurMs));
  const raw = t < 0.35
    ? -amount * (t / 0.35)
    : -amount * (1 - (t - 0.35) / 0.65);
  // `+ 0` normalises `-0` → `+0` at the endpoints so callers and tests
  // see a clean zero. No numeric effect anywhere else.
  return Math.max(-amount, Math.min(0, raw)) + 0;
}

/**
 * Linear fade-out over `lifeMs`: returns 1 at age=0, 0 at age>=life,
 * clamped so age<0 returns 1 and age>life returns 0. Callers scale
 * the result by their own max-opacity (0.9 for pad flush, 0.8 for
 * hit flash, 0.55 for pedal flash, 1.0 for judgment flash).
 */
export function linearFadeOut(age: number, lifeMs: number): number {
  if (lifeMs <= 0) return 0;
  const t = age / lifeMs;
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  return 1 - t;
}

/**
 * Linear fade-in / progress over `lifeMs`: returns 0 at age=0, 1 at
 * age>=life. Used for the result-screen overlay fade-in, the song
 * progress bar, and the judgment flash float-up position (scaled
 * by a pixel amount at the call site).
 */
export function linearFadeIn(age: number, lifeMs: number): number {
  if (lifeMs <= 0) return age > 0 ? 1 : 0;
  const t = age / lifeMs;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}
