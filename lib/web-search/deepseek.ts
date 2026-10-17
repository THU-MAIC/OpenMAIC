/** DeepSeek search shares its chat account's credentials and API base. */
import { deepseekToolsEndpoint } from './deepseek-endpoint';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult } from '@/lib/types/web-search';

interface DeepSeekSearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    summary?: string;
    snippet?: string;
    rerank_score?: number;
  }>;
  error?: { code?: string; message?: string };
}

export async function searchWithDeepSeek(params: {
  query: string;
  apiKey: string;
  maxResults?: number;
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<WebSearchResult> {
  const { apiKey, maxResults = 10, baseUrl = 'https://api.deepseek.com/v1', signal } = params;
  // Slice code points, so astral characters never become unpaired surrogates.
  const query = Array.from(params.query.trim()).slice(0, 128).join('');
  if (!query) throw new Error('DeepSeek Web Search requires a nonempty query');
  const count = Number.isFinite(maxResults)
    ? Math.min(50, Math.max(1, Math.floor(maxResults)))
    : 10;
  const startedAt = Date.now();
  const response = await proxyFetch(deepseekToolsEndpoint(baseUrl, 'search'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, count, need_content: false }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    let message = errorText || response.statusText;
    try {
      const raw = JSON.parse(errorText) as DeepSeekSearchResponse;
      message = raw.error?.message || message;
    } catch {
      // Preserve the HTTP status and response text for non-JSON errors.
    }
    throw new Error(`DeepSeek Web Search API error (${response.status}): ${message}`);
  }
  const raw = (await response.json()) as DeepSeekSearchResponse;
  if (raw?.error) {
    throw new Error(
      `DeepSeek Web Search API error (${raw.error.code || response.status}): ${raw.error.message || 'Request failed'}`,
    );
  }
  if (!Array.isArray(raw?.results)) {
    throw new Error('DeepSeek Web Search API returned an invalid results field');
  }
  const sources = raw.results
    .map((item) => ({
      title: item.title || item.url || '',
      url: item.url || '',
      content: item.summary?.trim() ? item.summary : item.snippet || '',
      score: item.rerank_score ?? 0,
    }))
    .filter((source) => source.url)
    .slice(0, count);
  return { answer: '', sources, query, responseTime: (Date.now() - startedAt) / 1000 };
}
