/** Firecrawl's cloud API root, shared by search and scrape. */
export const FIRECRAWL_DEFAULT_BASE_URL = 'https://api.firecrawl.dev';

/** Spellings of the cloud API base a workspace may save (any of them reaches both tools). */
export const FIRECRAWL_OFFICIAL_BASE_URLS = ['', '/v2', '/v2/search', '/v2/scrape'].map(
  (path) => `${FIRECRAWL_DEFAULT_BASE_URL}${path}`,
);

export function isOfficialFirecrawlBaseUrl(baseUrl: string): boolean {
  return FIRECRAWL_OFFICIAL_BASE_URLS.includes(baseUrl.trim().replace(/\/+$/, ''));
}

/**
 * One `firecrawl` provider serves web search and web fetch with the same base
 * URL, so either tool's endpoint is derived from it: the API root, its `/v2`
 * prefix or a tool's own endpoint all resolve to the requested tool, and a
 * self-hosted base keeps its path prefix.
 */
export function firecrawlEndpoint(baseUrl: string, tool: 'search' | 'scrape'): string {
  const base = new URL(baseUrl);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  ) {
    throw new Error('Invalid Firecrawl API base URL');
  }
  const root = base.pathname.replace(/\/+$/, '').replace(/\/v2(?:\/(?:search|scrape))?$/, '');
  base.pathname = `${root}/v2/${tool}`;
  return base.href;
}
