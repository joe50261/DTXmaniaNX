import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// On GitHub Actions we build for the project Pages site at
//   https://<owner>.github.io/DTXmaniaNX/
// so we need a /DTXmaniaNX/ base. Local dev + other CI keep `/`.
const base = process.env.GITHUB_ACTIONS ? '/DTXmaniaNX/' : '/';

// Skin assets shipped with the build. Single source of truth is the C#
// runtime tree (Runtime/System/Graphics/) so the desktop game and the web
// port stay in sync — the plugin copies a curated subset into dist/skin/
// at build time. Filenames preserve the original DTXMania casing/spaces.
//
//  - Stage 5 (song select): full set, 716KB. Cheap enough to ship all.
//  - Stage 7 (gameplay): explicit allowlist; the full set is ~13MB and
//    most of it is unused. Add to this list when a new asset is needed.
//  - Stage 8 (result): explicit allowlist (~14 files). Loaded by
//    `ResultCanvas` — see `result-design.md` for which file maps to
//    which sub-element.
//  - Stages 1 / 2 / 6 / 9 (splash): minimal — one or two files each,
//    loaded by `SplashCanvas` (see `splash-design.md`).
const RUNTIME_GRAPHICS = '../../../Runtime/System/Graphics';
const SPLASH_ALLOWLIST = [
  '1_background.jpg',
  '2_background.jpg',
  '2_menu.png',
  '6_background.jpg',
  '6_FadeOut.jpg',
  '9_background.jpg',
];
const STAGE7_ALLOWLIST = [
  '7_background.jpg',
  '7_pads.png',
  'ScreenPlayDrums pads flush.png',
  '7_chips_drums.png',
  'ScreenPlay judge strings 1.png',
  '7_Gauge.png',
  '7_gauge_bar.png',
  // Lane-flush per-lane forward textures — loaded by PlayfieldCanvas.
  // See playfield-design.md for the lane → filename map.
  'ScreenPlayDrums lane flush leftcymbal.png',
  'ScreenPlayDrums lane flush hihat.png',
  'ScreenPlayDrums lane flush leftpedal.png',
  'ScreenPlayDrums lane flush snare.png',
  'ScreenPlayDrums lane flush hitom.png',
  'ScreenPlayDrums lane flush bass.png',
  'ScreenPlayDrums lane flush lowtom.png',
  'ScreenPlayDrums lane flush floortom.png',
  'ScreenPlayDrums lane flush cymbal.png',
  // Per-lane chip-fire bursts — loaded by ChipFireCanvas.
  'ScreenPlayDrums chip fire_LC.png',
  'ScreenPlayDrums chip fire_HH.png',
  'ScreenPlayDrums chip fire_LP.png',
  'ScreenPlayDrums chip fire_SD.png',
  'ScreenPlayDrums chip fire_HT.png',
  'ScreenPlayDrums chip fire_BD.png',
  'ScreenPlayDrums chip fire_LT.png',
  'ScreenPlayDrums chip fire_FT.png',
  'ScreenPlayDrums chip fire_CY.png',
  'ScreenPlayDrums chip fire_Bonus.png',
];
const STAGE8_ALLOWLIST = [
  '8_background.jpg',
  '8_rankSS.png',
  '8_rankS.png',
  '8_rankA.png',
  '8_rankB.png',
  '8_rankC.png',
  '8_rankD.png',
  '8_rankE.png',
  '8_New Record.png',
  '8_numbers_large.png',
  '8_progress_bar_panel.png',
  'ScreenResult Excellent.png',
  'ScreenResult fullcombo.png',
  'ScreenResult StageCleared.png',
];

export default defineConfig({
  base,
  plugins: [
    viteStaticCopy({
      targets: [
        // `stripBase: true` strips every leading directory segment
        // (equivalent of a flat copy) so files land directly under
        // dist/skin/. Without it the plugin mirrors the source tree
        // — `dist/skin/Runtime/System/Graphics/5_*.png`. Per the
        // plugin's `RenameObject` type (vite-plugin-static-copy
        // v4.1.0): `stripBase: number | true`.
        {
          src: `${RUNTIME_GRAPHICS}/5_*.{png,jpg}`,
          dest: 'skin',
          rename: { stripBase: true },
        },
        ...STAGE7_ALLOWLIST.map((name) => ({
          src: `${RUNTIME_GRAPHICS}/${name}`,
          dest: 'skin',
          rename: { stripBase: true as const },
        })),
        ...STAGE8_ALLOWLIST.map((name) => ({
          src: `${RUNTIME_GRAPHICS}/${name}`,
          dest: 'skin',
          rename: { stripBase: true as const },
        })),
        ...SPLASH_ALLOWLIST.map((name) => ({
          src: `${RUNTIME_GRAPHICS}/${name}`,
          dest: 'skin',
          rename: { stripBase: true as const },
        })),
      ],
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
