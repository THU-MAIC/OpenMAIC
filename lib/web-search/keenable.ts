/**
 * Keenable Web Search integration.
 *
 * Uses Keenable Search (`POST /v1/search/public` without a key, `/v1/search`
 * with one; the key only lifts rate limits). Shares the `keenable` provider
 * (optional key and base URL) with Keenable web fetch.
 * Docs: https://docs.keenable.ai/api-reference
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';
import {
  KEENABLE_APP_TITLE,
  KEENABLE_DEFAULT_BASE_URL,
  keenableEndpoint,
} from './keenable-endpoint';
import { normalizeWebSearchQuery } from './utils';

type KeenableSearchResult = {
  title?: string | null;
  url?: string | null;
  /** Page text around the match; `description` is not populated by the API. */
  snippet?: string | null;
};

function mapKeenableResult(
  result: KeenableSearchResult,
  index: number,
): WebSearchSource | undefined {
  const url = (result.url || '').trim();
  if (!url) return undefined;

  return {
    title: result.title?.trim() || url,
    url,
    content: (result.snippet || '').replace(/\s+/g, ' ').trim(),
    score: Number((1 - index * 0.05).toFixed(2)),
  };
}

export async function searchWithKeenable(params: {
  query: string;
  apiKey?: string;
  maxResults?: number;
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<WebSearchResult> {
  const { query: rawQuery, apiKey, maxResults = 5, baseUrl, signal } = params;
  const query = normalizeWebSearchQuery(rawQuery);
  const limit = Number.isFinite(maxResults) ? Math.max(1, Math.min(Math.floor(maxResults), 50)) : 5;
  const startedAt = Date.now();

  const res = await proxyFetch(
    keenableEndpoint(baseUrl || KEENABLE_DEFAULT_BASE_URL, 'search', !!apiKey),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Keenable-Title': KEENABLE_APP_TITLE,
        ...(apiKey ? { 'X-API-Key': apiKey } : {}),
      },
      body: JSON.stringify({ query, max_results: limit }),
      ...(signal ? { signal } : {}),
    },
  );

  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    // Do not relay vendor messages, which can echo credentials or request data.
    throw new Error(`Keenable API error (HTTP ${res.status})`);
  }

  const data = (await res.json()) as { results?: KeenableSearchResult[] };
  const rawResults = Array.isArray(data.results) ? data.results : [];
  const sources = rawResults
    .map((result, index) => mapKeenableResult(result, index))
    .filter((source): source is WebSearchSource => !!source)
    .slice(0, limit);

  return {
    answer: '',
    sources,
    query,
    responseTime: (Date.now() - startedAt) / 1000,
  };
}
