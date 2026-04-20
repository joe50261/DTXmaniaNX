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
}

export interface SongIndex {
  rootPath: string;
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
}

const DEFAULT_SKIP_DIRS = new Set(['system', '$recycle.bin', 'node_modules', '.git']);

export class SongScanner {
  private readonly skipDirs: Set<string>;
  private readonly maxDepth: number;

  constructor(private readonly fs: FileSystemBackend, options: ScanOptions = {}) {
    this.skipDirs = new Set(
      (options.skipDirs ?? Array.from(DEFAULT_SKIP_DIRS)).map((s) => s.toLowerCase())
    );
    this.maxDepth = options.maxDepth ?? 12;
  }

  async scan(rootPath: string): Promise<SongIndex> {
    const songs: SongEntry[] = [];
    const errors: ScanError[] = [];
    await this.walk(rootPath, 0, songs, errors);
    return { rootPath, songs, errors };
  }

  private async walk(
    path: string,
    depth: number,
    songs: SongEntry[],
    errors: ScanError[]
  ): Promise<void> {
    if (depth > this.maxDepth) return;

    let entries: DirEntry[];
    try {
      entries = await this.fs.listDir(path);
    } catch (e) {
      errors.push({ path, message: errorMessage(e) });
      return;
    }

    const setDefEntry = entries.find(
      (e) => e.isFile && e.name.toLowerCase() === 'set.def'
    );

    if (setDefEntry) {
      try {
        const text = await this.fs.readText(setDefEntry.path, 'shift-jis');
        const blocks = parseSetDef(text);
        for (const block of blocks) {
          const song = blockToSong(block, path);
          // Only add the song if at least one referenced chart actually exists.
          const survivingCharts: ChartEntry[] = [];
          for (const chart of song.charts) {
            if (await this.fs.exists(chart.chartPath)) {
              survivingCharts.push(chart);
            }
          }
          if (survivingCharts.length > 0) {
            song.charts = survivingCharts;
            songs.push(song);
          }
        }
      } catch (e) {
        errors.push({ path: setDefEntry.path, message: errorMessage(e) });
      }
    } else {
      // No set.def: collect .dtx files as individual songs.
      for (const entry of entries) {
        if (!entry.isFile) continue;
        if (extname(entry.name) !== '.dtx') continue;
        songs.push(singleDtxToSong(entry, path));
      }
    }

    // Recurse into subdirectories.
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      if (this.skipDirs.has(entry.name.toLowerCase())) continue;
      await this.walk(entry.path, depth + 1, songs, errors);
    }
  }
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
