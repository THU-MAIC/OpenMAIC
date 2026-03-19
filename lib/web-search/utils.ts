/**
 * Shared utilities for web search providers.
 */

/** Maximum query length accepted by web search providers. */
export const MAX_WEB_SEARCH_QUERY_LENGTH = 400;

/**
 * Normalize a web search query: trim whitespace and truncate to
 * {@link MAX_WEB_SEARCH_QUERY_LENGTH} characters.
 *
 * Every provider should call this before using the query to ensure
 * consistent behaviour regardless of the call-site.
 */
export function normalizeWebSearchQuery(query: string): string {
  return query.trim().slice(0, MAX_WEB_SEARCH_QUERY_LENGTH);
}
