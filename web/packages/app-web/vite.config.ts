import { defineConfig } from 'vite';

// On GitHub Actions we build for the project Pages site at
//   https://<owner>.github.io/DTXmaniaNX/
// so we need a /DTXmaniaNX/ base. Local dev + other CI keep `/`.
const base = process.env.GITHUB_ACTIONS ? '/DTXmaniaNX/' : '/';

// Skin assets ship as plain files under packages/app-web/public/skin/
// — Vite serves `public/` at the deploy base automatically, so a file
// at `public/skin/5_background.jpg` is reachable at
// `${BASE_URL}skin/5_background.jpg`. Source-of-truth for these assets
// is `scripts/generate-skin.mjs`, which produces them procedurally
// from original geometric primitives. We deliberately do NOT pull from
// the C# `Runtime/System/Graphics/` tree because those upstream files
// are styled to mimic Konami GITADORA UI art; the web build keeps a
// clean break and ships its own placeholder skin.

export default defineConfig({
  base,
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
