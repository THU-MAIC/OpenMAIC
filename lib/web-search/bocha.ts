/**
 * Bocha Web Search Integration
 *
 * Uses raw REST API via proxyFetch for reliable proxy support.
 * Bocha web search endpoint: POST https://api.bocha.cn/v1/web-search
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';

const BOCHA_DEFAULT_BASE_URL = 'https://api.bocha.cn';
const BOCHA_MAX_RESULTS = 50;

function buildBochaWebSearchUrl(baseUrl?: string): string {
  const trimmed = (baseUrl || BOCHA_DEFAULT_BASE_URL).replace(/\/$/, '');
  if (trimmed.endsWith('/v1/web-search')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/web-search`;
  return `${trimmed}/v1/web-search`;
}

function clampCount(maxResults: number): number {
  return Math.min(Math.max(Math.floor(maxResults), 1), BOCHA_MAX_RESULTS);
}

function formatBochaError(status: number, statusText: string, errorText: string): string {
  if (!errorText) return `Bocha API error (${status}): ${statusText}`;

  try {
    const parsed = JSON.parse(errorText) as {
      code?: string | number;
      message?: string;
      msg?: string | null;
      log_id?: string;
    };
    const code = parsed.code ?? status;
    const message = parsed.message || parsed.msg || statusText;
    const logId = parsed.log_id ? `, log_id: ${parsed.log_id}` : '';
    return `Bocha API error (${code}): ${message}${logId}`;
  } catch {
    return `Bocha API error (${status}): ${errorText}`;
  }
}

/**
 * Search the web using Bocha Web Search API and return structured results.
 */
export async function searchWithBocha(params: {
  query: string;
  apiKey: string;
  maxResults?: number;
  baseUrl?: string;
}): Promise<WebSearchResult> {
  const { query, apiKey, maxResults = 10, baseUrl } = params;
  const startedAt = Date.now();

  const res = await proxyFetch(buildBochaWebSearchUrl(baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      freshness: 'noLimit',
      summary: true,
      count: clampCount(maxResults),
    }),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(formatBochaError(res.status, res.statusText, errorText));
  }

  const raw = (await res.json()) as {
    code?: number | string;
    msg?: string | null;
    message?: string;
    log_id?: string;
    data?: BochaSearchData;
  } & BochaSearchData;

  if (raw.code !== undefined && String(raw.code) !== '200') {
    const message = raw.message || raw.msg || 'Request failed';
    const logId = raw.log_id ? `, log_id: ${raw.log_id}` : '';
    throw new Error(`Bocha API error (${raw.code}): ${message}${logId}`);
  }

  const data = raw.data || raw;
  const pages = data.webPages?.value || [];

  const sources: WebSearchSource[] = pages
    .filter((page) => page.url)
    .map((page) => ({
      title: page.name || page.url,
      url: page.url,
      content: page.summary || page.snippet || '',
      score: 0,
    }));

  return {
    answer: '',
    sources,
    query: data.queryContext?.originalQuery || query,
    responseTime: (Date.now() - startedAt) / 1000,
  };
}

interface BochaSearchData {
  queryContext?: {
    originalQuery?: string;
  };
  webPages?: {
    value?: Array<{
      name?: string;
      url: string;
      snippet?: string;
      summary?: string;
    }>;
  };
}
