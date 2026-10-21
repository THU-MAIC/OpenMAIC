/** Keenable's API root, shared by search and fetch. */
export const KEENABLE_DEFAULT_BASE_URL = 'https://api.keenable.ai';

/** App label Keenable asks every request to carry (required without a key). */
export const KEENABLE_APP_TITLE = 'OpenMAIC';

/** Spellings of the API base a workspace may save (any of them reaches both tools). */
export const KEENABLE_OFFICIAL_BASE_URLS = [
  '',
  '/v1',
  '/v1/search',
  '/v1/search/public',
  '/v1/fetch',
  '/v1/fetch/public',
].map((path) => `${KEENABLE_DEFAULT_BASE_URL}${path}`);

export function isOfficialKeenableBaseUrl(baseUrl: string): boolean {
  return KEENABLE_OFFICIAL_BASE_URLS.includes(baseUrl.trim().replace(/\/+$/, ''));
}

/**
 * One `keenable` provider serves web search and web fetch with the same base
 * URL. Without a key each tool uses its public endpoint (`/v1/search/public`,
 * `/v1/fetch/public`); a key selects the keyed endpoint, which only lifts the
 * rate limits. The API root, its `/v1` prefix or a tool's own endpoint all
 * resolve to the requested one.
 */
export function keenableEndpoint(
  baseUrl: string,
  tool: 'search' | 'fetch',
  keyed: boolean,
): string {
  const base = new URL(baseUrl);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  ) {
    throw new Error('Invalid Keenable API base URL');
  }
  const root = base.pathname
    .replace(/\/+$/, '')
    .replace(/\/v1(?:\/(?:search|fetch)(?:\/public)?)?$/, '');
  base.pathname = `${root}/v1/${tool}${keyed ? '' : '/public'}`;
  return base.href;
}
