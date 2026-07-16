const CACHE_NAME = 'docrepo-shell-v1';
const SHELL_ASSETS = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Install: cache the app shell only
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean up old cache versions
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy:
// - Never touch /api/ requests (auth, documents, uploads) — always go to network.
// - For navigation/app-shell requests, try network first, fall back to cache when offline.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return; // don't intercept POST/PUT/DELETE (uploads, edits)
  if (url.pathname.startsWith('/api/')) return; // never cache dynamic/document data

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Keep the shell cache fresh with the latest successful response
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
