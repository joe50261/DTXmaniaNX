/**
 * State + transitions for the desktop Replays browser screen.
 *
 * The browser screen is a list of saved replay summaries, sorted /
 * filtered, with one row selected for the per-row Render / Delete
 * actions. The view layer (`replays-canvas.ts`, future) is a thin
 * subscriber: pure transitions live here so the navigation logic
 * is unit-testable without canvas / DOM.
 *
 * Conventions match `song-wheel-model.ts` (immutable state objects,
 * pure transition functions returning the new state). No singleton —
 * the canvas owns one `ListState` instance per mount.
 */

import type { ReplaySummary } from './storage.js';

/** Default sort = recent first. Mirrors the user's "一般就最新的"
 * intent: when the browser opens, the most recent replay is
 * highlighted ready to render. */
export type SortKey = 'startedAt-desc' | 'startedAt-asc' | 'score-desc';
export const DEFAULT_SORT: SortKey = 'startedAt-desc';

export interface ListState {
  /** Raw row data, in the order `storage.listReplaySummaries` returned
   * (caller-defined; usually IDB cursor order, which is by random
   * UUID key). Sort is applied on read via `sortedSummaries`. */
  summaries: readonly ReplaySummary[];
  sortKey: SortKey;
  /** Currently-highlighted row's id, or null when summaries are empty
   * or no selection has settled yet. */
  selectedId: string | null;
}

export function initialState(): ListState {
  return { summaries: [], sortKey: DEFAULT_SORT, selectedId: null };
}

/** Replace the summaries (e.g. after an IDB read or a delete). The
 * selection re-resolves:
 *  - If the previous selectedId is still in the list, keep it (the
 *    user's focus shouldn't jump on a refresh).
 *  - Otherwise, default to the first row of the sorted output, or
 *    null when empty. */
export function setSummaries(
  _state: ListState,
  _summaries: readonly ReplaySummary[],
): ListState {
  throw new Error('setSummaries: not implemented');
}

/** Change the active sort. Selection is preserved when possible
 * (same id still exists), otherwise re-defaults to first sorted row. */
export function setSortKey(_state: ListState, _key: SortKey): ListState {
  throw new Error('setSortKey: not implemented');
}

/** Move the highlight to a specific row, or clear it (id=null). No-op
 * when id isn't in the current summaries list — defensive against
 * stale clicks during a list refresh. */
export function setSelected(_state: ListState, _id: string | null): ListState {
  throw new Error('setSelected: not implemented');
}

/** Apply the current `sortKey` to summaries and return the projected
 * order. Pure read — does not mutate state. Caller re-derives on
 * every render; for ~hundreds of replays this is well under the
 * frame budget. */
export function sortedSummaries(_state: ListState): readonly ReplaySummary[] {
  throw new Error('sortedSummaries: not implemented');
}

/** Convenience: the currently-selected row's full summary, or null
 * when no selection. View layer uses this to populate the action bar
 * (Render / Delete buttons) with the right id. */
export function selectedSummary(_state: ListState): ReplaySummary | null {
  throw new Error('selectedSummary: not implemented');
}
