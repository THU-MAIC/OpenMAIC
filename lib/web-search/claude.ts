/**
 * Claude Web Search Integration
 *
 * This provider implements the native Claude web search tool via the Anthropic Messages API.
 * It requires a specific model (e.g., claude-opus-4-6) and a specific tool definition.
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import { createLogger } from '@/lib/logger';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';

const PAGE_CONTENT_MAX_LENGTH = 2000;
const PAGE_FETCH_TIMEOUT_MS = 5000;

interface SearchContent {
  url: string;
  title: string;
  content?: string;
  type?: string;
  cited_text?: string;
}

interface SearchResultItem {
  type: string;
  content?: SearchContent[];
  citations?: SearchContent[];
  text?: string;
}

interface SearchResult {
  content: SearchResultItem[];
}

/** Fetch a URL and return plain text extracted from its HTML. Returns empty string on any failure. */
async function fetchPageContent(url: string): Promise<string> {
  log.info(`Fetching page content: ${url}`);
  try {
    const res = await proxyFetch(url, {
      headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; OpenMAIC/1.0)' },
      signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn(`Failed to fetch page content [url="${url}" status=${res.status}]`);
      return '';
    }
    const html = await res.text();
    // Strip scripts, styles, and all tags; collapse whitespace
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const content = text.slice(0, PAGE_CONTENT_MAX_LENGTH);
    log.info(`Fetched page content [url="${url}" chars=${content.length}]`);
    return content;
  } catch (e) {
    log.warn(`Error fetching page content [url="${url}"]:`, e);
    return '';
  }
}

const log = createLogger('ClaudeSearch');

/**
 * Search the web using Claude's native web search tool.
 */
export async function searchWithClaude(params: {
  query: string;
  apiKey: string;
  modelId?: string;
  baseUrl: string;
  tools?: Array<{ type: string; name: string }>;
}): Promise<WebSearchResult> {
  const { query, apiKey, modelId = 'claude-sonnet-4-6', baseUrl, tools } = params;

  const apiVersion = '2023-06-01';

  const endpoint = `${baseUrl}/v1/messages`;

  try {
    const startTime = Date.now();
    const res = await proxyFetch(endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': apiVersion,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 4096,
        stream: false,
        messages: [
          {
            role: 'user',
            content: `Search for the following and provide a comprehensive summary with source links: ${query}.`,
          },
        ],
        tools: tools?.length ? tools : [{ type: 'web_search_20260209', name: 'web_search' }],
      }),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(`Claude API error (${res.status}): ${errorText || res.statusText}`);
    }

    const data = (await res.json()) as SearchResult;
    const contentBlocks: SearchResultItem[] = data.content || [];

    // Extract search results from web_search_tool_result blocks
    const searchResultMap = new Map<string, WebSearchSource>();
    for (const block of contentBlocks) {
      if (block.type !== 'web_search_tool_result') continue;
      for (const result of block.content || []) {
        if (result.type !== 'web_search_result') continue;
        if (!searchResultMap.has(result.url)) {
          searchResultMap.set(result.url, {
            title: result.title || result.url,
            url: result.url,
            content: '',
          });
        }
      }
    }

    // Collect the final answer text blocks (ignore server_tool_use / web_search_tool_result)
    const answerParts: string[] = [];
    for (const block of contentBlocks) {
      if (block.type === 'text' && block.text) {
        answerParts.push(block.text);
        // If the block carries citations, make sure those sources are captured
        for (const citation of block.citations || []) {
          if (citation.url && !searchResultMap.has(citation.url)) {
            searchResultMap.set(citation.url, {
              title: citation.title || citation.url,
              url: citation.url,
              content: citation.cited_text || '',
            });
          } else if (citation.url) {
            const existing = searchResultMap.get(citation.url)!;
            if (!existing.content && citation.cited_text) {
              existing.content = citation.cited_text;
            }
          }
        }
      }
    }

    const answerText = answerParts.join('');
    const sources = Array.from(searchResultMap.values());

    // Fetch page content for sources that have no content from citations
    await Promise.all(
      sources
        .filter((s) => !s.content)
        .map(async (s) => {
          s.content = await fetchPageContent(s.url);
        }),
    );

    // Drop sources for which we could not obtain any content
    const sourcesWithContent = sources.filter((s) => s.content);

    return {
      answer: answerText,
      sources: sourcesWithContent,
      query,
      responseTime: Date.now() - startTime,
    };
  } catch (e) {
    log.error('Claude search failed', e);
    throw e;
  }
}

/**
 * Reuse formatting logic from Tavily.
 */
export { formatSearchResultsAsContext } from './tavily';
