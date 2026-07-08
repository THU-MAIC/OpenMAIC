/*
 * OpenMAIC service worker (hand-rolled, no Workbox to stay dependency-free).
 *
 * Goal: make the app load fast and survive flaky 3G/4G — and let already-opened
 * lessons keep working offline.
 *
 * Strategy (deliberately conservative):
 *   - /_next/static/ + other hashed/static assets → CacheFirst. These are
 *     content-hashed, so a cached copy is never stale; serving them from cache
 *     removes the biggest repeat-load cost on a weak link.
 *   - navigations (full page loads) → NetworkFirst, falling back to a cached
 *     copy and finally a small synthesized offline page.
 *   - everything else (API/auth/dynamic data) → passthrough, never cached.
 *
 * Bump CACHE_VERSION only when this logic changes; old caches are purged on
 * activate. basePath arrives via the registration URL query (e.g. ?base=/maic).
 */
const CACHE_VERSION = 'v1';
const STATIC_CACHE = `openmaic-static-${CACHE_VERSION}`;
const PAGE_CACHE = `openmaic-pages-${CACHE_VERSION}`;
const BASE = new URL(self.location.href).searchParams.get('base') || '';

self.addEventListener('install', () => {
  // Take over as soon as installed; the conservative strategy makes this safe.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('aicr-') && !k.endsWith(CACHE_VERSION))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

function offlineResponse() {
  return new Response(
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title>' +
      '<style>body{font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#e6edf3;' +
      'display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px}' +
      'h1{font-size:20px;margin:0 0 8px}p{color:#9aa7b4;max-width:380px;line-height:1.5}</style></head>' +
      '<body><div><h1>You’re offline</h1><p>This page isn’t cached yet. Reconnect to load it — ' +
      'lessons you’ve already opened stay available offline.</p></div></body></html>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 },
  );
}

function isStaticAsset(url) {
  return (
    url.pathname.startsWith(`${BASE}/_next/static/`) ||
    /\.(?:js|css|woff2?|ttf|otf|png|jpg|jpeg|gif|svg|webp|avif|ico)$/.test(url.pathname)
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache APIs / auth / dynamic data — always hit the network.
  if (url.pathname.startsWith(`${BASE}/api/`)) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) {
            const cache = await caches.open(PAGE_CACHE);
            cache.put(req, fresh.clone());
          }
          return fresh;
        } catch {
          const cached = await caches.match(req);
          return cached || offlineResponse();
        }
      })(),
    );
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        try {
          const fresh = await fetch(req);
          if (fresh && (fresh.ok || fresh.type === 'opaque')) {
            const cache = await caches.open(STATIC_CACHE);
            cache.put(req, fresh.clone());
          }
          return fresh;
        } catch {
          return Response.error();
        }
      })(),
    );
  }
});
