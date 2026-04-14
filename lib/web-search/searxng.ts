import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';

const SEARXNG_MAX_QUERY_LENGTH = 400;

/**
 * Search the web using SearXNG API and return structured results.
 */
export async function searchWithSearXNG(params: {
  query: string;
  baseUrl: string;
  maxResults?: number;
}): Promise<WebSearchResult> {
  const { query, baseUrl, maxResults = 5 } = params;
  const truncatedQuery = query.slice(0, SEARXNG_MAX_QUERY_LENGTH);

  const url = new URL(baseUrl);
  url.searchParams.append('q', truncatedQuery);
  url.searchParams.append('format', 'json');
  url.searchParams.append('language', 'en');

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`SearXNG error: ${response.status}`);

  const data = await response.json();
  const startTime = Date.now();

  const sources: WebSearchSource[] = data.results.slice(0, maxResults).map((result: Record<string, string | number>) => ({
    title: String(result.title || ''),
    url: String(result.url || ''),
    content: String(result.content || ''),
    score: typeof result.score === 'number' ? result.score : 1,
  }));

  const answer = data.answers && data.answers.length > 0 ? data.answers[0] : '';
  const responseTime = (Date.now() - startTime) / 1000;

  return {
    answer,
    sources,
    query: data.query,
    responseTime,
  };
}
