/**
 * Shared utilities for web search providers.
 */

export const MAX_WEB_SEARCH_QUERY_LENGTH = 400;

export function normalizeWebSearchQuery(query: string): string {
  return query.trim().slice(0, MAX_WEB_SEARCH_QUERY_LENGTH);
}
