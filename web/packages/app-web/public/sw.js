// Minimal Service Worker for install-ability.
//
// The goal is installability (PWA manifest + registered SW) so users can
// add the app to their home screen / Quest library. Smart caching of hashed
// Vite assets is deferred — we use cache-first for the app shell
// (index.html, icons, manifest) and network-first for everything else so
// fresh JS/WASM is always fetched when online.
//
// Paths are derived from the SW's own location so the same file works at
// site root (`/sw.js`) and under a project-site base (`/DTXmaniaNX/sw.js`).

const BASE_PATH = new URL('./', self.location).pathname; // "/" or "/DTXmaniaNX/"
const SHELL_CACHE = 'dtxmania-shell-v1';
const SHELL_URLS = [
  BASE_PATH,
  BASE_PATH + 'index.html',
  BASE_PATH + 'manifest.webmanifest',
  BASE_PATH + 'icon.svg',
  BASE_PATH + 'icon-maskable.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Failing one url shouldn't break install; addAll is all-or-nothing so use add individually.
      Promise.all(SHELL_URLS.map((u) => cache.add(u).catch(() => undefined)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Shell: cache-first, then network (falls back to cached shell offline).
  if (SHELL_URLS.includes(url.pathname)) {
    event.respondWith(
      caches.match(req).then((cached) =>
        cached ??
        fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        })
      )
    );
    return;
  }

  // Everything else: network-first, fall through to cache if offline.
  event.respondWith(
    fetch(req).catch(() => caches.match(req).then((r) => r ?? Response.error()))
  );
});
