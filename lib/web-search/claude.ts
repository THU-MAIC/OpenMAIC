/**
 * Claude Web Search Integration
 *
 * This provider implements the native Claude web search tool via the Anthropic Messages API.
 * It requires a specific model (e.g., claude-opus-4-6) and a specific tool definition.
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { createLogger } from '@/lib/logger';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';
import Anthropic from '@anthropic-ai/sdk';
import { Tool, WebSearchTool20260209 } from '@anthropic-ai/sdk/resources';

const DEFAULT_WEB_SEARCH_TOOL: WebSearchTool20260209 = {
  type: 'web_search_20260209',
  name: 'web_search',
  allowed_callers: ['direct'],
};

const PAGE_CONTENT_MAX_LENGTH = 2000;
const PAGE_FETCH_TIMEOUT_MS = 5000;

const log = createLogger('ClaudeSearch');

/** Fetch a URL and return plain text extracted from its HTML. Returns empty string on any failure. */
async function fetchPageContent(url: string): Promise<string> {
  const ssrfError = await validateUrlForSSRF(url);
  if (ssrfError) {
    log.warn(`Blocked page fetch due to SSRF check [url="${url}" reason="${ssrfError}"]`);
    return '';
  }
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

/**
 * Search the web using Claude's native web search tool.
 */
export async function searchWithClaude(params: {
  query: string;
  apiKey: string;
  modelId?: string;
  baseUrl: string;
  tools?: Tool[];
}): Promise<WebSearchResult> {
  const { query, apiKey, modelId: rawModelId, baseUrl, tools: rawTools } = params;
  const modelId = rawModelId?.trim() || 'claude-sonnet-4-6';
  const tools: (Tool | WebSearchTool20260209)[] =
    rawTools && rawTools.length > 0
      ? rawTools.map(
          (t) => ({ ...t, allowed_callers: ['direct'] }) as Tool & { allowed_callers: string[] },
        )
      : [DEFAULT_WEB_SEARCH_TOOL];

  try {
    const startTime = Date.now();
    const client = new Anthropic({ baseURL: baseUrl, apiKey, fetch: proxyFetch as typeof fetch });
    const response = await client.messages
      .create({
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: `Search for the following and provide a comprehensive summary with source links: ${query}.`,
          },
        ],
        model: modelId || '',
        tools: tools as Tool[],
      })
      .catch(async (err) => {
        if (err instanceof Anthropic.APIError) {
          throw new Error(`Claude API error (${err.status}): ${err.message}`);
        } else {
          throw err;
        }
      });

    const contentBlocks = response.content;

    // Extract search results from web_search_tool_result blocks
    const searchResultMap = new Map<string, WebSearchSource>();
    for (const block of contentBlocks) {
      if (block.type !== 'web_search_tool_result') continue;
      for (const source of getWebSearchResult(block.content)) {
        if (!searchResultMap.has(source.url)) {
          searchResultMap.set(source.url, source);
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
          if (citation.type !== 'web_search_result_location') continue;
          if (!searchResultMap.has(citation.url)) {
            searchResultMap.set(citation.url, {
              title: citation.title || citation.url,
              url: citation.url,
              content: citation.cited_text || '',
            });
          } else {
            const existing = searchResultMap.get(citation.url)!;
            if (!existing.content && citation.cited_text) {
              existing.content = citation.cited_text;
            }
          }
        }
      }
    }

    const answerText = answerParts.join('\n\n');
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

function getWebSearchResult(content: Anthropic.WebSearchToolResultBlockContent): WebSearchSource[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((r) => r.type === 'web_search_result')
    .map((r) => ({ title: r.title || r.url, url: r.url, content: '' }));
}

/**
 * Reuse formatting logic from Tavily.
 */
export { formatSearchResultsAsContext } from './tavily';
