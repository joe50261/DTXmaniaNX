import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Pixel-content tests for the placeholder skin set.
 *
 * The dimension test (`skin-assets.test.ts`) confirms each PNG decodes
 * and has the correct width/height. This file goes a layer deeper: for
 * the asset regions where text labels were silently absent in earlier
 * commits (uppercase glyphs missing from `GLYPHS` →
 * `drawText('PERFECT')` etc. rendered as no-ops), we count opaque
 * pixels in the expected text bounding box and assert non-trivial ink.
 *
 * "Bigger PNG file size" is not a real check — compressed-zero
 * regressions can still grow a file. Counting opaque pixels in a
 * specific text rect is. ~30–50 % fill is typical for 5×7 bitmap text;
 * we use a 10 % floor so hand-tweaked spacing / future font tweaks
 * have headroom.
 */

const SKIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'skin');

interface Pixmap {
  width: number;
  height: number;
  data: Buffer;
}

function decodePng(file: string): Pixmap {
  const buf = readFileSync(join(SKIN_DIR, file));
  let off = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IHDR') {
      width = buf.readUInt32BE(off + 8);
      height = buf.readUInt32BE(off + 12);
    } else if (type === 'IDAT') {
      idat.push(buf.slice(off + 8, off + 8 + len));
    } else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  // Generator always emits filter=0 (None) per scanline.
  const pixels = Buffer.alloc(width * height * 4);
  let src = 0, dst = 0;
  for (let y = 0; y < height; y++) {
    if (raw[src++] !== 0) throw new Error(`${file}: unsupported PNG filter at row ${y}`);
    raw.copy(pixels, dst, src, src + width * 4);
    src += width * 4;
    dst += width * 4;
  }
  return { width, height, data: pixels };
}

function inkCount(p: Pixmap, x0: number, y0: number, x1: number, y1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if ((p.data[(y * p.width + x) * 4 + 3] ?? 0) > 0) n++;
    }
  }
  return n;
}

/** Per-bounding-box assertion: at least `floor` fraction of pixels are
 *  opaque. The bbox is the text glyph rect (5×7 cell × scale, multiplied
 *  by char count + spacing). */
function assertInk(file: string, label: string, p: Pixmap, x: number, y: number, w: number, h: number, floor = 0.10): void {
  const ink = inkCount(p, x, y, x + w, y + h);
  const ratio = ink / (w * h);
  if (ratio < floor) {
    throw new Error(`${file}: '${label}' bbox (${x},${y}) ${w}×${h} has ${ink} ink px (${(ratio*100).toFixed(1)}% < ${floor*100}%)`);
  }
}

describe('skin pixel content — text labels actually render', () => {
  it('ScreenPlay judge strings 1.png paints PERFECT / GREAT / GOOD', () => {
    const p = decodePng('ScreenPlay judge strings 1.png');
    // Per makeJudgeStrings: 5×7 glyph at scale 2 → 14px tall.
    // textWidth = chars * (5+1) * 2 - 2. x_start = (128 - textWidth) / 2.
    // y baseline = row.y + (42 - 14) / 2 = row.y + 14.
    assertInk('judge', 'PERFECT', p, 23, 14, 82, 14);  // 7 chars
    assertInk('judge', 'GREAT',   p, 35, 57, 58, 14);  // 5 chars
    assertInk('judge', 'GOOD',    p, 41, 100, 46, 14); // 4 chars
    // Sanity: gaps between labels are empty.
    expect(inkCount(p, 0, 28, p.width, 43)).toBe(0);
    expect(inkCount(p, 0, 71, p.width, 86)).toBe(0);
  });

  it('5_header panel.png paints SONG SELECT (the stage chrome label)', () => {
    const p = decodePng('5_header panel.png');
    // Per makeHeaderPanel: drawText('SONG SELECT', 40, 30, 4, COL.textLight).
    // 11 chars × scale 4: width = 11*(5+1)*4 - 4 = 260. height = 7*4 = 28.
    assertInk('header', 'SONG SELECT', p, 40, 30, 260, 28);
  });

  it('7_pads.png paints lane labels on each pad', () => {
    const p = decodePng('7_pads.png');
    // Per paintPad: each 96×96 cell, label at gx + 48 - w/2, gy + 42, scale 2.
    // 2-char label at scale 2: w = 2*6*2 - 2 = 22. So x = gx + 48 - 11 = gx + 37.
    // Sample LC (top-left cell, gx=0 gy=0) and BD (row 2, col 0, gx=0 gy=192).
    assertInk('pads', 'LC label', p, 37, 42, 22, 14);
    assertInk('pads', 'BD label', p, 37, 234, 22, 14);
  });

  it('5_skill icon.png paints rank labels (SS / S / FC / EX etc.)', () => {
    const p = decodePng('5_skill icon.png');
    // Per makeSkillIcon: 9 cells × 35 wide, 31×31 inner box.
    // Labels at scale 2, x = i*35 + (35 - w)/2 — floor in drawText.
    // SS (i=0, w=22 → x=6). EX (i=8, w=22 → x=8*35+6=286).
    assertInk('skill icon', 'SS', p, 6, 10, 22, 14);
    assertInk('skill icon', 'EX', p, 286, 10, 22, 14);
  });
});
