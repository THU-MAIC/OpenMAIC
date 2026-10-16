/** Kimi search, using the same credentials and base URL as Kimi chat. */
import { normalizeWebSearchQuery } from './utils';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult } from '@/lib/types/web-search';

const DEFAULT_BASE_URL = 'https://api.moonshot.cn/v1';

interface KimiSearchResponse {
  search_results?: Array<{
    title?: string;
    url?: string;
    snippet?: string;
    content?: string;
    chunks?: Array<{ text?: string }>;
  }>;
  error?: { code?: string; message?: string };
}

/** Endpoint selection stays here so callers only pass the account's base URL. */
function searchEndpoint(baseUrl: string): { url: string; coding: boolean } {
  const base = baseUrl.replace(/\/+$/, '');
  const coding = new URL(base).pathname.replace(/\/+$/, '').endsWith('/coding/v1');
  return { url: `${base}${coding ? '/search' : '/tools/search_pro'}`, coding };
}

export async function searchWithKimi(params: {
  query: string;
  apiKey: string;
  maxResults?: number;
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<WebSearchResult> {
  const { query: rawQuery, apiKey, maxResults = 10, baseUrl, signal } = params;
  const query = normalizeWebSearchQuery(rawQuery);
  const startedAt = Date.now();
  const limit = Number.isFinite(maxResults)
    ? Math.min(20, Math.max(1, Math.floor(maxResults)))
    : 10;
  const { url, coding } = searchEndpoint(baseUrl || DEFAULT_BASE_URL);
  const res = await proxyFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      text_query: query,
      limit,
      timeout_seconds: 30,
      ...(coding ? { enable_page_crawling: true } : {}),
    }),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    let message = errorText || res.statusText;
    try {
      const raw = JSON.parse(errorText) as KimiSearchResponse;
      message = raw.error?.message || message;
    } catch {
      // Non-JSON errors retain their HTTP status and response text.
    }
    throw new Error(`Kimi Web Search API error (${res.status}): ${message}`);
  }

  const raw = (await res.json()) as KimiSearchResponse;
  if (raw.error) {
    throw new Error(
      `Kimi Web Search API error (${raw.error.code || res.status}): ${raw.error.message || 'Request failed'}`,
    );
  }
  if (!Array.isArray(raw.search_results)) {
    throw new Error('Kimi Web Search API returned an invalid search_results field');
  }

  const sources = raw.search_results
    .map((item) => ({
      title: item.title || item.url || '',
      url: item.url || '',
      content:
        (coding
          ? item.content
          : item.chunks
              ?.map((chunk) => chunk.text || '')
              .filter((text) => text.trim())
              .join('\n\n')) ||
        item.snippet ||
        '',
      score: 0,
    }))
    .filter((source) => source.url)
    // Coding Plan search may ignore the requested limit; cap both endpoints locally.
    .slice(0, limit);

  return { answer: '', sources, query, responseTime: (Date.now() - startedAt) / 1000 };
}
