/**
 * Desktop Replays browser modal.
 *
 * DOM-based — replay viewing/exporting is `desktop-only` (per the
 * design discussion: replay UI is for rendering replays into shareable
 * videos, not for in-VR playback). VR sessions never see this panel,
 * so there's no need for the song-select-canvas-style CanvasTexture
 * gymnastics; plain HTML is cheaper and gets us a11y for free.
 *
 * Pattern mirrors `config-panel.ts`:
 *  - Owns its own backdrop + modal DOM, mounted to body at construction.
 *  - `open()` / `close()` flip backdrop display.
 *  - State + transition logic lives in `replays-list-model.ts`; this
 *    file is the thin subscriber that paints + dispatches clicks.
 *
 * Render integration is intentionally a placeholder for now — the
 * "Render" button shows a "coming soon" message. The list, sort, and
 * delete paths are fully wired so the user can already manage their
 * stored replays.
 */

import {
  deleteReplay,
  listReplaySummaries,
  type ReplaySummary,
} from './storage.js';
import {
  initialState,
  selectedSummary,
  setSelected,
  setSortKey,
  setSummaries,
  sortedSummaries,
  type ListState,
  type SortKey,
} from './replays-list-model.js';

const SORT_OPTIONS: Array<{ key: SortKey; label: string }> = [
  { key: 'startedAt-desc', label: 'Newest first' },
  { key: 'startedAt-asc', label: 'Oldest first' },
  { key: 'score-desc', label: 'Highest score' },
];

export interface ReplaysPanelDeps {
  /** Hook for the future render integration. Receives the chosen
   * replay's id; the host orchestrates load → render → download.
   * Optional so this panel can ship before the render slice lands. */
  onRender?: (id: string) => void;
}

export class ReplaysPanel {
  private readonly backdrop: HTMLDivElement;
  private readonly listEl: HTMLDivElement;
  private readonly sortSel: HTMLSelectElement;
  private state: ListState = initialState();
  private readonly deps: ReplaysPanelDeps;

  constructor(deps: ReplaysPanelDeps = {}) {
    this.deps = deps;

    this.backdrop = document.createElement('div');
    this.backdrop.id = 'replays-backdrop';
    this.backdrop.className = 'config-backdrop';
    this.backdrop.style.display = 'none';
    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) this.close();
    });

    const modal = document.createElement('div');
    modal.className = 'config-modal';
    modal.style.width = '600px';
    this.backdrop.appendChild(modal);

    const header = document.createElement('div');
    header.className = 'config-header';
    const title = document.createElement('div');
    title.className = 'config-title';
    title.textContent = 'Replays';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'config-close';
    close.textContent = '✕';
    close.addEventListener('click', () => this.close());
    header.appendChild(title);
    header.appendChild(close);
    modal.appendChild(header);

    // Toolbar: sort selector. Future: filter by chart, search.
    const toolbar = document.createElement('div');
    toolbar.className = 'replays-toolbar';
    const sortLabel = document.createElement('span');
    sortLabel.textContent = 'Sort:';
    sortLabel.style.fontSize = '12px';
    sortLabel.style.color = '#94a3b8';
    toolbar.appendChild(sortLabel);
    this.sortSel = document.createElement('select');
    for (const opt of SORT_OPTIONS) {
      const optEl = document.createElement('option');
      optEl.value = opt.key;
      optEl.textContent = opt.label;
      this.sortSel.appendChild(optEl);
    }
    this.sortSel.addEventListener('change', () => {
      this.state = setSortKey(this.state, this.sortSel.value as SortKey);
      this.repaint();
    });
    toolbar.appendChild(this.sortSel);
    modal.appendChild(toolbar);

    this.listEl = document.createElement('div');
    this.listEl.className = 'replays-list';
    modal.appendChild(this.listEl);

    document.body.appendChild(this.backdrop);
  }

  /** Open the panel and refresh the list from IndexedDB. Returns
   * after the IDB read settles so callers can await if they want. */
  async open(): Promise<void> {
    this.backdrop.style.display = 'flex';
    await this.refresh();
  }

  close(): void {
    this.backdrop.style.display = 'none';
  }

  private async refresh(): Promise<void> {
    let summaries: ReplaySummary[] = [];
    try {
      summaries = await listReplaySummaries();
    } catch (e) {
      console.warn('[replays] listReplaySummaries failed', e);
    }
    this.state = setSummaries(this.state, summaries);
    this.sortSel.value = this.state.sortKey;
    this.repaint();
  }

  private repaint(): void {
    this.listEl.replaceChildren();
    const rows = sortedSummaries(this.state);
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'replays-empty';
      empty.textContent =
        'No replays yet. Finish a charted song (not a practice run) and one will appear here.';
      this.listEl.appendChild(empty);
      return;
    }
    const selectedId = selectedSummary(this.state)?.id ?? null;
    for (const row of rows) {
      this.listEl.appendChild(this.buildRow(row, row.id === selectedId));
    }
  }

  private buildRow(s: ReplaySummary, isSelected: boolean): HTMLDivElement {
    const root = document.createElement('div');
    root.className = isSelected ? 'replays-row selected' : 'replays-row';
    root.addEventListener('click', () => {
      this.state = setSelected(this.state, s.id);
      this.repaint();
    });

    const left = document.createElement('div');
    const t = document.createElement('div');
    t.className = 'replays-row-title';
    t.textContent = s.title ?? s.chartPath.split('/').pop() ?? s.chartPath;
    const meta = document.createElement('div');
    meta.className = 'replays-row-meta';
    const date = formatDate(s.startedAt);
    const dur = formatDuration(s.durationMs);
    const fc = s.fullCombo ? ' · FC' : '';
    meta.textContent = s.artist
      ? `${s.artist} · ${date} · ${dur}${fc}`
      : `${date} · ${dur}${fc}`;
    left.appendChild(t);
    left.appendChild(meta);

    const score = document.createElement('div');
    score.className = 'replays-row-score';
    score.textContent = formatScore(s.finalScoreNorm);

    const actions = document.createElement('div');
    actions.className = 'replays-row-actions';
    const renderBtn = document.createElement('button');
    renderBtn.type = 'button';
    renderBtn.textContent = 'Render';
    if (this.deps.onRender) {
      renderBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deps.onRender!(s.id);
      });
    } else {
      renderBtn.disabled = true;
      renderBtn.title = 'Video render not implemented yet';
    }
    actions.appendChild(renderBtn);
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      // No HTML confirm() in the eventual VR flow, but desktop is fine
      // — single click on Delete with no undo would burn the user.
      if (!window.confirm(`Delete this replay?\n\n${t.textContent}`)) return;
      try {
        await deleteReplay(s.id);
      } catch (err) {
        console.warn('[replays] deleteReplay failed', err);
        return;
      }
      await this.refresh();
    });
    actions.appendChild(delBtn);

    root.appendChild(left);
    root.appendChild(score);
    root.appendChild(actions);
    return root;
  }
}

function formatDate(iso: string): string {
  // ISO 8601 → local short. Falling back to the raw string keeps the
  // panel usable if Date parsing fails (very old browsers).
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatScore(norm: number): string {
  // Display the live-game's 1,000,000 scale so the number matches
  // what the player saw on the result screen.
  const score = Math.round(norm * 1_000_000);
  return score.toLocaleString();
}
