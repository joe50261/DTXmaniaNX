// Resolves a skin asset filename to a URL that works under both local
// dev (BASE_URL = "/") and the GitHub Pages project site
// (BASE_URL = "/DTXmaniaNX/"). The plugin in vite.config.ts copies the
// canonical files from Runtime/System/Graphics/ into dist/skin/ at build
// time; this helper is the single read path for all loaders.

export function buildSkinUrl(base: string, filename: string): string {
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return `${prefix}skin/${filename}`;
}

export function skinUrl(filename: string): string {
  return buildSkinUrl(import.meta.env.BASE_URL, filename);
}
