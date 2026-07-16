/**
 * Pure formatting helpers for the in-play HUD header. Shared by the
 * live game (`game.ts`) and the offline replay renderer
 * (`replay/render.ts`) so the two paint identical meta lines.
 */

/**
 * Chart BPM for display: at most 3 decimals, trailing zeros dropped.
 * The parser stores `#BPM` as raw `parseFloat`, so a chart authored as
 * 133⅓ would otherwise stringify to `133.33333333333331` — 17 glyphs
 * that eat the narrow HUD header column and ellipsize the note count
 * away.
 */
export function formatBpm(bpm: number): string {
  return String(Math.round(bpm * 1000) / 1000);
}

/** The `BPM x / Notes y` line under the chart title. */
export function buildMetaLine(bpm: number, noteCount: number): string {
  return `BPM ${formatBpm(bpm)} / Notes ${noteCount}`;
}
