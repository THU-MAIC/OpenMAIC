/**
 * Firecrawl Web Search integration.
 *
 * Uses Firecrawl Search (`/v2/search`) and returns result descriptions only,
 * without scraping the result pages. Shares the `firecrawl` provider (key and
 * base URL) with Firecrawl web fetch.
 * Docs: https://docs.firecrawl.dev/features/search?utm_source=openmaic&utm_medium=integration
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';
import { FIRECRAWL_DEFAULT_BASE_URL, firecrawlEndpoint } from './firecrawl-endpoint';
import { normalizeWebSearchQuery } from './utils';

type FirecrawlSearchResult = {
  title?: string | null;
  url?: string | null;
  description?: string | null;
};

function mapFirecrawlResult(
  result: FirecrawlSearchResult,
  index: number,
): WebSearchSource | undefined {
  const url = (result.url || '').trim();
  if (!url) return undefined;

  return {
    title: result.title?.trim() || url,
    url,
    content: (result.description || '').replace(/\s+/g, ' ').trim(),
    score: Number((1 - index * 0.05).toFixed(2)),
  };
}

export async function searchWithFirecrawl(params: {
  query: string;
  apiKey: string;
  maxResults?: number;
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<WebSearchResult> {
  const { query: rawQuery, apiKey, maxResults = 5, baseUrl, signal } = params;
  const query = normalizeWebSearchQuery(rawQuery);
  const limit = Number.isFinite(maxResults)
    ? Math.max(1, Math.min(Math.floor(maxResults), 100))
    : 5;
  const startedAt = Date.now();

  const res = await proxyFetch(firecrawlEndpoint(baseUrl || FIRECRAWL_DEFAULT_BASE_URL, 'search'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      limit,
      origin: 'openmaic',
    }),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    // Do not relay vendor messages, which can echo credentials or request data.
    throw new Error(`Firecrawl API error (HTTP ${res.status})`);
  }

  const data = (await res.json()) as { data?: { web?: FirecrawlSearchResult[] } };
  const rawResults = Array.isArray(data.data?.web) ? data.data.web : [];
  const sources = rawResults
    .map((result, index) => mapFirecrawlResult(result, index))
    .filter((source): source is WebSearchSource => !!source)
    .slice(0, limit);

  return {
    answer: '',
    sources,
    query,
    responseTime: (Date.now() - startedAt) / 1000,
  };
}
