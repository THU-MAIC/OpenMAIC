/**
 * Doubao Web Search integration (豆包搜索 Custom 版).
 *
 * The Volcengine Ark Agent Plan exposes web search through the same REST
 * endpoint the `mcp-server-askecho-search-infinity` MCP server wraps:
 * POST https://open.feedcoopapi.com/search_api/web_search
 * authenticated with the Agent Plan's dedicated API Key (Bearer). We call it
 * directly so it lights up as a one-click token-plan modality, no MCP runtime.
 *
 * Docs: https://www.volcengine.com/docs/85508/1650263
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';

const DOUBAO_DEFAULT_BASE_URL = 'https://open.feedcoopapi.com';
const DOUBAO_SEARCH_PATH = '/search_api/web_search';
/** Query is truncated past 100 chars by the API; trim defensively first. */
const DOUBAO_MAX_QUERY_LENGTH = 100;

function buildDoubaoSearchUrl(baseUrl?: string): string {
  const trimmed = (baseUrl || DOUBAO_DEFAULT_BASE_URL).replace(/\/$/, '');
  return trimmed.endsWith(DOUBAO_SEARCH_PATH) ? trimmed : `${trimmed}${DOUBAO_SEARCH_PATH}`;
}

/** Doubao reports failures in ResponseMetadata.Error, often with HTTP 200. */
interface DoubaoError {
  Code?: string;
  CodeN?: number;
  Message?: string;
}

interface DoubaoWebItem {
  Title?: string;
  Url?: string;
  Snippet?: string;
  Summary?: string;
  Content?: string;
  SiteName?: string;
  RankScore?: number;
  PublishTime?: string;
}

interface DoubaoSearchResponse {
  ResponseMetadata?: {
    RequestId?: string;
    Error?: DoubaoError;
  };
  Result?: {
    ResultCount?: number;
    WebResults?: DoubaoWebItem[] | null;
  } | null;
}

function formatDoubaoError(
  err: DoubaoError | undefined,
  status: number,
  statusText: string,
): string {
  const code = err?.Code ?? err?.CodeN ?? status;
  const message = err?.Message || statusText || 'Request failed';
  return `Doubao Web Search API error (${code}): ${message}`;
}

/**
 * Search the web using Doubao Search (Custom 版) and return structured results.
 * Prefers `Summary` (query-relevant 500~1000 char excerpt, recommended for LLM
 * use) over `Snippet` (~200 char list blurb) for each source's content.
 */
export async function searchWithDoubao(params: {
  query: string;
  apiKey: string;
  maxResults?: number;
  baseUrl?: string;
}): Promise<WebSearchResult> {
  const { query, apiKey, maxResults = 10, baseUrl } = params;
  const startedAt = Date.now();
  const limit = Math.max(Math.floor(maxResults), 1);

  const res = await proxyFetch(buildDoubaoSearchUrl(baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      Query: query.slice(0, DOUBAO_MAX_QUERY_LENGTH),
      SearchType: 'web',
      Count: Math.min(limit, 50),
      NeedSummary: true,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Doubao Web Search API error (${res.status}): ${errorText || res.statusText}`);
  }

  const raw = (await res.json()) as DoubaoSearchResponse;
  const err = raw.ResponseMetadata?.Error;
  // Doubao returns errors inside a 200 body; CodeN 0 / absent Error == success.
  if (err && (err.Code || err.CodeN || err.Message)) {
    throw new Error(formatDoubaoError(err, res.status, res.statusText));
  }

  const sources: WebSearchSource[] = (raw.Result?.WebResults || [])
    .map((item) => ({
      title: item.Title || item.Url || '',
      url: item.Url || '',
      content: item.Summary || item.Content || item.Snippet || '',
      score: typeof item.RankScore === 'number' ? item.RankScore : 0,
    }))
    .filter((source) => source.url)
    .slice(0, limit);

  return {
    answer: '',
    sources,
    query,
    responseTime: (Date.now() - startedAt) / 1000,
  };
}
