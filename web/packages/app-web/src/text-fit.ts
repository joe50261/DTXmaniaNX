/**
 * Pure text-fitting helper for canvas painting. Extracted from
 * renderer.ts so the ellipsis rule can be unit-tested with a fake
 * measurer instead of a real Canvas2D context.
 */

const ELLIPSIS = '…';

/**
 * Fits `text` into `maxWidth` by trimming the tail and appending an
 * ellipsis. `measure` is the pixel-width oracle — pass
 * `(s) => ctx.measureText(s).width` with the target font already set
 * on the context.
 *
 * Guarantee: `measure(returned) <= maxWidth`, always. If even the
 * bare ellipsis overflows, returns '' (draw nothing rather than
 * spill into a neighbouring HUD region).
 *
 * Trims on code points (`Array.from`), not UTF-16 units, so an emoji
 * or astral-plane kanji at the cut point is dropped whole instead of
 * leaving a lone surrogate that renders as a replacement box.
 */
export function fitTextEnd(
  text: string,
  maxWidth: number,
  measure: (s: string) => number
): string {
  if (measure(text) <= maxWidth) return text;
  if (measure(ELLIPSIS) > maxWidth) return '';
  const chars = Array.from(text);
  // Binary search the longest prefix whose width (with ellipsis) fits.
  let lo = 0;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(chars.slice(0, mid).join('') + ELLIPSIS) <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return chars.slice(0, lo).join('') + ELLIPSIS;
}
