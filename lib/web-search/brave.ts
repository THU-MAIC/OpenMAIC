/**
 * Brave Web Search integration.
 *
 * Supports two modes:
 * - **API mode** (preferred): Uses the official Brave Search API with an API key.
 *   Returns structured JSON results with rich metadata.
 * - **Scrape mode** (fallback): Fetches the public HTML search page and extracts
 *   web result snippets via regex. No API key needed but subject to rate-limiting.
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';
import { normalizeWebSearchQuery } from './utils';

const BRAVE_DEFAULT_BASE_URL = 'https://search.brave.com';

const BRAVE_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function buildBraveSearchUrl(query: string, baseUrl?: string): string {
  const trimmed = (baseUrl || BRAVE_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const endpoint = trimmed.endsWith('/search') ? trimmed : `${trimmed}/search`;
  const url = new URL(endpoint);
  url.searchParams.set('q', query);
  return url.toString();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function isBraveOwnedUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'brave.com' || host.endsWith('.brave.com');
  } catch {
    return true;
  }
}

export function parseBraveSearchHtml(html: string, maxResults: number): WebSearchSource[] {
  const results: WebSearchSource[] = [];
  const snippetRegex =
    /<div[^>]*class="[^"]*\bsnippet\b[^"]*"[^>]*data-type="web"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*\bsnippet\b[^"]*"[^>]*data-type="web"|<footer|$)/gi;

  let snippetMatch: RegExpExecArray | null;
  while ((snippetMatch = snippetRegex.exec(html)) !== null && results.length < maxResults) {
    const block = snippetMatch[1];
    const linkMatch = block.match(/<a[^>]*href="([^"]+)"[^>]*>/i);
    if (!linkMatch) continue;

    const url = decodeHtml(linkMatch[1].trim());
    if (!url || isBraveOwnedUrl(url)) continue;

    const titleMatch = block.match(
      /<span[^>]*class="[^"]*search-snippet-title[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
    );
    const title = titleMatch ? stripHtml(titleMatch[1]) : '';
    if (!title) continue;

    const genericMatch = block.match(
      /<div[^>]*class="[^"]*generic-snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    );
    const descMatch = block.match(
      /<p[^>]*class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
    );
    const rawContent = genericMatch?.[1] || descMatch?.[1] || '';
    const content = stripHtml(rawContent)
      .replace(/^\d+ \w+ ago\s*-\s*/, '')
      .replace(/^[A-Z][a-z]+ \d+, \d{4}\s*-\s*/, '');

    results.push({
      title,
      url,
      content,
      score: Number((1 - results.length * 0.1).toFixed(2)),
    });
  }

  return results;
}

const BRAVE_API_BASE_URL = 'https://api.search.brave.com';

/**
 * Use the official Brave Search API (requires API key).
 * Docs: https://api.search.brave.com/app/documentation/web-search
 */
async function searchWithBraveApi(
  query: string,
  apiKey: string,
  maxResults: number,
): Promise<WebSearchSource[]> {
  const url = new URL('/res/v1/web/search', BRAVE_API_BASE_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(maxResults, 20)));

  const res = await proxyFetch(url.toString(), {
    method: 'GET',
    headers: {
      'X-Subscription-Token': apiKey,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Brave API error (${res.status}): ${errorText || res.statusText}`);
  }

  const data = (await res.json()) as {
    web?: {
      results?: Array<{
        title?: string;
        url?: string;
        description?: string;
      }>;
    };
  };

  return (data.web?.results || [])
    .filter((r) => r.url)
    .slice(0, maxResults)
    .map((r, i) => ({
      title: r.title || '',
      url: r.url || '',
      content: stripHtml(r.description || ''),
      score: Number((1 - i * 0.05).toFixed(2)),
    }));
}

/**
 * Fallback: scrape the public Brave Search HTML page (no API key needed).
 */
async function searchWithBraveScrape(
  query: string,
  maxResults: number,
  baseUrl?: string,
): Promise<WebSearchSource[]> {
  const res = await proxyFetch(buildBraveSearchUrl(query, baseUrl), {
    method: 'GET',
    headers: BRAVE_HEADERS,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Brave Search error (${res.status}): ${errorText || res.statusText}`);
  }

  const html = await res.text();
  return parseBraveSearchHtml(html, maxResults);
}

export async function searchWithBrave(params: {
  query: string;
  apiKey?: string;
  maxResults?: number;
  baseUrl?: string;
}): Promise<WebSearchResult> {
  const { query: rawQuery, apiKey, maxResults = 5, baseUrl } = params;
  const query = normalizeWebSearchQuery(rawQuery);
  const startedAt = Date.now();

  const sources = apiKey
    ? await searchWithBraveApi(query, apiKey, maxResults)
    : await searchWithBraveScrape(query, maxResults, baseUrl);

  return {
    answer: '',
    sources,
    query,
    responseTime: (Date.now() - startedAt) / 1000,
  };
}
