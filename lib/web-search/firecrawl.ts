/**
 * Firecrawl Web Search integration.
 *
 * Uses Firecrawl Search (`/v2/search`) and returns result descriptions only,
 * without scraping the result pages.
 * Docs: https://docs.firecrawl.dev/features/search?utm_source=openmaic&utm_medium=integration
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';
import { normalizeWebSearchQuery } from './utils';

const FIRECRAWL_DEFAULT_BASE_URL = 'https://api.firecrawl.dev';

function buildFirecrawlSearchUrl(baseUrl?: string): string {
  const trimmed = (baseUrl || FIRECRAWL_DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (trimmed.endsWith('/v2/search')) return trimmed;
  if (trimmed.endsWith('/v2')) return `${trimmed}/search`;
  return `${trimmed}/v2/search`;
}

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
  const limit = Math.max(1, Math.min(maxResults, 100));
  const startedAt = Date.now();

  const res = await proxyFetch(buildFirecrawlSearchUrl(baseUrl), {
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
    const errorText = await res.text().catch(() => '');
    throw new Error(`Firecrawl API error (${res.status}): ${errorText || res.statusText}`);
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
