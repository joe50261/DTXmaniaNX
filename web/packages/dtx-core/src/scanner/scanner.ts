import { parseDtx } from '../parser/parser.js';
import type { ChartRecord } from '../scoring/record.js';
import { parseBoxDef, type BoxDefMeta } from './boxdef.js';
import {
  basename,
  dirname,
  extname,
  joinPath,
  type DirEntry,
  type FileSystemBackend,
} from './fs-backend.js';
import { parseSetDef, type SetDefBlock } from './setdef.js';

/**
 * Song library scanner. Walks a directory tree (v1: only .dtx + set.def;
 * .gda/.bms/.bme/.g2d are deliberately out of scope) and produces a flat
 * list of song entries, each with up to 5 difficulty charts.
 */

export interface ChartEntry {
  /** One of 5 difficulty slots: 0=NOVICE, 1=REGULAR, 2=EXPERT, 3=MASTER, 4=DTXMania. */
  slot: number;
  label: string;
  /** Absolute path (relative to the backend root) of the .dtx file. */
  chartPath: string;
  /** #DLEVEL from the .dtx header (0..1000). Undefined if meta parsing was skipped/failed. */
  drumLevel?: number;
  /** #BPM from the .dtx header. Populated alongside drumLevel. */
  bpm?: number;
  /** Best-of play record. Runtime-attached by the app layer after
   * scan / cache hydration; **not** serialised into the scan cache
   * (records live in a separate IDB store keyed by chartPath). */
  record?: ChartRecord;
}

export interface SongEntry {
  /** Title from set.def or, if no set.def, the .dtx filename stem. */
  title: string;
  /** Directory containing the chart(s). */
  folderPath: string;
  /** True if this entry came from a set.def (vs. a single .dtx file). */
  fromSetDef: boolean;
  fontColor?: string;
  charts: ChartEntry[];
  /**
   * Optional song-wide metadata, cheap to extract from any single chart's
   * header (#ARTIST / #GENRE / #BPM). Filled when parseMeta is enabled and
   * at least one chart parsed successfully.
   */
  artist?: string;
  genre?: string;
  bpm?: number;
  /** `#PREVIEW` WAV path relative to folderPath. Used for song-select audio. */
  preview?: string;
  /** `#PREIMAGE` cover-art path relative to folderPath. */
  preimage?: string;
  /** `#COMMENT` free-form text, often a song blurb shown in the info panel. */
  comment?: string;
}

/** DTXmania-style song-select tree. The top-level `root` is a virtual box
 * wrapping the scanned root path; every directory containing songs (or
 * holding nested song directories) becomes a BoxNode. Back / Random
 * navigation entries are synthetic and added by the UI layer at render
 * time rather than baked into the tree here. */
export interface BoxNode {
  type: 'box';
  /** Display name (box.def #TITLE if present, else the `dtxfiles.`
   * suffix if present, else the raw folder-name segment; "/" for root). */
  name: string;
  /** Absolute path (relative to the backend root). Stable across
   * re-scans; used as the cache key for breadcrumb restoration. */
  path: string;
  parent: BoxNode | null;
  children: LibraryNode[];
  /** `#FONTCOLOR` from box.def, hex string like "#0099FF". UI tints
   * the focused row with this. */
  fontColor?: string;
  /** `#COMMENT` from box.def. Not currently rendered anywhere but
   * preserved across cache round-trips so future UI can use it. */
  comment?: string;
  /** `#PREIMAGE` path relative to this box's folder. Cover art for
   * the box itself (vs. a song's cover). */
  preimage?: string;
  /** True if this box was explicitly declared via `dtxfiles.` folder
   * prefix or a `box.def` file. Shields the box from the single-child
   * hoist rule — the author wanted this folder visible even if it
   * only contains one song. */
  explicit?: boolean;
}

export interface SongNode {
  type: 'song';
  entry: SongEntry;
  parent: BoxNode;
}

export type LibraryNode = BoxNode | SongNode;

export interface SongIndex {
  rootPath: string;
  /** Tree root. All boxes / songs reachable from here; DTXmania-style drill. */
  root: BoxNode;
  /** Flat list of every SongEntry, for callers that don't care about folder
   * structure (e.g. the legacy song-list UI pre-wheel rewrite). Populated as
   * a pre-order DFS of `root`. */
  songs: SongEntry[];
  errors: ScanError[];
}

export interface ScanError {
  path: string;
  message: string;
}

export interface ScanOptions {
  /** Subdirectory names to skip (case-insensitive). Default skips common noise. */
  skipDirs?: string[];
  /** Max recursion depth (root = 0). Default 12. */
  maxDepth?: number;
  /**
   * When true (default), read each .dtx header after detection and fill in
   * `chart.drumLevel` / `chart.bpm` and `song.artist` / `song.genre`. Costs
   * one read per chart; for very large libraries with cold FS caches you
   * may want to disable and parse lazily on selection.
   */
  parseMeta?: boolean;
  /**
   * Called during the meta-parse phase once per song with
   * `(songsDone, songsTotal)`. Fires from 0/N up through N/N. Gives the UI
   * something to show while a Quest 3 cold scan churns through header
   * reads.
   */
  onMetaProgress?: (done: number, total: number) => void;
  /**
   * Called during the directory-walk phase once per `listDir` call with
   * `(dirsScanned, songsFoundSoFar)`. Total isn't known while walking
   * (that's what we're walking to find out), so this is just two running
   * counters. On Quest 3 a large library's walk alone can take tens of
   * seconds and `onMetaProgress` can't fire yet — this keeps the UI from
   * looking stuck on the opening frame.
   */
  onWalkProgress?: (dirsScanned: number, songsFound: number) => void;
  /**
   * Maximum in-flight backend I/O calls (listDir / readText). Above 1 the
   * walk runs sibling subdirectories and meta-parse reads in parallel;
   * on Quest 3's File System Access API this turns the cold scan from a
   * latency-bound serial chain into a throughput-bound batch. Default 6
   * — empirically the knee between diminishing returns and the FSA
   * backend queueing up. Set to 1 to restore fully sequential behaviour.
   */
  concurrency?: number;
}

const DEFAULT_SKIP_DIRS = new Set(['system', '$recycle.bin', 'node_modules', '.git']);

export class SongScanner {
  private readonly skipDirs: Set<string>;
  private readonly maxDepth: number;
  private readonly parseMeta: boolean;
  private readonly onMetaProgress: ((done: number, total: number) => void) | undefined;
  private readonly onWalkProgress:
    | ((dirsScanned: number, songsFound: number) => void)
    | undefined;
  private readonly sem: Semaphore;
  private dirsScanned = 0;
  private songsFound = 0;

  constructor(private readonly fs: FileSystemBackend, options: ScanOptions = {}) {
    this.skipDirs = new Set(
      (options.skipDirs ?? Array.from(DEFAULT_SKIP_DIRS)).map((s) => s.toLowerCase())
    );
    this.maxDepth = options.maxDepth ?? 12;
    this.parseMeta = options.parseMeta ?? true;
    this.onMetaProgress = options.onMetaProgress;
    this.onWalkProgress = options.onWalkProgress;
    this.sem = new Semaphore(Math.max(1, options.concurrency ?? 6));
  }

  async scan(rootPath: string): Promise<SongIndex> {
    const errors: ScanError[] = [];
    const root: BoxNode = {
      type: 'box',
      name: '/',
      path: rootPath,
      parent: null,
      children: [],
    };
    // Reset walk counters so re-using one SongScanner for a second scan
    // doesn't accumulate numbers across calls.
    this.dirsScanned = 0;
    this.songsFound = 0;
    this.onWalkProgress?.(0, 0);
    await this.walk(root, 0, errors);
    const songs = flattenSongs(root);
    if (this.parseMeta) {
      await this.fillAllMeta(songs, errors);
    }
    return { rootPath, root, songs, errors };
  }

  // Gated I/O: only the actual backend call holds a semaphore slot, not
  // the surrounding recursion. Otherwise deeply nested walks all hold
  // slots while awaiting children and deadlock the pool.
  private listDir(path: string): Promise<DirEntry[]> {
    return this.sem.run(() => this.fs.listDir(path));
  }
  private readText(path: string, encoding?: string): Promise<string> {
    return this.sem.run(() => this.fs.readText(path, encoding));
  }

  private async fillAllMeta(songs: SongEntry[], errors: ScanError[]): Promise<void> {
    const total = songs.length;
    this.onMetaProgress?.(0, total);
    if (total === 0) return;
    let done = 0;
    // Parallel across songs; within a song the 1-5 charts run sequentially
    // (they cross-populate the same SongEntry fields, and the parallelism
    // win comes from songs-level fanout anyway).
    await Promise.all(
      songs.map(async (song) => {
        await this.fillSongMeta(song, errors);
        done++;
        this.onMetaProgress?.(done, total);
      })
    );
  }

  private async fillSongMeta(song: SongEntry, errors: ScanError[]): Promise<void> {
    for (const chart of song.charts) {
      try {
        const text = await this.readText(chart.chartPath);
        const parsed = parseDtx(text);
        chart.drumLevel = parsed.drumLevel;
        chart.bpm = parsed.baseBpm;
        if (song.artist === undefined && parsed.artist) song.artist = parsed.artist;
        if (song.genre === undefined && parsed.genre) song.genre = parsed.genre;
        if (song.bpm === undefined) song.bpm = parsed.baseBpm;
        // Preview/preimage/comment are per-song (same across difficulties),
        // so the first chart that declares them wins.
        if (song.preview === undefined && parsed.preview) song.preview = parsed.preview;
        if (song.preimage === undefined && parsed.preimage) song.preimage = parsed.preimage;
        if (song.comment === undefined && parsed.comment) song.comment = parsed.comment;
      } catch (e) {
        errors.push({ path: chart.chartPath, message: errorMessage(e) });
      }
    }
  }

  private async walk(
    box: BoxNode,
    depth: number,
    errors: ScanError[]
  ): Promise<void> {
    if (depth > this.maxDepth) return;

    let entries: DirEntry[];
    try {
      entries = await this.listDir(box.path);
    } catch (e) {
      errors.push({ path: box.path, message: errorMessage(e) });
      return;
    }
    this.dirsScanned++;
    this.onWalkProgress?.(this.dirsScanned, this.songsFound);

    // Single pass over entries: bucket into set.def / box.def / .dtx /
    // subdirs, and build a lowercase fileSet for O(1) existence checks
    // against set.def chart references later. This replaces three
    // separate loops + a `fs.exists` per referenced chart.
    let setDefEntry: DirEntry | undefined;
    let boxDefEntry: DirEntry | undefined;
    const dtxFiles: DirEntry[] = [];
    const subdirs: DirEntry[] = [];
    const fileSet = new Set<string>();
    for (const entry of entries) {
      const lower = entry.name.toLowerCase();
      if (entry.isFile) {
        fileSet.add(lower);
        if (lower === 'set.def') setDefEntry = entry;
        else if (lower === 'box.def') boxDefEntry = entry;
        else if (extname(entry.name) === '.dtx') dtxFiles.push(entry);
      } else if (entry.isDirectory) {
        if (!this.skipDirs.has(lower)) subdirs.push(entry);
      }
    }

    // box.def metadata (found in THIS listDir — no separate probe pass).
    // Apply before recursion so hoist logic sees the correct `explicit`
    // flag, and before children are populated so the order of side
    // effects matches the old two-pass implementation.
    if (boxDefEntry) {
      try {
        const text = await this.readText(boxDefEntry.path, 'shift-jis');
        const meta = parseBoxDef(text);
        applyBoxDefMeta(box, meta);
      } catch (e) {
        errors.push({ path: boxDefEntry.path, message: errorMessage(e) });
      }
    }

    const pushSong = (entry: SongEntry): void => {
      box.children.push({ type: 'song', entry, parent: box });
      this.songsFound++;
    };

    if (setDefEntry) {
      let pushedFromSetDef = 0;
      try {
        const text = await this.readText(setDefEntry.path, 'shift-jis');
        const blocks = parseSetDef(text);
        for (const block of blocks) {
          const song = blockToSong(block, box.path);
          // Existence check: if the chart is in this directory (the
          // overwhelmingly common case for set.def) use the O(1)
          // fileSet we just built. If it references a subpath fall
          // back to the backend's exists() — rare enough to eat the
          // round trip.
          const survivingCharts: ChartEntry[] = [];
          for (const chart of song.charts) {
            if (await this.chartExists(chart.chartPath, box.path, fileSet)) {
              survivingCharts.push(chart);
            }
          }
          if (survivingCharts.length > 0) {
            song.charts = survivingCharts;
            pushSong(song);
            pushedFromSetDef++;
          }
        }
      } catch (e) {
        errors.push({ path: setDefEntry.path, message: errorMessage(e) });
      }

      // If the set.def yielded nothing usable (malformed file, broken chart
      // references, wrong case on a case-sensitive FS), fall through to a
      // plain .dtx scan so the folder still shows up in the library.
      if (pushedFromSetDef === 0) {
        for (const entry of dtxFiles) {
          pushSong(singleDtxToSong(entry, box.path));
        }
      }
    } else {
      // No set.def: collect .dtx files as individual songs.
      for (const entry of dtxFiles) {
        pushSong(singleDtxToSong(entry, box.path));
      }
    }

    // Recurse into subdirectories. Each becomes a candidate BoxNode; we
    // prune it in three ways so the wheel doesn't grow dead / redundant
    // folders:
    //   - 0 descendants → drop (empty dir)
    //   - exactly 1 descendant → "hoist" that descendant into our
    //     own children instead, eliminating a pointless single-entry
    //     wrapper. Matches DTXmania's behaviour for set.def packs that
    //     live inside a plain folder (the pack's one song would otherwise
    //     appear as Songs → FolderName → OneSong, an obvious dead layer).
    //     Cascades naturally: if the lifted descendant is itself a box
    //     with exactly one child after recursion, its parent's pushing
    //     step will hoist that too.
    //   - ≥2 descendants → keep the box.
    //
    // Subdir walks run concurrently through the shared semaphore; we
    // pre-allocate subBoxes in filesystem order so children commit back
    // in the same order regardless of which walk returns first. Commit
    // order is what feeds flattenSongs / the song-wheel, and scan-cache
    // keys depend on it being deterministic.
    const subBoxes: BoxNode[] = subdirs.map((entry) => {
      const subBox: BoxNode = {
        type: 'box',
        name: entry.name,
        path: entry.path,
        parent: box,
        children: [],
      };
      // `dtxfiles.` prefix is purely a filename convention, no I/O
      // needed. Apply it up front so both the name and explicit flag
      // are settled before walk's box.def discovery (which can override
      // the title).
      const prefix = 'dtxfiles.';
      if (entry.name.toLowerCase().startsWith(prefix)) {
        subBox.explicit = true;
        subBox.name = entry.name.slice(prefix.length) || entry.name;
      }
      return subBox;
    });

    await Promise.all(
      subBoxes.map((subBox) => this.walk(subBox, depth + 1, errors))
    );

    for (const subBox of subBoxes) {
      if (subBox.children.length === 0) continue;
      if (subBox.children.length === 1 && !subBox.explicit) {
        // Implicit single-child folders collapse into the parent so
        // set.def packs don't create a "box → one song" dead layer.
        // Explicit-marked boxes always survive — the author chose to
        // surface them.
        const only = subBox.children[0]!;
        only.parent = box;
        box.children.push(only);
      } else {
        box.children.push(subBox);
      }
    }
  }

  private async chartExists(
    chartPath: string,
    folderPath: string,
    fileSet: Set<string>
  ): Promise<boolean> {
    // Same-directory chart: O(1) lookup against the listDir we already
    // did. Covers the common set.def shape (every #LnFILE is a bare
    // filename in the same folder).
    if (dirname(chartPath) === folderPath) {
      return fileSet.has(basename(chartPath).toLowerCase());
    }
    // Sub-path chart (rare): fall back to the backend. Still goes
    // through the semaphore so it doesn't stampede parallel walks.
    return this.sem.run(() => this.fs.exists(chartPath));
  }
}

function applyBoxDefMeta(box: BoxNode, meta: BoxDefMeta): void {
  // Presence of a parsed box.def always flips the box to explicit, even
  // if none of the optional fields are set — matches the legacy
  // applyExplicitBoxMarkers behaviour.
  box.explicit = true;
  if (meta.title) box.name = meta.title;
  if (meta.fontColor) box.fontColor = meta.fontColor;
  if (meta.comment) box.comment = meta.comment;
  if (meta.preimage) box.preimage = meta.preimage;
}

/**
 * Minimal async semaphore. Only gates the backend I/O call itself
 * (listDir / readText / exists) — NOT the surrounding recursion, so
 * deeply nested walks can't deadlock the pool by holding a slot while
 * awaiting their children.
 */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/** Pre-order DFS collecting every SongEntry under the given root. Preserves
 * filesystem-walk order so callers that previously relied on the flat list
 * see no behavioural change. */
export function flattenSongs(root: BoxNode): SongEntry[] {
  const out: SongEntry[] = [];
  const stack: LibraryNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'song') {
      out.push(node.entry);
    } else {
      // Iterate children in reverse so pre-order LTR matches original walk.
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]!);
      }
    }
  }
  return out;
}

function blockToSong(block: SetDefBlock, folderPath: string): SongEntry {
  const charts: ChartEntry[] = [];
  for (let slot = 0; slot < 5; slot++) {
    const file = block.files[slot];
    const label = block.labels[slot];
    if (!file || !label) continue;
    charts.push({
      slot,
      label,
      chartPath: joinPath(folderPath, file),
    });
  }
  const song: SongEntry = {
    title: block.title,
    folderPath,
    fromSetDef: true,
    charts,
  };
  if (block.fontColor !== undefined) {
    song.fontColor = block.fontColor;
  }
  return song;
}

function singleDtxToSong(entry: DirEntry, folderPath: string): SongEntry {
  const stem = entry.name.replace(/\.dtx$/i, '');
  return {
    title: stem,
    folderPath,
    fromSetDef: false,
    charts: [{ slot: 0, label: 'DTX', chartPath: entry.path }],
  };
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Persisted scan-cache schema. Bumped whenever SongEntry, ChartEntry, or
 * BoxNode shape changes in a way that would make an old cache produce
 * wrong-looking rows. Consumers should throw-away caches whose version !==
 * INDEX_CACHE_VERSION instead of trying to migrate.
 */
export const INDEX_CACHE_VERSION = 2;

/** JSON-friendly mirror of the BoxNode / SongNode tree. Strips parent
 * refs (they're reconstructed on load) so the shape is structured-
 * cloneable and IDB-storable without cycles. */
export interface SerializedIndex {
  version: number;
  rootPath: string;
  root: SerializedBox;
  errors: ScanError[];
  /** Wall-clock epoch ms when the scan completed. UI can display it so
   * the player knows how stale the cached view is. */
  scannedAtMs: number;
}

interface SerializedBox {
  kind: 'box';
  name: string;
  path: string;
  children: Array<SerializedBox | SerializedSong>;
  // Optional metadata from box.def / `dtxfiles.` prefix. Persisted so
  // the UI tint + breadcrumb survive cache hydration.
  fontColor?: string;
  comment?: string;
  preimage?: string;
  explicit?: boolean;
}

interface SerializedSong {
  kind: 'song';
  entry: SongEntry;
}

export function serializeIndex(index: SongIndex): SerializedIndex {
  return {
    version: INDEX_CACHE_VERSION,
    rootPath: index.rootPath,
    root: serializeBox(index.root),
    errors: index.errors,
    scannedAtMs: Date.now(),
  };
}

function serializeBox(box: BoxNode): SerializedBox {
  const children: SerializedBox['children'] = [];
  for (const child of box.children) {
    if (child.type === 'song') {
      children.push({ kind: 'song', entry: child.entry });
    } else {
      children.push(serializeBox(child));
    }
  }
  const out: SerializedBox = {
    kind: 'box',
    name: box.name,
    path: box.path,
    children,
  };
  if (box.fontColor !== undefined) out.fontColor = box.fontColor;
  if (box.comment !== undefined) out.comment = box.comment;
  if (box.preimage !== undefined) out.preimage = box.preimage;
  if (box.explicit) out.explicit = true;
  return out;
}

/**
 * Rebuild a live SongIndex (with parent refs) from a persisted
 * SerializedIndex. Throws if the version doesn't match the current
 * code's INDEX_CACHE_VERSION — caller should clear the cache and do a
 * fresh scan in that case.
 */
export function deserializeIndex(s: SerializedIndex): SongIndex {
  if (s.version !== INDEX_CACHE_VERSION) {
    throw new Error(
      `scan cache version ${s.version} does not match current ${INDEX_CACHE_VERSION}`
    );
  }
  const root = deserializeBox(s.root, null);
  return {
    rootPath: s.rootPath,
    root,
    songs: flattenSongs(root),
    errors: s.errors,
  };
}

function deserializeBox(s: SerializedBox, parent: BoxNode | null): BoxNode {
  const box: BoxNode = {
    type: 'box',
    name: s.name,
    path: s.path,
    parent,
    children: [],
  };
  if (s.fontColor !== undefined) box.fontColor = s.fontColor;
  if (s.comment !== undefined) box.comment = s.comment;
  if (s.preimage !== undefined) box.preimage = s.preimage;
  if (s.explicit) box.explicit = true;
  for (const child of s.children) {
    if (child.kind === 'song') {
      box.children.push({ type: 'song', entry: child.entry, parent: box });
    } else {
      box.children.push(deserializeBox(child, box));
    }
  }
  return box;
}
