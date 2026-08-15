/* OpenMAIC offline application shell.
 *
 * Imported courses and media stay in IndexedDB. This worker caches only safe,
 * same-origin application resources. API responses and authenticated/RSC/range
 * requests are never cached. A small route allowlist is treated as a client-only
 * application shell so imported courses can reopen after a full offline refresh.
 */

const CACHE_PREFIX = 'openmaic-pwa-';
const CACHE_VERSION = 'v3';
const SHELL_CACHE = `${CACHE_PREFIX}shell-${CACHE_VERSION}`;
const PAGE_CACHE = `${CACHE_PREFIX}pages-${CACHE_VERSION}`;
const STATIC_CACHE = `${CACHE_PREFIX}static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}runtime-${CACHE_VERSION}`;

const SHELL_ASSETS = ['/openmaic-mark.png', '/logo-horizontal.png'];
const MAX_PAGE_ENTRIES = 24;
const MAX_STATIC_ENTRIES = 180;
const MAX_RUNTIME_ENTRIES = 96;
const MAX_CACHEABLE_BYTES = 8 * 1024 * 1024;

function isHttpRequest(request) {
  try {
    const url = new URL(request.url);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isSensitiveOrDynamicRequest(request, url) {
  if (request.method !== 'GET' || url.origin !== self.location.origin) return true;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/_next/data/')) return true;
  if (url.pathname === '/_next/webpack-hmr') return true;
  if (url.searchParams.has('_rsc')) return true;
  if (request.headers.has('authorization') || request.headers.has('range')) return true;
  if (
    request.headers.has('rsc') ||
    request.headers.has('next-router-prefetch') ||
    request.headers.has('next-action') ||
    request.headers.get('accept')?.includes('text/x-component')
  ) {
    return true;
  }
  return false;
}

function isResponseCacheable(response) {
  if (!response || !response.ok || response.status !== 200) return false;
  if (response.type !== 'basic' && response.type !== 'default') return false;

  const vary = response.headers.get('vary') || '';
  if (/\brsc\b/i.test(vary) || /\bcookie\b/i.test(vary)) return false;

  const cacheControl = response.headers.get('cache-control') || '';
  if (/\b(?:no-store|private)\b/i.test(cacheControl)) return false;
  if (response.headers.has('set-cookie')) return false;

  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_CACHEABLE_BYTES) return false;
  return true;
}

function isOfflineShellPath(pathname) {
  return (
    pathname === '/' ||
    pathname === '/courses' ||
    pathname === '/imports' ||
    pathname === '/offline' ||
    pathname === '/library' ||
    pathname === '/create' ||
    /^\/courses\/[^/]+$/.test(pathname) ||
    /^\/classroom\/[^/]+$/.test(pathname)
  );
}

function isNavigationResponseCacheable(request, response) {
  if (!response || !response.ok || response.status !== 200) return false;
  if (response.type !== 'basic' && response.type !== 'default') return false;

  const url = new URL(request.url);
  if (!isOfflineShellPath(url.pathname)) return false;
  if (response.headers.has('set-cookie')) return false;

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return false;

  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_CACHEABLE_BYTES) return false;
  return true;
}

function navigationCacheKey(request) {
  const url = new URL(request.url);
  url.search = '';
  url.hash = '';
  return new Request(url.toString(), {
    method: 'GET',
    credentials: 'same-origin',
  });
}

async function putAndTrim(
  cacheName,
  request,
  response,
  maxEntries,
  isCacheable = isResponseCacheable,
) {
  if (!isCacheable(response)) return;
  const cache = await caches.open(cacheName);
  try {
    await cache.put(request, response.clone());
  } catch {
    return;
  }

  const keys = await cache.keys();
  const overflow = keys.length - maxEntries;
  if (overflow > 0) {
    await Promise.all(keys.slice(0, overflow).map((key) => cache.delete(key)));
  }
}

async function matchOpenMaicCache(request, cacheNames) {
  for (const cacheName of cacheNames) {
    const cache = await caches.open(cacheName);
    const response = await cache.match(request);
    if (response) return response;
  }
  return undefined;
}

async function warmShell() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.allSettled(
    SHELL_ASSETS.map(async (path) => {
      const request = new Request(path, { cache: 'reload', credentials: 'same-origin' });
      const response = await fetch(request);
      if (isResponseCacheable(response)) await cache.put(request, response);
    }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(warmShell());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      const activeCaches = [SHELL_CACHE, PAGE_CACHE, STATIC_CACHE, RUNTIME_CACHE];
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && !activeCaches.includes(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

async function networkFirstPage(request) {
  const cacheKey = navigationCacheKey(request);
  try {
    const response = await fetch(request);
    await putAndTrim(PAGE_CACHE, cacheKey, response, MAX_PAGE_ENTRIES, (candidate) =>
      isNavigationResponseCacheable(request, candidate),
    );
    return response;
  } catch {
    const cached = await matchOpenMaicCache(cacheKey, [PAGE_CACHE]);
    if (cached) return cached;

    return new Response(
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OpenMAIC 离线</title><style>body{font:16px system-ui,sans-serif;background:#faf8ff;color:#241b32;display:grid;min-height:100vh;place-items:center;margin:0}.card{max-width:30rem;margin:2rem;padding:2rem;border:1px solid #e8e0f2;border-radius:1.25rem;background:white;box-shadow:0 16px 50px #5c38791a}h1{font-size:1.25rem}p{line-height:1.7;color:#6b6174}</style></head><body><main class="card"><h1>当前处于离线状态</h1><p>这个页面还没有在本设备上打开过。恢复网络并访问一次后，OpenMAIC 会保存可安全缓存的应用界面，供离线启动。</p></main></body></html>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

async function warmPage(path) {
  const url = new URL(path, self.location.origin);
  if (url.origin !== self.location.origin || !isOfflineShellPath(url.pathname)) return;
  url.search = '';
  url.hash = '';
  const request = new Request(url.toString(), {
    method: 'GET',
    mode: 'same-origin',
    credentials: 'same-origin',
    headers: { Accept: 'text/html' },
  });
  try {
    const response = await fetch(request);
    await putAndTrim(
      PAGE_CACHE,
      navigationCacheKey(request),
      response,
      MAX_PAGE_ENTRIES,
      (candidate) => isNavigationResponseCacheable(request, candidate),
    );
  } catch {
    // Normal while offline; an earlier cached copy remains available.
  }
}

async function cacheFirstStatic(request) {
  const cached = await matchOpenMaicCache(request, [STATIC_CACHE, SHELL_CACHE]);
  if (cached) return cached;

  const response = await fetch(request);
  await putAndTrim(STATIC_CACHE, request, response, MAX_STATIC_ENTRIES);
  return response;
}

async function staleWhileRevalidate(request, event) {
  const cached = await matchOpenMaicCache(request, [RUNTIME_CACHE, SHELL_CACHE]);
  const network = fetch(request)
    .then(async (response) => {
      await putAndTrim(RUNTIME_CACHE, request, response, MAX_RUNTIME_ENTRIES);
      return response;
    })
    .catch(() => undefined);

  if (cached) {
    event.waitUntil(network);
    return cached;
  }

  const response = await network;
  return response || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isHttpRequest(request)) return;

  const url = new URL(request.url);
  if (isSensitiveOrDynamicRequest(request, url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstPage(request));
    return;
  }

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirstStatic(request));
    return;
  }

  if (['style', 'script', 'font', 'image', 'worker'].includes(request.destination)) {
    event.respondWith(staleWhileRevalidate(request, event));
  }
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (event.data?.type === 'CLEAR_OPENMAIC_CACHES') {
    event.waitUntil(
      caches
        .keys()
        .then((names) =>
          Promise.all(
            names
              .filter((name) => name.startsWith(CACHE_PREFIX))
              .map((name) => caches.delete(name)),
          ),
        ),
    );
    return;
  }

  if (event.data?.type === 'WARM_OFFLINE_PAGES' && Array.isArray(event.data.paths)) {
    event.waitUntil(
      Promise.allSettled(
        event.data.paths
          .filter((path) => typeof path === 'string')
          .slice(0, MAX_PAGE_ENTRIES)
          .map(warmPage),
      ),
    );
  }
});
