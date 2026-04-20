/**
 * set.def parser. Ported from DTXMania/Code/Score,Song/CSetDef.cs.
 *
 * A set.def groups up to 5 difficulty charts for one song. One file may
 * contain multiple blocks (each starting with a fresh #TITLE).
 *
 * Example:
 *   #TITLE My Song
 *   #L1LABEL NOVICE
 *   #L1FILE  nov.dtx
 *   #L2LABEL REGULAR
 *   #L2FILE  reg.dtx
 */

export const SET_DEF_DEFAULT_LABELS = ['NOVICE', 'REGULAR', 'EXPERT', 'MASTER', 'DTXMania'] as const;

export interface SetDefBlock {
  title: string;
  /** Hex color like "#RRGGBB" (set.def's FONTCOLOR). Undefined if not specified. */
  fontColor?: string;
  /** 5 slots; null means "no chart at this difficulty". */
  files: (string | null)[];
  labels: (string | null)[];
}

export function parseSetDef(text: string): SetDefBlock[] {
  const blocks: SetDefBlock[] = [];
  let current = createEmptyBlock();
  let currentInUse = false;

  const flush = () => {
    if (!currentInUse) return;
    applyDefaultLabels(current);
    dropLabelsWithoutFiles(current);
    blocks.push(current);
    current = createEmptyBlock();
    currentInUse = false;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const stripped = stripCommentsAndBOM(rawLine);
    const line = stripped.replace(/^[\s]+/, '');
    if (line.length === 0 || !line.startsWith('#')) continue;

    const upper = line.toUpperCase();

    if (upper.startsWith('#TITLE')) {
      if (currentInUse) flush();
      current.title = extractValue(line, 6);
      currentInUse = true;
      continue;
    }
    if (upper.startsWith('#FONTCOLOR')) {
      const val = extractValue(line, 10).replace(/^#/, '');
      if (val.length > 0) current.fontColor = `#${val}`;
      currentInUse = true;
      continue;
    }

    const fileMatch = /^#L([1-5])FILE/i.exec(line);
    if (fileMatch) {
      const idx = Number(fileMatch[1]) - 1;
      current.files[idx] = extractValue(line, fileMatch[0].length);
      currentInUse = true;
      continue;
    }

    const labelMatch = /^#L([1-5])LABEL/i.exec(line);
    if (labelMatch) {
      const idx = Number(labelMatch[1]) - 1;
      current.labels[idx] = extractValue(line, labelMatch[0].length);
      currentInUse = true;
      continue;
    }
  }

  flush();
  return blocks;
}

function createEmptyBlock(): SetDefBlock {
  return {
    title: '',
    files: [null, null, null, null, null],
    labels: [null, null, null, null, null],
  };
}

function stripCommentsAndBOM(s: string): string {
  let out = s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  const ci = out.indexOf(';');
  if (ci >= 0) out = out.slice(0, ci);
  return out.trimEnd();
}

/** Strips the `:`, whitespace and optional colon that sits after the command keyword. */
function extractValue(line: string, keywordLength: number): string {
  return line.slice(keywordLength).replace(/^[\s:]+/, '').trim();
}

function applyDefaultLabels(block: SetDefBlock): void {
  for (let i = 0; i < 5; i++) {
    const file = block.files[i];
    const label = block.labels[i];
    if (file && file.length > 0 && (!label || label.length === 0)) {
      block.labels[i] = SET_DEF_DEFAULT_LABELS[i]!;
    }
  }
}

function dropLabelsWithoutFiles(block: SetDefBlock): void {
  for (let i = 0; i < 5; i++) {
    const file = block.files[i];
    const label = block.labels[i];
    if (label && label.length > 0 && (!file || file.length === 0)) {
      block.labels[i] = null;
    }
  }
}
