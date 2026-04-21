import { parseDtx } from '../parser/parser.js';
import { extname, joinPath, type DirEntry, type FileSystemBackend } from './fs-backend.js';
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
  /** Display name (last path segment for subfolders; "/" for root). */
  name: string;
  /** Absolute path (relative to the backend root). */
  path: string;
  parent: BoxNode | null;
  children: LibraryNode[];
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
}

const DEFAULT_SKIP_DIRS = new Set(['system', '$recycle.bin', 'node_modules', '.git']);

export class SongScanner {
  private readonly skipDirs: Set<string>;
  private readonly maxDepth: number;
  private readonly parseMeta: boolean;

  constructor(private readonly fs: FileSystemBackend, options: ScanOptions = {}) {
    this.skipDirs = new Set(
      (options.skipDirs ?? Array.from(DEFAULT_SKIP_DIRS)).map((s) => s.toLowerCase())
    );
    this.maxDepth = options.maxDepth ?? 12;
    this.parseMeta = options.parseMeta ?? true;
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
    await this.walk(root, 0, errors);
    const songs = flattenSongs(root);
    if (this.parseMeta) {
      for (const song of songs) {
        await this.fillSongMeta(song, errors);
      }
    }
    return { rootPath, root, songs, errors };
  }

  private async fillSongMeta(song: SongEntry, errors: ScanError[]): Promise<void> {
    for (const chart of song.charts) {
      try {
        const text = await this.fs.readText(chart.chartPath);
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
      entries = await this.fs.listDir(box.path);
    } catch (e) {
      errors.push({ path: box.path, message: errorMessage(e) });
      return;
    }

    const setDefEntry = entries.find(
      (e) => e.isFile && e.name.toLowerCase() === 'set.def'
    );

    const pushSong = (entry: SongEntry): void => {
      box.children.push({ type: 'song', entry, parent: box });
    };

    if (setDefEntry) {
      let pushedFromSetDef = 0;
      try {
        const text = await this.fs.readText(setDefEntry.path, 'shift-jis');
        const blocks = parseSetDef(text);
        for (const block of blocks) {
          const song = blockToSong(block, box.path);
          // Only add the song if at least one referenced chart actually exists.
          const survivingCharts: ChartEntry[] = [];
          for (const chart of song.charts) {
            if (await this.fs.exists(chart.chartPath)) {
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
        for (const entry of entries) {
          if (!entry.isFile) continue;
          if (extname(entry.name) !== '.dtx') continue;
          pushSong(singleDtxToSong(entry, box.path));
        }
      }
    } else {
      // No set.def: collect .dtx files as individual songs.
      for (const entry of entries) {
        if (!entry.isFile) continue;
        if (extname(entry.name) !== '.dtx') continue;
        pushSong(singleDtxToSong(entry, box.path));
      }
    }

    // Recurse into subdirectories. Each becomes a child BoxNode; we only
    // keep it attached if it ends up with any descendants, otherwise empty
    // folders would clutter the wheel with dead entries.
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      if (this.skipDirs.has(entry.name.toLowerCase())) continue;
      const subBox: BoxNode = {
        type: 'box',
        name: entry.name,
        path: entry.path,
        parent: box,
        children: [],
      };
      await this.walk(subBox, depth + 1, errors);
      if (subBox.children.length > 0) {
        box.children.push(subBox);
      }
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
