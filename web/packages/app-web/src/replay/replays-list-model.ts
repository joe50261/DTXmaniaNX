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
  state: ListState,
  summaries: readonly ReplaySummary[],
): ListState {
  let selectedId: string | null;
  if (state.selectedId !== null && summaries.some((r) => r.id === state.selectedId)) {
    selectedId = state.selectedId;
  } else if (summaries.length > 0) {
    const next: ListState = { summaries, sortKey: state.sortKey, selectedId: null };
    selectedId = sortedSummaries(next)[0]?.id ?? null;
  } else {
    selectedId = null;
  }
  return { summaries, sortKey: state.sortKey, selectedId };
}

/** Change the active sort. Selection is preserved when possible
 * (same id still exists), otherwise re-defaults to first sorted row. */
export function setSortKey(state: ListState, key: SortKey): ListState {
  return { summaries: state.summaries, sortKey: key, selectedId: state.selectedId };
}

/** Move the highlight to a specific row, or clear it (id=null). No-op
 * when id isn't in the current summaries list — defensive against
 * stale clicks during a list refresh. */
export function setSelected(state: ListState, id: string | null): ListState {
  if (id === null) {
    return { summaries: state.summaries, sortKey: state.sortKey, selectedId: null };
  }
  if (!state.summaries.some((r) => r.id === id)) {
    return state;
  }
  return { summaries: state.summaries, sortKey: state.sortKey, selectedId: id };
}

/** Apply the current `sortKey` to summaries and return the projected
 * order. Pure read — does not mutate state. Caller re-derives on
 * every render; for ~hundreds of replays this is well under the
 * frame budget. */
export function sortedSummaries(state: ListState): readonly ReplaySummary[] {
  const copy = [...state.summaries];
  switch (state.sortKey) {
    case 'startedAt-desc':
      copy.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
      break;
    case 'startedAt-asc':
      copy.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
      break;
    case 'score-desc':
      copy.sort((a, b) => b.finalScoreNorm - a.finalScoreNorm);
      break;
  }
  return copy;
}

/** Convenience: the currently-selected row's full summary, or null
 * when no selection. View layer uses this to populate the action bar
 * (Render / Delete buttons) with the right id. */
export function selectedSummary(state: ListState): ReplaySummary | null {
  if (state.selectedId === null) return null;
  return state.summaries.find((r) => r.id === state.selectedId) ?? null;
}
