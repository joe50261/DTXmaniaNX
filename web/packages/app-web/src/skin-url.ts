// Resolves a skin asset filename to a URL that works under both local
// dev (BASE_URL = "/") and the GitHub Pages project site
// (BASE_URL = "/DTXmaniaNX/"). The plugin in vite.config.ts copies the
// canonical files from Runtime/System/Graphics/ into dist/skin/ at build
// time; this helper is the single read path for all loaders.
//
// Filenames are URL-encoded — the canonical DTXMania assets keep their
// original names (`5_skill number on gauge etc.png`, `ScreenPlay judge
// strings 1.png`) which contain spaces. Browsers tolerate raw spaces in
// `<img src>` and `THREE.TextureLoader` for typical hosts, but the URL
// constructor / service-worker `Request` matching / some CDNs reject
// them. `encodeURIComponent` would also escape `/` and `:` — for a leaf
// filename that's exactly what we want.

export function buildSkinUrl(base: string, filename: string): string {
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return `${prefix}skin/${encodeURIComponent(filename)}`;
}

export function skinUrl(filename: string): string {
  return buildSkinUrl(import.meta.env.BASE_URL, filename);
}
