/**
 * SearXNG Web Search integration.
 *
 * Uses the SearXNG JSON API: GET {baseUrl}/search?q=...&format=json
 * Docs: https://docs.searxng.org/dev/search_api.html
 */

import { createLogger } from '@/lib/logger';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';
import { normalizeWebSearchQuery } from './utils';

const log = createLogger('SearXNG');

const SEARXNG_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (compatible; OpenMAIC/1.0; +https://github.com/THU-MAIC/OpenMAIC)',
};

export function buildSearxngSearchUrl(baseUrl: string, query: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const root = trimmed.endsWith('/search') ? trimmed.slice(0, -'/search'.length) : trimmed;
  const url = new URL(`${root}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  return url.toString();
}

function mapSearxngResult(
  result: {
    title?: string;
    url?: string;
    link?: string;
    content?: string;
    score?: number;
  },
  index: number,
): WebSearchSource | undefined {
  const url = (result.url || result.link || '').trim();
  if (!url) return undefined;

  const title = (result.title || '').trim() || url;
  return {
    title,
    url,
    content: (result.content || '').trim(),
    score: typeof result.score === 'number' ? result.score : Number((1 - index * 0.05).toFixed(2)),
  };
}

export async function searchWithSearxng(params: {
  query: string;
  maxResults?: number;
  baseUrl?: string;
}): Promise<WebSearchResult> {
  const { query: rawQuery, maxResults = 5, baseUrl } = params;
  const query = normalizeWebSearchQuery(rawQuery);

  if (!baseUrl?.trim()) {
    throw new Error('SearXNG base URL is not configured. Set SEARXNG_BASE_URL on the server.');
  }

  const startedAt = Date.now();
  const requestUrl = buildSearxngSearchUrl(baseUrl, query);
  const res = await proxyFetch(requestUrl, {
    method: 'GET',
    headers: SEARXNG_HEADERS,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`SearXNG error (${res.status}): ${errorText || res.statusText}`);
  }

  const rawText = await res.text();
  let data: {
    query?: string;
    number_of_results?: number;
    results?: Array<{
      title?: string;
      url?: string;
      link?: string;
      content?: string;
      score?: number;
    }>;
  };

  try {
    data = JSON.parse(rawText) as typeof data;
  } catch {
    throw new Error(
      `SearXNG returned non-JSON response. Ensure "json" is enabled in SearXNG search formats.`,
    );
  }

  const rawResults = Array.isArray(data.results) ? data.results : [];
  const sources: WebSearchSource[] = rawResults
    .map((result, index) => mapSearxngResult(result, index))
    .filter((source): source is WebSearchSource => !!source)
    .slice(0, maxResults);

  if (sources.length === 0 && (data.number_of_results ?? rawResults.length) > 0) {
    log.warn('SearXNG reported results but none could be mapped', {
      numberOfResults: data.number_of_results,
      rawResultCount: rawResults.length,
      requestUrl,
    });
  }

  return {
    answer: '',
    sources,
    query: data.query || query,
    responseTime: (Date.now() - startedAt) / 1000,
  };
}
