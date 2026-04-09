/**
 * Exa Web Search Integration
 *
 * Uses REST API via proxyFetch for reliable proxy support.
 * Exa search endpoint: POST https://api.exa.ai/search
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import { createLogger } from '@/lib/logger';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';

const log = createLogger('ExaSearch');

const EXA_API_URL = 'https://api.exa.ai/search';
const EXA_MAX_QUERY_LENGTH = 400;

/**
 * Search the web using Exa REST API and return structured results.
 */
export async function searchWithExa(params: {
  query: string;
  apiKey: string;
  maxResults?: number;
}): Promise<WebSearchResult> {
  const { query, apiKey, maxResults = 5 } = params;

  const truncatedQuery = query.slice(0, EXA_MAX_QUERY_LENGTH);

  const startTime = Date.now();

  const res = await proxyFetch(EXA_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      query: truncatedQuery,
      type: 'auto',
      numResults: maxResults,
      highlights: {
        numSentences: 3,
        highlightsPerUrl: 1,
      },
    }),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Exa API error (${res.status}): ${errorText || res.statusText}`);
  }

  const data = (await res.json()) as {
    results: Array<{
      title: string;
      url: string;
      highlights?: string[];
      score: number;
    }>;
    requestId?: string;
  };

  const responseTime = (Date.now() - startTime) / 1000;

  const sources: WebSearchSource[] = (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.highlights?.join(' ') || '',
    score: r.score,
  }));

  // Log token-equivalent consumption (results count as proxy for usage)
  log.info('[TOKEN_USAGE] web-search exa', {
    service: 'web-search',
    provider: 'exa',
    resultsCount: sources.length,
    queryLength: truncatedQuery.length,
    responseTimeSec: responseTime,
  });

  return {
    answer: '',
    sources,
    query: truncatedQuery,
    responseTime,
  };
}

/**
 * Format Exa search results into a markdown context block for LLM prompts.
 */
export function formatSearchResultsAsContext(result: WebSearchResult): string {
  if (!result.answer && result.sources.length === 0) {
    return '';
  }

  const lines: string[] = [];

  if (result.answer) {
    lines.push(result.answer);
    lines.push('');
  }

  if (result.sources.length > 0) {
    lines.push('Sources:');
    for (const src of result.sources) {
      lines.push(`- [${src.title}](${src.url}): ${src.content.slice(0, 200)}`);
    }
  }

  return lines.join('\n');
}
