/**
 * Brave Web Search Integration
 *
 * Scrapes Brave Search public page via proxyFetch.
 * No API key required — uses the public search endpoint.
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';
import { normalizeWebSearchQuery } from './utils';

const BRAVE_SEARCH_URL = 'https://search.brave.com/search';

/**
 * Browser-like headers to avoid being blocked by Brave.
 */
const BRAVE_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
};

/**
 * Parse Brave Search HTML response and extract search results.
 * Uses regex-based parsing to avoid JSDOM dependency.
 */
function parseBraveResults(html: string, maxResults: number): WebSearchSource[] {
  const results: WebSearchSource[] = [];

  // Match each search result snippet block with data-type="web"
  // Actual HTML: <div class="snippet  svelte-xxx" data-pos="0" data-type="web" ...>
  const snippetRegex =
    /<div[^>]*class="snippet[^"]*"[^>]*data-type="web"[^>]*>([\s\S]*?)(?=<div[^>]*class="snippet[^"]*"[^>]*data-type="web"|<footer|$)/gi;

  let snippetMatch;
  while ((snippetMatch = snippetRegex.exec(html)) !== null && results.length < maxResults) {
    const block = snippetMatch[1];

    // Extract URL from the main anchor tag
    const linkMatch = block.match(/<a[^>]*href="([^"]+)"[^>]*>/);
    if (!linkMatch || linkMatch[1].includes('brave.com')) continue;
    const url = linkMatch[1];

    // Extract title — actual class: "title search-snippet-title line-clamp-1 svelte-xxx"
    const titleMatch = block.match(
      /<span[^>]*class="[^"]*search-snippet-title[^"]*"[^>]*>([^<]+)<\/span>/,
    );
    const title = titleMatch ? titleMatch[1].trim() : '';
    if (!title) continue;

    // Extract snippet/description content
    // Try generic-snippet div first (current Brave structure),
    // then fall back to snippet-description p tag (legacy)
    let content = '';
    const genericMatch = block.match(
      /<div[^>]*class="[^"]*generic-snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/,
    );
    const descMatch = block.match(
      /<p[^>]*class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\/p>/,
    );
    const rawDesc = genericMatch?.[1] || descMatch?.[1] || '';
    if (rawDesc) {
      content = rawDesc.replace(/<[^>]+>/g, '').trim();
      // Remove date prefix if present (e.g., "2 days ago -" or "Jan 1, 2026 - ")
      content = content.replace(/^\d+ \w+ ago\s*[-—]\s*/, '');
      content = content.replace(/^[A-Z][a-z]+ \d+, \d{4}\s*[-—]\s*/, '');
    }

    results.push({
      title,
      url,
      content,
      score: 1 - results.length * 0.1, // Position-based score: 1.0, 0.9, 0.8, ...
    });
  }

  return results;
}

/**
 * Search the web using Brave Search (public page scraping) and return structured results.
 */
export async function searchWithBrave(params: {
  query: string;
  maxResults?: number;
}): Promise<WebSearchResult> {
  const { query: rawQuery, maxResults = 5 } = params;
  const query = normalizeWebSearchQuery(rawQuery);

  const url = `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(query)}`;

  const startTime = Date.now();
  const res = await proxyFetch(url, {
    method: 'GET',
    headers: BRAVE_HEADERS,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Brave Search error (${res.status}): ${errorText || res.statusText}`);
  }

  const html = await res.text();
  const responseTime = (Date.now() - startTime) / 1000;

  const sources = parseBraveResults(html, maxResults);

  return {
    answer: '', // Brave Search doesn't provide a direct answer
    sources,
    query,
    responseTime,
  };
}
