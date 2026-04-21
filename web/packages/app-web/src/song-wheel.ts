import type { BoxNode, ChartEntry, LibraryNode, SongEntry, SongNode } from '@dtxmania/dtx-core';

/** Number of visible rows in the wheel. Odd so there's a single focused
 * center row with equal offsets above and below. */
const WHEEL_VISIBLE_ROWS = 7;
const WHEEL_CENTER_OFFSET = (WHEEL_VISIBLE_ROWS - 1) / 2;

const DIFFICULTY_SLOT_LABELS = ['NOVICE', 'REGULAR', 'EXPERT', 'MASTER', 'DTX'] as const;

/** Synthetic wheel entries that DTXmania renders alongside real songs /
 * boxes. We don't bake them into the scanner tree; they're computed at
 * render time so the scanner doesn't have to know about UI conventions. */
type SyntheticEntry =
  | { kind: 'back'; parent: BoxNode }
  | { kind: 'random'; box: BoxNode };

type DisplayEntry = { kind: 'node'; node: LibraryNode } | SyntheticEntry;

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
  private root: BoxNode | null = null;
  private currentBox: BoxNode | null = null;
  private entries: DisplayEntry[] = [];
  private focusIdx = 0;
  /** Preferred slot the player keeps coming back to (0..4). Clamped to
   * what the currently-focused song actually has. */
  private preferredSlot = 4;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private focusListener: ((idx: number) => void) | null = null;

  constructor(
    private readonly wheelEl: HTMLElement,
    private readonly statusPanelEl: HTMLElement,
    private readonly breadcrumbEl: HTMLElement,
    private readonly callbacks: SongWheelCallbacks
  ) {}

  /** Replace the library tree shown in the wheel and reset navigation to
   * the root box. */
  setRoot(root: BoxNode | null): void {
    this.root = root;
    this.currentBox = root;
    this.focusIdx = 0;
    this.rebuildEntries();
    this.render();
    this.emitFocusChanged();
  }

  /** Current focused SongEntry (or null if focus is on a folder / back /
   * random entry, or the library is empty). Main.ts uses this to decide
   * whether to start preview audio / load a cover image. */
  focusedSong(): SongEntry | null {
    const entry = this.entries[this.focusIdx];
    if (entry?.kind !== 'node') return null;
    if (entry.node.type !== 'song') return null;
    return entry.node.entry;
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
    if (this.entries.length === 0) return;
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
        this.activateFocused();
        return;
      case 'Escape':
        e.preventDefault();
        this.goBack();
        return;
    }
  }

  private moveFocus(delta: number): void {
    const n = this.entries.length;
    if (n === 0) return;
    this.focusIdx = ((this.focusIdx + delta) % n + n) % n;
    this.render();
    this.emitFocusChanged();
  }

  private cycleDifficulty(delta: number): void {
    const song = this.focusedSong();
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

  /** Commit the focused entry: start a song, descend into a box, pop out
   * of a back entry, or random-pick inside the current box. */
  private activateFocused(): void {
    const entry = this.entries[this.focusIdx];
    if (!entry) return;
    if (entry.kind === 'back') {
      this.goBack();
      return;
    }
    if (entry.kind === 'random') {
      const song = this.pickRandomSongIn(entry.box);
      if (song) this.callbacks.onStart(this.chartForPreferred(song));
      return;
    }
    const node = entry.node;
    if (node.type === 'box') {
      this.enterBox(node);
      return;
    }
    // SongNode
    this.callbacks.onStart(this.chartForPreferred(node.entry));
  }

  private enterBox(box: BoxNode): void {
    this.currentBox = box;
    this.focusIdx = 0;
    this.rebuildEntries();
    this.render();
    this.emitFocusChanged();
  }

  /** Pop to the parent box, placing focus on the child we came from so
   * the player doesn't lose their place. */
  private goBack(): void {
    const cur = this.currentBox;
    if (!cur || !cur.parent) return; // already at root
    const parent = cur.parent;
    this.currentBox = parent;
    this.rebuildEntries();
    const returnIdx = this.entries.findIndex(
      (e) => e.kind === 'node' && e.node.type === 'box' && e.node === cur
    );
    this.focusIdx = returnIdx >= 0 ? returnIdx : 0;
    this.render();
    this.emitFocusChanged();
  }

  private pickRandomSongIn(box: BoxNode): SongEntry | null {
    const songs: SongEntry[] = [];
    const stack: LibraryNode[] = [box];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.type === 'song') songs.push(node.entry);
      else for (const c of node.children) stack.push(c);
    }
    if (songs.length === 0) return null;
    return songs[Math.floor(Math.random() * songs.length)] ?? null;
  }

  /** Rebuild the flat display list for `currentBox`: synthetic Back at
   * the top (if not root), Random, then all children in filesystem
   * order. Called whenever currentBox changes. */
  private rebuildEntries(): void {
    const box = this.currentBox;
    this.entries = [];
    if (!box) return;
    if (box.parent) {
      this.entries.push({ kind: 'back', parent: box.parent });
    }
    this.entries.push({ kind: 'random', box });
    for (const child of box.children) {
      this.entries.push({ kind: 'node', node: child });
    }
  }

  private emitFocusChanged(): void {
    this.focusListener?.(this.focusIdx);
  }

  private render(): void {
    this.renderBreadcrumb();
    this.renderWheel();
    this.renderStatusPanel();
  }

  private renderBreadcrumb(): void {
    this.breadcrumbEl.replaceChildren();
    if (!this.currentBox) return;
    // Walk up from currentBox collecting names; reverse so we display
    // root → … → current.
    const chain: BoxNode[] = [];
    for (let b: BoxNode | null = this.currentBox; b !== null; b = b.parent) {
      chain.push(b);
    }
    chain.reverse();
    for (let i = 0; i < chain.length; i++) {
      const box = chain[i]!;
      const seg = document.createElement('span');
      seg.className = 'breadcrumb-seg';
      seg.textContent = box.name;
      if (box === this.currentBox) seg.classList.add('current');
      else {
        seg.classList.add('nav');
        seg.addEventListener('click', () => this.enterBox(box));
      }
      this.breadcrumbEl.appendChild(seg);
      if (i < chain.length - 1) {
        const sep = document.createElement('span');
        sep.className = 'breadcrumb-sep';
        sep.textContent = '›';
        this.breadcrumbEl.appendChild(sep);
      }
    }
  }

  private renderWheel(): void {
    this.wheelEl.replaceChildren();
    if (this.entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'wheel-empty';
      empty.textContent = this.root
        ? 'This folder is empty.'
        : 'No .dtx charts found in this folder.';
      this.wheelEl.appendChild(empty);
      return;
    }
    const n = this.entries.length;
    for (let i = 0; i < WHEEL_VISIBLE_ROWS; i++) {
      const offset = i - WHEEL_CENTER_OFFSET;
      const idx = ((this.focusIdx + offset) % n + n) % n;
      const entry = this.entries[idx]!;
      this.wheelEl.appendChild(this.buildRow(entry, offset, idx));
    }
  }

  private buildRow(entry: DisplayEntry, offset: number, idx: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'wheel-row';
    if (offset === 0) row.classList.add('wheel-focus');
    else row.classList.add(`wheel-off-${Math.abs(offset)}`);

    const title = document.createElement('div');
    title.className = 'wheel-title';
    title.textContent = rowTitle(entry);
    row.appendChild(title);

    if (offset === 0 && entry.kind === 'node' && entry.node.type === 'song') {
      // Only real songs on the focused center row get the meta + chart
      // buttons. Boxes / Back / Random rows are single-line.
      const song = entry.node.entry;
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
    }

    if (offset !== 0) {
      // Off-center rows: click → move focus (mouse browsing).
      row.addEventListener('click', () => {
        this.focusIdx = idx;
        this.render();
        this.emitFocusChanged();
      });
    } else if (
      entry.kind === 'back' ||
      entry.kind === 'random' ||
      (entry.kind === 'node' && entry.node.type === 'box')
    ) {
      // Focused non-song rows: click activates (enter folder / back / random).
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => this.activateFocused());
    }

    return row;
  }

  private renderStatusPanel(): void {
    this.statusPanelEl.replaceChildren();
    const song = this.focusedSong();
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

function rowTitle(entry: DisplayEntry): string {
  if (entry.kind === 'back') return `⬆  ..  (${entry.parent.name})`;
  if (entry.kind === 'random') return '🎲  Random';
  const node = entry.node;
  if (node.type === 'box') return `📁  ${node.name}`;
  return node.entry.title;
}

function formatSongMeta(song: SongEntry): string {
  const parts: string[] = [];
  if (song.artist) parts.push(song.artist);
  if (song.genre) parts.push(song.genre);
  if (song.bpm) parts.push(`BPM ${Math.round(song.bpm)}`);
  return parts.join(' · ');
}
