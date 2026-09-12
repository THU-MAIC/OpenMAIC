/**
 * Serply Web Search integration.
 *
 * Uses the Serply Google search endpoint, which returns organic results with
 * a title, link, and description snippet per hit.
 * Docs: https://serply.io/docs
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';
import { normalizeWebSearchQuery } from './utils';

const SERPLY_DEFAULT_BASE_URL = 'https://api.serply.io';
const SERPLY_USER_AGENT =
  'Mozilla/5.0 (compatible; OpenMAIC/1.0; +https://github.com/THU-MAIC/OpenMAIC)';

function buildSerplySearchUrl(baseUrl: string | undefined, query: string, num: number): string {
  const trimmed = (baseUrl || SERPLY_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const endpoint = trimmed.endsWith('/v1/search') ? trimmed : `${trimmed}/v1/search`;
  const params = new URLSearchParams({ q: query, num: String(num) });
  return `${endpoint}?${params.toString()}`;
}

type SerplySearchResult = {
  title?: string | null;
  link?: string | null;
  description?: string | null;
};

function mapSerplyResult(result: SerplySearchResult, index: number): WebSearchSource | undefined {
  const url = (result.link || '').trim();
  if (!url) return undefined;

  return {
    title: result.title?.trim() || url,
    url,
    content: result.description?.trim() || '',
    score: Number((1 - index * 0.05).toFixed(2)),
  };
}

export async function searchWithSerply(params: {
  query: string;
  apiKey: string;
  maxResults?: number;
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<WebSearchResult> {
  const { query: rawQuery, apiKey, maxResults = 5, baseUrl, signal } = params;
  const query = normalizeWebSearchQuery(rawQuery);
  const num = Math.max(1, Math.min(maxResults, 100));
  const startedAt = Date.now();

  const res = await proxyFetch(buildSerplySearchUrl(baseUrl, query, num), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Api-Key': apiKey,
      'User-Agent': SERPLY_USER_AGENT,
    },
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Serply API error (${res.status}): ${errorText || res.statusText}`);
  }

  const data = (await res.json()) as { results?: SerplySearchResult[] };
  const rawResults = Array.isArray(data.results) ? data.results : [];
  const sources = rawResults
    .map((result, index) => mapSerplyResult(result, index))
    .filter((source): source is WebSearchSource => !!source)
    .slice(0, num);

  return {
    answer: '',
    sources,
    query,
    responseTime: (Date.now() - startedAt) / 1000,
  };
}
