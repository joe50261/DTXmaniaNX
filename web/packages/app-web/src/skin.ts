import * as THREE from 'three';
import type { SkinTextures } from './renderer.js';

/**
 * Loads the drum-play skin assets we ship under public/skin/. Ported from the
 * subset of Runtime/System/Graphics/ used by Stage 07 (performance) in the
 * original DTXMania; only the handful we actually render are copied so the
 * PWA shell stays small.
 *
 * Missing files resolve to undefined rather than throwing — the renderer
 * tolerates absent skin pieces and falls back to its plain 2D drawing.
 */
export async function loadSkin(baseUrl: string): Promise<SkinTextures> {
  const loader = new THREE.TextureLoader();
  const load = (name: string): Promise<THREE.Texture | undefined> =>
    new Promise((resolve) => {
      loader.load(
        `${baseUrl}skin/${name}`,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          resolve(tex);
        },
        undefined,
        () => resolve(undefined)
      );
    });

  const [background, pads, chipsDrums, judgeStrings, gaugeFrame, gaugeBar] = await Promise.all([
    load('7_background.jpg'),
    load('7_pads.png'),
    load('7_chips_drums.png'),
    load('ScreenPlay judge strings 1.png'),
    load('7_Gauge.png'),
    load('7_gauge_bar.png'),
  ]);
  const out: SkinTextures = {};
  if (background) out.background = background;
  if (pads) out.pads = pads;
  if (chipsDrums) out.chipsDrums = chipsDrums;
  if (judgeStrings) out.judgeStrings = judgeStrings;
  if (gaugeFrame) out.gaugeFrame = gaugeFrame;
  if (gaugeBar) out.gaugeBar = gaugeBar;
  return out;
}
