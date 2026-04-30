#!/usr/bin/env node
// Generates the in-tree replacement skin assets shipped under
// public/skin/. We do NOT copy from the C# Runtime/System/Graphics/
// tree. Everything below is original geometric placeholder art
// produced procedurally with zero third-party dependencies.
//
// Run: `node scripts/generate-skin.mjs` from packages/app-web/.
//
// All atlas dimensions and glyph layouts must stay in sync with the
// consumers under src/ (chip-atlas.ts, pad-atlas.ts, judge-atlas.ts,
// song-select-canvas.ts drawLevelGlyphs / drawBpmGlyphs /
// drawAchievementGlyphs).

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public', 'skin');
mkdirSync(OUT, { recursive: true });

// ─── PNG encoder ────────────────────────────────────────────────────
// 8-bit RGBA. Pure scanlines (filter byte 0 per row), single IDAT.

// Inline CRC32 — `zlib.crc32` exists but requires Node 22.2+, and
// web/package.json declares `>=22.0.0`. A 256-entry table keeps this
// self-contained and portable across the whole supported range.
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const head = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(head), 0);
  return Buffer.concat([len, head, c]);
}

function encodePNG(canvas) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(canvas.w, 0);
  ihdr.writeUInt32BE(canvas.h, 4);
  ihdr[8] = 8;            // bit depth
  ihdr[9] = 6;            // color type = RGBA
  ihdr[10] = 0;           // compression
  ihdr[11] = 0;           // filter
  ihdr[12] = 0;           // interlace
  const stride = canvas.w * 4;
  const filtered = Buffer.alloc((stride + 1) * canvas.h);
  for (let y = 0; y < canvas.h; y++) {
    filtered[y * (stride + 1)] = 0; // filter type None
    canvas.data.copy(filtered, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(filtered, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Canvas helpers ─────────────────────────────────────────────────

function createCanvas(w, h, bg = [0, 0, 0, 0]) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = bg[0];
    data[i * 4 + 1] = bg[1];
    data[i * 4 + 2] = bg[2];
    data[i * 4 + 3] = bg[3];
  }
  return { w, h, data };
}

function setPx(c, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const o = (y * c.w + x) * 4;
  // src-over alpha composite
  const sa = a / 255;
  const da = c.data[o + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) {
    c.data[o] = c.data[o + 1] = c.data[o + 2] = c.data[o + 3] = 0;
    return;
  }
  c.data[o] = Math.round((r * sa + c.data[o] * da * (1 - sa)) / oa);
  c.data[o + 1] = Math.round((g * sa + c.data[o + 1] * da * (1 - sa)) / oa);
  c.data[o + 2] = Math.round((b * sa + c.data[o + 2] * da * (1 - sa)) / oa);
  c.data[o + 3] = Math.round(oa * 255);
}

function fillRect(c, x, y, w, h, color) {
  const [r, g, b, a = 255] = color;
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(c.w, Math.ceil(x + w));
  const y1 = Math.min(c.h, Math.ceil(y + h));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      setPx(c, px, py, r, g, b, a);
    }
  }
}

function strokeRect(c, x, y, w, h, color, lineW = 1) {
  fillRect(c, x, y, w, lineW, color);
  fillRect(c, x, y + h - lineW, w, lineW, color);
  fillRect(c, x, y, lineW, h, color);
  fillRect(c, x + w - lineW, y, lineW, h, color);
}

function fillRoundedRect(c, x, y, w, h, radius, color) {
  fillRect(c, x + radius, y, w - 2 * radius, h, color);
  fillRect(c, x, y + radius, w, h - 2 * radius, color);
  fillCircle(c, x + radius, y + radius, radius, color);
  fillCircle(c, x + w - radius - 1, y + radius, radius, color);
  fillCircle(c, x + radius, y + h - radius - 1, radius, color);
  fillCircle(c, x + w - radius - 1, y + h - radius - 1, radius, color);
}

function fillCircle(c, cx, cy, r, color) {
  const [rr, gg, bb, aa = 255] = color;
  for (let py = -r; py <= r; py++) {
    for (let px = -r; px <= r; px++) {
      const d = Math.sqrt(px * px + py * py);
      if (d <= r) {
        const edge = Math.max(0, Math.min(1, r - d));
        const a = Math.round(aa * edge);
        if (a > 0) setPx(c, cx + px, cy + py, rr, gg, bb, a);
      }
    }
  }
}

function fillGradientV(c, x, y, w, h, top, bot) {
  for (let py = 0; py < h; py++) {
    const t = h <= 1 ? 0 : py / (h - 1);
    const r = Math.round(top[0] + (bot[0] - top[0]) * t);
    const g = Math.round(top[1] + (bot[1] - top[1]) * t);
    const b = Math.round(top[2] + (bot[2] - top[2]) * t);
    fillRect(c, x, y + py, w, 1, [r, g, b, 255]);
  }
}

// ─── 5×7 bitmap font ────────────────────────────────────────────────
// Hand-rolled glyphs. '#' = pixel on, '.' = off. 5 cols × 7 rows.

const GLYPHS = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  '%': ['##..#', '##.#.', '..#..', '.#.##', '#..##', '.....', '.....'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  // Uppercase A–Z. Without these, every drawText call passing an
  // uppercase string is a silent no-op (`drawGlyph` returns early when
  // the key is missing) — so panel chrome paints but its labels don't.
  'A': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'B': ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  'C': ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  'D': ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  'E': ['#####', '#....', '#....', '###..', '#....', '#....', '#####'],
  'F': ['#####', '#....', '#....', '###..', '#....', '#....', '#....'],
  'G': ['.####', '#....', '#....', '#..##', '#...#', '#...#', '.###.'],
  'H': ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'I': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  'J': ['#####', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  'K': ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  'L': ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  'M': ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
  'N': ['#...#', '##..#', '##..#', '#.#.#', '#..##', '#..##', '#...#'],
  'O': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  'P': ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  'Q': ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  'R': ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  'S': ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  'T': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  'U': ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  'V': ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  'W': ['#...#', '#...#', '#...#', '#...#', '#.#.#', '##.##', '#...#'],
  'X': ['#...#', '.#.#.', '..#..', '..#..', '..#..', '.#.#.', '#...#'],
  'Y': ['#...#', '.#.#.', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  'Z': ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  // Lowercase 'p' kept lowercase to match the BPM-font glyph offset
  // (`drawBpmGlyphs` slices x=132 for 'p').
  'p': ['.....', '.....', '####.', '#...#', '####.', '#....', '#....'],
};

function drawGlyph(c, ch, x, y, scale, color) {
  const g = GLYPHS[ch];
  if (!g) return;
  // Snap to integer pixel grid — callers often centre glyphs with
  // `(cellW - glyphW) / 2`, which is fractional when cellW and glyphW
  // have opposite parity. fillRect's floor/ceil edge handling would
  // otherwise widen each "1×1" glyph pixel to 2×2 at fractional x/y,
  // producing fuzzy oversized text.
  x = Math.floor(x);
  y = Math.floor(y);
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      if (g[row][col] === '#') {
        fillRect(c, x + col * scale, y + row * scale, scale, scale, color);
      }
    }
  }
}

function drawText(c, text, x, y, scale, color, spacing = 1) {
  // Snap baseline to integer pixels for the same reason drawGlyph does
  // (see comment there). cx then advances by integer increments
  // (`(5 + spacing) * scale`) so every glyph stays grid-aligned.
  let cx = Math.floor(x);
  y = Math.floor(y);
  for (const ch of text) {
    drawGlyph(c, ch, cx, y, scale, color);
    cx += (5 + spacing) * scale;
  }
}

function textWidth(text, scale, spacing = 1) {
  return text.length * (5 + spacing) * scale - spacing * scale;
}

// ─── Output helper ──────────────────────────────────────────────────

function write(filename, canvas) {
  const path = join(OUT, filename);
  const buf = encodePNG(canvas);
  return new Promise((resolve, reject) => {
    const ws = createWriteStream(path);
    ws.on('error', reject);
    ws.on('finish', () => resolve(path));
    ws.end(buf);
  });
}

// ─── Palette (intentionally distinct from canonical DTXMania) ──────

const COL = {
  bgDark: [12, 18, 32, 255],
  bgMid: [22, 32, 56, 255],
  panel: [28, 38, 64, 230],
  panelEdge: [80, 110, 180, 255],
  accentTeal: [56, 200, 200, 255],
  accentMagenta: [200, 60, 160, 255],
  accentAmber: [240, 200, 80, 255],
  textLight: [220, 230, 245, 255],
  textDim: [140, 160, 195, 255],
  shadow: [0, 0, 0, 120],
};

// ─── Stage 5 (song select) ──────────────────────────────────────────

async function makeBackground5() {
  const c = createCanvas(1280, 720);
  fillGradientV(c, 0, 0, 1280, 720, [8, 14, 28], [22, 30, 60]);
  // Subtle diagonal stripes for texture.
  for (let i = -720; i < 1280; i += 80) {
    for (let py = 0; py < 720; py++) {
      const px = i + Math.floor(py * 0.4);
      if (px >= 0 && px < 1280) setPx(c, px, py, 255, 255, 255, 6);
    }
  }
  await write('5_background.png', c);
}

function makeBar(focused, kind /* 'score' | 'box' | 'other' */) {
  const c = createCanvas(360, 50);
  const tints = {
    score: focused ? [40, 90, 160, 240] : [20, 35, 70, 220],
    box: focused ? [110, 80, 150, 240] : [55, 40, 80, 220],
    other: focused ? [60, 130, 110, 240] : [30, 60, 55, 220],
  };
  const edge = focused ? COL.accentAmber : COL.panelEdge;
  fillRoundedRect(c, 0, 0, 360, 50, 6, tints[kind]);
  strokeRect(c, 0, 0, 360, 50, edge, focused ? 2 : 1);
  fillRect(c, 8, 8, 6, 34, focused ? COL.accentAmber : COL.accentTeal);
  return c;
}

async function makeBars5() {
  for (const focused of [false, true]) {
    const sfx = focused ? ' selected' : '';
    await write(`5_bar score${sfx}.png`, makeBar(focused, 'score'));
    await write(`5_bar box${sfx}.png`, makeBar(focused, 'box'));
    await write(`5_bar other${sfx}.png`, makeBar(focused, 'other'));
  }
}

async function makePreimagePanel() {
  const c = createCanvas(308, 308);
  fillRoundedRect(c, 0, 0, 308, 308, 6, [16, 22, 40, 255]);
  strokeRect(c, 4, 4, 300, 300, COL.panelEdge, 2);
  await write('5_preimage panel.png', c);
}

async function makePreimageDefault() {
  const c = createCanvas(292, 292);
  fillRect(c, 0, 0, 292, 292, [22, 28, 48, 255]);
  // Diagonal gradient + crosshair.
  for (let y = 0; y < 292; y++) {
    for (let x = 0; x < 292; x++) {
      if ((x + y) % 32 === 0) setPx(c, x, y, 60, 80, 130, 90);
    }
  }
  fillRect(c, 0, 144, 292, 4, [60, 80, 130, 200]);
  fillRect(c, 144, 0, 4, 292, [60, 80, 130, 200]);
  drawText(c, 'NO COVER', 96, 138, 2, COL.textDim);
  await write('5_preimage default.png', c);
}

async function makeStatusPanel() {
  const c = createCanvas(380, 320);
  fillRoundedRect(c, 0, 0, 380, 320, 8, [18, 24, 44, 230]);
  strokeRect(c, 0, 0, 380, 320, COL.panelEdge, 1);
  await write('5_status panel.png', c);
}

async function makeDifficultyPanel() {
  const c = createCanvas(561, 321);
  // Header strip + 5 rows × 3 columns.
  fillRect(c, 0, 0, 561, 321, [12, 18, 32, 240]);
  fillRect(c, 0, 0, 561, 21, [40, 60, 100, 255]);
  drawText(c, 'DR', 60, 6, 1, COL.textLight);
  drawText(c, 'GT', 247, 6, 1, COL.textLight);
  drawText(c, 'BS', 434, 6, 1, COL.textLight);
  const labels = ['BASIC', 'ADVANCED', 'EXTREME', 'MASTER', 'DTX'];
  for (let i = 0; i < 5; i++) {
    const y = 21 + (4 - i) * 60;
    if (i % 2 === 0) fillRect(c, 0, y, 561, 60, [22, 30, 50, 200]);
    drawText(c, labels[i], 4, y + 26, 1, COL.textDim);
    // Column dividers.
    fillRect(c, 187, y, 1, 60, [40, 60, 100, 180]);
    fillRect(c, 374, y, 1, 60, [40, 60, 100, 180]);
  }
  strokeRect(c, 0, 0, 561, 321, COL.panelEdge, 1);
  await write('5_difficulty panel.png', c);
}

async function makeDifficultyFrame() {
  const c = createCanvas(187, 60);
  strokeRect(c, 0, 0, 187, 60, COL.accentMagenta, 2);
  strokeRect(c, 2, 2, 183, 56, [255, 200, 240, 180], 1);
  await write('5_difficulty frame.png', c);
}

// 5_level number.png — sprite font matching drawLevelGlyphs:
//   digits 0..9 at (i*20, 0, 20, 28)
//   '.'    at (200,  0, 10, 28)
async function makeLevelNumber() {
  const c = createCanvas(210, 28);
  // For each digit, draw a 20×28 cell with the glyph centered.
  const scale = 3; // 5×7 → 15×21
  for (let i = 0; i < 10; i++) {
    const ch = String(i);
    const cx = i * 20 + (20 - 5 * scale) / 2;
    const cy = (28 - 7 * scale) / 2;
    drawGlyph(c, ch, cx, cy, scale, COL.accentAmber);
  }
  // '.' cell at x=200, width 10. Cell is 10×28 — center the 5×7 glyph.
  drawGlyph(c, '.', 200 + (10 - 5) / 2, (28 - 7) / 2, 1, COL.accentAmber);
  await write('5_level number.png', c);
}

// 5_BPM.png — small label (Length / BPM stacked).
async function makeBPMLabel() {
  const c = createCanvas(50, 50);
  fillRoundedRect(c, 0, 0, 50, 50, 4, [22, 32, 56, 220]);
  drawText(c, 'LEN', 4, 6, 1, COL.textDim);
  drawText(c, 'BPM', 4, 28, 1, COL.accentTeal);
  await write('5_BPM.png', c);
}

// 5_bpm font.png — sprite font matching drawBpmGlyphs:
//   digits 0..9 at (i*12, 0, 12, 20)
//   ':'    at (123, 0, 6, 20)
//   'p'    at (132, 0, 12, 20)
async function makeBPMFont() {
  const c = createCanvas(144, 20);
  for (let i = 0; i < 10; i++) {
    drawGlyph(c, String(i), i * 12 + (12 - 5 * 2) / 2, (20 - 7 * 2) / 2, 2, COL.accentTeal);
  }
  drawGlyph(c, ':', 123 + 0, (20 - 7) / 2, 1, COL.accentTeal);
  drawGlyph(c, 'p', 132 + (12 - 5 * 2) / 2, (20 - 7 * 2) / 2, 2, COL.accentTeal);
  await write('5_bpm font.png', c);
}

async function makeHeaderPanel() {
  const c = createCanvas(1280, 105);
  fillGradientV(c, 0, 0, 1280, 105, [40, 60, 110], [16, 24, 50]);
  fillRect(c, 0, 100, 1280, 5, COL.accentTeal);
  drawText(c, 'SONG SELECT', 40, 30, 4, COL.textLight);
  drawText(c, '1ST STAGE', 1100, 18, 2, COL.accentAmber);
  await write('5_header panel.png', c);
}

async function makeFooterPanel() {
  const c = createCanvas(1280, 30);
  fillGradientV(c, 0, 0, 1280, 30, [16, 24, 50], [10, 14, 30]);
  fillRect(c, 0, 0, 1280, 2, COL.accentTeal);
  await write('5_footer panel.png', c);
}

async function makeSkillPointPanel() {
  const c = createCanvas(187, 62);
  fillRoundedRect(c, 0, 0, 187, 62, 4, [16, 24, 44, 230]);
  strokeRect(c, 0, 0, 187, 62, COL.accentMagenta, 1);
  drawText(c, 'SKILL POINT', 6, 4, 1, COL.accentMagenta);
  await write('5_skill point panel.png', c);
}

async function makeGraphPanelDrums() {
  const c = createCanvas(110, 321);
  fillRoundedRect(c, 0, 0, 110, 321, 4, [14, 20, 36, 230]);
  strokeRect(c, 0, 0, 110, 321, COL.panelEdge, 1);
  drawText(c, 'DRUMS', 30, 6, 1, COL.accentTeal);
  drawText(c, 'NOTES', 30, 300, 1, COL.textDim);
  // 9 lane bars sketched.
  const lanes = ['LC', 'HH', 'LP', 'SD', 'HT', 'BD', 'LT', 'FT', 'CY'];
  for (let i = 0; i < lanes.length; i++) {
    const x = 8 + i * 11;
    fillRect(c, x, 30, 8, 260, [40, 60, 100, 180]);
  }
  await write('5_graph panel drums.png', c);
}

// 5_skill icon.png — 9 columns × 35 wide rank icons + medals.
//   slots 0..6 = SS,S,A,B,C,D,E
//   slot 7 = full-combo medal
//   slot 8 = excellent medal
async function makeSkillIcon() {
  const c = createCanvas(315, 35);
  const labels = ['SS', 'S', 'A', 'B', 'C', 'D', 'E', 'FC', 'EX'];
  const colors = [
    COL.accentAmber,
    [240, 180, 60, 255],
    [220, 130, 60, 255],
    [80, 180, 220, 255],
    [80, 200, 100, 255],
    [180, 180, 180, 255],
    [120, 120, 120, 255],
    COL.accentTeal,
    COL.accentMagenta,
  ];
  for (let i = 0; i < 9; i++) {
    fillRoundedRect(c, i * 35 + 2, 2, 31, 31, 6, [10, 14, 24, 230]);
    strokeRect(c, i * 35 + 2, 2, 31, 31, colors[i], 2);
    const w = textWidth(labels[i], 2);
    drawText(c, labels[i], i * 35 + (35 - w) / 2, 10, 2, colors[i]);
  }
  await write('5_skill icon.png', c);
}

// 5_skill number.png — sprite font matching drawAchievementGlyphs:
//   digits 0..9 at (i*12, 0, 12, 20)
//   '.'    at (120, 0, 6, 20)
//   '%'    at (126, 0, 12, 20)
async function makeSkillNumber() {
  const c = createCanvas(138, 20);
  for (let i = 0; i < 10; i++) {
    drawGlyph(c, String(i), i * 12 + (12 - 5 * 2) / 2, (20 - 7 * 2) / 2, 2, COL.accentAmber);
  }
  // '.' cell at x=120, width 6 (drawAchievementGlyphs slices 6 px). Center
  // the 5×7 glyph; matches makeLevelNumber's pattern.
  drawGlyph(c, '.', 120 + (6 - 5) / 2, (20 - 7) / 2, 1, COL.accentAmber);
  drawGlyph(c, '%', 126 + (12 - 5 * 2) / 2, (20 - 7 * 2) / 2, 2, COL.accentAmber);
  await write('5_skill number.png', c);
}

async function makeSkillMax() {
  const c = createCanvas(35, 20);
  fillRoundedRect(c, 0, 0, 35, 20, 4, COL.accentMagenta);
  drawText(c, 'MAX', 6, 7, 1, [255, 255, 255, 255]);
  await write('5_skill max.png', c);
}

async function makeCommentBar() {
  const c = createCanvas(720, 100);
  // Inner clip rect lives at x=123, y=82 in panel-local coords (per
  // COMMENT_TEXT_OFFSET_*). Frame the bar around that.
  fillRoundedRect(c, 0, 60, 720, 35, 6, [12, 16, 28, 240]);
  strokeRect(c, 0, 60, 720, 35, COL.accentTeal, 1);
  // Artist banner above.
  fillRect(c, 460, 30, 260, 2, COL.accentTeal);
  await write('5_comment bar.png', c);
}

async function makeScrollbar() {
  const c = createCanvas(12, 492);
  fillRect(c, 0, 0, 12, 492, [22, 30, 50, 200]);
  strokeRect(c, 0, 0, 12, 492, COL.panelEdge, 1);
  await write('5_scrollbar.png', c);
}

// ─── Stage 7 (gameplay) ─────────────────────────────────────────────

async function makeBackground7() {
  const c = createCanvas(1280, 720);
  fillGradientV(c, 0, 0, 1280, 720, [4, 6, 14], [16, 22, 44]);
  // Faint horizontal scanlines.
  for (let y = 0; y < 720; y += 4) fillRect(c, 0, y, 1280, 1, [255, 255, 255, 4]);
  await write('7_background.png', c);
}

// 7_pads.png — 4×3 atlas of 96×96 pads. Order from PAD_ATLAS:
//   row 0: LC, HH, CY, RD
//   row 1: SD, HT, LT, FT
//   row 2: BD, LP, _, _
const PAD_LANES = [
  ['LC', 'HH', 'CY', 'RD'],
  ['SD', 'HT', 'LT', 'FT'],
  ['BD', 'LP', null, null],
];
const PAD_COLORS = {
  LC: [120, 60, 200, 255],
  HH: [240, 200, 80, 255],
  CY: [240, 130, 50, 255],
  RD: [80, 200, 240, 255],
  SD: [240, 80, 90, 255],
  HT: [80, 240, 130, 255],
  LT: [80, 240, 200, 255],
  FT: [80, 130, 240, 255],
  BD: [200, 200, 220, 255],
  LP: [240, 100, 200, 255],
};

function paintPad(c, gx, gy, label, glow) {
  const color = PAD_COLORS[label];
  const r = 8;
  // Outer rim.
  fillRoundedRect(c, gx + 4, gy + 4, 88, 88, r, [10, 14, 24, 240]);
  strokeRect(c, gx + 4, gy + 4, 88, 88, color, glow ? 4 : 2);
  // Inner disc.
  fillCircle(c, gx + 48, gy + 48, 32, [color[0], color[1], color[2], glow ? 220 : 90]);
  if (glow) {
    fillCircle(c, gx + 48, gy + 48, 36, [255, 255, 255, 120]);
  }
  // Label.
  const w = textWidth(label, 2);
  drawText(c, label, gx + 48 - w / 2, gy + 42, 2, [255, 255, 255, glow ? 255 : 200]);
}

async function makePadsAtlas(filename, glow) {
  const c = createCanvas(384, 288);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const lane = PAD_LANES[row][col];
      if (!lane) continue;
      paintPad(c, col * 96, row * 96, lane, glow);
    }
  }
  await write(filename, c);
}

// 7_chips_drums.png — chips at y=640 height=64 with per-lane x:
//   LC sx=538 w=64, HH sx=70 w=46, SD sx=126 w=54, BD sx=0 w=60,
//   HT sx=190 w=46, LT sx=246 w=46, FT sx=302 w=46, CY sx=358 w=60,
//   LP sx=660 w=48, RD sx=432 w=48
async function makeChipsDrums() {
  // Canvas only needs to reach the bottom of the chip strip
  // (sy=640 + h=64 = 704). The widest entry is LP at sx=660+sw=48=708;
  // 720 wide gives 12 px right-margin. No chips above y=640 so the
  // top region stays empty by design — height 704 instead of 720
  // saves ~80 KB of compressed-zero rows in the IDAT.
  const c = createCanvas(720, 704);
  const CHIPS = [
    { lane: 'LC', sx: 538, sw: 64 },
    { lane: 'HH', sx: 70, sw: 46 },
    { lane: 'SD', sx: 126, sw: 54 },
    { lane: 'BD', sx: 0, sw: 60 },
    { lane: 'HT', sx: 190, sw: 46 },
    { lane: 'LT', sx: 246, sw: 46 },
    { lane: 'FT', sx: 302, sw: 46 },
    { lane: 'CY', sx: 358, sw: 60 },
    { lane: 'LP', sx: 660, sw: 48 },
    { lane: 'RD', sx: 432, sw: 48 },
  ];
  for (const chip of CHIPS) {
    const color = PAD_COLORS[chip.lane];
    // 64-tall chip cell.
    const cy = 640;
    fillRoundedRect(c, chip.sx + 2, cy + 16, chip.sw - 4, 32, 6, color);
    fillRoundedRect(c, chip.sx + 2, cy + 16, chip.sw - 4, 6, 3, [255, 255, 255, 180]);
    fillRoundedRect(c, chip.sx + 2, cy + 42, chip.sw - 4, 6, 3, [0, 0, 0, 100]);
    strokeRect(c, chip.sx + 2, cy + 16, chip.sw - 4, 32, [255, 255, 255, 220], 1);
  }
  await write('7_chips_drums.png', c);
}

// ScreenPlay judge strings 1.png — 128×129. Three rows × 43 high (PERFECT, GREAT, GOOD).
async function makeJudgeStrings() {
  const c = createCanvas(128, 129);
  const rows = [
    { y: 0, text: 'PERFECT', color: COL.accentAmber },
    { y: 43, text: 'GREAT', color: COL.accentTeal },
    { y: 86, text: 'GOOD', color: [120, 200, 120, 255] },
  ];
  for (const r of rows) {
    const w = textWidth(r.text, 2);
    drawText(c, r.text, (128 - w) / 2, r.y + (42 - 14) / 2, 2, r.color);
  }
  await write('ScreenPlay judge strings 1.png', c);
}

// 7_Gauge.png — frame, two rows stacked (the renderer takes the top half).
async function makeGauge() {
  const c = createCanvas(380, 94);
  for (let row = 0; row < 2; row++) {
    const y = row * 47;
    fillRoundedRect(c, 0, y + 4, 380, 39, 8, [12, 16, 28, 230]);
    strokeRect(c, 0, y + 4, 380, 39, COL.accentTeal, 2);
    drawText(c, 'GAUGE', 8, y + 16, 2, COL.accentTeal);
  }
  await write('7_Gauge.png', c);
}

async function makeGaugeBar() {
  const c = createCanvas(320, 40);
  fillGradientV(c, 0, 0, 320, 40, [80, 240, 130], [40, 180, 90]);
  await write('7_gauge_bar.png', c);
}

// ─── Run ────────────────────────────────────────────────────────────

const tasks = [
  makeBackground5,
  makeBars5,
  makePreimagePanel,
  makePreimageDefault,
  makeStatusPanel,
  makeDifficultyPanel,
  makeDifficultyFrame,
  makeLevelNumber,
  makeBPMLabel,
  makeBPMFont,
  makeHeaderPanel,
  makeFooterPanel,
  makeSkillPointPanel,
  makeGraphPanelDrums,
  makeSkillIcon,
  makeSkillNumber,
  makeSkillMax,
  makeCommentBar,
  makeScrollbar,
  makeBackground7,
  () => makePadsAtlas('7_pads.png', false),
  () => makePadsAtlas('ScreenPlayDrums pads flush.png', true),
  makeChipsDrums,
  makeJudgeStrings,
  makeGauge,
  makeGaugeBar,
];

// Each task writes an independent file, so they fan out cleanly.
await Promise.all(tasks.map((t) => t()));
console.log(`Wrote ${tasks.length} skin assets to ${OUT}`);
