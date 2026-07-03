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
 * Render integration: the host (main.ts) owns the render job — this
 * panel only paints its progress. The panel therefore exposes two
 * distinct entries into render mode: `showRender()` (a NEW job —
 * resets bar/status/log) and `resumeRenderView()` (an EXISTING job —
 * flips visibility only, so a re-click on Render while a job is
 * running surfaces the live progress instead of wiping it).
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
import type { RenderProgress } from './render.js';

const SORT_OPTIONS: Array<{ key: SortKey; label: string }> = [
  { key: 'startedAt-desc', label: 'Newest first' },
  { key: 'startedAt-asc', label: 'Oldest first' },
  { key: 'score-desc', label: 'Highest score' },
];

export interface ReplaysPanelDeps {
  /** Receives the chosen replay's id; the host orchestrates
   * load → render → download (and enforces single-flight — see
   * `render-job-model.ts`). Optional so this panel can ship before
   * the render slice lands. */
  onRender?: (id: string) => void;
  /** Cancel the in-flight render. The host aborts its controller; the
   * panel just relays the click. */
  onCancelRender?: () => void;
}

export class ReplaysPanel {
  private readonly backdrop: HTMLDivElement;
  private readonly listEl: HTMLDivElement;
  private readonly sortSel: HTMLSelectElement;
  private readonly toolbar: HTMLDivElement;
  private readonly renderEl: HTMLDivElement;
  private readonly renderTitleEl: HTMLDivElement;
  private readonly renderBarEl: HTMLProgressElement;
  private readonly renderStatusEl: HTMLDivElement;
  private readonly renderLogEl: HTMLDivElement;
  private readonly renderCancelBtn: HTMLButtonElement;
  private readonly renderSaveBtn: HTMLButtonElement;
  /** Re-triggers the download of the finished render's blob. Held so
   * a render that finishes while the tab is hidden (headset off — the
   * browser drops programmatic download clicks there) still has a
   * user-gesture path to the file. Cleared on hideRender so the blob
   * can be GC'd. */
  private saveCb: (() => void) | null = null;
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
    // Distinct class name from Settings' `.config-modal` so playwright
    // selectors targeting the Settings panel (`page.locator('.config-modal')`)
    // don't pick up two elements once both panels live in the DOM.
    // Visual style is shared via the CSS selector list in index.html.
    modal.className = 'replays-modal';
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
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'replays-toolbar';
    const sortLabel = document.createElement('span');
    sortLabel.textContent = 'Sort:';
    sortLabel.style.fontSize = '12px';
    sortLabel.style.color = '#94a3b8';
    this.toolbar.appendChild(sortLabel);
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
    this.toolbar.appendChild(this.sortSel);
    modal.appendChild(this.toolbar);

    this.listEl = document.createElement('div');
    this.listEl.className = 'replays-list';
    modal.appendChild(this.listEl);

    // Render-progress overlay — hidden when idle, shown during a
    // render so the user has visible feedback (a 3-minute song
    // rendering with the page idle is otherwise indistinguishable
    // from a hang). Replaces the list area in-place so the modal
    // height stays stable.
    this.renderEl = document.createElement('div');
    this.renderEl.className = 'replays-render';
    this.renderTitleEl = document.createElement('div');
    this.renderTitleEl.className = 'replays-render-title';
    this.renderBarEl = document.createElement('progress');
    this.renderBarEl.className = 'replays-render-bar';
    this.renderBarEl.max = 1;
    this.renderBarEl.value = 0;
    this.renderStatusEl = document.createElement('div');
    this.renderStatusEl.className = 'replays-render-status';
    this.renderLogEl = document.createElement('div');
    this.renderLogEl.className = 'replays-render-log';
    const renderFooter = document.createElement('div');
    renderFooter.className = 'config-footer';
    this.renderSaveBtn = document.createElement('button');
    this.renderSaveBtn.type = 'button';
    this.renderSaveBtn.textContent = 'Save video';
    this.renderSaveBtn.style.display = 'none';
    this.renderSaveBtn.addEventListener('click', () => this.saveCb?.());
    renderFooter.appendChild(this.renderSaveBtn);
    this.renderCancelBtn = document.createElement('button');
    this.renderCancelBtn.type = 'button';
    this.renderCancelBtn.className = 'danger';
    this.renderCancelBtn.textContent = 'Cancel render';
    // Hidden until showRender — resumeRenderView can surface this
    // view before the first job ever reaches showRender, and a
    // visible Cancel with no job behind it would be a dead button.
    this.renderCancelBtn.style.display = 'none';
    this.renderCancelBtn.addEventListener('click', () => {
      this.deps.onCancelRender?.();
    });
    renderFooter.appendChild(this.renderCancelBtn);
    const renderClose = document.createElement('button');
    renderClose.type = 'button';
    renderClose.textContent = 'Back to replays';
    renderClose.addEventListener('click', () => this.hideRender());
    renderFooter.appendChild(renderClose);
    this.renderEl.appendChild(this.renderTitleEl);
    this.renderEl.appendChild(this.renderBarEl);
    this.renderEl.appendChild(this.renderStatusEl);
    this.renderEl.appendChild(this.renderLogEl);
    this.renderEl.appendChild(renderFooter);
    modal.appendChild(this.renderEl);

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
    // Reset render mode so the next open() starts fresh on the list
    // rather than showing a stale render log.
    this.hideRender();
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

  /** Switch the modal into "rendering" mode for a NEW job: reset the
   * bar / status / log, then surface the progress view. Title is the
   * row being rendered so the user can confirm at a glance. */
  showRender(rowTitle: string): void {
    this.renderTitleEl.textContent = `Rendering: ${rowTitle}`;
    this.renderBarEl.removeAttribute('value');
    this.renderBarEl.max = 1;
    this.renderStatusEl.textContent = 'Starting…';
    this.renderLogEl.textContent = '';
    this.renderCancelBtn.style.display = '';
    this.renderSaveBtn.style.display = 'none';
    this.saveCb = null;
    this.enterRenderView();
  }

  /** Re-surface the progress view of the job that's ALREADY running,
   * without touching its bar / status / log. This is what a Render
   * click lands on while a job is in flight — after a headset
   * sleep/wake the first job resumes where it froze, and the re-click
   * must show that progress, not start a competing render. */
  resumeRenderView(): void {
    this.enterRenderView();
  }

  /** The render job ended. Hide Cancel; when the host hands us a
   * `save` callback (success path) surface the "Save video" button so
   * a download the browser suppressed (hidden tab at completion) can
   * be re-triggered by a real user gesture.
   *
   * If the user already left the render view AND the tab is visible,
   * the automatic download has delivered the file — drop the callback
   * so the Blob can be GC'd. But when the tab is hidden (headset set
   * down — the exact workflow this feature serves) the automatic
   * download was suppressed and this callback is the ONLY remaining
   * path to the finished file: keep it and re-surface the render view
   * so the button is actually reachable when the user returns. */
  finishRender(save: (() => void) | null): void {
    this.renderCancelBtn.style.display = 'none';
    const inRenderView = this.renderEl.classList.contains('active');
    const keep = save !== null && (inRenderView || document.hidden);
    this.saveCb = keep ? save : null;
    this.renderSaveBtn.style.display = this.saveCb ? '' : 'none';
    if (keep && !inRenderView) this.enterRenderView();
  }

  private enterRenderView(): void {
    this.toolbar.style.display = 'none';
    this.listEl.style.display = 'none';
    this.renderEl.classList.add('active');
    // Auto-open if the user closed the panel between click and the
    // first progress emit — they shouldn't lose the feedback.
    this.backdrop.style.display = 'flex';
  }

  /** Update the progress bar + status line. `null` resets to
   * indeterminate (used during the finalize phase where there's no
   * meaningful percentage). */
  updateRenderProgress(p: RenderProgress): void {
    if (p.phase === 'preload') {
      if (p.total === 0) {
        this.renderBarEl.removeAttribute('value');
        this.renderStatusEl.textContent = 'Preloading samples…';
      } else {
        this.renderBarEl.max = p.total;
        this.renderBarEl.value = p.current;
        this.renderStatusEl.textContent = `Preloading samples — ${p.current}/${p.total}`;
      }
    } else if (p.phase === 'recording') {
      this.renderBarEl.max = Math.max(1, p.total);
      this.renderBarEl.value = Math.min(p.current, p.total);
      const cur = formatDuration(p.current);
      const tot = formatDuration(p.total);
      const pct = p.total > 0 ? Math.floor((p.current / p.total) * 100) : 0;
      this.renderStatusEl.textContent = `Recording — ${cur} / ${tot} (${pct}%)`;
    } else if (p.phase === 'finalize') {
      this.renderBarEl.removeAttribute('value');
      this.renderStatusEl.textContent = 'Finalising video…';
    }
  }

  appendRenderLog(line: string): void {
    const stamp = new Date().toLocaleTimeString();
    const wasAtBottom =
      this.renderLogEl.scrollTop + this.renderLogEl.clientHeight >=
      this.renderLogEl.scrollHeight - 4;
    this.renderLogEl.textContent =
      (this.renderLogEl.textContent ?? '') + `[${stamp}] ${line}\n`;
    if (wasAtBottom) {
      this.renderLogEl.scrollTop = this.renderLogEl.scrollHeight;
    }
  }

  /** Tear down render mode and re-paint the list. Called whether the
   * render succeeded, failed, or was cancelled — caller decides. */
  hideRender(): void {
    this.renderEl.classList.remove('active');
    this.toolbar.style.display = '';
    this.listEl.style.display = '';
    // Drop the save closure — it pins the rendered Blob (potentially
    // ~100 MB) and the user has left the render view.
    this.saveCb = null;
    this.renderSaveBtn.style.display = 'none';
    // Refresh in case the user just rendered a replay and we want
    // the list to reflect any incidental changes (no-op on success
    // path; cheap).
    void this.refresh();
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
