import { describe, expect, it } from 'vitest';
import type { ReplaySummary } from './storage.js';
import {
  DEFAULT_SORT,
  initialState,
  selectedSummary,
  setSelected,
  setSortKey,
  setSummaries,
  sortedSummaries,
} from './replays-list-model.js';

function s(over: Partial<ReplaySummary>): ReplaySummary {
  return {
    id: 'id',
    chartPath: 'song.dtx',
    title: 'Test',
    artist: 'Test',
    durationMs: 60_000,
    startedAt: '2025-01-01T00:00:00.000Z',
    finalScoreNorm: 0.5,
    comboMax: 10,
    fullCombo: false,
    ...over,
  };
}

describe('initialState', () => {
  it('starts empty, sortKey=startedAt-desc, selectedId=null', () => {
    const st = initialState();
    expect(st.summaries).toEqual([]);
    expect(st.sortKey).toBe(DEFAULT_SORT);
    expect(st.sortKey).toBe('startedAt-desc');
    expect(st.selectedId).toBeNull();
  });
});

describe('setSummaries', () => {
  it('replaces the summaries array', () => {
    const a = s({ id: 'a' });
    const b = s({ id: 'b' });
    const st = setSummaries(initialState(), [a, b]);
    expect(st.summaries).toHaveLength(2);
  });

  it('auto-selects the first sorted row on initial load (default = latest)', () => {
    const old = s({ id: 'old', startedAt: '2025-01-01T00:00:00.000Z' });
    const recent = s({ id: 'recent', startedAt: '2025-06-01T00:00:00.000Z' });
    const st = setSummaries(initialState(), [old, recent]);
    expect(st.selectedId).toBe('recent');
  });

  it('preserves selectedId when that row is still in the new list', () => {
    const before = setSummaries(initialState(), [s({ id: 'a' }), s({ id: 'b' })]);
    const focused = setSelected(before, 'b');
    const after = setSummaries(focused, [s({ id: 'a' }), s({ id: 'b' }), s({ id: 'c' })]);
    expect(after.selectedId).toBe('b');
  });

  it('falls back to first sorted row when selectedId disappears (e.g., after delete)', () => {
    const before = setSummaries(initialState(), [
      s({ id: 'a', startedAt: '2025-01-01T00:00:00.000Z' }),
      s({ id: 'b', startedAt: '2025-06-01T00:00:00.000Z' }),
    ]);
    const focused = setSelected(before, 'a');
    const afterDelete = setSummaries(focused, [s({ id: 'b', startedAt: '2025-06-01T00:00:00.000Z' })]);
    expect(afterDelete.selectedId).toBe('b');
  });

  it('clears selection when the new list is empty', () => {
    const before = setSummaries(initialState(), [s({ id: 'a' })]);
    const after = setSummaries(before, []);
    expect(after.selectedId).toBeNull();
  });
});

describe('setSortKey', () => {
  it('changes the active sort', () => {
    const st = setSortKey(initialState(), 'score-desc');
    expect(st.sortKey).toBe('score-desc');
  });

  it('preserves selection across a sort change (no highlight jumping)', () => {
    const a = s({ id: 'a', startedAt: '2025-01-01T00:00:00.000Z', finalScoreNorm: 0.9 });
    const b = s({ id: 'b', startedAt: '2025-06-01T00:00:00.000Z', finalScoreNorm: 0.1 });
    const start = setSummaries(initialState(), [a, b]);
    // Default sort = startedAt-desc → b is selected.
    expect(start.selectedId).toBe('b');
    // Switch to score-desc: a is now on top, but the highlight stays
    // on b — sort changes are display-only, they don't move selection.
    const flipped = setSortKey(start, 'score-desc');
    expect(flipped.selectedId).toBe('b');
  });
});

describe('setSelected', () => {
  it('moves the highlight to a present id', () => {
    const st = setSummaries(initialState(), [s({ id: 'a' }), s({ id: 'b' })]);
    expect(setSelected(st, 'a').selectedId).toBe('a');
  });

  it('null clears the selection', () => {
    const st = setSummaries(initialState(), [s({ id: 'a' })]);
    expect(setSelected(st, null).selectedId).toBeNull();
  });

  it('is a no-op when id is not in the current summaries (stale click guard)', () => {
    const st = setSummaries(initialState(), [s({ id: 'a' })]);
    const out = setSelected(st, 'gone');
    expect(out.selectedId).toBe('a'); // unchanged
  });
});

describe('sortedSummaries', () => {
  const oldA = s({ id: 'a', startedAt: '2025-01-01T00:00:00.000Z', finalScoreNorm: 0.9 });
  const midB = s({ id: 'b', startedAt: '2025-03-01T00:00:00.000Z', finalScoreNorm: 0.5 });
  const newC = s({ id: 'c', startedAt: '2025-06-01T00:00:00.000Z', finalScoreNorm: 0.1 });

  it('startedAt-desc: most recent first', () => {
    const st = setSortKey(setSummaries(initialState(), [oldA, midB, newC]), 'startedAt-desc');
    expect(sortedSummaries(st).map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('startedAt-asc: oldest first', () => {
    const st = setSortKey(setSummaries(initialState(), [oldA, midB, newC]), 'startedAt-asc');
    expect(sortedSummaries(st).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('score-desc: highest score first', () => {
    const st = setSortKey(setSummaries(initialState(), [oldA, midB, newC]), 'score-desc');
    expect(sortedSummaries(st).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the underlying summaries array', () => {
    const arr = [oldA, midB, newC];
    const st = setSortKey(setSummaries(initialState(), arr), 'score-desc');
    sortedSummaries(st);
    // Original passed array stays in input order — the model copies internally.
    expect(arr.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns [] for empty summaries', () => {
    expect(sortedSummaries(initialState())).toEqual([]);
  });
});

describe('selectedSummary', () => {
  it('returns the row matching selectedId', () => {
    const st = setSummaries(initialState(), [s({ id: 'a', title: 'A' }), s({ id: 'b', title: 'B' })]);
    expect(selectedSummary(st)?.id).toBe('a' /* default = first sorted */);
    expect(selectedSummary(setSelected(st, 'b'))?.title).toBe('B');
  });

  it('returns null when selectedId is null or missing', () => {
    expect(selectedSummary(initialState())).toBeNull();
  });
});
