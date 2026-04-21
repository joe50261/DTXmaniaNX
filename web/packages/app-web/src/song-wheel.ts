import type { ChartEntry, SongEntry } from '@dtxmania/dtx-core';

/** Number of visible rows in the wheel. Odd so there's a single focused
 * center row with equal offsets above and below. */
const WHEEL_VISIBLE_ROWS = 7;
const WHEEL_CENTER_OFFSET = (WHEEL_VISIBLE_ROWS - 1) / 2;

const DIFFICULTY_SLOT_LABELS = ['NOVICE', 'REGULAR', 'EXPERT', 'MASTER', 'DTX'] as const;

export interface SongWheelCallbacks {
  /** Called when the user commits a chart (Enter key or direct chart-btn click). */
  onStart: (chart: ChartEntry) => void;
  /** Format a DTXMania #DLEVEL integer (0..1000) as a display string. */
  formatLevel: (dlevel: number) => string;
  /** Predicate the keyboard handler checks before consuming a keypress.
   * Lets main.ts say "only navigate when the overlay is actually visible"
   * without the wheel needing DOM refs outside its own tree. */
  isActive: () => boolean;
}

/**
 * DTXmania Stage 05-style focused-center song wheel for the desktop
 * overlay. Renders 7 rows with the center one enlarged + highlighted,
 * plus a side status panel showing every difficulty slot and song-wide
 * metadata for the focused song.
 *
 * Keyboard controls (only bound while attachKeyboard() is active):
 *   ↑ / ↓        move focus, wrapping at ends
 *   ← / →        cycle selected difficulty among the focused song's charts
 *   Enter / Space  start the focused song's selected difficulty
 *
 * Mouse still works: clicking an unfocused row moves focus to it;
 * clicking a chart button on the focused row starts that chart directly.
 */
export class SongWheel {
  private songs: SongEntry[] = [];
  private focusIdx = 0;
  /** Preferred slot the player keeps coming back to (0..4). Clamped to
   * what the currently-focused song actually has. */
  private preferredSlot = 4;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private focusListener: ((idx: number) => void) | null = null;

  constructor(
    private readonly wheelEl: HTMLElement,
    private readonly statusPanelEl: HTMLElement,
    private readonly callbacks: SongWheelCallbacks
  ) {}

  /** Replace the song data shown in the wheel and reset focus to the top. */
  setSongs(songs: SongEntry[]): void {
    this.songs = songs;
    this.focusIdx = 0;
    this.render();
    this.emitFocusChanged();
  }

  /** Current focused song (or null if the library is empty). */
  focusedSong(): SongEntry | null {
    return this.songs[this.focusIdx] ?? null;
  }

  /** Register a listener that fires whenever the focused song changes
   * (including setSongs + every arrow-key step + every mouse-row click).
   * Phase 3 will use this to drive preview audio + preimage loads. */
  onFocusChanged(cb: (idx: number) => void): void {
    this.focusListener = cb;
  }

  /** Start listening for keyboard nav. Caller should detach when the
   * player leaves the song-select screen (e.g. game starts, overlay
   * hides). Safe to call multiple times. */
  attachKeyboard(): void {
    if (this.keyHandler) return;
    this.keyHandler = (e) => this.handleKey(e);
    window.addEventListener('keydown', this.keyHandler);
  }

  detachKeyboard(): void {
    if (!this.keyHandler) return;
    window.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = null;
  }

  private handleKey(e: KeyboardEvent): void {
    if (!this.callbacks.isActive()) return;
    if (this.songs.length === 0) return;
    // Swallow only the keys we consume so drum hotkeys, browser shortcuts,
    // and text inputs (when phase 5 adds search) keep working.
    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        this.moveFocus(-1);
        return;
      case 'ArrowDown':
        e.preventDefault();
        this.moveFocus(1);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        this.cycleDifficulty(-1);
        return;
      case 'ArrowRight':
        e.preventDefault();
        this.cycleDifficulty(1);
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        this.startFocusedChart();
        return;
    }
  }

  private moveFocus(delta: number): void {
    const n = this.songs.length;
    this.focusIdx = ((this.focusIdx + delta) % n + n) % n;
    this.render();
    this.emitFocusChanged();
  }

  private cycleDifficulty(delta: number): void {
    const song = this.songs[this.focusIdx];
    if (!song || song.charts.length === 0) return;
    // The available slots are song.charts' slot numbers (not always
    // contiguous: a song may have only slot 1 + 3). Find the current
    // index within the SLOTS present, step, and translate back.
    const slots = song.charts.map((c) => c.slot).sort((a, b) => a - b);
    const effective = this.chartForPreferred(song);
    const curIdx = slots.indexOf(effective.slot);
    const next = ((curIdx + delta) % slots.length + slots.length) % slots.length;
    this.preferredSlot = slots[next]!;
    this.render();
  }

  /** Pick the chart whose slot matches preferredSlot, falling back to the
   * nearest-higher and then the highest available. */
  private chartForPreferred(song: SongEntry): ChartEntry {
    const sorted = [...song.charts].sort((a, b) => a.slot - b.slot);
    const exact = sorted.find((c) => c.slot === this.preferredSlot);
    if (exact) return exact;
    const nextHigher = sorted.find((c) => c.slot >= this.preferredSlot);
    return nextHigher ?? sorted[sorted.length - 1]!;
  }

  private startFocusedChart(): void {
    const song = this.songs[this.focusIdx];
    if (!song) return;
    const chart = this.chartForPreferred(song);
    this.callbacks.onStart(chart);
  }

  private emitFocusChanged(): void {
    this.focusListener?.(this.focusIdx);
  }

  private render(): void {
    this.renderWheel();
    this.renderStatusPanel();
  }

  private renderWheel(): void {
    this.wheelEl.replaceChildren();
    if (this.songs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'wheel-empty';
      empty.textContent = 'No .dtx charts found in this folder.';
      this.wheelEl.appendChild(empty);
      return;
    }
    const n = this.songs.length;
    for (let i = 0; i < WHEEL_VISIBLE_ROWS; i++) {
      const offset = i - WHEEL_CENTER_OFFSET;
      const idx = ((this.focusIdx + offset) % n + n) % n;
      const song = this.songs[idx]!;
      const row = this.buildRow(song, offset, idx);
      this.wheelEl.appendChild(row);
    }
  }

  private buildRow(song: SongEntry, offset: number, idx: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'wheel-row';
    if (offset === 0) row.classList.add('wheel-focus');
    else row.classList.add(`wheel-off-${Math.abs(offset)}`);

    const title = document.createElement('div');
    title.className = 'wheel-title';
    title.textContent = song.title;
    row.appendChild(title);

    if (offset === 0) {
      const meta = document.createElement('div');
      meta.className = 'wheel-meta';
      meta.textContent = formatSongMeta(song);
      row.appendChild(meta);

      const chartRow = document.createElement('div');
      chartRow.className = 'wheel-charts';
      const selectedChart = this.chartForPreferred(song);
      for (const chart of [...song.charts].sort((a, b) => a.slot - b.slot)) {
        const btn = document.createElement('button');
        btn.className = 'chart-btn';
        if (chart.slot === selectedChart.slot) btn.classList.add('selected');
        const lbl = document.createElement('span');
        lbl.textContent = chart.label;
        btn.appendChild(lbl);
        if (chart.drumLevel !== undefined && chart.drumLevel > 0) {
          const lv = document.createElement('span');
          lv.className = 'level';
          lv.textContent = this.callbacks.formatLevel(chart.drumLevel);
          btn.appendChild(lv);
        }
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.preferredSlot = chart.slot;
          this.callbacks.onStart(chart);
        });
        chartRow.appendChild(btn);
      }
      row.appendChild(chartRow);
    } else {
      // Unfocused rows: clicking moves focus so the player can mouse-browse
      // the wheel instead of only keyboard-scrolling.
      row.addEventListener('click', () => {
        this.focusIdx = idx;
        this.render();
        this.emitFocusChanged();
      });
    }

    return row;
  }

  private renderStatusPanel(): void {
    this.statusPanelEl.replaceChildren();
    const song = this.songs[this.focusIdx];
    if (!song) return;

    const slotsUsed = new Map<number, ChartEntry>();
    for (const chart of song.charts) slotsUsed.set(chart.slot, chart);

    const diffList = document.createElement('div');
    diffList.className = 'status-diffs';
    const selected = this.chartForPreferred(song);
    for (let slot = 0; slot < DIFFICULTY_SLOT_LABELS.length; slot++) {
      const chart = slotsUsed.get(slot);
      const row = document.createElement('div');
      row.className = 'status-diff';
      if (chart === undefined) row.classList.add('empty');
      if (chart && chart.slot === selected.slot) row.classList.add('selected');
      const lab = document.createElement('span');
      lab.className = 'diff-label';
      lab.textContent = chart?.label ?? DIFFICULTY_SLOT_LABELS[slot]!;
      const lv = document.createElement('span');
      lv.className = 'diff-level';
      lv.textContent =
        chart?.drumLevel !== undefined && chart.drumLevel > 0
          ? this.callbacks.formatLevel(chart.drumLevel)
          : '—';
      row.appendChild(lab);
      row.appendChild(lv);
      diffList.appendChild(row);
    }
    this.statusPanelEl.appendChild(diffList);

    const metaBlock = document.createElement('div');
    metaBlock.className = 'status-meta';
    const metaLines: Array<[string, string | undefined]> = [
      ['Artist', song.artist],
      ['Genre', song.genre],
      ['BPM', song.bpm ? Math.round(song.bpm).toString() : undefined],
      ['Comment', song.comment],
    ];
    for (const [label, value] of metaLines) {
      if (!value) continue;
      const line = document.createElement('div');
      line.className = 'status-meta-line';
      const k = document.createElement('span');
      k.className = 'status-meta-key';
      k.textContent = label;
      const v = document.createElement('span');
      v.className = 'status-meta-val';
      v.textContent = value;
      line.appendChild(k);
      line.appendChild(v);
      metaBlock.appendChild(line);
    }
    this.statusPanelEl.appendChild(metaBlock);
  }
}

function formatSongMeta(song: SongEntry): string {
  const parts: string[] = [];
  if (song.artist) parts.push(song.artist);
  if (song.genre) parts.push(song.genre);
  if (song.bpm) parts.push(`BPM ${Math.round(song.bpm)}`);
  return parts.join(' · ');
}
