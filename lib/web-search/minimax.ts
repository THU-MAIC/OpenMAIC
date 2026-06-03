/**
 * MiniMax Web Search integration.
 *
 * Uses the Token Plan HTTP endpoint behind the MiniMax MCP web_search tool:
 * POST https://api.minimaxi.com/v1/coding_plan/search
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';

const MINIMAX_DEFAULT_BASE_URL = 'https://api.minimaxi.com';

function buildMiniMaxWebSearchUrl(baseUrl?: string): string {
  const trimmed = (baseUrl || MINIMAX_DEFAULT_BASE_URL).replace(/\/$/, '');
  if (trimmed.endsWith('/v1/coding_plan/search')) return trimmed;
  if (trimmed.endsWith('/v1/coding_plan')) return `${trimmed}/search`;
  if (trimmed.endsWith('/v1')) return `${trimmed}/coding_plan/search`;
  return `${trimmed}/v1/coding_plan/search`;
}

function getMiniMaxBaseResp(raw: unknown):
  | {
      status_code?: string | number;
      status_msg?: string;
    }
  | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value =
    (raw as { base_resp?: unknown; baseResp?: unknown }).base_resp ||
    (raw as { base_resp?: unknown; baseResp?: unknown }).baseResp;
  if (!value || typeof value !== 'object') return undefined;
  return value as { status_code?: string | number; status_msg?: string };
}

function formatMiniMaxError(status: number, statusText: string, errorText: string): string {
  if (!errorText) return `MiniMax Web Search API error (${status}): ${statusText}`;

  try {
    const parsed = JSON.parse(errorText) as {
      code?: string | number;
      message?: string;
      error?: { message?: string };
      base_resp?: { status_code?: string | number; status_msg?: string };
    };
    const baseResp = getMiniMaxBaseResp(parsed);
    const code = baseResp?.status_code ?? parsed.code ?? status;
    const message = baseResp?.status_msg || parsed.message || parsed.error?.message || statusText;
    return `MiniMax Web Search API error (${code}): ${message}`;
  } catch {
    return `MiniMax Web Search API error (${status}): ${errorText}`;
  }
}

function getOrganicResults(raw: MiniMaxSearchResponse): MiniMaxOrganicResult[] {
  return raw.organic || raw.data?.organic || raw.results || [];
}

/**
 * Search the web using MiniMax Web Search API and return structured results.
 */
export async function searchWithMiniMax(params: {
  query: string;
  apiKey: string;
  maxResults?: number;
  baseUrl?: string;
}): Promise<WebSearchResult> {
  const { query, apiKey, maxResults = 10, baseUrl } = params;
  const startedAt = Date.now();

  const res = await proxyFetch(buildMiniMaxWebSearchUrl(baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'MM-API-Source': 'OpenMAIC',
    },
    body: JSON.stringify({ q: query }),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(formatMiniMaxError(res.status, res.statusText, errorText));
  }

  const raw = (await res.json()) as MiniMaxSearchResponse;
  const baseResp = getMiniMaxBaseResp(raw);
  if (baseResp?.status_code !== undefined && String(baseResp.status_code) !== '0') {
    throw new Error(
      `MiniMax Web Search API error (${baseResp.status_code}): ${
        baseResp.status_msg || 'Request failed'
      }`,
    );
  }

  const limit = Math.max(Math.floor(maxResults), 1);
  const sources: WebSearchSource[] = getOrganicResults(raw)
    .map((item) => {
      const url = item.link || item.url || '';
      return {
        title: item.title || url,
        url,
        content: item.snippet || item.summary || item.content || item.date || '',
        score: 0,
      };
    })
    .filter((source) => source.url)
    .slice(0, limit);

  return {
    answer: '',
    sources,
    query,
    responseTime: (Date.now() - startedAt) / 1000,
  };
}

interface MiniMaxSearchResponse {
  organic?: MiniMaxOrganicResult[];
  results?: MiniMaxOrganicResult[];
  data?: {
    organic?: MiniMaxOrganicResult[];
  };
  base_resp?: {
    status_code?: string | number;
    status_msg?: string;
  };
  baseResp?: {
    status_code?: string | number;
    status_msg?: string;
  };
}

interface MiniMaxOrganicResult {
  title?: string;
  link?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  content?: string;
  date?: string;
}
