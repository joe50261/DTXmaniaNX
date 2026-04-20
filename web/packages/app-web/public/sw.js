// Service worker for install-ability + sensible caching under a Vite build.
//
// Caching strategy, per URL kind:
//   - Shell HTML (navigation, /, index.html): network-first → cache fallback.
//     Vite emits content-hashed asset filenames, so stale index.html refers
//     to bundle files that were deleted by the next deploy. network-first
//     keeps shell HTML fresh; cache fallback keeps the app openable offline.
//   - Non-hashed shell assets (manifest, icons): cache-first. These files
//     don't change across builds so serving cached copies is safe.
//   - Hashed /assets/*: cache-first with network fallback and opportunistic
//     write-through. Content-addressed => cached forever is correct.
//   - Everything else same-origin: cache-first with network fallback, so
//     song-folder reads etc. aren't cached (FS Access API requests don't
//     hit the network anyway).
//
// Paths are derived from the SW's own location so the same file works at
// site root (`/sw.js`) and under a project-site base (`/DTXmaniaNX/sw.js`).

const BASE_PATH = new URL('./', self.location).pathname; // "/" or "/DTXmaniaNX/"
// Bumped from v1 (cache-first shell) to v2 (network-first shell). The
// activate handler deletes caches whose key !== SHELL_CACHE, so existing
// users who were stuck on a stale cached index.html are rescued when the
// v2 SW activates.
const SHELL_CACHE = 'dtxmania-shell-v2';
const SHELL_URL = BASE_PATH;
const INDEX_URL = BASE_PATH + 'index.html';
const NON_HASHED_SHELL = [
  BASE_PATH + 'manifest.webmanifest',
  BASE_PATH + 'icon.svg',
  BASE_PATH + 'icon-maskable.svg',
];
const PRECACHE_URLS = [SHELL_URL, INDEX_URL, ...NON_HASHED_SHELL];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Failing one URL shouldn't break install (addAll is all-or-nothing).
      Promise.all(PRECACHE_URLS.map((u) => cache.add(u).catch(() => undefined)))
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

  const pathname = url.pathname;
  const isShellHtml =
    req.mode === 'navigate' || pathname === SHELL_URL || pathname === INDEX_URL;

  if (isShellHtml) {
    event.respondWith(networkFirst(req));
    return;
  }

  if (NON_HASHED_SHELL.includes(pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Hashed assets + anything else same-origin: cache-first with network
  // fallback. Content-addressed filenames mean stale is impossible for JS.
  event.respondWith(cacheFirst(req));
});

function networkFirst(req) {
  return fetch(req)
    .then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    })
    .catch(() => caches.match(req).then((r) => r ?? Response.error()));
}

function cacheFirst(req) {
  return caches.match(req).then((cached) => {
    if (cached) return cached;
    return fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    });
  });
}
