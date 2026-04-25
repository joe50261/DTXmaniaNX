import type { BoxNode, ChartEntry, LibraryNode, SongEntry } from '@dtxmania/dtx-core';

/**
 * Pure data/logic model for the song-selection wheel.
 *
 * Consumed by `song-select-canvas.ts`, which is the single view used
 * for both desktop (mounted into the overlay) and VR (uploaded as a
 * Three.js CanvasTexture). Nothing in this module touches DOM,
 * Three.js, or Canvas — the same concepts (wheel size, difficulty
 * slots, entry list, focus/slot cycling, sort, breadcrumb path) used
 * to be copy-pasted between a DOM SongWheel and the canvas, and drifted
 * on small details. A single model keeps the rendering paths in
 * lock-step and means adding a new sort mode or synthetic entry is a
 * one-line change.
 */

/** Number of visible rows. Odd so there's one focused center row. */
export const WHEEL_VISIBLE_ROWS = 7;
export const WHEEL_CENTER_OFFSET = (WHEEL_VISIBLE_ROWS - 1) / 2;

export const DIFFICULTY_SLOT_LABELS = ['NOVICE', 'REGULAR', 'EXPERT', 'MASTER', 'DTX'] as const;

/** Synthetic wheel entries that the views render alongside real songs /
 * boxes. They aren't baked into the scanner tree; we compute them at
 * render time so the scanner doesn't have to know about UI conventions. */
export type SyntheticEntry =
  | { kind: 'back'; parent: BoxNode }
  | { kind: 'random'; box: BoxNode };

export type DisplayEntry = { kind: 'node'; node: LibraryNode } | SyntheticEntry;

export type SortMode = 'title' | 'artist' | 'bpm' | 'level';

export const SORT_MODES: readonly SortMode[] = ['title', 'artist', 'bpm', 'level'];

/** A single breadcrumb hop, from root to current. `current: true` marks
 * the terminal segment so the DOM view can style it differently and the
 * canvas view can skip the separator after it. */
export interface BreadcrumbSegment {
  node: BoxNode;
  current: boolean;
}

/** Mutually exclusive options for building the display entry list. The
 * desktop view uses the full form (filter + sort); the VR panel passes
 * neither today (no search UI in headset). */
export interface BuildDisplayEntriesOptions {
  sort?: SortMode;
  /** Lower-cased substring; empty string or undefined disables filtering. */
  searchQuery?: string;
}

/** Build the flat display list for one box: synthetic Back (if not root),
 * Random, then children filtered + sorted. */
export function buildDisplayEntries(
  box: BoxNode | null,
  opts: BuildDisplayEntriesOptions = {}
): DisplayEntry[] {
  const out: DisplayEntry[] = [];
  if (!box) return out;
  if (box.parent) out.push({ kind: 'back', parent: box.parent });
  out.push({ kind: 'random', box });

  const q = opts.searchQuery?.trim().toLowerCase() ?? '';
  let children = q
    ? box.children.filter((c) => displayTitle(c).toLowerCase().includes(q))
    : box.children.slice();
  if (opts.sort !== undefined) {
    const mode = opts.sort;
    children = children.slice().sort((a, b) => compareNodes(a, b, mode));
  }
  for (const child of children) out.push({ kind: 'node', node: child });
  return out;
}

/** Wrap `(idx + delta)` around a list of size `n`. Returns 0 for empty. */
export function cycleFocus(currentIdx: number, n: number, delta: number): number {
  if (n <= 0) return 0;
  return ((currentIdx + delta) % n + n) % n;
}

/** Given a song and the player's currently-effective slot, cycle through
 * the *available* slots (which may not be contiguous: a song could have
 * only slot 1 + 3) and return the new slot. Returns the unchanged input
 * when the song has no charts. */
export function cycleDifficultySlot(
  song: SongEntry,
  currentSlot: number,
  delta: number
): number {
  if (song.charts.length === 0) return currentSlot;
  const slots = song.charts.map((c) => c.slot).sort((a, b) => a - b);
  const effective = pickChartForSlot(song, currentSlot);
  const curIdx = slots.indexOf(effective.slot);
  const next = ((curIdx + delta) % slots.length + slots.length) % slots.length;
  return slots[next]!;
}

/** Pick the chart whose slot matches `preferredSlot`, falling back to
 * the nearest-higher slot and then the highest available. Pure so it
 * can be unit-tested independent of any view.
 *
 * Why "nearest higher" over "nearest either direction": if the player
 * has been cycling through MASTER (slot 3) and lands on a song that
 * only offers NOVICE (0) + REGULAR (1), picking the highest avoids a
 * sudden difficulty downshift to the easiest chart — usually not what
 * the player wants. */
export function pickChartForSlot(song: SongEntry, preferredSlot: number): ChartEntry {
  const sorted = [...song.charts].sort((a, b) => a.slot - b.slot);
  const exact = sorted.find((c) => c.slot === preferredSlot);
  if (exact) return exact;
  const nextHigher = sorted.find((c) => c.slot >= preferredSlot);
  return nextHigher ?? sorted[sorted.length - 1]!;
}

/** Walk the tree looking for a BoxNode whose `path` matches. Lets the
 * views restore browse position across Rescans where BoxNode identity
 * changes but path strings stay stable. */
export function findBoxByPath(box: BoxNode, path: string): BoxNode | null {
  if (box.path === path) return box;
  for (const child of box.children) {
    if (child.type !== 'box') continue;
    const found = findBoxByPath(child, path);
    if (found) return found;
  }
  return null;
}

/** Depth-first collect every SongEntry reachable from `box`, then pick
 * one at random. Returns null if the subtree has no songs. */
export function pickRandomSongIn(box: BoxNode): SongEntry | null {
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

/** Build the breadcrumb chain from root → ... → current box. Views
 * render it differently (DOM `<span>` tree vs canvas joined string) but
 * both need the same walk up the `.parent` chain. */
export function buildBreadcrumbPath(currentBox: BoxNode | null): BreadcrumbSegment[] {
  if (!currentBox) return [];
  const chain: BoxNode[] = [];
  for (let b: BoxNode | null = currentBox; b !== null; b = b.parent) {
    chain.push(b);
  }
  chain.reverse();
  return chain.map((node) => ({ node, current: node === currentBox }));
}

/** Row title text, identical across views (DTXmania uses the same
 * glyphs). Emoji on BACK/RANDOM/📁 matches the desktop convention so
 * players moving between desktop and VR see the same icons. */
export function rowTitle(entry: DisplayEntry): string {
  if (entry.kind === 'back') return `⬆  ..  (${entry.parent.name})`;
  if (entry.kind === 'random') return '🎲  Random';
  const node = entry.node;
  if (node.type === 'box') return `📁  ${node.name}`;
  return node.entry.title;
}

export function displayTitle(node: LibraryNode): string {
  return node.type === 'box' ? node.name : node.entry.title;
}

/** Best-record summary line for the status panel. Undefined when the
 * chart's never been played so the view can skip the row. */
export function formatBestRecordLine(chart: ChartEntry): string | undefined {
  const r = chart.record;
  if (!r) return undefined;
  const score = r.bestScore.toString().padStart(7, '0');
  const medal = r.excellent ? ' · EX' : r.fullCombo ? ' · FC' : '';
  return `${score} (${r.bestRank})${medal}`;
}

/** Compact "Artist · Genre · BPM X" meta line. Empty string when the
 * song has none of those fields. */
export function formatSongMeta(song: SongEntry): string {
  const parts: string[] = [];
  if (song.artist) parts.push(song.artist);
  if (song.genre) parts.push(song.genre);
  if (song.bpm) parts.push(`BPM ${Math.round(song.bpm)}`);
  return parts.join(' · ');
}

/** Clear-lamp tier, mapped from a ChartEntry's record. Views map each
 * tier to their own palette (desktop and canvas use slightly different
 * slate shades for the "played" tier). */
export type LampTier = 'excellent' | 'fullCombo' | 'played';

export function lampTier(chart: ChartEntry): LampTier | null {
  const r = chart.record;
  if (!r) return null;
  if (r.excellent) return 'excellent';
  if (r.fullCombo) return 'fullCombo';
  return 'played';
}

/** Max level across the preferred-slot chart(s), or 0 if no chart has
 * a parsed level. Used for the `level` sort mode — unknown levels sort
 * to the top, matching DTXmania's "ungraded" ordering. */
function levelKey(node: LibraryNode): number {
  if (node.type === 'box') return 0;
  const levels = node.entry.charts
    .map((c) => c.drumLevel ?? 0)
    .filter((l) => l > 0);
  if (levels.length === 0) return 0;
  return Math.max(...levels);
}

/** Comparator for sorting library nodes. Boxes always sort above songs
 * within the same tier so the folder layout stays visually obvious —
 * mirrors DTXmania's habit of listing BOX nodes at the top of a wheel. */
export function compareNodes(a: LibraryNode, b: LibraryNode, mode: SortMode): number {
  if (a.type !== b.type) return a.type === 'box' ? -1 : 1;
  switch (mode) {
    case 'title':
      return displayTitle(a).localeCompare(displayTitle(b));
    case 'artist': {
      const aa = a.type === 'song' ? (a.entry.artist ?? '') : '';
      const bb = b.type === 'song' ? (b.entry.artist ?? '') : '';
      const primary = aa.localeCompare(bb);
      return primary !== 0 ? primary : displayTitle(a).localeCompare(displayTitle(b));
    }
    case 'bpm': {
      const aa = a.type === 'song' ? (a.entry.bpm ?? 0) : 0;
      const bb = b.type === 'song' ? (b.entry.bpm ?? 0) : 0;
      const primary = aa - bb;
      return primary !== 0 ? primary : displayTitle(a).localeCompare(displayTitle(b));
    }
    case 'level': {
      const primary = levelKey(a) - levelKey(b);
      return primary !== 0 ? primary : displayTitle(a).localeCompare(displayTitle(b));
    }
  }
}
