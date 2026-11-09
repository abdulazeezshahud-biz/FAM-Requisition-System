/* FAM Requisition System — service worker
 *
 * Scope: same-origin app shell only. The app talks to PocketBase on a
 * DIFFERENT origin (pb.*), and loads fonts from Google — those requests are
 * cross-origin and are deliberately left untouched so the SW never caches or
 * interferes with API/auth/realtime traffic.
 *
 * Strategy:
 *   - navigations (the HTML document): network-first, fall back to the cached
 *     shell when offline, so updates always roll out but the app still opens
 *     without a connection.
 *   - other same-origin GETs (icons, manifest, manual): cache-first.
 */
const CACHE = 'fam-req-v7';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/manual.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only handle our own origin. PocketBase (pb.*) and font CDNs are
  // cross-origin → let the browser handle them normally (no caching).
  if (url.origin !== self.location.origin) return;
  // Never cache the backend or runtime config. When PocketBase is reverse-
  // proxied under THIS domain (single-domain Docker setup), its API and admin
  // dashboard are same-origin — they must bypass the cache entirely. config.js
  // carries the backend URL and must always be fresh.
  if (url.pathname === '/config.js' ||
      url.pathname.startsWith('/api/') ||
      url.pathname === '/_' || url.pathname.startsWith('/_/')) return;

  // App navigation → network-first with offline fallback to the shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // Static same-origin assets → cache-first.
  event.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
    )
  );
});
