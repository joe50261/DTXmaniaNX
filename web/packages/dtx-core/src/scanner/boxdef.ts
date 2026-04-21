/**
 * Minimal parser for DTXmania's `box.def` file. Lives at the root of a
 * folder that the author wants surfaced as a browsable box in the
 * song-select wheel. Matches the small subset of directives our
 * song-select UI can actually render:
 *
 *   #TITLE        display name (overrides the folder name)
 *   #ARTIST       box-level artist credit
 *   #GENRE        box-level genre tag
 *   #COMMENT      tooltip / comment
 *   #FONTCOLOR    hex colour (e.g. #FFAA00) used to tint the row
 *   #PREIMAGE     cover art path, relative to the box folder
 *
 * Reference: DTXMania Code/Score,Song/CBoxDef.cs. Unknown directives,
 * blank lines, and `;`-prefixed comments are silently skipped.
 *
 * Input is expected to be already-decoded Shift-JIS text (the scanner
 * reads it via `backend.readText(path, 'shift-jis')`).
 */

export interface BoxDefMeta {
  title?: string;
  artist?: string;
  genre?: string;
  comment?: string;
  /** Hex colour string as authored — no normalisation. Caller should
   * treat empty / obviously-invalid values as missing. */
  fontColor?: string;
  /** Path to the cover image, relative to the box's own folder. */
  preimage?: string;
}

const COMMAND = /^#\s*([A-Za-z_][A-Za-z0-9_]*)\s*[:=\s]\s*(.*?)\s*$/;

export function parseBoxDef(text: string): BoxDefMeta {
  const out: BoxDefMeta = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = stripBOM(raw).trim();
    if (line.length === 0) continue;
    if (line.startsWith(';')) continue;
    if (!line.startsWith('#')) continue;
    const m = COMMAND.exec(line);
    if (!m) continue;
    const key = m[1]!.toUpperCase();
    const value = (m[2] ?? '').trim();
    if (value.length === 0) continue;
    switch (key) {
      case 'TITLE':
        out.title = value;
        break;
      case 'ARTIST':
        out.artist = value;
        break;
      case 'GENRE':
        out.genre = value;
        break;
      case 'COMMENT':
        out.comment = value;
        break;
      case 'FONTCOLOR':
      case 'COLOR':
        out.fontColor = value;
        break;
      case 'PREIMAGE':
        out.preimage = value;
        break;
      // intentionally ignore everything else (SKINPATH, hit ranges,
      // PREMOVIE, etc.) — not consumed by our UI.
    }
  }
  return out;
}

function stripBOM(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
