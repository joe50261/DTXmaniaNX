/**
 * Stage-fade layout — tile geometry + timing for the FIFO fade.
 *
 * Pure data, no THREE / DOM. Source of truth: `stage-fade-design.md`
 * (mirroring `CActFIFOBlack` / `CActFIFOWhite`).
 */

/** Tile sprite dimensions (px). */
export const FADE_TILE_W = 64;
export const FADE_TILE_H = 64;

/** Default canvas dimensions used for the tile-grid sizing. The
 *  canvas itself stays 1280×720 — these are exposed so the host can
 *  pass actual dimensions in for non-default layouts. */
export const FADE_CANVAS_W = 1280;
export const FADE_CANVAS_H = 720;

/** Total fade duration in ms — counter 0..100 step 5 ≈ 320 ms. */
export const FADE_DURATION_MS = 320;

/** Discrete fade modes the host can request. */
export type FadeMode =
  | 'fade-in-black'
  | 'fade-out-black'
  | 'fade-in-white'
  | 'fade-out-white';

export const ALL_FADE_MODES: readonly FadeMode[] = [
  'fade-in-black',
  'fade-out-black',
  'fade-in-white',
  'fade-out-white',
];

/** Tile asset filename for a given mode — black vs white. */
export function fadeAsset(mode: FadeMode): string {
  return mode.endsWith('white') ? 'Tile white 64x64.png' : 'Tile black 64x64.png';
}

/** Whether `mode` fades out (alpha grows) versus fading in
 *  (alpha shrinks). Web-port reformulation of the C# branch in
 *  `CActFIFOBlack.OnUpdateAndDraw` line 58. */
export function isFadeOutMode(mode: FadeMode): boolean {
  return mode === 'fade-out-black' || mode === 'fade-out-white';
}

/** Compute the rendered alpha for a fade given its elapsed time
 *  and mode. Clamps `elapsedMs` to [0, FADE_DURATION_MS] so callers
 *  don't have to track completion themselves. */
export function fadeAlpha(elapsedMs: number, mode: FadeMode): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return isFadeOutMode(mode) ? 0 : 1;
  }
  if (elapsedMs >= FADE_DURATION_MS) {
    return isFadeOutMode(mode) ? 1 : 0;
  }
  const progress = elapsedMs / FADE_DURATION_MS;
  return isFadeOutMode(mode) ? progress : 1 - progress;
}

/** Whether the fade has finished its animation. Mirrors the
 *  `counter.nCurrentValue == 100` gate in C#. */
export function isFadeDone(elapsedMs: number): boolean {
  return Number.isFinite(elapsedMs) && elapsedMs >= FADE_DURATION_MS;
}

/** How many tiles the host should paint along each axis. Caller
 *  passes the canvas dimensions; the result rounds up so the
 *  bottom / right edge is fully covered (one extra tile of overhang). */
export function tileGridSize(canvasW: number, canvasH: number): { cols: number; rows: number } {
  return {
    cols: Math.ceil(canvasW / FADE_TILE_W),
    rows: Math.ceil(canvasH / FADE_TILE_H),
  };
}
