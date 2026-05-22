/**
 * SearXNG Web Search Integration
 *
 * Uses the SearXNG JSON API.
 * SearXNG is a self-hosted, privacy-respecting metasearch engine.
 * API docs: https://docs.searxng.org/dev/search_api.html
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';
import { SEARXNG_DEFAULT_BASE_URL } from './constants';
import { normalizeWebSearchQuery } from './utils';

export { formatSearchResultsAsContext } from './format';

function buildSearXNGSearchUrl(query: string, baseUrl?: string): string {
  const trimmed = (baseUrl || SEARXNG_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const endpoint = trimmed.endsWith('/search') ? trimmed : `${trimmed}/search`;
  const url = new URL(endpoint);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('categories', 'general');
  return url.toString();
}

export async function searchWithSearXNG(params: {
  query: string;
  apiKey?: string;
  maxResults?: number;
  baseUrl?: string;
}): Promise<WebSearchResult> {
  const { query: rawQuery, apiKey, maxResults = 5, baseUrl } = params;
  const query = normalizeWebSearchQuery(rawQuery);
  const startedAt = Date.now();

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await proxyFetch(buildSearXNGSearchUrl(query, baseUrl), {
    method: 'GET',
    headers,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`SearXNG API error (${res.status}): ${errorText || res.statusText}`);
  }

  const data = (await res.json()) as {
    query: string;
    number_of_results: number;
    results: Array<{
      title: string;
      url: string;
      content: string;
      score: number;
    }>;
    answers?: string[];
  };

  const sources: WebSearchSource[] = (data.results || []).slice(0, maxResults).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.content,
    score: r.score,
  }));

  const answer = data.answers?.join('\n') || '';

  return {
    answer,
    sources,
    query: data.query || query,
    responseTime: (Date.now() - startedAt) / 1000,
  };
}
