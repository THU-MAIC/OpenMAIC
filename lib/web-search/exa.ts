/**
 * Exa Web Search integration.
 *
 * Uses the official Search API with query-relevant highlights so agent calls
 * receive auditable excerpts without downloading full page contents.
 * Docs: https://exa.ai/docs/reference/search-api-guide-for-coding-agents
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';
import { normalizeWebSearchQuery } from './utils';

const EXA_DEFAULT_BASE_URL = 'https://api.exa.ai';

function buildExaSearchUrl(baseUrl?: string): string {
  const trimmed = (baseUrl || EXA_DEFAULT_BASE_URL).replace(/\/+$/, '');
  return trimmed.endsWith('/search') ? trimmed : `${trimmed}/search`;
}

type ExaSearchResult = {
  title?: string | null;
  url?: string | null;
  id?: string | null;
  text?: string | null;
  highlights?: string[] | null;
  summary?: string | null;
  score?: number | null;
};

function mapExaResult(result: ExaSearchResult, index: number): WebSearchSource | undefined {
  const url = (result.url || result.id || '').trim();
  if (!url) return undefined;

  const highlights = Array.isArray(result.highlights)
    ? result.highlights
        .map((highlight) => highlight.trim())
        .filter(Boolean)
        .join('\n\n')
    : '';

  return {
    title: result.title?.trim() || url,
    url,
    content: highlights || result.summary?.trim() || result.text?.trim() || '',
    score: typeof result.score === 'number' ? result.score : Number((1 - index * 0.05).toFixed(2)),
  };
}

export async function searchWithExa(params: {
  query: string;
  apiKey: string;
  maxResults?: number;
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<WebSearchResult> {
  const { query: rawQuery, apiKey, maxResults = 5, baseUrl, signal } = params;
  const query = normalizeWebSearchQuery(rawQuery);
  const numResults = Math.max(1, Math.min(maxResults, 100));
  const startedAt = Date.now();

  const res = await proxyFetch(buildExaSearchUrl(baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      type: 'auto',
      numResults,
      contents: { highlights: true },
    }),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Exa API error (${res.status}): ${errorText || res.statusText}`);
  }

  const data = (await res.json()) as { results?: ExaSearchResult[] };
  const rawResults = Array.isArray(data.results) ? data.results : [];
  const sources = rawResults
    .map((result, index) => mapExaResult(result, index))
    .filter((source): source is WebSearchSource => !!source)
    .slice(0, numResults);

  return {
    answer: '',
    sources,
    query,
    responseTime: (Date.now() - startedAt) / 1000,
  };
}
