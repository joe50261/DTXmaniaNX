import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Pin every `public/skin/*.png` against the dimensions the consumers
 * expect. The runtime renderer + canvas slicers have no graceful
 * recovery if these contracts drift — atlas slicing math (pad-atlas,
 * chip-atlas, judge-atlas) reads pixels from hard-coded offsets and
 * silently produces nonsense if the source image is the wrong size or
 * empty. THREE.TextureLoader doesn't error on undersized images, and
 * `loadSkin()` deliberately swallows missing-file errors to keep the
 * fallback 2D-draw path open. Net effect: a regression here is a
 * silent visual bug at runtime.
 *
 * This test fails loudly the moment `generate-skin.mjs` drifts from
 * what `pad-atlas.ts` / `chip-atlas.ts` / `judge-atlas.ts` /
 * `song-select-canvas.ts`'s sprite-font helpers ask for. Updating the
 * generator without updating these expectations (or vice versa) blocks
 * the PR.
 */

const SKIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'skin');

/** PNG signature (8 bytes) + IHDR chunk-data layout: width/height each
 *  big-endian uint32 at offsets 16 and 20 of the file. */
function readPngDims(buf: Buffer): { width: number; height: number } {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A.
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) throw new Error('not a PNG');
  }
  // IHDR chunk: bytes 8..15 are length+type (always 13/IHDR for a valid
  // PNG); bytes 16..19 are width, 20..23 are height.
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

/** Per-file expectations. Width/height come from:
 *
 *  - **`7_pads.png` / `ScreenPlayDrums pads flush.png`** — pad-atlas.ts
 *    PAD_SIZE=96 with 4 columns × 3 rows.
 *  - **`7_chips_drums.png`** — chip-atlas.ts CHIP_ATLAS_Y=640,
 *    CHIP_ATLAS_H=64; widest entry is LP at sx=660 + sw=48 = 708.
 *    Anything smaller breaks slicing on the LP lane silently.
 *  - **`ScreenPlay judge strings 1.png`** — judge-atlas.ts:
 *    JUDGE_SPRITE_W=128, three rows at sy 0/43/86 each JUDGE_SPRITE_H=42
 *    tall. 86+42=128 actually, so 128×129 leaves a 1-px guard row.
 *  - **`5_difficulty panel.png`** — song-select-layout.ts comment pins
 *    "561 × 321".
 *  - **`5_skill point panel.png`** — song-select-layout.ts:
 *    SKILL_POINT_PANEL chrome 187×62.
 *  - **`5_graph panel drums.png`** — song-select-layout.ts:
 *    GRAPH_PANEL chrome 110×321.
 *  - **`5_difficulty frame.png`** — DIFF_PART_W × DIFF_ROW_H = 187×60.
 *  - **`5_level number.png`** — drawLevelGlyphs uses 10 digits ×20 + a
 *    period at (200,0,10,28) → total 210×28.
 *  - **`5_bpm font.png`** — drawBpmGlyphs reaches 'p' at (132,0,12,20)
 *    → minimum width 144, height 20.
 *  - **`5_skill number.png`** — drawAchievementGlyphs reaches '%' at
 *    (126,0,12,20) → minimum width 138, height 20.
 *  - **`5_skill icon.png`** — 9 columns × 35 wide rank/medal slots →
 *    315 wide; height is whatever the generator picked (used as
 *    `rankSprite.height` in song-select-canvas, not pinned).
 *  - **`5_background.png` / `7_background.png`** — full canvas
 *    1280×720 background.
 *
 *  Bar / preimage / panel / scrollbar / footer textures are drawn at
 *  whatever size they happen to load (consumers measure
 *  `tex.width`/`height` rather than fixing dims), so we only assert
 *  PNG validity for those — not exact size — to keep the test a
 *  contract pin and not an art-direction lock.
 */
const STRICT_DIMS: Record<string, [number, number]> = {
  '5_background.png': [1280, 720],
  '5_difficulty panel.png': [561, 321],
  '5_difficulty frame.png': [187, 60],
  '5_skill point panel.png': [187, 62],
  '5_graph panel drums.png': [110, 321],
  '5_level number.png': [210, 28],
  '5_bpm font.png': [144, 20],
  '5_skill number.png': [138, 20],
  '5_skill icon.png': [315, 35],
  '7_background.png': [1280, 720],
  '7_pads.png': [384, 288],
  'ScreenPlayDrums pads flush.png': [384, 288],
  'ScreenPlay judge strings 1.png': [128, 129],
};

/** Files that need to be at least this big — runtime slicers reach into
 *  fixed offsets that demand a minimum atlas size. Bigger is fine
 *  (transparent margin) but smaller silently produces wrong slices. */
const MIN_DIMS: Record<string, [number, number]> = {
  // chip-atlas.ts: LP at sx=660 sw=48 (right edge x=708) at sy=640 h=64
  // (bottom edge y=704). Generator currently produces 720×720.
  '7_chips_drums.png': [708, 704],
};

describe('skin assets', () => {
  const files = readdirSync(SKIN_DIR).filter((f) => f.endsWith('.png'));

  it('directory has the canonical 31 skin PNGs (no orphan / no missing)', () => {
    expect(files.length).toBe(31);
  });

  it.each(files)('%s is a valid PNG with non-trivial content', (file) => {
    const buf = readFileSync(join(SKIN_DIR, file));
    // Empty PNG of any size weighs ~80 B (sig + IHDR + 1 IDAT + IEND);
    // a meaningful image is significantly larger. 200 B is well above
    // the empty floor and well below the smallest committed asset
    // (5_skill max.png ≈ 143 B is borderline — we use 100 B floor to
    // tolerate genuinely tiny single-glyph badges while still catching
    // a totally-empty encoder regression).
    expect(buf.length, `${file}: file size suspiciously small`).toBeGreaterThan(100);
    // Decoding throws if the signature / IHDR is malformed.
    const { width, height } = readPngDims(buf);
    expect(width, `${file}: width must be positive`).toBeGreaterThan(0);
    expect(height, `${file}: height must be positive`).toBeGreaterThan(0);
  });

  it.each(Object.entries(STRICT_DIMS))(
    '%s has the exact dims (%j) the consumers slice against',
    (file, [expectedW, expectedH]) => {
      const buf = readFileSync(join(SKIN_DIR, file as string));
      const { width, height } = readPngDims(buf);
      expect(width).toBe(expectedW);
      expect(height).toBe(expectedH);
    },
  );

  it.each(Object.entries(MIN_DIMS))(
    '%s has at least %j px so atlas slicing can reach all entries',
    (file, [minW, minH]) => {
      const buf = readFileSync(join(SKIN_DIR, file as string));
      const { width, height } = readPngDims(buf);
      expect(width).toBeGreaterThanOrEqual(minW);
      expect(height).toBeGreaterThanOrEqual(minH);
    },
  );
});
