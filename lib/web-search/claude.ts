/**
 * Claude Web Search integration.
 *
 * Uses the AI SDK Anthropic provider with Anthropic's native server-side
 * web_search tool: Claude runs the searches and the adapter returns the
 * model's synthesized answer plus its cited sources. Result pages are never
 * fetched by this server — the answer already incorporates their content,
 * and a page-content enrichment fetch would be an SSRF vector.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { callLLM } from '@/lib/ai/llm';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import { createLogger } from '@/lib/logger';
import { CLAUDE_WEB_SEARCH_DEFAULT_MODEL, WEB_SEARCH_PROVIDERS } from './constants';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';

const CLAUDE_MAX_OUTPUT_TOKENS = 4096;

const log = createLogger('ClaudeSearch');

/**
 * Haiku-tier and pre-4.6 models only support the basic web_search_20250305
 * tool; 4.6+ Opus/Sonnet models use web_search_20260209 (dynamic filtering).
 */
function usesBasicWebSearchTool(modelId: string): boolean {
  return /haiku|-4-5|-4-1|-4-0|-3-/.test(modelId);
}

/**
 * The AI SDK serializes its provider-defined web_search tools without
 * `allowed_callers`, but Anthropic requires `allowed_callers: ["direct"]` on
 * the tool for models without programmatic tool support (the request 400s
 * otherwise). Patch it into outgoing request bodies at the fetch layer.
 */
async function fetchWithAllowedCallers(url: string, init?: RequestInit): Promise<Response> {
  if (init?.method === 'POST' && typeof init.body === 'string') {
    try {
      const body = JSON.parse(init.body);
      if (Array.isArray(body?.tools)) {
        body.tools = body.tools.map((tool: Record<string, unknown>) =>
          tool.allowed_callers ? tool : { ...tool, allowed_callers: ['direct'] },
        );
        init = { ...init, body: JSON.stringify(body) };
      }
    } catch {
      /* leave body unchanged if it can't be parsed */
    }
  }
  return proxyFetch(url, init);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Search the web using Claude's native web search tool via the AI SDK.
 */
export async function searchWithClaude(params: {
  query: string;
  apiKey: string;
  modelId?: string;
  baseUrl?: string;
  maxResults?: number;
}): Promise<WebSearchResult> {
  const { query, maxResults } = params;
  const modelId = params.modelId?.trim() || CLAUDE_WEB_SEARCH_DEFAULT_MODEL;
  // Keys and URLs are pasted by hand into Settings; surrounding whitespace
  // would otherwise be sent verbatim and come back as "invalid x-api-key".
  const apiKey = params.apiKey.trim();
  const baseUrl = params.baseUrl?.trim();

  const provider = createAnthropic({
    apiKey,
    baseURL: (baseUrl || WEB_SEARCH_PROVIDERS.claude.defaultBaseUrl || '').replace(/\/+$/, ''),
    fetch: fetchWithAllowedCallers as typeof fetch,
  });

  const toolArgs = maxResults && maxResults > 0 ? { maxUses: maxResults } : {};
  const webSearch = usesBasicWebSearchTool(modelId)
    ? provider.tools.webSearch_20250305(toolArgs)
    : provider.tools.webSearch_20260209(toolArgs);

  const startTime = Date.now();
  try {
    const result = await callLLM(
      {
        model: provider(modelId),
        messages: [
          {
            role: 'user',
            content: `Search for the following and provide a comprehensive summary with source links: ${query}.`,
          },
        ],
        maxOutputTokens: CLAUDE_MAX_OUTPUT_TOKENS,
        tools: { web_search: webSearch },
      },
      'web-search-claude',
    );

    // The AI SDK surfaces the tool's citations as sources (url + title only).
    // Claude's answer already synthesizes the page contents, so sources are
    // returned as references, deduplicated by URL.
    const sources = new Map<string, WebSearchSource>();
    for (const source of result.sources) {
      if (source.sourceType !== 'url') continue;
      if (!isHttpUrl(source.url) || sources.has(source.url)) continue;
      sources.set(source.url, {
        title: source.title?.trim() || new URL(source.url).hostname,
        url: source.url,
        content: 'Referenced by the Claude web-search answer.',
        score: 1,
      });
    }

    return {
      answer: result.text,
      sources: [...sources.values()],
      query,
      responseTime: Date.now() - startTime,
    };
  } catch (e) {
    log.error(`Claude web search failed [model="${modelId}"]:`, e);
    throw e;
  }
}
