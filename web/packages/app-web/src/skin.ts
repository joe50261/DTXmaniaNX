import * as THREE from 'three';
import type { SkinTextures } from './renderer.js';
import { skinUrl } from './skin-url.js';

/**
 * Loads the drum-play skin assets shipped under public/skin/. The
 * source-of-truth files live under packages/app-web/public/skin/ and
 * are produced procedurally by scripts/generate-skin.mjs from original
 * geometric primitives. Each filename is a stable contract — atlases
 * (7_pads.png, 7_chips_drums.png, ScreenPlay judge strings 1.png)
 * match the per-lane / per-judgment offsets in pad-atlas.ts /
 * chip-atlas.ts / judge-atlas.ts.
 *
 * Missing files resolve to undefined rather than throwing — the renderer
 * tolerates absent skin pieces and falls back to its plain 2D drawing.
 */
export async function loadSkin(): Promise<SkinTextures> {
  const loader = new THREE.TextureLoader();
  const load = (name: string): Promise<THREE.Texture | undefined> =>
    new Promise((resolve) => {
      loader.load(
        skinUrl(name),
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          resolve(tex);
        },
        undefined,
        () => resolve(undefined)
      );
    });

  const [background, pads, padsFlush, chipsDrums, judgeStrings, gaugeFrame, gaugeBar] =
    await Promise.all([
      load('7_background.jpg'),
      load('7_pads.png'),
      load('ScreenPlayDrums pads flush.png'),
      load('7_chips_drums.png'),
      load('ScreenPlay judge strings 1.png'),
      load('7_Gauge.png'),
      load('7_gauge_bar.png'),
    ]);
  const out: SkinTextures = {};
  if (background) out.background = background;
  if (pads) out.pads = pads;
  if (padsFlush) out.padsFlush = padsFlush;
  if (chipsDrums) out.chipsDrums = chipsDrums;
  if (judgeStrings) out.judgeStrings = judgeStrings;
  if (gaugeFrame) out.gaugeFrame = gaugeFrame;
  if (gaugeBar) out.gaugeBar = gaugeBar;
  return out;
}
