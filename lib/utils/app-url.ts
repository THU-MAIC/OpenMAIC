/**
 * Deployment sub-path adapter.
 *
 * Next.js applies `basePath` to `next/link`, `next/router`, route handlers and
 * `middleware` matching on its own, but NOT to values the application builds
 * itself: `fetch()` targets, `EventSource` URLs, `window.open()` targets,
 * `history.pushState()` entries, `next/image` `src` (the default loader does
 * not prefix it), or any URL persisted inside a document.
 *
 * On a deployment served under a sub-path (`https://example.com/openmaic`)
 * those self-built values reach the domain root and 404 — or open a blank tab.
 * Route every app-local absolute path through `appUrl()` so a deployment only
 * has to set NEXT_PUBLIC_APP_BASE_PATH once.
 *
 * The helper is a no-op when no basePath is configured and is idempotent when a
 * path already carries the prefix, so it is always safe to call — including on
 * values that were prefixed elsewhere.
 */

const APP_BASE_PATH = (process.env.NEXT_PUBLIC_APP_BASE_PATH || '').replace(/\/+$/, '');

/** Prefixes an app-local absolute path with the configured Next.js basePath. */
export function appUrl(path: string): string {
  // Absolute (`https://…`), protocol-relative (`//cdn…`) and pseudo-scheme
  // (`data:`, `blob:`, emoji) addresses are not app-local: leave them alone.
  if (!path.startsWith('/') || path.startsWith('//')) return path;
  if (!APP_BASE_PATH) return path;
  // A caller may already have prefixed the path (or persisted it that way):
  // prefixing twice would produce `/openmaic/openmaic/...`.
  if (path === APP_BASE_PATH || path.startsWith(`${APP_BASE_PATH}/`)) return path;
  return `${APP_BASE_PATH}${path}`;
}
