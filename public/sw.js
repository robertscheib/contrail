/* radar-dash service worker — app-shell offline + smart runtime caching.
   Bump CACHE on every shell change so old caches are purged on activate. */
const CACHE = 'radar-dash-v1';

// Minimal shell precached on install. The dashboard HTML is fetched fresh
// (network-first) so brand tokens / new builds always win when online.
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for a request, falling back to cache (then optional offline shell).
async function networkFirst(req, fallbackToShell) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok && req.method === 'GET') cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    if (fallbackToShell) {
      const shell = await cache.match('/');
      if (shell) return shell;
    }
    throw err;
  }
}

// Stale-while-revalidate for static assets (own + CDN).
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || network || fetch(req);
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache live flight/API data — always go to network, fail cleanly offline.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    return; // default browser fetch
  }

  // Page navigations: network-first, fall back to cached shell when offline.
  if (request.mode === 'navigate') {
    e.respondWith(networkFirst(request, true));
    return;
  }

  // Map tiles / CDN libs (Leaflet, OSM tiles) + own static assets: SWR.
  if (
    url.origin !== self.location.origin ||
    /\.(?:css|js|png|jpg|jpeg|svg|webp|ico|woff2?|webmanifest)$/.test(url.pathname)
  ) {
    e.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Everything else same-origin: network-first with cache fallback.
  e.respondWith(networkFirst(request, false));
});
