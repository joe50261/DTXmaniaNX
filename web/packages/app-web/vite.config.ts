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
const RUNTIME_GRAPHICS = '../../../Runtime/System/Graphics';
const STAGE7_ALLOWLIST = [
  '7_background.jpg',
  '7_pads.png',
  'ScreenPlayDrums pads flush.png',
  '7_chips_drums.png',
  'ScreenPlay judge strings 1.png',
  '7_Gauge.png',
  '7_gauge_bar.png',
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
