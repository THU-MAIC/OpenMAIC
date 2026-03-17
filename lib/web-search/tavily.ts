/**
 * Tavily Web Search Integration
 *
 * Uses raw REST API via proxyFetch for reliable proxy support.
 * Tavily search endpoint: POST https://api.tavily.com/search
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';

const TAVILY_API_URL = 'https://api.tavily.com/search';

/**
 * Search the web using Tavily REST API and return structured results.
 */
export async function searchWithTavily(params: {
  query: string;
  apiKey: string;
  maxResults?: number;
}): Promise<WebSearchResult> {
  const { query, apiKey, maxResults = 5 } = params;

  const res = await proxyFetch(TAVILY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      max_results: maxResults,
      include_answer: 'basic',
    }),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Tavily API error (${res.status}): ${errorText || res.statusText}`);
  }

  const data = (await res.json()) as {
    answer?: string;
    query: string;
    response_time: number;
    results: Array<{
      title: string;
      url: string;
      content: string;
      score: number;
    }>;
  };

  const sources: WebSearchSource[] = (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.content,
    score: r.score,
  }));

  return {
    answer: data.answer || '',
    sources,
    query: data.query,
    responseTime: data.response_time,
  };
}

/**
 * Format search results into a markdown context block for LLM prompts.
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
